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
/** Coordinate compression never contributes future counts. Only observations
 * explicitly added to the trailing window contribute to an empirical rank. */
class EmpiricalWindow {
  private coordinates: number[];
  private positions: Map<number, number>;
  private counts: Int32Array;
  size = 0;
  constructor(values: readonly number[]) {
    this.coordinates = [...new Set(values)].sort((a, b) => a - b);
    this.positions = new Map(this.coordinates.map((v, i) => [v, i + 1]));
    this.counts = new Int32Array(this.coordinates.length + 1);
  }
  add(value: number, delta: 1 | -1) {
    this.size += delta;
    for (
      let i = this.positions.get(value)!;
      i < this.counts.length;
      i += i & -i
    )
      this.counts[i]! += delta;
  }
  rank(value: number) {
    let count = 0;
    for (let i = this.positions.get(value)!; i > 0; i -= i & -i)
      count += this.counts[i]!;
    return count / this.size;
  }
}
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
  bars: readonly Pick<Bar, "date" | "close">[],
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
  const prices = new EmpiricalWindow(bars.map((b) => b.close));
  const sortedFacts = [...facts].sort((a, b) => a.date.localeCompare(b.date));
  const valuations = {
    pe: new EmpiricalWindow(
      facts.flatMap((f) => (f.pe !== null && f.pe > 0 ? [f.pe] : [])),
    ),
    pb: new EmpiricalWindow(
      facts.flatMap((f) => (f.pb !== null && f.pb > 0 ? [f.pb] : [])),
    ),
  };
  const approximate = { pe: 0, pb: 0 };
  const addFact = (fact: LowZoneFact, delta: 1 | -1) => {
    for (const field of ["pe", "pb"] as const) {
      const value = fact[field];
      if (value !== null && value > 0) {
        valuations[field].add(value, delta);
        if (fact.confidence !== "verified") approximate[field] += delta;
      }
    }
  };
  let firstIndex = 0,
    factStart = 0,
    factEnd = 0,
    highStart = 0;
  const highs: number[] = [];
  return bars.map((bar, index) => {
    const end = new Date(bar.date);
    const first = new Date(end);
    first.setUTCFullYear(end.getUTCFullYear() - options.years);
    const minimum = new Date(end);
    minimum.setUTCFullYear(end.getUTCFullYear() - 5);
    const firstDate = first.toISOString().slice(0, 10);
    const minimumDate = minimum.toISOString().slice(0, 10);
    prices.add(bar.close, 1);
    while (bars[firstIndex]!.date < firstDate)
      prices.add(bars[firstIndex++]!.close, -1);
    while (highs.length > highStart && bars[highs.at(-1)!]!.close <= bar.close)
      highs.pop();
    highs.push(index);
    while (highs[highStart]! < firstIndex) highStart++;
    while (sortedFacts[factEnd] && sortedFacts[factEnd]!.date <= bar.date)
      addFact(sortedFacts[factEnd++]!, 1);
    while (
      factStart < factEnd &&
      sortedFacts[factStart]!.date < bars[firstIndex]!.date
    )
      addFact(sortedFacts[factStart++]!, -1);
    const enough =
      bars[0]!.date <= minimumDate && prices.size >= options.minimumBars;
    const price: LowZoneComponent = enough
      ? {
          value: prices.rank(bar.close),
          confidence: "verified",
          observations: prices.size,
          reason: `Trailing ${options.years} calendar years, minimum 5 years; fixed price basis`,
        }
      : missing(
          "Less than five calendar years / minimum observations",
          prices.size,
        );
    const drawdown: LowZoneComponent = enough
      ? {
          value: bar.close / bars[highs[highStart]!]!.close - 1,
          confidence: "verified",
          observations: prices.size,
          reason:
            "Drawdown from preceding high including current completed close",
        }
      : missing("Insufficient price history", prices.size);
    const current = byDate.get(bar.date);
    const valuation = (field: "pe" | "pb"): LowZoneComponent => {
      const value = current?.[field];
      const history = valuations[field];
      if (value == null || value <= 0 || history.size < 60)
        return missing(
          "No positive PIT valuation / fewer than 60 observations",
          history.size,
        );
      return {
        value: history.rank(value),
        confidence: approximate[field] === 0 ? "verified" : "approximate",
        observations: history.size,
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
