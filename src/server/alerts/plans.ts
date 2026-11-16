import { randomUUID } from "node:crypto";
import Big from "big.js";
import { z } from "zod";
import { marketRules } from "trading-strategy-core/market-rules";
import type { Settings } from "~/lib/domain";
import { planExposure } from "./plan-exposure";
import { AlertRepository } from "../db/alert-repository";
import {
  checkExposureCaps,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";

export const createAlertPlanSchema = z.object({
  overrideCaps: z.boolean().default(false),
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
    );
    if (config.accountReview.caps.length && !admission)
      throw new Error("敞口检查缺少完整账户事实，请刷新后重试");
    const positions = admission?.positions ?? [];
    const industry =
      admission?.industry?.(plan.symbol) ??
      positions.find(
        (p) => p.market === plan.market && p.symbol === plan.symbol,
      )?.industry ??
      "未知";
    const violations = checkExposureCaps({
      positions,
      proposed: {
        market: plan.market,
        symbol: plan.symbol,
        sleeve: plan.sleeve,
        industry,
        value: plan.stages.reduce((n, s) => n + s.entry * s.quantity, 0),
      },
      reserved: repository
        .plans(true)
        .filter((p) => p.market !== undefined)
        .map((p) => ({
          market: p.market!,
          symbol: p.symbol,
          sleeve: p.sleeve,
          industry:
            positions.find(
              (row) => row.market === p.market && row.symbol === p.symbol,
            )?.industry ?? "未知",
          value:
            p.stages?.reduce((n, s) => n + s.entry * s.quantity, 0) ??
            p.entry * (p.quantity ?? 0),
        })),
      capital: config.alerts.capital,
      caps: config.accountReview.caps,
    });
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
          caps: config.accountReview.caps,
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
) {
  const event = repository.event(input.eventKey);
  if (!event || event.status === "missed" || event.type !== "entry")
    throw new Error("只能从有效入场候选加入计划");
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
  const sleeve = config.alerts.sleeves.find(
    (s) => s.id === event.sleeve && s.market === event.market,
  );
  const equity = config.alerts.capital[event.market];
  if (!sleeve || !equity || !sleeve.share)
    throw new Error("请先配置该分仓资金和目标份额");
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
          p.entry * (p.quantity ?? 0)),
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
          p.entry * (p.quantity ?? 0)),
      0,
    );
  const unassignedValue = actualPositions
    ? actualPositions
        .filter((p) => p.sleeve === "未知")
        .reduce((n, p) => n + p.value!, 0)
    : usage.filter((u) => u.sleeve === "未知").reduce((n, u) => n + u.value, 0);
  const budget = Math.max(
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
  const perStageBudget = budget / input.stages.length;
  const perStageRisk =
    (equity * sleeve.share * sleeve.risk) / input.stages.length;
  const stages = input.stages.map((entry) => {
    const raw = Math.min(
      perStageBudget / entry,
      perStageRisk / (entry - input.stop),
    );
    const quantity = Number(
      new Big(raw).div(step).round(0, 0).times(step).toFixed(),
    );
    if (quantity < minimum)
      throw new Error("剩余额度或风险预算不足最小交易数量");
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
    entry: stages[0]!.entry,
    tranches: stages.length,
    quantity: stages.reduce((n, s) => n + s.quantity, 0),
    stages,
    stop: input.stop,
    target: input.target,
    expiresAt: input.expiresAt,
    status: "open" as const,
    createdAt: now,
    positionSnapshot: {
      at: snapshot.at!,
      basis: snapshot.basis,
      unassignedValue,
    },
    ...(input.quantityRules ? { quantityRules: input.quantityRules } : {}),
  };
  return plan;
}
