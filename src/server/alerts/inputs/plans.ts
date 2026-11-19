import { systemWatch, digest, type AlertInputContext } from "./context";

export async function evaluatePlanInputs(ctx: AlertInputContext) {
  const { phase, now, repo, market, result, series, error, propose } = ctx;
  for (const plan of repo
    .plans(true)
    .filter(
      (p) =>
        p.market === market ||
        (!p.market &&
          repo.strategies.strategy(p.strategyId, p.strategyVersion)?.market ===
            market),
    )) {
    if (plan.expiresAt && Date.parse(plan.expiresAt) <= now) continue;
    try {
      const data = await series(plan.symbol, phase === "close" ? "day" : "5m");
      const bar = data.bars.at(-1);
      if (
        !bar ||
        (plan.createdAt && data.completedAt(bar.date) <= plan.createdAt)
      )
        continue;
      const stages = plan.stages ?? [
        { entry: plan.entry, quantity: plan.quantity ?? 0 },
      ];
      const triggered = repo.state<number[]>(`plan-stages:${plan.id}`) ?? [];
      const next = [...triggered];
      for (const [i, stage] of stages.entries()) {
        if (next.includes(i) || bar.close < stage.entry) continue;
        next.push(i);
        const strategy = systemWatch(
          `plan-stage-${digest([plan.id, i])}`,
          market,
          plan.symbol,
          plan.sleeve,
        );
        propose(
          strategy,
          plan.symbol,
          bar.date,
          "plan-entry",
          bar.close,
          `计划${plan.id}第${i + 1}档收盘达到${stage.entry}，参考数量${stage.quantity}；须人工核对，不下单`,
          data.source,
          data.completedAt(bar.date),
          { planId: plan.id, stop: plan.stop, target: plan.target },
        );
        result.proposals.at(-1)!.authorize = () =>
          repo.strategies.plan(plan.id)?.status === "open";
        if (next.length === stages.length)
          result.proposals.at(-1)!.closePlan = "triggered";
      }
      result.states.push({ id: `plan-stages:${plan.id}`, value: next });
    } catch (e) {
      error(plan.symbol, e);
    }
  }
}
