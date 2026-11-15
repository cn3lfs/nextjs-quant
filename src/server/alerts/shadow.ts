import type { StrategyObjectInput } from "trading-strategies";
import {
  runValidationSuite,
  validationDefaults,
  validationRowReasons,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { multipleTesting } from "~/lib/backtest/multiple-testing";
import { scoreValidationResult } from "../research/validation-replay";
import { sizeCryptoResearch } from "../research/crypto-sizing";
import { researchExecutionAt } from "../research/corporate-actions";

export type ShadowRegistration = {
  startedAt: number;
  status: "shadow-candidate";
  active: boolean;
  trialSharpes: { value: number | null; reason: string | null }[];
  neighbors: { id: string; excess: number | null }[];
  sizing: "legacy" | "equal" | "volatility";
  completeMarketCycles: number;
  lowZoneCorroborated: boolean;
};
export type ShadowSample = {
  symbol: string;
  bar: Bar;
  benchmark: Bar;
  observedAt: number;
  completedAt: number;
  source: string;
  entry: boolean | null;
  exit: boolean | null;
  stop: number | null;
  actions: PortfolioInstrument["actions"];
};
export type ShadowProgress = {
  samples: ShadowSample[];
  days: string[];
  signals: number;
  paused: boolean;
  assessment: {
    at: number;
    eligible: boolean;
    reasons: string[];
    recommendation: string;
  } | null;
};
export type ShadowSummary = Pick<
  ShadowProgress,
  "signals" | "paused" | "assessment"
> & { days: number };
export const shadowLimits = { signals: 30, days: 60, samples: 100000 } as const;
/** Separate the15:00 physical close from the15:05 batch receipt window. */
export function shadowBarCompletedAt(
  market: StrategyObjectInput["market"],
  period: StrategyObjectInput["period"],
  date: string,
  evaluationCompletedAt: number,
) {
  return market === "cn-equity" && (period === "day" || period === "week")
    ? Date.parse(`${date.slice(0, 10)}T15:00:00+08:00`)
    : evaluationCompletedAt;
}
export function appendShadowSamples(
  previous: ShadowProgress | undefined,
  registration: ShadowRegistration,
  fresh: ShadowSample[],
): ShadowProgress {
  const next: ShadowProgress = previous
    ? { ...previous, samples: [...previous.samples], days: [...previous.days] }
    : { samples: [], days: [], signals: 0, paused: false, assessment: null };
  if (next.paused) return next;
  const seen = new Set(next.samples.map((s) => `${s.symbol}|${s.bar.date}`));
  for (const sample of fresh) {
    if (
      sample.observedAt < registration.startedAt ||
      sample.completedAt < registration.startedAt ||
      sample.observedAt < sample.completedAt ||
      Date.parse(sample.bar.date) <
        new Date(registration.startedAt).setUTCHours(0, 0, 0, 0)
    )
      continue;
    const key = `${sample.symbol}|${sample.bar.date}`;
    if (seen.has(key)) continue;
    if (next.samples.length >= shadowLimits.samples) {
      next.paused = true;
      break;
    }
    seen.add(key);
    next.samples.push(sample);
    if (sample.entry === true && sample.exit !== true) next.signals++;
    const day = sample.bar.date.slice(0, 10);
    if (!next.days.includes(day)) next.days.push(day);
  }
  next.days.sort();
  return next;
}
/** Replay ONLY observations captured after registration, never backfill a missed
 * rule decision from later revised history. Same financial gates; no enabling. */
export function assessShadow(
  strategy: StrategyObjectInput,
  registration: ShadowRegistration,
  progress: ShadowProgress,
  now: number,
  marketCalendar: readonly string[] = [],
): ShadowProgress["assessment"] {
  if (
    progress.signals < shadowLimits.signals &&
    progress.days.length < shadowLimits.days
  )
    return null;
  const pending = (reasons: string[]) => ({
    at: now,
    eligible: false,
    reasons,
    recommendation: "继续影子观察；证据或门槛尚未满足",
  });
  if (progress.paused) return pending(["shadow-observation-capacity-reached"]);
  if (progress.days.length < 35)
    return pending(["insufficient-forward-windows"]);
  const symbols = [
    ...new Set(
      strategy.universe.kind === "symbols"
        ? strategy.universe.symbols
        : progress.samples.map((s) => s.symbol),
    ),
  ].sort();
  const benchmark = [
    ...new Map(
      progress.samples.map((s) => [s.benchmark.date, s.benchmark]),
    ).values(),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (strategy.market === "crypto") {
    const step = (
      {
        day: 86400000,
        "4h": 14400000,
        "1h": 3600000,
        "15m": 900000,
        "5m": 300000,
      } as Partial<Record<StrategyObjectInput["period"], number>>
    )[strategy.period];
    if (
      !step ||
      benchmark.some(
        (b, i) =>
          i > 0 &&
          Date.parse(b.date) - Date.parse(benchmark[i - 1]!.date) !== step,
      )
    )
      return pending(["incomplete-forward-execution-evidence"]);
  } else {
    const expectedDays = marketCalendar.filter(
      (d) => d >= progress.days[0]! && d <= progress.days.at(-1)!,
    );
    if (
      !expectedDays.length ||
      expectedDays.length !== progress.days.length ||
      expectedDays.some((d) => !progress.days.includes(d))
    )
      return pending(["incomplete-forward-execution-evidence"]);
  }
  const expectedDates = new Set(benchmark.map((b) => b.date));
  if (
    symbols.some(
      (symbol) =>
        new Set(
          progress.samples
            .filter((s) => s.symbol === symbol && expectedDates.has(s.bar.date))
            .map((s) => s.bar.date),
        ).size !== expectedDates.size,
    )
  )
    return pending(["incomplete-forward-execution-evidence"]);
  const instruments: PortfolioInstrument[] = symbols.map((symbol) => {
    const samples = progress.samples
      .filter((s) => s.symbol === symbol)
      .sort((a, b) => a.bar.date.localeCompare(b.bar.date));
    const actions = [
      ...new Map(
        samples.flatMap((s) => s.actions ?? []).map((a) => [a.date, a]),
      ).values(),
    ];
    return {
      symbol,
      market: strategy.market,
      bars: samples.map((s) => s.bar),
      signalBars: samples.map((s) => s.bar),
      actions,
      execution: Object.fromEntries(
        samples.map((s, i) => [
          s.bar.date,
          strategy.market === "cn-equity"
            ? researchExecutionAt(symbol, s.bar, samples[i - 1]?.bar, actions)!
            : {
                evidence:
                  "Prospectively observed native raw bars; venue research scenario",
                tradable: s.bar.volume > 0,
                minimum: 0.000001,
                step: 0.000001,
                limitUp: null,
                limitDown: null,
              },
        ]),
      ),
      external: {
        signals: samples.map((s) => ({
          id: strategy.id,
          date: s.bar.date,
          availableAt: s.bar.date,
          entry: s.entry === true,
          exit: s.exit === true,
        })),
        levels: samples.flatMap((s) =>
          s.stop !== null && s.stop > 0
            ? [
                {
                  field: strategy.id,
                  date: s.bar.date,
                  availableAt: s.bar.date,
                  value: s.stop,
                },
              ]
            : [],
        ),
      },
    };
  });
  const s = {
    ...strategy,
    universe: { kind: "symbols" as const, symbols },
    entry: {
      kind: "external" as const,
      id: strategy.id,
      side: "entry" as const,
    },
    exit: {
      ...strategy.exit,
      rule: {
        kind: "external" as const,
        id: strategy.id,
        side: "exit" as const,
      },
      ...(strategy.exit.stop?.kind === "atr"
        ? { stop: { kind: "structure" as const, field: strategy.id } }
        : {}),
    },
  };
  let request: PortfolioRequest = {
    market: strategy.market,
    initial: 1000000,
    start: progress.days[0]!,
    end: progress.days.at(-1)!,
    calendar: benchmark.map((b) => b.date),
    instruments,
    strategies: [s],
    sleeves: [
      {
        id: s.sleeve,
        share: 1,
        riskPerTrade: s.sleeve === "low-zone" ? 0.1 : 0.02,
        maxPositions: strategy.market === "crypto" ? symbols.length : 10,
      },
    ],
  };
  if (strategy.market === "crypto" && registration.sizing !== "legacy")
    request = sizeCryptoResearch(request, registration.sizing);
  const dataset = {
    period: strategy.period,
    instruments,
    sources: [],
    benchmark,
    benchmarkName: "First-observed forward benchmark",
    dates: progress.days,
  };
  const suite = runValidationSuite(
    [{ id: s.id, family: s.id, request }],
    progress.days,
    {
      ...validationDefaults,
      trainBars: Math.max(20, Math.floor(progress.days.length * 0.4)),
      testBars: Math.max(5, Math.floor(progress.days.length * 0.1)),
    },
    (r, q) => scoreValidationResult(r, q, dataset),
  );
  const row = { ...suite.rows[0]!, neighbors: registration.neighbors };
  const reasons = validationRowReasons(row, {
    ...validationDefaults,
    trainBars: 20,
    testBars: 5,
  });
  if (progress.samples.some((s) => s.entry === null || s.exit === null))
    reasons.push("unknown-forward-rule-inputs");
  const test = multipleTesting(
    row.windows.flatMap((w) => w.base.daily),
    registration.trialSharpes,
  );
  if (test.selected.dsr.value === null || test.selected.dsr.value < 0.95)
    reasons.push("multiple-testing-dsr-0.95");
  if (s.sleeve === "low-zone") {
    if (registration.completeMarketCycles < 3)
      reasons.push("insufficient-complete-market-cycles");
    if (!registration.lowZoneCorroborated)
      reasons.push("low-zone-input-confidence");
  }
  // Volatility sizing needs 60 preceding captured days, independent of the warmup
  // used to compute entry rules. Never substitute hindsight pre-registration bars.
  if (registration.sizing === "volatility" && progress.days.length < 61)
    reasons.push("insufficient-forward-volatility-warmup");
  const eligible = reasons.length === 0;
  return {
    at: now,
    eligible,
    reasons,
    recommendation: eligible
      ? "可考虑开启提醒；请在设置中手动开启live并启用订阅"
      : "继续影子观察；未通过相同门槛",
  };
}
