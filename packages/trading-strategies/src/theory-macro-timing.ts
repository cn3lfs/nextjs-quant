export const macroSeriesIds = [
  "gdp-yoy",
  "cpi-yoy",
  "ppi-yoy",
  "pmi-mfg",
  "bond-1y",
  "bond-10y",
  "fr007",
  "lpr-1y",
] as const;
export type MacroSeriesId = (typeof macroSeriesIds)[number];
export type MacroPublicationBasis = "official" | "conservative-lag";
export type MacroObservation = {
  seriesId: MacroSeriesId;
  /** Reporting period and first visible date of this vintage, both YYYY-MM-DD. */
  reportPeriod: string;
  availableAt: string;
  value: number;
  publicationBasis: MacroPublicationBasis;
};

function visibleRows(
  observations: readonly MacroObservation[],
  seriesId: MacroSeriesId,
  asOf: string,
) {
  return observations.filter(
    (row) =>
      row.seriesId === seriesId &&
      row.availableAt <= asOf &&
      Number.isFinite(row.value),
  );
}

function newest(latest: MacroObservation | null, row: MacroObservation) {
  return !latest ||
    row.reportPeriod > latest.reportPeriod ||
    (row.reportPeriod === latest.reportPeriod &&
      row.availableAt > latest.availableAt)
    ? row
    : latest;
}

export function latestVisibleMacro(
  observations: readonly MacroObservation[],
  seriesId: MacroSeriesId,
  asOf: string,
): MacroObservation | null {
  return visibleRows(
    observations,
    seriesId,
    asOf,
  ).reduce<MacroObservation | null>(newest, null);
}

export function visibleMacroHistory(
  observations: readonly MacroObservation[],
  seriesId: MacroSeriesId,
  asOf: string,
): MacroObservation[] {
  const periods = new Map<string, MacroObservation>();
  for (const row of visibleRows(observations, seriesId, asOf)) {
    periods.set(
      row.reportPeriod,
      newest(periods.get(row.reportPeriod) ?? null, row),
    );
  }
  return [...periods.values()].sort((a, b) =>
    a.reportPeriod.localeCompare(b.reportPeriod),
  );
}

type MacroInput = { asOf: string; observations: readonly MacroObservation[] };
const clockTargets = {
  recovery: { sh510300: 0.4, sz159915: 0.4, sh510880: 0.2 },
  overheat: { sh512400: 0.3, sh515220: 0.3, sh518880: 0.2, sh510300: 0.2 },
  stagflation: { sh518880: 0.4, sh510880: 0.3, sh511010: 0.3 },
  recession: { sh511010: 0.6, sh518880: 0.2, sh510880: 0.2 },
  unknown: {},
};
type Direction = "up" | "down";

function periodChange(history: readonly MacroObservation[]) {
  return history.length < 2
    ? null
    : history.at(-1)!.value - history.at(-2)!.value;
}

function clockRegime(
  growth: Direction | null,
  inflation: Direction | null,
): keyof typeof clockTargets {
  if (!growth || !inflation) return "unknown";
  if (growth === "up") return inflation === "up" ? "overheat" : "recovery";
  return inflation === "up" ? "stagflation" : "recession";
}

export function evaluateMacroClockEtfRotation({
  observations,
  asOf,
}: MacroInput) {
  const history = (id: MacroSeriesId) =>
    visibleMacroHistory(observations, id, asOf);
  const pmi = history("pmi-mfg");
  const pmiChange = periodChange(pmi);
  const growth =
    pmiChange === null
      ? null
      : (pmi.at(-1)!.value >= 50 && pmiChange >= 0) || pmiChange >= 0.5
        ? "up"
        : "down";
  const changes = [
    periodChange(history("cpi-yoy")),
    periodChange(history("ppi-yoy")),
  ].filter((change) => change !== null);
  const inflationChange = changes.length
    ? changes.reduce((sum, change) => sum + change, 0) / changes.length
    : null;
  const inflation =
    inflationChange === null ? null : inflationChange > 0 ? "up" : "down";
  const regime = clockRegime(growth, inflation);
  const short = latestVisibleMacro(observations, "bond-1y", asOf);
  const long = latestVisibleMacro(observations, "bond-10y", asOf);
  return {
    status: regime === "unknown" ? "unknown" : "ok",
    regime,
    growth,
    inflation,
    targets: { ...clockTargets[regime] } as Record<string, number>,
    diagnostics: {
      pmiChange,
      inflationChange,
      termSpread: long && short ? long.value - short.value : null,
    },
    reason:
      regime === "unknown"
        ? "PMI 或通胀缺少两个可见报告期"
        : `PMI 增长轴 ${growth}，通胀轴 ${inflation}`,
  } as const;
}

/** The supplied trading calendar contains consecutive sessions. A following
 * month confirms a holiday/weekend end; a literal month-end confirms itself. */
export function generateMacroClockSchedule({
  calendar,
  observations,
  rebalanceCadence = "month-end",
}: {
  calendar: readonly string[];
  observations: readonly MacroObservation[];
  rebalanceCadence?: "month-end" | "quarter-end";
}) {
  const dates = [...new Set(calendar)].sort();
  return dates.flatMap((date, index) => {
    const month = Number(date.slice(5, 7));
    if (rebalanceCadence === "quarter-end" && month % 3 !== 0) return [];
    const next = dates[index + 1];
    const completed = next
      ? next.slice(0, 7) !== date.slice(0, 7)
      : Number(date.slice(8, 10)) ===
        new Date(Date.UTC(Number(date.slice(0, 4)), month, 0)).getUTCDate();
    if (!completed) return [];
    const { regime, targets, reason } = evaluateMacroClockEtfRotation({
      asOf: date,
      observations,
    });
    return [{ date, availableAt: date, regime, targets, reason }];
  });
}

export function evaluateMacroErpAllocation({
  asOf,
  observations,
  equityPeSeries,
  lookbackDays = 250,
  minObservations = 60,
}: MacroInput & {
  equityPeSeries: readonly { date: string; pe: number }[];
  lookbackDays?: number;
  minObservations?: number;
}) {
  const unknown = {
    status: "unknown" as const,
    erp: null,
    percentile: null,
    targets: {},
  };
  if (
    !Number.isSafeInteger(lookbackDays) ||
    lookbackDays < 1 ||
    !Number.isSafeInteger(minObservations) ||
    minObservations < 1
  )
    return unknown;

  // Count distinct PE sessions before discarding unusable pairs. Conflicting
  // values for a single date cannot establish that session's earnings yield.
  const peByDate = new Map<string, number | null>();
  for (const { date, pe } of equityPeSeries) {
    if (date > asOf) continue;
    const previous = peByDate.get(date);
    peByDate.set(date, previous === undefined || previous === pe ? pe : null);
  }
  if (!peByDate.has(asOf)) return unknown;
  const dates = [...peByDate.keys()].sort().slice(-lookbackDays);
  const yields = visibleRows(observations, "bond-10y", asOf).sort((a, b) =>
    a.availableAt.localeCompare(b.availableAt),
  );
  let nextYield = 0;
  let bond: MacroObservation | null = null;
  const sample: number[] = [];
  for (const date of dates) {
    while (
      nextYield < yields.length &&
      yields[nextYield]!.availableAt <= date
    ) {
      bond = newest(bond, yields[nextYield++]!);
    }
    const pe = peByDate.get(date) ?? null;
    const erp =
      pe !== null && Number.isFinite(pe) && pe > 0 && bond
        ? 1 / pe - bond.value / 100
        : null;
    if (erp !== null && Number.isFinite(erp)) sample.push(erp);
    else if (date === asOf) return unknown;
  }
  if (sample.length < minObservations) return unknown;
  const erp = sample.at(-1)!;
  // Empirical CDF, including the current session and all ties.
  const percentile =
    sample.filter((value) => value <= erp).length / sample.length;
  const equityPct = percentile >= 0.7 ? 80 : percentile <= 0.3 ? 20 : 50;
  return {
    status: "ok" as const,
    erp,
    percentile,
    targets: { sh510300: equityPct / 100, sh511010: (100 - equityPct) / 100 },
  };
}
