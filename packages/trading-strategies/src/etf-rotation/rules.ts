import type { ResolvedEtfRotationConfig } from "./catalog.js";

type Dual = Extract<
  ResolvedEtfRotationConfig,
  { strategyId: "etf-dual-momentum" }
>;
type Sector = Extract<
  ResolvedEtfRotationConfig,
  { strategyId: "etf-sector-rotation" }
>;
type Risk = Extract<
  ResolvedEtfRotationConfig,
  { strategyId: "etf-risk-budget" }
>;

export type EtfRotationDecisionRow = Readonly<{
  symbol: string;
  momentum: number | null;
  rank: number | null;
  sma: number | null;
  volatility: number | null;
  baseWeight: number;
  targetWeight: number;
  reason:
    | "missing-history"
    | "zero-volatility"
    | "below-trend"
    | "rank-cutoff"
    | "same-index"
    | "selected"
    | "retained"
    | "defense"
    | "allocated"
    | "static-exclusion";
}>;

type Candidate = {
  symbol: string;
  indexGroup: string;
  closes: readonly (number | null)[];
};
type Ranked = { candidate: Candidate; score: number };
type Allocation = {
  rows: Record<string, EtfRotationDecisionRow>;
  selected: string[];
};

export const defensiveEtf = "sh511010";
export const riskBudgetEtfs = ["sh510300", defensiveEtf, "sh518880"] as const;

export function lookback(config: ResolvedEtfRotationConfig) {
  switch (config.strategyId) {
    case "etf-dual-momentum":
      return Math.max(
        config.momentumWindow + 1,
        config.trend.kind === "sma" ? config.trend.window : 1,
      );
    case "etf-sector-rotation":
      return config.momentumWindows.reduce((max, n) => Math.max(max, n + 1), 1);
    case "etf-risk-budget":
      return Math.max(
        config.mode === "inverse-vol" ? config.volatilityWindow + 1 : 1,
        config.trendWindow ?? 1,
      );
  }
}

function window(candidate: Candidate, sessions: number) {
  const values = candidate.closes.slice(-sessions);
  return values.length === sessions && values.every((close) => close !== null)
    ? values
    : null;
}

const closeOf = (candidate: Candidate) => candidate.closes.at(-1) ?? null;
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);

function momentum(candidate: Candidate, sessions: number) {
  const closes = window(candidate, sessions + 1);
  if (!closes) return null;
  const value = closes.at(-1)! / closes[0]! - 1;
  return Number.isFinite(value) ? value : null;
}

function sma(candidate: Candidate, sessions: number) {
  const closes = window(candidate, sessions);
  return closes ? mean(closes) : null;
}

function volatility(candidate: Candidate, sessions: number) {
  const closes = window(candidate, sessions + 1);
  if (!closes) return null;
  const returns = closes.slice(1).map((close, i) => close / closes[i]! - 1);
  if (returns.every((value) => value === returns[0])) return 0;
  const average = mean(returns);
  const sample = Math.sqrt(
    returns.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (returns.length - 1),
  );
  return Number.isFinite(sample) ? sample : null;
}

function initialRows(candidates: readonly Candidate[]) {
  return Object.fromEntries(
    candidates.map(({ symbol }) => [
      symbol,
      {
        symbol,
        momentum: null,
        rank: null,
        sma: null,
        volatility: null,
        baseWeight: 0,
        targetWeight: 0,
        reason: "missing-history",
      } satisfies EtfRotationDecisionRow,
    ]),
  ) as Allocation["rows"];
}

function rank(rows: Ranked[]) {
  return rows.sort(
    (a, b) =>
      b.score - a.score || a.candidate.symbol.localeCompare(b.candidate.symbol),
  );
}

function addDefense(
  rows: Allocation["rows"],
  candidates: readonly Candidate[],
  defense: "treasury" | "cash",
  weight: number,
  cap = 1,
  requireVolatility = false,
) {
  const treasury = candidates.find(({ symbol }) => symbol === defensiveEtf);
  if (defense !== "treasury" || !treasury || closeOf(treasury) === null) return;
  const row = rows[defensiveEtf]!;
  if (requireVolatility && !(row.volatility && row.volatility > 0)) return;
  const added = Math.min(weight, Math.max(0, cap - row.targetWeight));
  if (added > 0)
    rows[defensiveEtf] = {
      ...row,
      targetWeight: row.targetWeight + added,
      reason: "defense",
    };
}

function assignSlots(
  rows: Allocation["rows"],
  selected: readonly string[],
  topK: number,
  retained: ReadonlySet<string>,
) {
  for (const symbol of selected)
    rows[symbol] = {
      ...rows[symbol]!,
      baseWeight: 1 / topK,
      targetWeight: 1 / topK,
      reason: retained.has(symbol) ? "retained" : "selected",
    };
}

export function dualMomentumDecision(
  candidates: readonly Candidate[],
  config: Dual,
): Allocation {
  const rows = initialRows(candidates);
  const eligible: Ranked[] = [];
  for (const candidate of candidates) {
    const { symbol } = candidate;
    if (symbol === defensiveEtf) continue;
    const score = momentum(candidate, config.momentumWindow);
    const average =
      config.trend.kind === "sma" ? sma(candidate, config.trend.window) : null;
    rows[symbol] = { ...rows[symbol]!, momentum: score, sma: average };
    if (score === null || (config.trend.kind === "sma" && average === null))
      continue;
    const passes = average === null ? score > 0 : closeOf(candidate)! > average;
    rows[symbol] = {
      ...rows[symbol]!,
      reason: passes ? "rank-cutoff" : "below-trend",
    };
    if (passes) eligible.push({ candidate, score });
  }
  const groups = new Set<string>();
  const selected: string[] = [];
  for (const [
    index,
    {
      candidate: { symbol, indexGroup },
    },
  ] of rank(eligible).entries()) {
    rows[symbol] = { ...rows[symbol]!, rank: index + 1 };
    if (groups.has(indexGroup)) {
      rows[symbol] = { ...rows[symbol]!, reason: "same-index" };
    } else if (selected.length < config.topK) {
      selected.push(symbol);
      groups.add(indexGroup);
    }
  }
  assignSlots(rows, selected, config.topK, new Set());
  addDefense(
    rows,
    candidates,
    config.defense,
    (config.topK - selected.length) / config.topK,
  );
  return { rows, selected };
}

export function sectorRotationDecision(
  candidates: readonly Candidate[],
  config: Sector,
  previous: readonly string[],
): Allocation {
  const rows = initialRows(candidates);
  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    const { symbol } = candidate;
    if (symbol === defensiveEtf) continue;
    const returns = config.momentumWindows.map((n) => momentum(candidate, n));
    if (!returns.every((value) => value !== null)) continue;
    const score = mean(returns);
    rows[symbol] = { ...rows[symbol]!, momentum: score, reason: "rank-cutoff" };
    ranked.push({ candidate, score });
  }
  const eligible = rank(ranked).flatMap(
    ({ candidate: { symbol }, score }, i) => {
      const passes = !config.requirePositiveMomentum || score > 0;
      rows[symbol] = {
        ...rows[symbol]!,
        rank: i + 1,
        reason: passes ? "rank-cutoff" : "below-trend",
      };
      return passes ? [symbol] : [];
    },
  );
  const retained = new Set(
    eligible.filter(
      (symbol) =>
        previous.includes(symbol) &&
        rows[symbol]!.rank! <= config.topK + config.exitRankBuffer,
    ),
  );
  const selected = [...retained];
  for (const symbol of eligible.slice(0, config.topK)) {
    if (selected.length === config.topK) break;
    if (!retained.has(symbol)) selected.push(symbol);
  }
  assignSlots(rows, selected, config.topK, retained);
  addDefense(
    rows,
    candidates,
    config.defense,
    (config.topK - selected.length) / config.topK,
  );
  return { rows, selected };
}

export function riskBudgetDecision(
  candidates: readonly Candidate[],
  config: Risk,
): Allocation {
  const rows = initialRows(candidates);
  for (const candidate of candidates) {
    const { symbol } = candidate;
    if (config.mode === "inverse-vol") {
      const vol = volatility(candidate, config.volatilityWindow);
      rows[symbol] = {
        ...rows[symbol]!,
        volatility: vol,
        reason: vol === 0 ? "zero-volatility" : "missing-history",
      };
    } else if (symbol === "sh518880") {
      rows[symbol] = { ...rows[symbol]!, reason: "static-exclusion" };
    }
  }
  const positiveVols = Object.values(rows).flatMap(({ volatility }) =>
    volatility !== null && volatility > 0 ? [volatility] : [],
  );
  // minVol / vol gives the same weights as 1 / vol without overflow.
  const minVol = Math.min(...positiveVols);
  const total = positiveVols.reduce((sum, vol) => sum + minVol / vol, 0);
  let released = 0;
  for (const candidate of candidates) {
    const { symbol } = candidate;
    const row = rows[symbol]!;
    const closingPrice = closeOf(candidate);
    if (closingPrice === null) continue;
    let base = 0;
    if (config.mode === "static-60-40") {
      if (symbol === "sh518880") continue;
      base = symbol === defensiveEtf ? 0.4 : 0.6;
    } else if (row.volatility !== null && row.volatility > 0) {
      base = minVol / row.volatility / total;
    }
    if (base === 0) continue;
    const trendRequired =
      config.trendWindow !== null && symbol !== defensiveEtf;
    const average = trendRequired ? sma(candidate, config.trendWindow!) : null;
    const missingTrend = trendRequired && average === null;
    const belowTrend = average !== null && closingPrice < average;
    const riskWeight = missingTrend ? 0 : belowTrend ? base / 2 : base;
    const targetWeight = Math.min(riskWeight, config.maxEtfWeight);
    released += Math.min(base, config.maxEtfWeight) - targetWeight;
    rows[symbol] = {
      ...row,
      baseWeight: base,
      targetWeight,
      sma: average,
      reason: missingTrend
        ? "missing-history"
        : belowTrend
          ? "below-trend"
          : "allocated",
    };
  }
  addDefense(
    rows,
    candidates,
    config.defense,
    released,
    config.maxEtfWeight,
    config.mode === "inverse-vol",
  );
  return {
    rows,
    selected: Object.values(rows)
      .filter(({ targetWeight }) => targetWeight > 0)
      .map(({ symbol }) => symbol),
  };
}
