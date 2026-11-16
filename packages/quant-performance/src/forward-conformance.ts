export type ForwardIdentity = {
  strategyId: string;
  version: number;
  definitionHash: string;
  inputHash: string;
  buildHash: string;
};
export type ForwardDay = { date: string; return: number; signals: number };
export type ForwardDistribution = {
  frozenAt: number;
  identity: ForwardIdentity;
  days: readonly ForwardDay[];
  tradeReturns: readonly number[];
  slippageBps: readonly number[];
};
export type ForwardObservation = Omit<ForwardDistribution, "frozenAt"> & {
  entries: number;
  missingDates: readonly string[];
  unknownDecisions: number;
};
export type ConformanceBand = {
  observed: number | null;
  lower: number | null;
  upper: number | null;
  status: "within" | "adverse" | "insufficient";
};
export type ForwardConformance = {
  comparison: {
    tradeReturn: "per-trade-net-return-mean";
    slippage: "mean-slippage-bps";
  };
  method: "forward-conformance-1";
  verdict: "conforming" | "degraded" | "insufficient";
  reasons: string[];
  days: number;
  entries: number;
  minimumDays: number;
  minimumEntries: number;
  signalRate: ConformanceBand;
  tradeReturn: ConformanceBand;
  slippage: ConformanceBand;
  equity: {
    status: ConformanceBand["status"];
    breaches: string[];
    lowerPath: { date: string; value: number | null }[];
    simultaneousScale: number | null;
  };
  bootstrap: {
    draws: 1000;
    calibrationDraws: 1000;
    blockDays: 5;
    seed: 20261116;
    calibrationSeed: 20261117;
    boundary: string;
  };
};

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);
function percentile(values: number[], probability: number) {
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) * probability)]!;
}
const emptyBand = (): ConformanceBand => ({
  observed: null,
  lower: null,
  upper: null,
  status: "insufficient",
});
function randomSource(seed = 20261116) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function validDays(days: readonly ForwardDay[]) {
  return (
    days.length > 0 &&
    days.every(
      (day, i) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
        Number.isFinite(Date.parse(day.date)) &&
        new Date(day.date).toISOString().slice(0, 10) === day.date &&
        (!i || day.date > days[i - 1]!.date) &&
        Number.isFinite(day.return) &&
        day.return >= -1 &&
        Number.isInteger(day.signals) &&
        day.signals >= 0,
    )
  );
}
function sameIdentity(a: ForwardIdentity, b: ForwardIdentity) {
  return (
    a.strategyId === b.strategyId &&
    a.version === b.version &&
    a.definitionHash === b.definitionHash &&
    a.inputHash === b.inputHash &&
    a.buildHash === b.buildHash &&
    a.strategyId.length > 0 &&
    Number.isInteger(a.version) &&
    a.version > 0 &&
    [a.definitionHash, a.inputHash, a.buildHash].every((hash) =>
      /^[a-f0-9]{64}$/.test(hash),
    )
  );
}

/** Compare observations with one frozen OOS distribution, never refit research gates. */
export function assessForwardConformance(input: {
  market: "cn-equity" | "crypto";
  period: string;
  reference: ForwardDistribution | null;
  observed: ForwardObservation;
  startedAt: number;
  asOf: number;
  expectedDates?: readonly string[];
}): ForwardConformance {
  const { observed, reference } = input;
  const dailyCrypto = input.market === "crypto" && input.period === "day";
  const result: ForwardConformance = {
    comparison: {
      tradeReturn: "per-trade-net-return-mean",
      slippage: "mean-slippage-bps",
    },
    method: "forward-conformance-1",
    verdict: "insufficient",
    reasons: [],
    days: observed.days.length,
    entries: observed.entries,
    minimumDays: dailyCrypto ? 120 : 60,
    minimumEntries: dailyCrypto ? 0 : 20,
    signalRate: emptyBand(),
    tradeReturn: emptyBand(),
    slippage: emptyBand(),
    equity: {
      status: "insufficient",
      breaches: [],
      lowerPath: [],
      simultaneousScale: null,
    },
    bootstrap: {
      draws: 1000,
      calibrationDraws: 1000,
      blockDays: 5,
      seed: 20261116,
      calibrationSeed: 20261117,
      boundary:
        "Equity uses an approximate simultaneous 95% lower band from independent bootstrap groups; signal rate uses a 90% two-sided band, trade-return/slippage means use one-sided bands. Their conjunction is not joint 95% coverage, and finite-sample model coverage does not prove real-world false-alarm rates.",
    },
  };
  const completedAt = (date: string) =>
    input.market === "crypto"
      ? Date.parse(`${date}T00:00:00Z`) + 86400000
      : Date.parse(`${date}T15:00:00+08:00`);
  if (
    !Number.isFinite(input.startedAt) ||
    !Number.isFinite(input.asOf) ||
    input.asOf < input.startedAt
  )
    result.reasons.push("invalid-forward-observation-clock");
  if (!reference) result.reasons.push("missing-frozen-forward-distribution");
  else if (!sameIdentity(reference.identity, observed.identity))
    result.reasons.push("forward-version-mismatch");
  if (
    reference &&
    (!Number.isFinite(reference.frozenAt) ||
      reference.frozenAt > input.startedAt ||
      (reference.days.length > 0 &&
        completedAt(reference.days.at(-1)!.date) > reference.frozenAt))
  )
    result.reasons.push("reference-not-frozen-before-registration");
  if (
    reference?.days.length &&
    observed.days.length &&
    observed.days[0]!.date <= reference.days.at(-1)!.date
  )
    result.reasons.push("forward-overlaps-frozen-history");
  if (!validDays(observed.days) || (reference && !validDays(reference.days)))
    result.reasons.push("invalid-forward-day-evidence");
  if (
    observed.days.some(
      (day) =>
        completedAt(day.date) < input.startedAt ||
        completedAt(day.date) > input.asOf,
    )
  )
    result.reasons.push("forward-day-outside-observed-clock");
  if (
    input.market === "crypto" &&
    observed.days.some(
      (day, i) =>
        i > 0 &&
        Date.parse(day.date) - Date.parse(observed.days[i - 1]!.date) !==
          86400000,
    )
  )
    result.reasons.push("incomplete-crypto-forward-calendar");
  if (
    input.market === "cn-equity" &&
    (!input.expectedDates?.length ||
      input.expectedDates.length !== observed.days.length ||
      input.expectedDates.some(
        (date, i) =>
          date !== observed.days[i]!.date ||
          completedAt(date) > input.asOf ||
          completedAt(date) < input.startedAt,
      ))
  )
    result.reasons.push("incomplete-equity-forward-calendar");
  if (observed.missingDates.length || observed.unknownDecisions > 0)
    result.reasons.push("incomplete-observed-forward-evidence");
  if (
    !Number.isInteger(observed.unknownDecisions) ||
    observed.unknownDecisions < 0
  )
    result.reasons.push("invalid-unknown-decision-count");
  if (
    !Number.isInteger(observed.entries) ||
    observed.entries < result.minimumEntries
  )
    result.reasons.push("insufficient-forward-entries");
  if (observed.days.length < result.minimumDays)
    result.reasons.push("insufficient-forward-days");
  if (reference && reference.days.length < result.minimumDays)
    result.reasons.push("insufficient-frozen-oos-days");
  const arrays = [
    observed.tradeReturns,
    observed.slippageBps,
    ...(reference ? [reference.tradeReturns, reference.slippageBps] : []),
  ];
  if (arrays.some((values) => values.some((value) => !Number.isFinite(value))))
    result.reasons.push("invalid-forward-distribution");
  if (
    !dailyCrypto &&
    (observed.tradeReturns.length < 5 ||
      (reference?.tradeReturns.length ?? 0) < 5)
  )
    result.reasons.push("insufficient-forward-closed-trades");
  if (
    !dailyCrypto &&
    (observed.slippageBps.length < 5 ||
      (reference?.slippageBps.length ?? 0) < 5)
  )
    result.reasons.push("insufficient-forward-slippage-evidence");
  if (result.reasons.length || !reference) return result;

  const random = randomSource();
  const length = observed.days.length;
  const simulatedSignals: number[] = [];
  const paths: number[][] = Array.from({ length }, () => []);
  for (let draw = 0; draw < result.bootstrap.draws; draw++) {
    let value = 1,
      signals = 0;
    for (
      let offset = 0;
      offset < length;
      offset += result.bootstrap.blockDays
    ) {
      // Moving blocks never wrap the end back to the beginning of history.
      const first = Math.floor(
        random() * (reference.days.length - result.bootstrap.blockDays + 1),
      );
      for (
        let j = 0;
        j < result.bootstrap.blockDays && offset + j < length;
        j++
      ) {
        const day = reference.days[first + j]!;
        value *= 1 + day.return;
        signals += day.signals;
        paths[offset + j]!.push(value);
      }
    }
    simulatedSignals.push(signals / length);
  }
  const observedSignals = mean(observed.days.map((day) => day.signals));
  const signalLower = percentile([...simulatedSignals], 0.05),
    signalUpper = percentile(simulatedSignals, 0.95);
  result.signalRate = {
    observed: observedSignals,
    lower: signalLower,
    upper: signalUpper,
    status:
      observedSignals < signalLower - 1e-12 ||
      observedSignals > signalUpper + 1e-12
        ? "adverse"
        : "within",
  };
  const baseLower = paths.map((values) => percentile(values, 0.05));
  const calibrationRandom = randomSource(result.bootstrap.calibrationSeed);
  const minimumRatios: number[] = [];
  for (let draw = 0; draw < result.bootstrap.calibrationDraws; draw++) {
    let value = 1,
      minimum = 1;
    for (
      let offset = 0;
      offset < length;
      offset += result.bootstrap.blockDays
    ) {
      const first = Math.floor(
        calibrationRandom() *
          (reference.days.length - result.bootstrap.blockDays + 1),
      );
      for (
        let j = 0;
        j < result.bootstrap.blockDays && offset + j < length;
        j++
      ) {
        value *= 1 + reference.days[first + j]!.return;
        const lower = baseLower[offset + j]!;
        if (!Number.isFinite(value) || !Number.isFinite(lower)) {
          result.reasons.push("non-finite-bootstrap-equity");
          return result;
        }
        // A zero lower bound imposes no positive wealth constraint.
        if (lower > 0) {
          const ratio = value / lower;
          if (!Number.isFinite(ratio)) {
            result.reasons.push("non-finite-bootstrap-equity");
            return result;
          }
          minimum = Math.min(minimum, ratio);
        }
      }
    }
    minimumRatios.push(minimum);
  }
  const simultaneousScale = percentile(minimumRatios, 0.05);
  result.equity.simultaneousScale = simultaneousScale;
  let observedValue = 1;
  result.equity.lowerPath = observed.days.map((day, i) => {
    observedValue *= 1 + day.return;
    const lower = baseLower[i]! * simultaneousScale;
    if (!Number.isFinite(observedValue) || !Number.isFinite(lower)) {
      if (!result.reasons.includes("non-finite-forward-equity"))
        result.reasons.push("non-finite-forward-equity");
    } else if (observedValue < lower - 1e-12)
      result.equity.breaches.push(day.date);
    return { date: day.date, value: Number.isFinite(lower) ? lower : null };
  });
  result.equity.status = result.reasons.includes("non-finite-forward-equity")
    ? "insufficient"
    : result.equity.breaches.length
      ? "adverse"
      : "within";
  const compareMean = (
    baseline: readonly number[],
    values: readonly number[],
    adverse: "lower" | "upper",
  ) => {
    if (baseline.length < 5 || values.length < 5) return emptyBand();
    const samples = Array.from({ length: result.bootstrap.draws }, () =>
      mean(
        Array.from(
          { length: values.length },
          () => baseline[Math.floor(random() * baseline.length)]!,
        ),
      ),
    );
    const lower = percentile([...samples], 0.05),
      upper = percentile(samples, 0.95),
      actual = mean(values);
    return {
      observed: actual,
      lower,
      upper,
      status: (
        adverse === "lower" ? actual < lower - 1e-12 : actual > upper + 1e-12
      )
        ? ("adverse" as const)
        : ("within" as const),
    };
  };
  result.tradeReturn = compareMean(
    reference.tradeReturns,
    observed.tradeReturns,
    "lower",
  );
  result.slippage = compareMean(
    reference.slippageBps,
    observed.slippageBps,
    "upper",
  );
  if (result.signalRate.status === "adverse")
    result.reasons.push("forward-signal-rate-outside-band");
  if (result.equity.status === "adverse")
    result.reasons.push("forward-equity-below-frozen-band");
  if (result.tradeReturn.status === "adverse")
    result.reasons.push("forward-trade-return-degraded");
  if (result.slippage.status === "adverse")
    result.reasons.push("forward-slippage-degraded");
  result.verdict = result.reasons.includes("non-finite-forward-equity")
    ? "insufficient"
    : result.reasons.length
      ? "degraded"
      : "conforming";
  return result;
}
