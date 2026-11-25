import { dailyBarEpoch } from "../../theory-input.js";
import { orderCrossSection } from "../value/value-pit-strategies.js";

export type SentimentPhase =
  "ice" | "recovery" | "ferment" | "climax" | "ebb" | "unknown";

export type LimitPoolStatsSnapshot = {
  date: string;
  limitUp: number;
  broken: number;
  limitDown: number;
  breakRate: number | null;
  maxHeight: number;
  promotionRate: number | null;
  yesterdayAvgChange: number | null;
};

export type LimitPoolCandidateRow = {
  symbol: string;
  name: string;
  price: number;
  changePct: number | null;
  amount: number | null;
  turnover: number | null;
  industry: string;
  streak: number | null;
  breaks: number | null;
  sealFund: number | null;
};

const regimes = {
  ice: { phase: "ice", exposureScale: 0.3, allowNewEntries: false },
  ebb: { phase: "ebb", exposureScale: 0.2, allowNewEntries: false },
  climax: { phase: "climax", exposureScale: 0.6, allowNewEntries: false },
  ferment: { phase: "ferment", exposureScale: 1, allowNewEntries: true },
  recovery: { phase: "recovery", exposureScale: 0.75, allowNewEntries: true },
  unknown: { phase: "unknown", exposureScale: null, allowNewEntries: false },
} as const;

function classify(
  current: LimitPoolStatsSnapshot,
  previous?: LimitPoolStatsSnapshot,
): SentimentPhase {
  const {
    limitUp,
    limitDown,
    maxHeight,
    breakRate,
    promotionRate,
    yesterdayAvgChange,
  } = current;
  if (
    ![limitUp, current.broken, limitDown, maxHeight].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    ![breakRate, promotionRate].every(
      (n) => n === null || (Number.isFinite(n) && n >= 0 && n <= 100),
    ) ||
    (yesterdayAvgChange !== null && !Number.isFinite(yesterdayAvgChange))
  )
    return "unknown";
  if (limitUp <= 25 && (limitDown >= 15 || maxHeight <= 3)) return "ice";
  if (
    (breakRate !== null && breakRate >= 40) ||
    (limitDown >= 20 &&
      yesterdayAvgChange !== null &&
      yesterdayAvgChange <= -1.5) ||
    (previous &&
      Number.isSafeInteger(previous.maxHeight) &&
      previous.maxHeight >= 5 &&
      maxHeight <= previous.maxHeight - 2 &&
      promotionRate !== null &&
      promotionRate < 20)
  )
    return "ebb";
  if (limitUp >= 90 && maxHeight >= 5 && (breakRate === null || breakRate < 25))
    return "climax";
  if (breakRate === null) return "unknown";
  if (
    limitUp >= 50 &&
    maxHeight >= 4 &&
    promotionRate !== null &&
    promotionRate >= 25 &&
    breakRate < 35
  )
    return "ferment";
  if (limitUp >= 30 && breakRate < 38 && limitDown < 15) return "recovery";
  return "unknown";
}

/** Inputs are completed daily pool snapshots. Rates and changes use percentage points. */
export function evaluateSentimentRegime(
  history: readonly LimitPoolStatsSnapshot[],
  options?: { asOf?: string },
) {
  const asOf = options?.asOf;
  let previous: LimitPoolStatsSnapshot | undefined;
  let latest: LimitPoolStatsSnapshot | undefined;
  if (asOf !== undefined && dailyBarEpoch(asOf) === null)
    return { ...regimes.unknown };
  for (const snapshot of history) {
    if (asOf !== undefined && snapshot.date > asOf) continue;
    if (
      dailyBarEpoch(snapshot.date) === null ||
      (latest && snapshot.date <= latest.date)
    )
      return { ...regimes.unknown };
    previous = latest;
    latest = snapshot;
  }
  return { ...regimes[latest ? classify(latest, previous) : "unknown"] };
}

export function selectDragonForwardCandidates(input: {
  date: string;
  phase: SentimentPhase;
  ztPool: readonly LimitPoolCandidateRow[];
  yztPool: readonly LimitPoolCandidateRow[];
  maxCandidates?: number;
}) {
  const { date, phase, maxCandidates } = input;
  const base = { date, phase, forwardOnly: true as const };
  if (phase !== "recovery" && phase !== "ferment")
    return {
      ...base,
      candidates: [],
      reason: `情绪阶段 ${phase} 暂停新增候选`,
    };
  if (
    dailyBarEpoch(date) === null ||
    (maxCandidates !== undefined &&
      (!Number.isSafeInteger(maxCandidates) || maxCandidates < 0))
  )
    return { ...base, candidates: [], reason: "交易日期或候选数量无效" };
  const candidates = input.ztPool.filter(
    ({ streak, breaks, turnover, amount }) =>
      streak !== null &&
      Number.isSafeInteger(streak) &&
      streak >= 2 &&
      breaks !== null &&
      Number.isSafeInteger(breaks) &&
      breaks >= 0 &&
      breaks <= 1 &&
      turnover !== null &&
      turnover >= 5 &&
      turnover <= 35 &&
      amount !== null &&
      Number.isFinite(amount) &&
      amount >= 2e8,
  );
  const seal = (row: LimitPoolCandidateRow) =>
    Number.isFinite(row.sealFund) ? row.sealFund! : -Infinity;
  const ordered = orderCrossSection(
    candidates,
    (row) => -row.streak!,
    (row) => -seal(row),
  );
  return {
    ...base,
    candidates: ordered.slice(0, maxCandidates),
    reason: "仅供前向观察，历史涨停排队成交未经证实",
  };
}
