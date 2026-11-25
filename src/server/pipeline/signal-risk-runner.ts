import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { big, bigMin, toNumber } from "trading-strategy-core/money";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import {
  evaluateDowDualIndex,
  evaluateOneilMarketDirection,
  poolSyncSnapshotSchema,
  strategyTargetProposalSchema,
  type PipelineTriggerKind,
  type RegimeGateSpec,
  type StrategyTargetProposal,
  type VenueBinding,
} from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { cryptoSymbol } from "~/lib/market/crypto";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import { sqlite } from "../db";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import {
  getDeployment,
  type DeploymentRecord,
} from "../db/deployment-repository";
import type { JsonValue } from "../db/execution-audit";
import {
  getOrCreatePipelineRun,
  getPipelineRun,
  insertOrderIntents,
  listIntentsByRun,
  updatePipelineRunStage,
  type InsertOrderIntentInput,
  type PipelineRunRecord,
  type PipelineRunStagePatch,
} from "../db/pipeline-repository";
import {
  getActivePoolEntries,
  normalizePoolSymbol,
} from "../db/pool-repository";
import { SimAccountRepository } from "../db/sim-account-repository";
import { sentimentRegimeSnapshot } from "../market/limit-sentiment-regime";
import { getSimAccountDetail } from "../portfolio/sim-accounts/service";
import { quantityDigits } from "../portfolio/sim-accounts/engine";
import {
  checkTicketUnlockEvents,
  type TicketUnlockCheck,
} from "../portfolio/ticket-unlock-check";
import { previewMacroClockAllocation } from "../research/value-pit-service";
import {
  evaluateDeploymentStrategy,
  type StrategyEvaluatorDeps,
} from "./strategy-evaluator";
import {
  readDecisionBars,
  syncDeploymentPool,
  type UniversePoolDeps,
} from "./universe-pool-runner";

type MaybePromise<T> = T | Promise<T>;
type ReadPrice = (
  symbol: string,
  decisionDate: string,
) => MaybePromise<number | null>;

export type PipelineAccountState = {
  cash: number;
  equity: number;
  drawdownPct: number | null;
  positions: readonly {
    symbol: string;
    quantity: number;
    sellable: number;
    lastPrice: number | null;
  }[];
};

function validPrice(price: number | null | undefined): price is number {
  return price != null && Number.isFinite(price) && price > 0;
}

function readClose(readBars?: UniversePoolDeps["readBars"]): ReadPrice {
  return async (symbol, date) => {
    const last = (await readDecisionBars(symbol, date, readBars)).at(-1);
    return last?.date === date ? last.close : null;
  };
}

export async function readLocalSimAccountState(
  simAccountId: string,
  executeDate: string,
  db: Database.Database,
  readPrice: ReadPrice = readClose(),
  decisionDate = executeDate,
): Promise<PipelineAccountState> {
  const repo = new SimAccountRepository(db);
  const { detail, baseline } = repo.read(() => {
    const latest = repo.latestDate(simAccountId);
    if (latest && latest > decisionDate)
      throw new Error("交易日期早于账户已成交日期");
    const detail = getSimAccountDetail(
      { accountId: simAccountId, currentTradeDate: executeDate, limit: 1 },
      db,
    );
    const account = repo.account(simAccountId);
    let baseline = big(detail.account.initialCapital);
    let cursor: string | undefined;
    do {
      const page = repo.flows(account, cursor, 1000);
      for (const flow of page) {
        if (flow.kind === "deposit" || flow.kind === "withdrawal")
          baseline = baseline.plus(flow.delta);
      }
      cursor = page.length === 1000 ? page.at(-1)?.id : undefined;
    } while (cursor);
    return { detail, baseline };
  });
  const positions = await Promise.all(
    detail.positions.map(async (position) => {
      const symbol = normalizePoolSymbol(position.symbol);
      const price = await readPrice(symbol, decisionDate);
      return {
        symbol,
        quantity: Number(position.quantity),
        sellable: Number(position.sellableQuantity),
        lastPrice: validPrice(price) ? price : null,
      };
    }),
  );
  const equity = positions.reduce(
    (total, position) =>
      position.lastPrice === null
        ? total
        : total.plus(big(position.quantity).times(position.lastPrice)),
    big(detail.cash),
  );
  return {
    cash: Number(detail.cash),
    equity: toNumber(equity),
    drawdownPct: baseline.gt(0)
      ? Math.max(0, toNumber(baseline.minus(equity).div(baseline)))
      : null,
    positions,
  };
}

type GateSpec =
  | RegimeGateSpec
  | (Partial<Omit<RegimeGateSpec, "kind">> &
      (
        | { kind: "oneil-distribution" | "dow-confirm" | "macro-clock" }
        | { kind: "composite"; gates: readonly GateSpec[] }
      ));
type SentimentGateSnapshot = {
  phase: ReturnType<typeof sentimentRegimeSnapshot>["phase"];
  exposureScale: number | null;
  allowNewEntries: boolean;
  reason?: string;
};
type MacroGateSnapshot = Pick<
  ReturnType<typeof previewMacroClockAllocation>,
  "regime"
> & { disclosure?: string };

export type RegimeGateDeps = {
  readBars?: UniversePoolDeps["readBars"];
  readSentiment?: (decisionDate: string) => MaybePromise<SentimentGateSnapshot>;
  readMacroClock?: (decisionDate: string) => MaybePromise<MacroGateSnapshot>;
};

export type RegimeGateVerdict = {
  status: "allow" | "reduced" | "block" | "unknown";
  scale: number;
  allowNewEntries: boolean;
  reasons: string[];
  details: Record<string, JsonValue>;
};

function canEnter({ status, scale, allowNewEntries }: RegimeGateVerdict) {
  return (
    allowNewEntries &&
    Number.isFinite(scale) &&
    scale > 0 &&
    (status === "allow" || status === "reduced")
  );
}

function scaledGate(
  scale: number | null,
  reason: string,
  details: RegimeGateVerdict["details"],
  allowNewEntries = true,
): RegimeGateVerdict {
  if (scale === null || !Number.isFinite(scale) || scale < 0 || scale > 1)
    return {
      status: "unknown",
      scale: 0,
      allowNewEntries: false,
      reasons: [reason],
      details,
    };
  const allowed = allowNewEntries && scale > 0;
  return {
    status: allowed ? (scale === 1 ? "allow" : "reduced") : "block",
    scale,
    allowNewEntries: allowed,
    reasons: [reason],
    details,
  };
}

export async function evaluateRegimeGate(
  gate: GateSpec,
  decisionDate: string,
  deps: RegimeGateDeps = {},
): Promise<RegimeGateVerdict> {
  const asOf = researchDateSchema.parse(decisionDate);
  const benchmark = normalizePoolSymbol(gate.benchmark ?? "sh000300");
  try {
    switch (gate.kind) {
      case "none":
        return {
          status: "allow",
          scale: 1,
          allowNewEntries: true,
          reasons: [],
          details: {},
        };
      case "oneil-distribution":
      case "oneil-market-direction": {
        const bars = await readDecisionBars(benchmark, asOf, deps.readBars);
        const result = evaluateOneilMarketDirection(bars, { asOf });
        return scaledGate(result.scale, `欧奈尔市场方向：${result.status}`, {
          benchmark,
          ...result,
        });
      }
      case "dow-confirm":
      case "dow-dual-index": {
        if (!gate.secondaryBenchmark)
          return scaledGate(null, "道氏双指数缺少副基准", { benchmark });
        const secondaryBenchmark = normalizePoolSymbol(gate.secondaryBenchmark);
        if (secondaryBenchmark === benchmark)
          return scaledGate(null, "道氏双指数需要两个不同基准", {
            benchmark,
            secondaryBenchmark,
          });
        const [primary, secondary] = await Promise.all([
          readDecisionBars(benchmark, asOf, deps.readBars),
          readDecisionBars(secondaryBenchmark, asOf, deps.readBars),
        ]);
        const result = evaluateDowDualIndex(primary, secondary, { asOf });
        return scaledGate(result.scale, `道氏双指数：${result.status}`, {
          benchmark,
          secondaryBenchmark,
          ...result,
        });
      }
      case "sentiment-regime": {
        const snapshot = deps.readSentiment
          ? await deps.readSentiment(asOf)
          : sentimentRegimeSnapshot({ asOfDate: asOf });
        const { phase, exposureScale, allowNewEntries, reason } = snapshot;
        return scaledGate(
          phase === "unknown" ? null : exposureScale,
          reason ?? `情绪阶段：${phase}`,
          { phase },
          allowNewEntries,
        );
      }
      case "macro-clock":
      case "macro-clock-filter": {
        const snapshot = deps.readMacroClock
          ? await deps.readMacroClock(asOf)
          : previewMacroClockAllocation({ asOfDate: asOf });
        const scales = {
          recovery: 1,
          overheat: 1,
          stagflation: 0.5,
          recession: 0.5,
          unknown: null,
        };
        return scaledGate(
          scales[snapshot.regime],
          snapshot.disclosure ?? `宏观时钟：${snapshot.regime}`,
          {
            regime: snapshot.regime,
          },
        );
      }
      case "composite": {
        if (!gate.gates.length)
          return scaledGate(null, "组合门控缺少子门控", {});
        const verdicts = await Promise.all(
          gate.gates.map((child) => evaluateRegimeGate(child, asOf, deps)),
        );
        const scale = Math.min(...verdicts.map((verdict) => verdict.scale));
        const combined = scaledGate(
          scale,
          "",
          { gates: verdicts },
          verdicts.every(canEnter),
        );
        return {
          ...combined,
          status: verdicts.some((verdict) => verdict.status === "block")
            ? "block"
            : verdicts.some((verdict) => verdict.status === "unknown")
              ? "unknown"
              : combined.status,
          reasons: verdicts.flatMap((verdict) => verdict.reasons),
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return scaledGate(null, message, { error: message });
  }
}

type CheckUnlockEvents = (
  input: Parameters<typeof checkTicketUnlockEvents>[0],
) => MaybePromise<readonly TicketUnlockCheck[]>;
type OrderPlanningDeps = {
  readReferencePrice?: ReadPrice;
  checkUnlockEvents?: CheckUnlockEvents;
};

export type PipelinePlanningDeps = OrderPlanningDeps & {
  now?: () => number;
  universe?: UniversePoolDeps;
  strategy?: StrategyEvaluatorDeps;
  regime?: RegimeGateDeps;
  readAccountState?: (
    binding: VenueBinding,
    executeDate: string,
    db: Database.Database,
  ) => MaybePromise<PipelineAccountState>;
};

type SkippedOrder = {
  symbol: string;
  side: "BUY" | "SELL";
  reason: string;
  detail?: string;
};

function defaultReferencePrice(
  deployment: DeploymentRecord,
  readBars?: UniversePoolDeps["readBars"],
): ReadPrice {
  const spec = deployment.strategySpec;
  if (spec.kind !== "crypto-dual-ma") return readClose(readBars);
  return async (symbol, date) => {
    const end = Math.min(Date.now(), Date.parse(date) + 86_400_000);
    const bars = readBars
      ? await readBars(symbol, date)
      : ((
          await (
            await import("../research/validation-crypto-history")
          ).readCachedResearchCryptoWindow({
            instrument: {
              market: "crypto",
              symbol: cryptoSymbol(symbol.replace(/^CX/i, "")),
            },
            period: spec.period,
            adjustment: "none",
            cryptoSource: "binance",
            to: date,
            now: end,
          })
        )?.snapshot.bars ?? []);
    const last = bars.reduce<(typeof bars)[number] | undefined>(
      (latest, bar) =>
        bar.date.slice(0, 10) === date &&
        cryptoPeriodEnd(bar.date, spec.period) <= end &&
        (!latest || bar.date > latest.date)
          ? bar
          : latest,
      undefined,
    );
    return last?.close ?? null;
  };
}

function roundedQuantity(
  quantity: ReturnType<typeof big>,
  market: DeploymentRecord["market"],
) {
  return market === "cn-equity"
    ? toNumber(quantity.div(100).round(0, 0).times(100))
    : toNumber(quantity.round(quantityDigits(market), 0));
}

export async function planOrderIntents({
  deployment,
  run,
  proposal,
  accountState,
  regimeVerdict,
  deps = {},
}: {
  deployment: DeploymentRecord;
  run: Pick<PipelineRunRecord, "id" | "decisionDate" | "executeDate">;
  proposal: StrategyTargetProposal;
  accountState: PipelineAccountState;
  regimeVerdict: RegimeGateVerdict;
  deps?: OrderPlanningDeps;
}) {
  const { decisionDate, executeDate } = run;
  if (proposal.asOf !== decisionDate) throw new Error("策略信号与决策日不匹配");
  const { market, riskPolicy, venueBinding } = deployment;
  const { equity, drawdownPct } = accountState;
  if (![accountState.cash, equity, drawdownPct ?? 0].every(Number.isFinite))
    throw new Error("账户资金、权益或回撤无效");

  const riskReasons = [...regimeVerdict.reasons];
  const drawdownPaused =
    drawdownPct !== null && drawdownPct >= riskPolicy.drawdownPausePct;
  if (drawdownPaused) riskReasons.push("drawdown_pause");
  const allowNewEntries = canEnter(regimeVerdict) && !drawdownPaused;
  const entryScale = allowNewEntries ? Math.min(1, regimeVerdict.scale) : 0;
  const skipped: SkippedOrder[] = [];
  const skip = (
    symbol: string,
    side: SkippedOrder["side"],
    reason: string,
    detail?: string,
  ) => {
    skipped.push({
      symbol,
      side,
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const intents: InsertOrderIntentInput[] = [];
  const addIntent = (
    symbol: string,
    phase: 1 | 2,
    quantity: number,
    referencePrice: number,
  ) => {
    intents.push({
      runId: run.id,
      deploymentId: deployment.id,
      venueKind: venueBinding.kind,
      venueBinding,
      symbol,
      phase,
      side: phase === 1 ? "SELL" : "BUY",
      quantity,
      referencePrice,
    });
  };

  const readPrice =
    deps.readReferencePrice ?? defaultReferencePrice(deployment);
  const positions = new Map<
    string,
    PipelineAccountState["positions"][number]
  >();
  for (const position of accountState.positions) {
    if (![position.quantity, position.sellable].every(Number.isFinite))
      throw new Error(`无效账户持仓：${position.symbol}`);
    if (position.quantity <= 0) continue;
    const symbol = normalizePoolSymbol(position.symbol);
    if (positions.has(symbol)) throw new Error(`重复账户持仓：${symbol}`);
    positions.set(symbol, position);
  }
  const targets = new Map(
    Object.entries(proposal.targets).map(([symbol, weight]) => [
      normalizePoolSymbol(symbol),
      weight,
    ]),
  );
  const signals = new Map(
    proposal.signals.map((signal) => [
      normalizePoolSymbol(signal.symbol),
      signal,
    ]),
  );
  const targetMode = proposal.mode === "target-weights";
  const { minimumCommission, commissionBps, sellTaxBps, slippageBps } =
    researchExecutionCosts(market, "fixed");
  const sellPriceFactor = big(1)
    .minus(riskPolicy.maxGapPct)
    .minus(big(slippageBps).div(10_000));
  const buyPriceFactor = big(1)
    .plus(riskPolicy.maxGapPct)
    .plus(big(slippageBps).div(10_000));
  const commission = big(commissionBps).div(10_000);
  const tax = big(sellTaxBps).div(10_000);
  const commissionFor = (gross: ReturnType<typeof big>) => {
    const proportional = gross.times(commission);
    return proportional.gte(minimumCommission)
      ? proportional
      : minimumCommission;
  };
  // Round fee reserves up by a few currency ticks to cover ledger rounding.
  const feeRounding = market === "cn-equity" ? 0.02 : 0.00000002;
  let cash = big(accountState.cash);
  let exposure = big(0);
  let turnover = big(0);
  let unpricedHolding = false;
  const remainingValues = new Map<string, ReturnType<typeof big>>();
  const marks = new Map<string, number>();
  for (const [symbol, position] of [...positions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const weight = targets.get(symbol) ?? 0;
    const couldSell = targetMode
      ? weight === 0 || equity > 0
      : signals.get(symbol)?.action === "SELL";
    const sellable = Math.min(position.quantity, position.sellable);
    const referencePrice = validPrice(position.lastPrice)
      ? position.lastPrice
      : await readPrice(symbol, decisionDate);
    if (!validPrice(referencePrice)) {
      unpricedHolding = true;
      if (couldSell) skip(symbol, "SELL", "missing_reference_price");
      if (couldSell && weight === 0 && sellable <= 0)
        skip(symbol, "SELL", "t_plus_1_locked");
      continue;
    }
    marks.set(symbol, referencePrice);
    const value = big(position.quantity).times(referencePrice);
    const targetValue = targetMode
      ? big(Math.max(equity, 0)).times(weight)
      : big(0);
    let remainingValue = value;
    if (couldSell && value.gt(targetValue)) {
      if (sellable <= 0) {
        skip(symbol, "SELL", "t_plus_1_locked");
      } else if (intents.length >= riskPolicy.maxDailyOrders) {
        skip(symbol, "SELL", "max_daily_orders");
      } else {
        const quantity = targetValue.eq(0)
          ? sellable
          : roundedQuantity(
              bigMin(sellable, value.minus(targetValue).div(referencePrice)),
              market,
            );
        if (quantity > 0) {
          addIntent(symbol, 1, quantity, referencePrice);
          const gross = big(quantity).times(referencePrice);
          const estimatedGross = gross.times(sellPriceFactor);
          cash = cash
            .plus(estimatedGross)
            .minus(commissionFor(estimatedGross))
            .minus(estimatedGross.times(tax))
            .minus(feeRounding);
          remainingValue = value.minus(gross);
          turnover = turnover.plus(gross);
        } else {
          skip(symbol, "SELL", "below_min_lot");
        }
      }
    }
    exposure = exposure.plus(remainingValue);
    remainingValues.set(symbol, remainingValue);
  }

  const candidates = (
    targetMode
      ? [...targets]
          .filter(([, weight]) => weight > 0)
          .map(([symbol, weight]) => ({ symbol, weight, score: weight }))
      : [...signals]
          .filter(([, signal]) => signal.action === "BUY")
          .map(([symbol, signal]) => ({
            symbol,
            weight: riskPolicy.maxSymbolWeight,
            score: signal.score,
          }))
  ).sort(
    (a, b) =>
      (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  );
  let entriesBlocked = false;
  for (const { symbol, weight } of candidates) {
    if (equity <= 0) {
      skip(symbol, "BUY", "nonpositive_equity");
      continue;
    }
    const currentValue = remainingValues.get(symbol) ?? big(0);
    const targetValue = bigMin(weight, riskPolicy.maxSymbolWeight).times(
      equity,
    );
    if (targetValue.lte(currentValue)) continue;
    if (!allowNewEntries) {
      entriesBlocked = true;
      skip(
        symbol,
        "BUY",
        drawdownPaused ? "drawdown_pause" : "regime_gate_blocked",
      );
      continue;
    }
    if (unpricedHolding) {
      skip(symbol, "BUY", "unpriced_account_exposure");
      continue;
    }
    if (intents.length >= riskPolicy.maxDailyOrders) {
      skip(symbol, "BUY", "max_daily_orders");
      continue;
    }
    const symbolRoom = targetValue.times(entryScale).minus(currentValue);
    if (symbolRoom.lte(0)) continue;
    const cashAfterRounding = cash.minus(feeRounding);
    const spendingRoom = bigMin(
      cashAfterRounding.div(big(1).plus(commission)),
      cashAfterRounding.minus(minimumCommission),
    ).div(buyPriceFactor);
    const budget = bigMin(
      symbolRoom,
      big(equity)
        .times(riskPolicy.maxTotalExposure)
        .times(entryScale)
        .minus(exposure),
      big(equity).times(riskPolicy.maxDailyTurnover).minus(turnover),
      spendingRoom,
    );
    if (budget.lte(0)) {
      skip(symbol, "BUY", "risk_budget_exhausted");
      continue;
    }
    const referencePrice =
      marks.get(symbol) ?? (await readPrice(symbol, decisionDate));
    if (!validPrice(referencePrice)) {
      skip(symbol, "BUY", "missing_reference_price");
      continue;
    }
    const quantity = roundedQuantity(budget.div(referencePrice), market);
    if (quantity <= 0) {
      skip(symbol, "BUY", "below_min_lot");
      continue;
    }
    const windowDays = deployment.regimeGate.unlockAvoidanceDays;
    if (market === "cn-equity" && windowDays > 0) {
      const checks = await (deps.checkUnlockEvents ?? checkTicketUnlockEvents)({
        symbols: [symbol],
        executeDate,
        windowDays,
      });
      const warning = checks.find(
        (check) =>
          check.code === "unlock" &&
          check.status === "warning" &&
          check.symbol !== undefined &&
          normalizePoolSymbol(check.symbol) === symbol,
      );
      if (warning) {
        skip(symbol, "BUY", "unlock_window_blocked", warning.detail);
        continue;
      }
    }
    addIntent(symbol, 2, quantity, referencePrice);
    const gross = big(quantity).times(referencePrice);
    const estimatedGross = gross.times(buyPriceFactor);
    cash = cash
      .minus(estimatedGross)
      .minus(commissionFor(estimatedGross))
      .minus(feeRounding);
    exposure = exposure.plus(gross);
    turnover = turnover.plus(gross);
  }
  return {
    intents,
    entriesBlocked,
    riskVerdict: {
      regime: regimeVerdict,
      allowNewEntries,
      drawdownPct,
      reasons: riskReasons,
      skipped,
    },
  };
}

type PlanningInput = {
  deploymentId: string;
  decisionDate: string;
  executeDate: string;
  runSlot?: string;
  triggerKind: PipelineTriggerKind;
  stopAfterStage?: "universe" | "signals" | "risk";
  deps?: PipelinePlanningDeps;
};

const plansAlreadyPublished = new Set<PipelineRunRecord["stage"]>([
  "risk_checked",
  "executing",
  "completed",
  "partial",
  "blocked",
]);
const activePlanning = new Map<string, Promise<unknown>>();

export async function runPipelinePlanning(
  { stopAfterStage, deps = {}, ...input }: PlanningInput,
  db: Database.Database = sqlite(),
) {
  const deployment = getDeployment(input.deploymentId, db);
  if (!deployment) throw new Error(`策略部署不存在：${input.deploymentId}`);
  if (deployment.status === "archived") throw new Error("策略部署已归档");
  if (
    deployment.market === "cn-equity" &&
    (input.runSlot ?? "daily").trim() === "daily" &&
    !completedBarFilter(
      "day",
      deps.now?.() ?? Date.now(),
    )(researchDateSchema.parse(input.decisionDate))
  )
    throw new Error("A 股交易日尚未收盘，无法固化当日日频流水线");
  const { run } = getOrCreatePipelineRun(input, db);
  // Serialize concurrent requests for the same run, including different stop stages.
  const previous = activePlanning.get(run.id) ?? Promise.resolve();
  const planning = previous
    .catch(() => undefined)
    .then(() =>
      advancePipelinePlanning(
        getPipelineRun(run.id, db)!,
        deployment,
        stopAfterStage,
        deps,
        db,
      ),
    );
  activePlanning.set(run.id, planning);
  try {
    return await planning;
  } finally {
    if (activePlanning.get(run.id) === planning) activePlanning.delete(run.id);
  }
}

async function advancePipelinePlanning(
  run: PipelineRunRecord,
  deployment: DeploymentRecord,
  stopAfterStage: PlanningInput["stopAfterStage"],
  deps: PipelinePlanningDeps,
  db: Database.Database,
) {
  const result = () => ({ run, intents: listIntentsByRun(run.id, db) });
  if (plansAlreadyPublished.has(run.stage)) return result();

  const { decisionDate, executeDate } = run;
  const readBars = deps.strategy?.readBars ?? deps.universe?.readBars;
  const referencePrice =
    deps.readReferencePrice ?? defaultReferencePrice(deployment, readBars);
  const workspace = new AccountWorkspaceRepository(db);
  const currentRun = () => getPipelineRun(run.id, db)!;
  const checkpoint = (patch: PipelineRunStagePatch) =>
    workspace.atomic(() => {
      const current = currentRun();
      return isDeepStrictEqual(current, run)
        ? updatePipelineRunStage(
            run.id,
            { errorSummary: null, finishedAt: null, ...patch },
            db,
          )
        : current;
    });

  try {
    let universeSnapshot = run.universeSnapshot;
    if (universeSnapshot === null) {
      universeSnapshot = await syncDeploymentPool({
        deployment,
        decisionDate,
        deps: { readBars, ...deps.universe },
        db,
      });
      run = checkpoint({ stage: "universe_done", universeSnapshot });
      universeSnapshot = run.universeSnapshot;
    }
    if (plansAlreadyPublished.has(run.stage) || stopAfterStage === "universe")
      return result();
    const pool = poolSyncSnapshotSchema.parse(universeSnapshot);
    const binding = deployment.venueBinding;
    let accountState: PipelineAccountState;
    if (deps.readAccountState) {
      accountState = await deps.readAccountState(binding, executeDate, db);
    } else if (binding.kind === "local_sim") {
      accountState = await readLocalSimAccountState(
        binding.simAccountId,
        executeDate,
        db,
        referencePrice,
        decisionDate,
      );
    } else {
      throw new Error(`交易通道 ${binding.kind} 缺少账户快照读取器`);
    }

    if (run.signals === null) {
      const symbols = new Set(pool.activeSymbols);
      const activePoolEntries = getActivePoolEntries(deployment.id, db).filter(
        (entry) =>
          symbols.has(entry.symbol) && entry.lastCheckedDate === decisionDate,
      );
      if (activePoolEntries.length !== symbols.size)
        throw new Error("监控池已改变，无法恢复当前决策日的信号计算");
      const signals = await evaluateDeploymentStrategy({
        deployment,
        decisionDate,
        activePoolEntries,
        heldSymbols: accountState.positions
          .filter((position) => position.quantity > 0)
          .map((position) => position.symbol),
        deps: { readBars, ...deps.strategy },
        db,
      });
      run = checkpoint({ stage: "signals_done", signals });
    }
    if (plansAlreadyPublished.has(run.stage) || stopAfterStage === "signals")
      return result();
    const proposal = strategyTargetProposalSchema.parse(run.signals);
    const regimeVerdict = await evaluateRegimeGate(
      deployment.regimeGate,
      decisionDate,
      {
        readBars: deps.universe?.readBars ?? readBars,
        ...deps.regime,
      },
    );
    const plan = await planOrderIntents({
      deployment,
      run,
      proposal,
      accountState,
      regimeVerdict,
      deps: {
        readReferencePrice: referencePrice,
        checkUnlockEvents: deps.checkUnlockEvents,
      },
    });

    return workspace.atomic(() => {
      const current = currentRun();
      if (!isDeepStrictEqual(current, run)) {
        run = current;
        return result();
      }
      const intents = insertOrderIntents(run.id, plan.intents, db);
      const stage = intents.length
        ? "risk_checked"
        : plan.entriesBlocked
          ? "blocked"
          : "completed";
      const updated = updatePipelineRunStage(
        run.id,
        {
          stage,
          riskVerdict: plan.riskVerdict,
          errorSummary: null,
          finishedAt: stage === "risk_checked" ? null : Date.now(),
        },
        db,
      );
      run = updated;
      return result();
    });
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : String(error);
    checkpoint({ stage: "failed", errorSummary, finishedAt: Date.now() });
    throw error;
  }
}
