import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { type HoldingRiskSnapshot } from "../workspace";
import { systemWatch, type AlertInputContext } from "./context";
import { type Exposure, type HoldingInputs } from "./holdings";

export function projectAllocation(
  ctx: AlertInputContext,
  holdings: HoldingInputs,
) {
  const { phase, now, repo, config, market, result, propose } = ctx;
  const { exposure, holdingRisks, exposureComplete } = holdings;
  if (exposureComplete) {
    result.states.push({
      id: "holding-risk",
      value: [
        ...(repo.state<HoldingRiskSnapshot[]>("holding-risk") ?? []).filter(
          (h) => h.market !== market,
        ),
        ...holdingRisks,
      ],
    });
    const other = (repo.state<Exposure[]>("exposure") ?? []).filter(
      (e) => e.market !== market,
    );
    // Empty positions are a known zero; the marker also proves this market was checked.
    result.states.push({
      id: "exposure",
      value: [
        ...other,
        ...exposure,
        { market, sleeve: "__checked__", value: 0, at: now },
      ],
    });
    if (phase === "close")
      result.states.push({
        id: "exposure-close:cn-equity",
        value: [
          ...exposure,
          { market, sleeve: "__checked__", value: 0, at: now },
        ],
      });
    const capital = config.alerts.capital[market];
    for (const sleeve of config.alerts.sleeves.filter(
      (s) => s.market === market && capital > 0,
    )) {
      const actual =
        exposure
          .filter((e) => e.sleeve === sleeve.id)
          .reduce((n, e) => n + e.value, 0) / capital;
      const outside = Math.abs(actual - sleeve.share) >= 0.1;
      const key = `allocation:${market}:${sleeve.id}`;
      const previous = repo.state<boolean>(key);
      result.states.push({ id: key, value: outside });
      if (outside && previous !== true) {
        const strategy = systemWatch(
          `allocation-${market}-${sleeve.id}`,
          market,
          `sleeve:${sleeve.id}`,
          sleeve.id,
        );
        propose(
          strategy,
          `sleeve:${sleeve.id}`,
          new Date(now).toISOString(),
          "allocation",
          null,
          `分仓市值/配置总资金=${displayNumber(actual * 100, 2)}%，目标${displayNumber(sleeve.share * 100, 2)}%；偏离至少10个百分点。持仓默认归swing，可显式分配`,
          "本地持仓与用户配置资金；不含未登记外部持仓",
          now,
        );
      }
    }
  }
}
