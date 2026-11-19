import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { historicalLowSeries } from "trading-strategies";
import { regimeObservation } from "../observations";
import { systemWatch, type AlertInputContext } from "./context";

export async function evaluateRegime(
  ctx: AlertInputContext,
  hasStrategies: boolean,
  hasBots: boolean,
) {
  const { phase, now, repo, config, market, result, series, error, propose } =
    ctx;
  const regimeEnabled =
    market === "cn-equity"
      ? phase === "close" && !!config.tdxRoot
      : hasStrategies ||
        hasBots ||
        repo.subscriptions().some((s) => s.enabled && s.market === "crypto");
  if (regimeEnabled)
    for (const symbol of market === "crypto"
      ? ["BTCUSDT", "ETHUSDT"]
      : ["sh000300", "sz399006"]) {
      try {
        const data = await series(symbol, market === "crypto" ? "4h" : "day");
        const bar = data.bars.at(-1);
        const regime = regimeObservation(data.bars);
        if (!regime || !bar) continue;
        const key = `regime:${market}:${symbol}`;
        const previous = repo.state<ReturnType<typeof regimeObservation>>(key);
        result.states.push({
          id: key,
          value: {
            ...regime,
            bar: bar.date,
            source: data.source,
            observedAt: now,
            ...(market === "cn-equity"
              ? { low: historicalLowSeries(data.bars).at(-1) }
              : {}),
          },
        });
        if (
          previous &&
          (previous.trend !== regime.trend || previous.zone !== regime.zone)
        ) {
          const strategy = systemWatch(
            `regime-${market}-${symbol}`,
            market,
            symbol,
          );
          propose(
            strategy,
            symbol,
            bar.date,
            "regime",
            bar.close,
            `${previous.trend}/${previous.zone} → ${regime.trend}/${regime.zone}，温度${displayNumber(regime.temperature, 1)}；${regime.basis}`,
            data.source,
            data.completedAt(bar.date),
          );
        }
      } catch (e) {
        error(symbol, e);
      }
    }
}
