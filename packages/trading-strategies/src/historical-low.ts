import { z } from "zod";
import type { Bar } from "trading-strategy-core/bars";

export const historicalLowConfigSchema = z
  .object({
    years: z.number().int().min(5).max(10).default(10),
    minimumBars: z.number().int().min(1000).default(1000),
    recoveryPercentile: z.number().min(0.4).max(1).default(0.6),
  })
  .strict();
export type LowZoneFact = {
  date: string;
  availableAt: string;
  pe: number | null;
  pb: number | null;
  temperature: number | null;
  source: string;
  confidence: "verified" | "approximate";
};
export type LowZoneComponent = {
  value: number | null;
  confidence: "verified" | "approximate" | "missing";
  observations: number;
  reason: string;
};
export type LowZoneObservation = {
  date: string;
  depth: 0 | 1 | 2 | 3 | null;
  targetShare: number;
  recovery: boolean | null;
  confidence: "price-only" | "corroborated" | "insufficient";
  price: LowZoneComponent;
  drawdown: LowZoneComponent;
  pe: LowZoneComponent;
  pb: LowZoneComponent;
  temperature: LowZoneComponent;
};
const rank = (values: readonly number[], current: number) =>
  values.filter((value) => value <= current).length / values.length;
const missing = (reason: string, observations = 0): LowZoneComponent => ({
  value: null,
  confidence: "missing",
  observations,
  reason,
});

/** Trailing calendar years only. Financial facts must already be PIT-valued by
 * the source adapter; a report period or today's downloaded value is not PIT.
 * Price + drawdown trigger the zone; available valuation/temperature must agree.
 */
export function historicalLowSeries(
  bars: readonly Bar[],
  config: z.input<typeof historicalLowConfigSchema> = {},
  facts: readonly LowZoneFact[] = [],
): LowZoneObservation[] {
  const options = historicalLowConfigSchema.parse(config);
  if (
    bars.some(
      (b, i) =>
        !Number.isFinite(b.close) ||
        b.close <= 0 ||
        !Number.isFinite(Date.parse(b.date)) ||
        (i > 0 && b.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("Invalid historical-low price history");
  if (
    new Set(facts.map((f) => f.date)).size !== facts.length ||
    facts.some(
      (f) =>
        !f.source ||
        !Number.isFinite(Date.parse(f.availableAt)) ||
        f.availableAt > f.date ||
        [f.pe, f.pb, f.temperature].some(
          (v) => v !== null && !Number.isFinite(v),
        ) ||
        (f.temperature !== null && (f.temperature < 0 || f.temperature > 100)),
    )
  )
    throw new Error("Invalid / non-causal historical-low facts");
  const byDate = new Map(facts.map((f) => [f.date, f]));
  return bars.map((bar, index) => {
    const end = new Date(bar.date);
    const first = new Date(end);
    first.setUTCFullYear(end.getUTCFullYear() - options.years);
    const minimum = new Date(end);
    minimum.setUTCFullYear(end.getUTCFullYear() - 5);
    const firstDate = first.toISOString().slice(0, 10);
    const minimumDate = minimum.toISOString().slice(0, 10);
    const prefix = bars.slice(0, index + 1);
    const window = prefix.filter((b) => b.date >= firstDate);
    const enough =
      prefix[0]!.date <= minimumDate && window.length >= options.minimumBars;
    const prices = window.map((b) => b.close);
    const price: LowZoneComponent = enough
      ? {
          value: rank(prices, bar.close),
          confidence: "verified",
          observations: window.length,
          reason: `Trailing ${options.years} calendar years, minimum 5 years; fixed price basis`,
        }
      : missing(
          "Less than five calendar years / minimum observations",
          window.length,
        );
    const drawdown: LowZoneComponent = enough
      ? {
          value: bar.close / Math.max(...prices) - 1,
          confidence: "verified",
          observations: window.length,
          reason:
            "Drawdown from preceding high including current completed close",
        }
      : missing("Insufficient price history", window.length);
    const current = byDate.get(bar.date);
    const valuation = (field: "pe" | "pb"): LowZoneComponent => {
      const value = current?.[field];
      const history = facts.filter(
        (f) =>
          f.date >= window[0]!.date &&
          f.date <= bar.date &&
          f.availableAt <= bar.date &&
          f[field] !== null &&
          f[field]! > 0,
      );
      if (value == null || value <= 0 || history.length < 60)
        return missing(
          "No positive PIT valuation / fewer than 60 observations",
          history.length,
        );
      return {
        value: rank(
          history.map((f) => f[field]!),
          value,
        ),
        confidence: history.every((f) => f.confidence === "verified")
          ? "verified"
          : "approximate",
        observations: history.length,
        reason: current!.source,
      };
    };
    const pe = valuation("pe"),
      pb = valuation("pb");
    const temperature: LowZoneComponent =
      current?.temperature == null
        ? missing("Historical market-temperature evidence unavailable")
        : {
            value: current.temperature / 100,
            confidence: current.confidence,
            observations: 1,
            reason: current.source,
          };
    const corroboration = [pe, pb, temperature].filter((c) => c.value !== null);
    let depth: LowZoneObservation["depth"] = enough ? 0 : null;
    if (enough && corroboration.every((c) => c.value! <= 0.3)) {
      if (price.value! <= 0.2 && drawdown.value! <= -0.3) depth = 1;
      if (price.value! <= 0.1 && drawdown.value! <= -0.45) depth = 2;
      if (price.value! <= 0.05 && drawdown.value! <= -0.6) depth = 3;
    }
    return {
      date: bar.date,
      depth,
      targetShare: depth ? [0, 0.3, 0.35, 0.4][depth]! : 0,
      recovery: enough
        ? price.value! >= options.recoveryPercentile ||
          drawdown.value! >= -0.15 ||
          [pe, pb].some((c) => c.value !== null && c.value >= 0.7)
        : null,
      confidence: !enough
        ? "insufficient"
        : corroboration.length === 3
          ? "corroborated"
          : "price-only",
      price,
      drawdown,
      pe,
      pb,
      temperature,
    };
  });
}
