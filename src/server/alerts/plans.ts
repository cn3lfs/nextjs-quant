import { randomUUID } from "node:crypto";
import Big from "big.js";
import { planJournalSchema } from "~/lib/portfolio/account-review";
import {
  sizePortfolioEntry,
  sizePortfolioTargetEntry,
  portfolioExecutionFee,
} from "quant-backtest";
import { planSizingPolicy } from "./plan-sizing";
import { z } from "zod";
import { marketRules } from "trading-strategy-core/market-rules";
import type { Settings } from "~/lib/domain";
import { planExposure } from "./plan-exposure";
import { AlertRepository } from "../db/alert-repository";
import {
  checkExposureCaps,
  effectiveExposureCaps,
  industryGroupsFor,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";

import {
  effectiveMarketCapital,
  universalMarketSleeve,
  type AlertEvent,
} from "~/lib/strategy-facts/alerts";
import type { Period, Snapshot } from "~/lib/domain";
import { screenDataHealth } from "../market/data-health";
import {
  candidateScanFreshness,
  type CandidateScanState,
} from "./candidate-scan";

type CandidateEvidence = AlertEvent & {
  freshness?: "fresh-close" | "intraday" | "stale" | "unverified";
  scanFreshness?: "current" | "intraday" | "stale" | "unknown" | null;
  signalPrice?: number | null;
  signalPriceBasis?: Snapshot["adjustment"] | null;
  executionRawPrice?: number | null;
};
type CloseReference = { closeDate: string | null; calendar: readonly string[] };
export function evaluateCandidatePlanEligibility(
  event: CandidateEvidence,
  scan?: CandidateScanState,
  period?: Period,
  reference?: CloseReference,
) {
  let freshness =
    event.freshness ??
    (event.scanFreshness === "current"
      ? "fresh-close"
      : event.scanFreshness === "intraday"
        ? "intraday"
        : "unverified");
  if (event.scanFreshness === "stale") freshness = "stale";
  if (freshness !== "stale" && scan && period) {
    if (scan.bar && Date.parse(event.bar) < Date.parse(scan.bar))
      freshness = "stale";
    else if (
      event.market === "cn-equity" &&
      reference &&
      scan.bar === event.bar
    ) {
      const status = candidateScanFreshness(scan, period, reference);
      freshness =
        status === "current"
          ? "fresh-close"
          : status === "unknown"
            ? "unverified"
            : status;
    } else if (period !== "day" && period !== "week") freshness = "intraday";
  }
  const raw =
    event.executionRawPrice === undefined
      ? event.firstWatchPayload
        ? (event.confirmation?.price ?? null)
        : event.price
      : event.executionRawPrice;
  return {
    freshness,
    signalPrice: event.signalPrice ?? (event.market === "crypto" ? raw : null),
    signalPriceBasis:
      event.signalPriceBasis ?? (event.market === "crypto" ? "none" : null),
    executionRawPrice: raw,
  };
}

export function storedCandidateEligibility(
  event: AlertEvent,
  repo: AlertRepository,
  reference?: CloseReference,
  now = Date.now(),
) {
  const scan = repo.state<CandidateScanState>(
    `candidate-scan:${event.market}:${event.strategyId}:${event.version}`,
  );
  if (!reference && scan && event.market === "cn-equity") {
    const calendar = repo.records.days();
    reference = {
      calendar,
      closeDate: screenDataHealth(null, "day", now, {
        days: calendar,
        source: "已记录的交易日历",
        hash: null,
      }).referenceAsOf,
    };
  }
  return evaluateCandidatePlanEligibility(
    event,
    scan,
    scan?.period ??
      repo.strategies.strategy(event.strategyId, event.version)?.period,
    reference,
  );
}
export const createAlertPlanSchema = z.object({
  allowStale: z.boolean().optional(),
  ...planJournalSchema.shape,
  overrideCaps: z.boolean().default(false),
  overrideSizing: z
    .object({
      confirmed: z.literal(true),
      reason: z.string().trim().min(1).max(500),
      quantities: z
        .array(z.number().finite().positive())
        .min(1)
        .max(100)
        .optional(),
    })
    .strict()
    .optional(),
  eventKey: z.string().min(1).max(1000),
  stages: z.array(z.number().finite().positive()).min(1).max(10),
  stop: z.number().finite().positive(),
  target: z.number().finite().positive().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  // Exchange step is evidence supplied explicitly, never a guessed decimal lot.
  quantityRules: z
    .object({
      step: z.number().finite().positive(),
      minimum: z.number().finite().positive(),
      source: z.string().min(1).max(200),
    })
    .optional(),
});
export function createAlertPlan(
  input: z.input<typeof createAlertPlanSchema>,
  config: Settings,
  now: number,
  repository = new AlertRepository(),
  admission?: {
    positions: readonly AccountPosition[];
    industry?: (symbol: string) => string;
    industryGroups?: (symbol: string) => readonly string[];
    industrySource?: {
      hash: string;
      basis: "current-labelled";
      grouping: "all-known-groups";
    } | null;
    closeReference?: CloseReference;
    assertCurrent: () => void;
  },
) {
  return repository.atomic(() => {
    admission?.assertCurrent();
    const plan = previewAlertPlan(
      input,
      config,
      now,
      repository,
      admission?.positions,
      admission?.closeReference,
    );
    const caps = effectiveExposureCaps(config.accountReview, plan.market);
    if (caps.length && !admission)
      throw new Error("敞口检查缺少完整账户事实，请刷新后重试");
    const positions = admission?.positions ?? [];
    const industry =
      admission?.industry?.(plan.symbol) ??
      positions.find(
        (p) => p.market === plan.market && p.symbol === plan.symbol,
      )?.industry ??
      "未知";
    const capInput: Parameters<typeof checkExposureCaps>[0] = {
      positions,
      proposed: {
        market: plan.market,
        symbol: plan.symbol,
        sleeve: plan.sleeve,
        industry,
        ...(admission?.industryGroups
          ? { industryGroups: admission.industryGroups(plan.symbol) }
          : {}),
        value: plan.stages.reduce((n, s) => n + s.entry * s.quantity, 0),
        openRisk: plan.stages.reduce(
          (n, s) => n + Math.max(0, s.entry - plan.stop) * s.quantity,
          0,
        ),
        maxPositions: plan.sizingAudit.maxPositions,
      },
      reserved: repository
        .plans(true)
        .filter((p) => p.market !== undefined)
        .map((p) => ({
          market: p.market!,
          symbol: p.symbol,
          sleeve: p.sleeve,
          industry:
            admission?.industry?.(p.symbol) ??
            positions.find(
              (row) => row.market === p.market && row.symbol === p.symbol,
            )?.industry ??
            "未知",
          ...(admission?.industryGroups
            ? { industryGroups: admission.industryGroups(p.symbol) }
            : {}),
          openRisk:
            p.stop === null
              ? null
              : (p.stages?.reduce(
                  (n, s) => n + Math.max(0, s.entry - p.stop!) * s.quantity,
                  0,
                ) ?? Math.max(0, p.entry - p.stop) * (p.quantity ?? 0)),
          value:
            p.stages?.reduce((n, s) => n + s.entry * s.quantity, 0) ??
            p.entry * (p.quantity ?? 0),
        })),
      capital: {
        "cn-equity": effectiveMarketCapital(config.alerts, "cn-equity"),
        crypto: effectiveMarketCapital(config.alerts, "crypto"),
      },
      caps,
    };
    const violations = checkExposureCaps(capInput);
    if (violations.length && !input.overrideCaps)
      throw new Error(
        `敞口超限：${violations.map((v) => `${v.dimension}/${v.key}：${v.reason}（计划后${v.used ?? "未知"}，上限${v.limit}）`).join("；")}。核对后可明确选择仍然创建。`,
      );
    return repository.savePlan(
      {
        ...plan,
        exposureAudit: {
          at: now,
          overridden: violations.length > 0 && input.overrideCaps === true,
          violations,
          caps,
          industryGroups: {
            source: admission?.industrySource ?? null,
            proposed: {
              market: plan.market,
              symbol: plan.symbol,
              groups: industryGroupsFor(capInput.proposed),
            },
            reserved: (capInput.reserved ?? []).map((p) => ({
              market: p.market,
              symbol: p.symbol,
              groups: industryGroupsFor(p),
            })),
          },
        },
      },
      now,
    );
  });
}
/** Same admission and sizing as create, without persisting a plan. */
export function previewAlertPlan(
  input: z.input<typeof createAlertPlanSchema>,
  config: Settings,
  now: number,
  repository = new AlertRepository(),
  positions?: readonly AccountPosition[],
  reference?: CloseReference,
) {
  input = createAlertPlanSchema.parse(input);
  const event = repository.event(input.eventKey);
  if (!event || event.status === "missed" || event.type !== "entry")
    throw new Error("只能从有效入场候选加入计划");
  if (
    storedCandidateEligibility(event, repository, reference, now).freshness ===
      "stale" &&
    !input.allowStale
  )
    throw new Error(
      "该候选来自已过期的历史扫描批次，请选择当前批次，或明确允许使用历史候选后再创建计划",
    );
  if (Date.parse(input.expiresAt) <= now)
    throw new Error("计划到期时间必须在未来");
  if (
    input.stages.some(
      (price) =>
        price <= input.stop || (input.target !== null && input.target <= price),
    )
  )
    throw new Error("止损须低于每档入场价，目标须高于入场价");
  if (repository.plans(true).some((p) => p.triggerKey === input.eventKey))
    throw new Error("该候选已有未完成计划");
  const sleeve = universalMarketSleeve(
    config.alerts,
    event.market,
    event.sleeve,
  );
  const equity = effectiveMarketCapital(config.alerts, event.market);
  const snapshot = planExposure(event.market, config, now, repository);
  const usage = snapshot.usage;
  if (!snapshot.valid)
    throw new Error("持仓额度未完成核对或已过期，请等待提醒引擎更新");
  const actualPositions = positions?.filter(
    (p) => p.kind === "real" && p.market === event.market,
  );
  if (actualPositions?.some((p) => p.value === null))
    throw new Error("真实持仓估值未核对，不能计算剩余计划预算；请先核对持仓");
  const invested = actualPositions
    ? actualPositions
        .filter((p) => p.sleeve === event.sleeve)
        .reduce((n, p) => n + p.value!, 0)
    : usage
        .filter((u) => u.market === event.market && u.sleeve === event.sleeve)
        .reduce((n, u) => n + u.value, 0);
  const reserved = repository
    .plans(true)
    .filter((p) => p.market === event.market && p.sleeve === event.sleeve)
    .reduce(
      (n, p) =>
        n +
        (p.stages?.reduce((v, s) => v + s.entry * s.quantity, 0) ??
          p.entry * (p.quantity ?? 0)) +
        (p.sizingAudit?.estimatedFees ?? 0),
      0,
    );
  const marketInvested = actualPositions
    ? actualPositions.reduce((n, p) => n + p.value!, 0)
    : usage
        .filter((u) => u.sleeve !== "__checked__")
        .reduce((n, u) => n + u.value, 0);
  const marketReserved = repository
    .plans(true)
    .filter((p) => p.market === event.market)
    .reduce(
      (n, p) =>
        n +
        (p.stages?.reduce((v, s) => v + s.entry * s.quantity, 0) ??
          p.entry * (p.quantity ?? 0)) +
        (p.sizingAudit?.estimatedFees ?? 0),
      0,
    );
  const unassignedValue = actualPositions
    ? actualPositions
        .filter((p) => p.sleeve === "未知")
        .reduce((n, p) => n + p.value!, 0)
    : usage.filter((u) => u.sleeve === "未知").reduce((n, u) => n + u.value, 0);
  let budget = Math.max(
    0,
    Math.min(
      equity * sleeve.share - invested - reserved,
      equity - marketInvested - marketReserved,
    ),
  );
  const step =
    marketRules[event.market].quantity.step ?? input.quantityRules?.step;
  const minimum =
    marketRules[event.market].quantity.minimum ?? input.quantityRules?.minimum;
  if (!step || !minimum) throw new Error("缺少平台数量步长依据，不计算假数量");
  const strategy = repository.strategies.strategy(
    event.strategyId,
    event.version,
  );
  if (!strategy) throw new Error("缺少同版本策略定义");
  const policy = planSizingPolicy(strategy, event, config, repository);
  if (policy.bookSizing?.marketTargetShare !== undefined)
    budget = Math.min(
      budget,
      Math.max(
        0,
        equity * sleeve.share * policy.bookSizing.marketTargetShare -
          invested -
          reserved,
      ),
    );
  if (policy.bookSizing && !actualPositions)
    throw new Error(
      "组合目标计划需要真实同版本持仓快照，不能只用分仓汇总推算新增数量",
    );
  const confirmed = input.overrideSizing?.confirmed === true;
  const expectedTranches = strategy.sizing.tranches ?? 1;
  const initialStop =
    strategy.exit.stop?.kind === "fixed"
      ? input.stages[0]! * (1 - strategy.exit.stop.fraction)
      : event.stop;
  const initialTarget =
    strategy.exit.takeProfit === undefined
      ? null
      : input.stages[0]! * (1 + strategy.exit.takeProfit);
  const changed =
    input.stages.length !== expectedTranches ||
    initialStop === null ||
    Math.abs(initialStop - input.stop) > 1e-8 ||
    initialTarget !== input.target;
  if ((changed || input.overrideSizing?.quantities) && !confirmed)
    throw new Error("计划档数或保护位偏离策略；请明确确认仓位覆盖并填写原因");
  if (
    input.overrideSizing?.quantities &&
    input.overrideSizing.quantities.length !== input.stages.length
  )
    throw new Error("覆盖数量须与计划档位一一对应");
  let cash = budget;
  const held =
    actualPositions?.filter(
      (p) =>
        p.symbol === event.symbol &&
        p.sleeve === event.sleeve &&
        (!policy.bookSizing ||
          (p.strategyId === event.strategyId &&
            p.strategyVersion === event.version)),
    ) ?? [];
  if (
    policy.bookSizing &&
    actualPositions?.some(
      (p) =>
        p.symbol === event.symbol &&
        p.sleeve === event.sleeve &&
        p.strategyId === null,
    )
  )
    throw new Error("同标的真实持仓尚未归属策略，不能认证组合目标增仓差额");
  if (held.some((p) => p.cost === null || p.stop === null))
    throw new Error("同标的既有持仓缺少成本或止损依据，不能计算剩余风险");
  let existing = held.length
    ? {
        quantity: held.reduce((n, p) => n + p.quantity, 0),
        cost:
          held.reduce((n, p) => n + p.quantity * p.cost!, 0) /
          held.reduce((n, p) => n + p.quantity, 0),
        stop: Math.min(...held.map((p) => p.stop!)),
      }
    : undefined;
  const expectedQuantities: number[] = [];
  let estimatedFees = 0;
  const stages = input.stages.map((entry, index) => {
    const context = {
      sizing: strategy.rebalance
        ? { kind: "weight" as const, weight: policy.weightCeiling, tranches: 1 }
        : { ...strategy.sizing, tranches: input.stages.length },
      equity: equity * sleeve.share,
      cash,
      price: entry,
      stop: input.stop,
      riskPerTrade: policy.riskPerTrade,
      weightCeiling: policy.weightCeiling,
      existing,
      quantityRules: { step, minimum, maximum: 1e12 },
      costs: policy.costs,
    };
    const sized = policy.bookSizing
      ? sizePortfolioTargetEntry({
          ...context,
          targetWeight: policy.bookSizing.targetWeight,
        })
      : sizePortfolioEntry(context);
    expectedQuantities.push(sized.quantity);
    const quantity =
      input.overrideSizing?.quantities?.[index] ?? sized.quantity;
    if (quantity < minimum || !new Big(quantity).mod(step).eq(0))
      throw new Error("剩余额度或风险预算不足最小交易数量或数量不在交易网格");
    if (input.overrideSizing?.quantities) {
      const hardLimit = sizePortfolioEntry({
        ...context,
        sizing: { kind: "weight", weight: 1, tranches: 1 },
        weightCeiling: 1,
      });
      if (quantity > hardLimit.quantity)
        throw new Error("覆盖数量超过现金或风险硬约束");
    }
    const fee = portfolioExecutionFee(quantity, entry, "buy", policy.costs);
    estimatedFees += fee;
    cash -= quantity * entry + fee;
    const oldQuantity = existing?.quantity ?? 0;
    existing = {
      quantity: oldQuantity + quantity,
      cost:
        ((existing?.cost ?? 0) * oldQuantity + quantity * entry + fee) /
        (oldQuantity + quantity),
      stop: input.stop,
    };
    return { entry, quantity };
  });
  const plan = {
    id: `plan-${randomUUID()}`,
    strategyId: event.strategyId,
    strategyVersion: event.version,
    symbol: event.symbol,
    market: event.market,
    sleeve: event.sleeve,
    triggerKey: event.key,
    rationale: input.rationale ?? "",
    tags: input.tags ?? [],
    entry: stages[0]!.entry,
    tranches: stages.length,
    quantity: stages.reduce((n, s) => n + s.quantity, 0),
    stages,
    stop: input.stop,
    target: input.target,
    expiresAt: input.expiresAt,
    status: "open" as const,
    createdAt: now,
    sizingAudit: {
      source: policy.source,
      validated:
        policy.validated &&
        !changed &&
        input.overrideSizing?.quantities === undefined,
      scheme: policy.scheme,
      riskPerTrade: policy.riskPerTrade,
      maxPositions: policy.maxPositions,
      weightCeiling: policy.weightCeiling,
      ...(policy.bookSizing
        ? {
            bookSizing: {
              ...policy.bookSizing,
              actualHeldQuantity: held.reduce((n, p) => n + p.quantity, 0),
              // The required numeric audit field sums only verified valuations.
              // The market-wide guard above rejects null before sizing. An empty holding sums to zero.
              actualHeldValue: held.reduce((n, p) => n + p.value!, 0),
            },
          }
        : {}),
      signalDate: event.bar,
      budget,
      expectedQuantities,
      actualQuantities: stages.map((s) => s.quantity),
      estimatedFees,
      overridden: changed || input.overrideSizing?.quantities !== undefined,
      reason: confirmed ? input.overrideSizing!.reason : null,
      at: now,
    },
    protection: {
      version: "plan-protection-1" as const,
      exitSpec: strategy.exit,
      initialStop: input.stop,
      target: input.target,
      entryReference: stages[0]!.entry,
      asOf: event.bar,
      matchesStrategy: !changed,
      overrideReason: changed ? input.overrideSizing!.reason : null,
      initialStopEvidence: {
        bar: event.bar,
        source: event.source,
        level: event.stop,
      },
    },
    positionSnapshot: {
      at: snapshot.at!,
      basis: snapshot.basis,
      unassignedValue,
    },
    ...(input.quantityRules ? { quantityRules: input.quantityRules } : {}),
  };
  return plan;
}
