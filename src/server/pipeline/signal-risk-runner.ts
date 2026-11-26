import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { big, bigMin, toNumber } from "trading-strategy-core/money";
import { defaultPortfolioRiskPolicy } from "quant-execution";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import {
  evaluateDowDualIndex,
  evaluateOneilMarketDirection,
  isTerminalIntentStatus,
  type PipelineTriggerKind,
  type RegimeGateSpec,
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
  appendExecutionAuditEvent,
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
import {
  decisionIndustries,
  freezePlanningSleeves,
  ownedPlanningPositions,
  planningAccount,
  planningCalendarWarning,
  readPlanningFacts,
  type PlanningFacts,
} from "./account-coordinator";
import { readLocalSimAccountState } from "./local-account-state";
export { readLocalSimAccountState } from "./local-account-state";
import { sentimentRegimeSnapshot } from "../market/limit-sentiment-regime";
import { quantityDigits } from "../portfolio/sim-accounts/engine";
import {
  checkTicketUnlockEvents,
  type TicketUnlockCheck,
} from "../portfolio/ticket-unlock-check";
import { previewMacroClockAllocation } from "../research/value-pit-service";
import {
  evaluateDeploymentStrategy,
  evaluatedStrategyProposalSchema,
  type EvaluatedStrategyProposal,
  type StrategyEvaluatorDeps,
} from "./strategy-evaluator";
import {
  parseEvaluatedPoolSnapshot,
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
  riskRegime?: "normal" | "reduced" | "halted";
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
  readIndustries?: (symbol: string, decisionDate: string) => readonly string[];
};

export type PipelinePlanningDeps = OrderPlanningDeps & {
  now?: () => number;
  universe?: UniversePoolDeps;
  strategy?: StrategyEvaluatorDeps;
  regime?: RegimeGateDeps;
  readAccountState?: (
    binding: VenueBinding,
    decisionDate: string,
    db: Database.Database,
    asOfCreatedAt?: number,
  ) => MaybePromise<PipelineAccountState | null>;
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
  ownerPositions,
  commitments = [],
  accountCaps,
  regimeVerdict,
  deps = {},
}: {
  deployment: DeploymentRecord;
  run: Pick<PipelineRunRecord, "id" | "decisionDate" | "executeDate">;
  proposal: EvaluatedStrategyProposal;
  ownerPositions: readonly {
    symbol: string;
    quantity: number;
    executionSellable: number;
    pendingSell?: number;
    sellLimitReason?: string;
  }[];
  commitments?: PlanningFacts["commitments"];
  accountCaps?: PlanningFacts["accountCaps"];
  accountState: PipelineAccountState;
  regimeVerdict: RegimeGateVerdict;
  deps?: OrderPlanningDeps;
}) {
  const { decisionDate, executeDate } = run;
  if (proposal.asOf !== decisionDate) throw new Error("策略信号与决策日不匹配");
  const { market, riskPolicy, venueBinding } = deployment;
  const { equity, drawdownPct, riskRegime } = accountState;
  const riskReasons = [...regimeVerdict.reasons];
  const missingEvidence =
    !Number.isFinite(accountState.cash) ||
    !Number.isFinite(equity) ||
    !Number.isFinite(drawdownPct) ||
    (drawdownPct ?? -1) < 0 ||
    !Array.isArray(accountState.positions) ||
    accountState.positions.some(
      (p) =>
        !Number.isFinite(p.quantity) ||
        p.quantity < 0 ||
        !Number.isFinite(p.sellable) ||
        p.sellable < 0 ||
        (venueBinding.kind !== "local_sim" &&
          p.quantity > 0 &&
          !validPrice(p.lastPrice)),
    );
  const drawdownPaused =
    riskRegime === "halted" ||
    (drawdownPct !== null &&
      Number.isFinite(drawdownPct) &&
      drawdownPct >= riskPolicy.drawdownPausePct);
  if (missingEvidence) riskReasons.push("risk-evidence-missing");
  if (drawdownPaused) riskReasons.push("drawdown_pause");
  if (riskRegime === "reduced") riskReasons.push("drawdown_reduced");
  const allowNewEntries =
    !missingEvidence && canEnter(regimeVerdict) && !drawdownPaused;
  const entryScale = allowNewEntries
    ? Math.min(
        regimeVerdict.scale,
        riskRegime === "reduced" ? defaultPortfolioRiskPolicy.reducedScale : 1,
      )
    : 0;
  const clipped: {
    symbol: string;
    side: "BUY" | "SELL";
    reasons: string[];
    quantity: number;
  }[] = [];
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
  const theoreticalOrders: {
    symbol: string;
    side: "BUY" | "SELL";
    theoreticalQuantity: number;
    referencePrice: number;
  }[] = [];
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
  const positions = new Map(
    ownerPositions.map((p) => [normalizePoolSymbol(p.symbol), p]),
  );
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
  const fixed = researchExecutionCosts(market, "fixed");
  const costsFor = (symbol: string, date: string) =>
    market === "cn-equity"
      ? executionCostsForInstrument(fixed, symbol, date)
      : fixed;
  const feeRounding = market === "cn-equity" ? 0.02 : 0.00000002;
  type Amount = ReturnType<typeof big>;
  const grossWithGap = (gross: Amount, gap: number) =>
    gross.times(big(1).plus(gap));
  function buyCost(symbol: string, date: string, gross: Amount, gap: number) {
    const costs = costsFor(symbol, date);
    const value = grossWithGap(gross, gap);
    const commission = value.times(costs.commissionBps).div(10000);
    return value
      .plus(
        commission.gt(costs.minimumCommission)
          ? commission
          : costs.minimumCommission,
      )
      .plus(
        value.times(costs.slippageBps + (costs.transferBps ?? 0)).div(10000),
      )
      .plus(feeRounding);
  }
  let cash = big(Number.isFinite(accountState.cash) ? accountState.cash : 0);
  let exposure = big(0),
    turnover = big(0),
    dailyOrders = 0;
  let unpricedHolding = false;
  const accountValues = new Map<string, Amount>();
  const ownerValues = new Map<string, Amount>();
  const industryValues = new Map<string, Amount>();
  const marks = new Map<string, number>();
  const industries = (symbol: string) => {
    if (market !== "cn-equity") return [];
    const groups = deps.readIndustries?.(symbol, decisionDate);
    return groups?.length ? [...new Set(groups)] : ["unknown"];
  };
  function addExposure(symbol: string, delta: Amount) {
    exposure = exposure.plus(delta);
    accountValues.set(
      symbol,
      (accountValues.get(symbol) ?? big(0)).plus(delta),
    );
    for (const group of industries(symbol))
      industryValues.set(
        group,
        (industryValues.get(group) ?? big(0)).plus(delta),
      );
  }
  for (const p of accountState.positions ?? []) {
    if (!Number.isFinite(p.quantity) || p.quantity <= 0) continue;
    const symbol = normalizePoolSymbol(p.symbol);
    if (accountValues.has(symbol)) throw new Error(`重复账户持仓：${symbol}`);
    const mark = validPrice(p.lastPrice)
      ? p.lastPrice
      : await readPrice(symbol, decisionDate);
    if (!validPrice(mark)) {
      unpricedHolding = true;
      continue;
    }
    marks.set(symbol, mark);
    addExposure(symbol, big(p.quantity).times(mark));
  }
  for (const i of commitments) {
    const symbol = normalizePoolSymbol(i.symbol);
    const live = !isTerminalIntentStatus(i.status);
    if (i.executeDate === executeDate) {
      dailyOrders++;
      turnover = turnover.plus(
        big(live ? i.quantity : i.filledQuantity).times(i.referencePrice),
      );
    }
    // No other run may spend anticipated sale proceeds or free up its exposure.
    if (!live || i.side !== "BUY") continue;
    const gross = big(i.quantity)
      .minus(i.filledQuantity)
      .times(i.referencePrice);
    if (gross.lte(0)) continue;
    const frozenAtVenue =
      venueBinding.kind !== "local_sim" &&
      (i.status === "submitted" || i.status === "partial_filled");
    if (!frozenAtVenue)
      cash = cash.minus(buyCost(symbol, i.executeDate, gross, i.maxGapPct));
    addExposure(symbol, gross);
    if (i.deploymentId === deployment.id)
      ownerValues.set(symbol, (ownerValues.get(symbol) ?? big(0)).plus(gross));
  }
  for (const [symbol, position] of [...positions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const weight = targets.get(symbol) ?? 0;
    const couldSell = targetMode
      ? targets.has(symbol) &&
        (weight === 0 || (Number.isFinite(equity) && equity > 0))
      : signals.get(symbol)?.action === "SELL";
    const mark = marks.get(symbol);
    if (!mark) {
      if (couldSell) skip(symbol, "SELL", "missing_reference_price");
      continue;
    }
    const value = big(position.quantity).times(mark);
    ownerValues.set(symbol, (ownerValues.get(symbol) ?? big(0)).plus(value));
    if (!couldSell) continue;
    const desired =
      weight === 0
        ? big(position.quantity)
        : value.minus(big(equity).times(weight)).div(mark);
    if (desired.lte(0)) continue;
    const pending = position.pendingSell ?? 0;
    const wanted = desired.minus(pending);
    const theoreticalQuantity =
      weight === 0 ? wanted.toNumber() : roundedQuantity(wanted, market);
    if (theoreticalQuantity > 0)
      theoreticalOrders.push({
        symbol,
        side: "SELL",
        theoreticalQuantity,
        referencePrice: mark,
      });
    const available = Math.min(position.quantity, position.executionSellable);
    const remaining = bigMin(desired.minus(pending), available);
    if (remaining.lte(0)) {
      skip(
        symbol,
        "SELL",
        pending > 0 && desired.lte(pending)
          ? "pending_sell"
          : (position.sellLimitReason ?? "t_plus_1_locked"),
      );
      continue;
    }
    if (intents.length + dailyOrders >= riskPolicy.maxDailyOrders) {
      skip(symbol, "SELL", "max_daily_orders");
      continue;
    }
    const quantity =
      weight === 0 ? remaining.toNumber() : roundedQuantity(remaining, market);
    if (quantity <= 0) {
      skip(symbol, "SELL", "below_min_lot");
      continue;
    }
    addIntent(symbol, 1, quantity, mark);
    if (remaining.lt(desired))
      clipped.push({
        symbol,
        side: "SELL",
        quantity,
        reasons: [
          ...new Set([
            ...(pending > 0 ? ["pending_sell"] : []),
            ...(remaining.lt(desired.minus(pending))
              ? [position.sellLimitReason ?? "t_plus_1_locked"]
              : []),
          ]),
        ],
      });
    const gross = big(quantity).times(mark);
    const costs = costsFor(symbol, executeDate);
    const estimated = gross.times(big(1).minus(riskPolicy.maxGapPct));
    const commission = estimated.times(costs.commissionBps).div(10000);
    cash = cash
      .plus(estimated)
      .minus(
        commission.gt(costs.minimumCommission)
          ? commission
          : costs.minimumCommission,
      )
      .minus(
        estimated
          .times(
            costs.sellTaxBps + costs.slippageBps + (costs.transferBps ?? 0),
          )
          .div(10000),
      )
      .minus(feeRounding);
    turnover = turnover.plus(gross);
    addExposure(symbol, gross.times(-1));
    ownerValues.set(symbol, ownerValues.get(symbol)!.minus(gross));
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
    const currentValue = ownerValues.get(symbol) ?? big(0);
    const requested = Number.isFinite(equity)
      ? big(equity).times(weight).minus(currentValue)
      : big(0);
    let referencePrice: number | null | undefined;
    let failedQuote: { error: unknown } | undefined;
    if (requested.gt(0) && (!positions.has(symbol) || marks.has(symbol))) {
      try {
        referencePrice =
          marks.get(symbol) ?? (await readPrice(symbol, decisionDate));
      } catch (error) {
        // A blocked order can be published without a theoretical size; an
        // otherwise executable order still needs to retry its failed quote.
        failedQuote = { error };
      }
      if (validPrice(referencePrice)) {
        const theoreticalQuantity = roundedQuantity(
          requested.div(referencePrice),
          market,
        );
        if (theoreticalQuantity > 0)
          theoreticalOrders.push({
            symbol,
            side: "BUY",
            theoreticalQuantity,
            referencePrice,
          });
      }
    }
    if (missingEvidence) {
      entriesBlocked = true;
      skip(symbol, "BUY", "risk-evidence-missing");
      continue;
    }
    if (equity <= 0) {
      skip(symbol, "BUY", "nonpositive_equity");
      continue;
    }
    if (requested.lte(0)) continue;
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
    if (intents.length + dailyOrders >= riskPolicy.maxDailyOrders) {
      skip(symbol, "BUY", "max_daily_orders");
      continue;
    }
    const costs = costsFor(symbol, executeDate);
    const cashRoom = cash.minus(feeRounding);
    const factor = big(1).plus(
      big(costs.slippageBps + (costs.transferBps ?? 0)).div(10000),
    );
    const spendingRoom = bigMin(
      cashRoom.div(factor.plus(big(costs.commissionBps).div(10000))),
      cashRoom.minus(costs.minimumCommission).div(factor),
    ).div(big(1).plus(riskPolicy.maxGapPct));
    const limits: [string, Amount][] = [
      [
        "instrument_cap",
        big(equity)
          .times(Math.min(riskPolicy.maxSymbolWeight, accountCaps?.symbol ?? 1))
          .times(entryScale)
          .minus(accountValues.get(symbol) ?? 0),
      ],
      [
        "total_exposure_cap",
        big(equity)
          .times(Math.min(riskPolicy.maxTotalExposure, accountCaps?.total ?? 1))
          .times(entryScale)
          .minus(exposure),
      ],
      [
        "daily_turnover_cap",
        big(equity).times(riskPolicy.maxDailyTurnover).minus(turnover),
      ],
      ["cash_cap", spendingRoom],
    ];
    if (entryScale < 1)
      limits.push([
        riskRegime === "reduced" ? "drawdown_reduced" : "regime_scale",
        big(equity).times(weight).times(entryScale).minus(currentValue),
      ]);
    for (const group of industries(symbol))
      limits.push([
        "industry_cap",
        big(equity)
          .times(defaultPortfolioRiskPolicy.maxIndustryWeight)
          .minus(industryValues.get(group) ?? 0),
      ]);
    const budget = bigMin(requested, ...limits.map(([, room]) => room));
    const reasons = [
      ...new Set(
        limits
          .filter(([, room]) => room.lt(requested))
          .map(([reason]) => reason),
      ),
    ];
    if (budget.lte(0)) {
      skip(symbol, "BUY", limits.find(([, room]) => room.eq(budget))![0]);
      continue;
    }
    if (failedQuote) throw failedQuote.error;
    if (!validPrice(referencePrice)) {
      skip(symbol, "BUY", "missing_reference_price");
      continue;
    }
    const quantity = roundedQuantity(budget.div(referencePrice), market);
    if (quantity <= 0) {
      skip(symbol, "BUY", "below_min_lot");
      if (reasons.length)
        clipped.push({ symbol, side: "BUY", quantity: 0, reasons });
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
    if (reasons.length)
      clipped.push({ symbol, side: "BUY", quantity, reasons });
    cash = cash.minus(
      buyCost(symbol, executeDate, gross, riskPolicy.maxGapPct),
    );
    addExposure(symbol, gross);
    turnover = turnover.plus(gross);
  }
  return {
    intents,
    entriesBlocked,
    riskVerdict: {
      regime: regimeVerdict,
      allowNewEntries,
      scope: "account",
      ...planningAccount(venueBinding),
      entryScale,
      maxGapPct: riskPolicy.maxGapPct,
      riskRegime: riskRegime ?? null,
      drawdownPct: Number.isFinite(drawdownPct) ? drawdownPct : null,
      theoreticalOrders,
      clipped,
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
  calendarWarning?: string | null;
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
  { stopAfterStage, calendarWarning, deps = {}, ...input }: PlanningInput,
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
  const { run, warning, sleeves } = new AccountWorkspaceRepository(db).atomic(
    () => {
      const { run, created } = getOrCreatePipelineRun(input, db);
      const saved = planningCalendarWarning(run.id, db);
      if (!saved && calendarWarning)
        appendExecutionAuditEvent(
          {
            deploymentId: deployment.id,
            runId: run.id,
            eventType: "execution_calendar_fallback",
            details: { executeDate: run.executeDate, warning: calendarWarning },
          },
          db,
        );
      return {
        run,
        warning: saved ?? calendarWarning ?? null,
        sleeves: plansAlreadyPublished.has(run.stage)
          ? []
          : freezePlanningSleeves(deployment, run, db, created),
      };
    },
  );
  const accountKey = JSON.stringify([
    db.name,
    planningAccount(deployment.venueBinding),
  ]);
  const previous = activePlanning.get(accountKey) ?? Promise.resolve();
  const planning = previous
    .catch(() => undefined)
    .then(() =>
      advancePipelinePlanning(
        getPipelineRun(run.id, db)!,
        deployment,
        stopAfterStage,
        sleeves,
        deps,
        db,
      ),
    );
  activePlanning.set(accountKey, planning);
  try {
    return { ...(await planning), calendarWarning: warning };
  } finally {
    if (activePlanning.get(accountKey) === planning)
      activePlanning.delete(accountKey);
  }
}

async function advancePipelinePlanning(
  run: PipelineRunRecord,
  deployment: DeploymentRecord,
  stopAfterStage: PlanningInput["stopAfterStage"],
  sleeves: ReturnType<typeof freezePlanningSleeves>,
  deps: PipelinePlanningDeps,
  db: Database.Database,
) {
  const result = () => {
    const signals = run.signals;
    const skipReason =
      signals && typeof signals === "object" && !Array.isArray(signals)
        ? signals.skipReason
        : undefined;
    return {
      run,
      intents: listIntentsByRun(run.id, db),
      ...(skipReason === "missing-data" || skipReason === "non-rebalance-day"
        ? { skipReason }
        : {}),
    };
  };
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
    const pool = parseEvaluatedPoolSnapshot(universeSnapshot);
    const binding = deployment.venueBinding;
    const readFacts = () =>
      readPlanningFacts(
        deployment,
        decisionDate,
        executeDate,
        db,
        run.startedAt,
        sleeves,
      );
    const readState = async (): Promise<PipelineAccountState> => {
      const state = deps.readAccountState
        ? await deps.readAccountState(
            binding,
            decisionDate,
            db,
            ...(binding.kind === "local_sim" ? [run.startedAt] : []),
          )
        : binding.kind === "local_sim"
          ? await readLocalSimAccountState(
              binding.simAccountId,
              decisionDate,
              db,
              referencePrice,
              executeDate,
              run.startedAt,
            )
          : null;
      // Keep absent monetary evidence distinct from zero until the verdict is published.
      return (
        state ?? { cash: NaN, equity: NaN, drawdownPct: null, positions: [] }
      );
    };
    let facts = readFacts();
    let decisionState: PipelineAccountState | undefined;

    if (run.signals === null) {
      const symbols = new Set(pool.activeSymbols);
      const activePoolEntries = getActivePoolEntries(deployment.id, db).filter(
        (entry) =>
          symbols.has(entry.symbol) && entry.lastCheckedDate === decisionDate,
      );
      if (activePoolEntries.length !== symbols.size)
        throw new Error("监控池已改变，无法恢复当前决策日的信号计算");
      decisionState = await readState();
      const held = new Set(
        (decisionState.positions ?? [])
          .filter((p) => Number.isFinite(p.quantity) && p.quantity > 0)
          .map((p) => normalizePoolSymbol(p.symbol)),
      );
      const signals = await evaluateDeploymentStrategy({
        deployment,
        decisionDate,
        activePoolEntries,
        heldSymbols: facts.ownedSleeves
          .map((row) => normalizePoolSymbol(row.symbol))
          .filter((symbol) => held.has(symbol)),
        universeSkipReason: pool.skipReason,
        deps: { readBars, ...deps.strategy },
        db,
      });
      run = checkpoint({ stage: "signals_done", signals });
    }
    if (plansAlreadyPublished.has(run.stage) || stopAfterStage === "signals")
      return result();
    const proposal = evaluatedStrategyProposalSchema.parse(run.signals);
    if (proposal.skipReason) {
      run = checkpoint({
        stage: "completed",
        finishedAt: Date.now(),
        riskVerdict: {
          scope: "account",
          ...planningAccount(binding),
          skipReason: proposal.skipReason,
          allowNewEntries: false,
          reasons: [proposal.skipReason],
          skipped: [],
        },
      });
      return result();
    }
    let accountState = decisionState ?? (await readState());
    const regimeVerdict = await evaluateRegimeGate(
      deployment.regimeGate,
      decisionDate,
      {
        readBars: deps.universe?.readBars ?? readBars,
        ...deps.regime,
      },
    );
    const groups =
      deployment.market === "cn-equity" && !deps.readIndustries
        ? decisionIndustries(decisionDate, db)
        : null;
    for (;;) {
      const plan = await planOrderIntents({
        deployment,
        accountCaps: facts.accountCaps,
        run,
        proposal,
        accountState,
        ownerPositions: ownedPlanningPositions(deployment, accountState, facts),
        commitments: facts.commitments,
        regimeVerdict,
        deps: {
          readReferencePrice: referencePrice,
          checkUnlockEvents: deps.checkUnlockEvents,
          readIndustries:
            deps.readIndustries ?? ((symbol) => groups?.get(symbol) ?? []),
        },
      });

      const published = workspace.atomic(() => {
        const current = currentRun();
        if (!isDeepStrictEqual(current, run)) {
          run = current;
          return result();
        }
        // Another process can publish or settle during asynchronous pricing.
        if (!isDeepStrictEqual(readFacts(), facts)) return null;
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
            riskVerdict: {
              ...plan.riskVerdict,
              unattributedPositions: (accountState.positions ?? []).flatMap(
                (p) => {
                  if (!Number.isFinite(p.quantity) || p.quantity <= 0)
                    return [];
                  const owned = facts.sleeves
                    .filter(
                      (s) =>
                        normalizePoolSymbol(s.symbol) ===
                        normalizePoolSymbol(p.symbol),
                    )
                    .reduce((sum, s) => sum.plus(s.quantity), big(0));
                  const residual = big(p.quantity).minus(owned);
                  return residual.gt(0)
                    ? [
                        {
                          symbol: p.symbol,
                          quantity: residual.toNumber(),
                          ownerKind: "legacy_unknown",
                        },
                      ]
                    : [];
                },
              ),
            },
            errorSummary: null,
            finishedAt: stage === "risk_checked" ? null : Date.now(),
          },
          db,
        );
        run = updated;
        return result();
      });
      if (published) return published;
      facts = readFacts();
      accountState = await readState();
    }
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : String(error);
    checkpoint({ stage: "failed", errorSummary, finishedAt: Date.now() });
    throw error;
  }
}
