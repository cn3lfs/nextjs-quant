import { isCnEtfSymbol } from "trading-strategy-core/costs";
import {
  etfRotationCatalog,
  etfRotationConfigSchema,
  type EtfRotationConfig,
  type ResolvedEtfRotationConfig,
  type EtfRotationStrategyId,
} from "./catalog.js";
import {
  defensiveEtf,
  dualMomentumDecision,
  lookback,
  riskBudgetDecision,
  riskBudgetEtfs,
  sectorRotationDecision,
  type EtfRotationDecisionRow,
} from "./rules.js";
import { etfRotationUniverse, type EtfRotationInstrument } from "./universe.js";

export {
  etfDualMomentum,
  etfRiskBudget,
  etfSectorRotation,
} from "./catalog.js";
export { etfRotationCatalog, etfRotationConfigSchema };
export type {
  EtfRotationConfig,
  ResolvedEtfRotationConfig,
  EtfRotationStrategyId,
};
export {
  etfRotationUniverse,
  type EtfAssetClass,
  type EtfRotationInstrument,
} from "./universe.js";
export type { EtfRotationDecisionRow };

export type EtfRotationClose = Readonly<{ date: string; close: number }>;
export type EtfRotationPriceBasis =
  "gbbq-first-raw-anchor-1" | "causal-cny-forward";
export type EtfRotationInput = Readonly<{
  /** Ordered Shanghai sessions, including warmup and the first next-month
   * session when confirming a month-end. Dates carry no price information. */
  calendar: readonly string[];
  start: string;
  end: string;
  /** Completed domestic CNY closes on a fixed causal adjustment basis. */
  closes: Readonly<Partial<Record<string, readonly EtfRotationClose[]>>>;
  priceBasis: EtfRotationPriceBasis;
  universe?: readonly EtfRotationInstrument[];
}>;

export type EtfRotationDecisionEvidence = Readonly<{
  version: number;
  priceBasis: EtfRotationPriceBasis;
  lookbackFrom: string;
  previousSelected: readonly string[];
  rows: readonly EtfRotationDecisionRow[];
  holdRankLimit: number | null;
  cashWeight: number;
  maxEtfWeight: number;
  changedTargets: boolean;
  qdii: Readonly<{
    symbols: readonly string[];
    signalPrice: "completed-domestic-cny-close";
    premiumDiscount: "unobserved";
    premiumDiscountRisk: "domestic-price-may-diverge-from-overseas-nav";
    iopv: "unobserved";
    usesOverseasClose: false;
  }>;
}>;

export type TargetSnapshot = Readonly<{
  strategyId: EtfRotationStrategyId;
  date: string;
  availableAt: string;
  sourceHash: string;
  targets: Readonly<Record<string, number>>;
  scores: Readonly<Record<string, number>>;
  evidence: EtfRotationDecisionEvidence;
}>;

export type EtfRotationSchedule = Readonly<{
  config: ResolvedEtfRotationConfig;
  universe: readonly EtfRotationInstrument[];
  snapshots: readonly TargetSnapshot[];
  /** Sector signals with unchanged target weights leave the existing book in place. */
  scheduledTargets: readonly TargetSnapshot[];
}>;

const compareSymbol = (a: EtfRotationInstrument, b: EtfRotationInstrument) =>
  a.symbol.localeCompare(b.symbol);

export function etfRotationUniverseFor(
  config: EtfRotationConfig,
  universe: readonly EtfRotationInstrument[] = etfRotationUniverse,
): readonly EtfRotationInstrument[] {
  const members = new Set<string>();
  for (const etf of universe) {
    if (
      !/^(sh|sz)\d{6}$/.test(etf.symbol) ||
      !isCnEtfSymbol(etf.symbol) ||
      members.has(etf.symbol) ||
      !etf.indexGroup.trim() ||
      etf.isCrossBorder !== (etf.assetClass === "cross_border")
    )
      throw new Error("Invalid ETF universe member: " + etf.symbol);
    members.add(etf.symbol);
  }
  return Object.freeze(
    universe
      .filter((etf) => {
        switch (config.strategyId) {
          case "etf-dual-momentum":
            return (
              etf.assetClass !== "sector" &&
              (config.pool !== "legacy-long-history" || etf.isLegacyLongHistory)
            );
          case "etf-sector-rotation":
            return etf.assetClass === "sector" || etf.symbol === defensiveEtf;
          case "etf-risk-budget":
            return riskBudgetEtfs.some((symbol) => symbol === etf.symbol);
        }
      })
      .sort(compareSymbol)
      .map((etf) => Object.freeze({ ...etf })),
  );
}

function validDay(value: string) {
  return (
    /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function indexCloses(
  input: EtfRotationInput,
  universe: readonly EtfRotationInstrument[],
) {
  const sessions = new Set(input.calendar);
  return new Map(
    universe.map(({ symbol }) => {
      const closes = new Map<string, number>();
      let previous = "";
      for (const { date, close } of input.closes[symbol] ?? []) {
        if (
          date <= previous ||
          !validDay(date) ||
          !Number.isFinite(close) ||
          close <= 0 ||
          (date >= input.calendar[0]! &&
            date <= input.end &&
            !sessions.has(date))
        )
          throw new Error(`Invalid ETF close: ${symbol} ${date}`);
        previous = date;
        closes.set(date, close);
      }
      return [symbol, closes] as const;
    }),
  );
}

async function sha256(value: string) {
  // Web Crypto hashes in memory and keeps the strategy usable in browser and Node.
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function generateEtfRotationTargets(
  requestedConfig: EtfRotationConfig,
  input: EtfRotationInput,
): Promise<EtfRotationSchedule> {
  const config = etfRotationConfigSchema.parse(requestedConfig);
  if (
    !validDay(input.start) ||
    !validDay(input.end) ||
    input.start > input.end ||
    !input.calendar.length ||
    input.calendar.some(
      (date, i) => !validDay(date) || (i > 0 && date <= input.calendar[i - 1]!),
    ) ||
    !["gbbq-first-raw-anchor-1", "causal-cny-forward"].includes(
      input.priceBasis,
    )
  )
    throw new Error(
      "Invalid ETF rotation calendar, range or signal price basis",
    );

  const { calendar } = input;
  const universe = etfRotationUniverseFor(config, input.universe);
  if (!universe.length) throw new Error("Empty ETF rotation universe");
  const closes = indexCloses(input, universe);
  const maxLookback = lookback(config);
  const sector = config.strategyId === "etf-sector-rotation";
  const maxEtfWeight =
    config.strategyId === "etf-risk-budget" ? config.maxEtfWeight : 1;
  const monthly =
    config.strategyId === "etf-risk-budget" || config.cadence === "month-end";
  const version = etfRotationCatalog.find(
    ({ id }) => id === config.strategyId,
  )!.version;
  const qdii = Object.freeze({
    symbols: Object.freeze(
      universe
        .filter(({ isCrossBorder }) => isCrossBorder)
        .map(({ symbol }) => symbol),
    ),
    signalPrice: "completed-domestic-cny-close",
    premiumDiscount: "unobserved",
    premiumDiscountRisk: "domestic-price-may-diverge-from-overseas-nav",
    iopv: "unobserved",
    usesOverseasClose: false,
  } as const);
  const pendingSnapshots: Promise<TargetSnapshot>[] = [];
  let previousSelected: readonly string[] = Object.freeze([]);
  let previousTargets: Readonly<Record<string, number>> | undefined;

  for (const [i, date] of calendar.entries()) {
    if (date < input.start) continue;
    if (date > input.end) break;
    const next = calendar[i + 1];
    if (monthly && (!next || next.slice(0, 7) === date.slice(0, 7))) continue;
    const dates = calendar.slice(Math.max(0, i + 1 - maxLookback), i + 1);
    const candidates = universe.map(({ symbol, indexGroup }) => ({
      symbol,
      indexGroup,
      closes: dates.map((day) => closes.get(symbol)!.get(day) ?? null),
    }));
    let decision;
    switch (config.strategyId) {
      case "etf-dual-momentum":
        decision = dualMomentumDecision(candidates, config);
        break;
      case "etf-sector-rotation":
        decision = sectorRotationDecision(candidates, config, previousSelected);
        break;
      case "etf-risk-budget":
        decision = riskBudgetDecision(candidates, config);
        break;
    }
    const rows = Object.freeze(
      Object.values(decision.rows).map((row) => Object.freeze(row)),
    );
    const allocated = rows.filter(({ targetWeight }) => targetWeight > 0);
    const targets = Object.freeze(
      Object.fromEntries(
        allocated.map(({ symbol, targetWeight }) => [symbol, targetWeight]),
      ),
    );
    const scores = Object.freeze(
      Object.fromEntries(
        allocated.map(({ symbol, momentum, targetWeight }) => [
          symbol,
          momentum ??
            (config.strategyId === "etf-risk-budget" ? targetWeight : -2),
        ]),
      ),
    );
    const changedTargets =
      previousTargets === undefined ||
      Object.keys(previousTargets).length !== allocated.length ||
      allocated.some(
        ({ symbol, targetWeight }) =>
          previousTargets?.[symbol] !== targetWeight,
      );
    const evidence: EtfRotationDecisionEvidence = Object.freeze({
      version,
      priceBasis: input.priceBasis,
      lookbackFrom: dates[0]!,
      previousSelected,
      rows,
      holdRankLimit: sector ? config.topK + config.exitRankBuffer : null,
      cashWeight: Math.max(
        0,
        1 - allocated.reduce((total, row) => total + row.targetWeight, 0),
      ),
      maxEtfWeight,
      changedTargets,
      qdii,
    });
    const draft = {
      strategyId: config.strategyId,
      date,
      availableAt: date,
      targets,
      scores,
      evidence,
    };
    // Only decisions and observations available by this close enter this hash.
    pendingSnapshots.push(
      sha256(JSON.stringify([config, universe, dates, candidates, draft])).then(
        (sourceHash) => Object.freeze({ ...draft, sourceHash }),
      ),
    );
    if (sector) previousSelected = Object.freeze(decision.selected);
    previousTargets = targets;
  }
  const snapshots = Object.freeze(await Promise.all(pendingSnapshots));
  if (config.strategyId === "etf-dual-momentum") Object.freeze(config.trend);
  if (sector) Object.freeze(config.momentumWindows);
  return Object.freeze({
    config: Object.freeze(config),
    universe,
    snapshots,
    // The portfolio compares each rebalance against actual holdings, including
    // missing positions from orders rejected at an earlier open.
    scheduledTargets: snapshots,
  });
}
