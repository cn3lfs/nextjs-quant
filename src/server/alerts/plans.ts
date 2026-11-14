import { randomUUID } from "node:crypto";
import Big from "big.js";
import { z } from "zod";
import { marketRules } from "trading-strategy-core/market-rules";
import type { Settings } from "~/lib/domain";
import { AlertRepository } from "../db/alert-repository";

export const createAlertPlanSchema = z.object({
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
  input: z.infer<typeof createAlertPlanSchema>,
  config: Settings,
  now: number,
  repository = new AlertRepository(),
) {
  return repository.atomic(() => {
    const event = repository.event(input.eventKey);
    if (!event || event.status === "missed" || event.type !== "entry")
      throw new Error("只能从有效入场候选加入计划");
    if (Date.parse(input.expiresAt) <= now)
      throw new Error("计划到期时间必须在未来");
    if (
      input.stages.some(
        (price) =>
          price <= input.stop ||
          (input.target !== null && input.target <= price),
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
    const usage =
      repository.state<
        { market: string; sleeve: string; value: number; at: number }[]
      >("exposure");
    if (
      !usage?.some(
        (u) => u.market === event.market && u.sleeve === "__checked__",
      ) ||
      usage.some((u) => u.market === event.market && now - u.at > 10 * 60000)
    )
      throw new Error("持仓额度未完成核对或已过期，请等待提醒引擎更新");
    const invested = usage
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
    const budget = Math.max(0, equity * sleeve.share - invested - reserved);
    const step =
      marketRules[event.market].quantity.step ?? input.quantityRules?.step;
    const minimum =
      marketRules[event.market].quantity.minimum ??
      input.quantityRules?.minimum;
    if (!step || !minimum)
      throw new Error("缺少平台数量步长依据，不计算假数量");
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
      ...(input.quantityRules ? { quantityRules: input.quantityRules } : {}),
    };
    return repository.savePlan(plan, now);
  });
}
