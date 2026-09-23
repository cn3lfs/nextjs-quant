import type { Bar } from "../domain";

export const horizons = [5, 10, 20] as const;
export type Horizon = (typeof horizons)[number];
export type LedgerSignal = {
  id: string;
  strategy: "czsc" | "dual-breakout";
  symbol: string;
  observedDate: string;
  endpointDate: string;
  direction: "long" | "short";
  quality: string;
  score: number;
  evidence: string;
  invalidation: string;
  snapshotHash: string;
  strategyVersion: string;
  dllVersion: string | null;
  source: "tdx-local";
};
export type ActionEvidence = {
  dates: string[];
  source: string;
  // GBBQ is the market-wide event library; its latest event bounds coverage.
  coverageEnd?: string | null;
};
export type Outcome = {
  horizon: Horizon;
  settled: boolean;
  entryDate: string | null;
  exitDate: string | null;
  entry: number | null;
  exit: number | null;
  returnPct: number | null;
  action: "含除权，收益不可比" | "除权状态未知" | "区间无除权";
  reasons: string[];
  calendarSource: string;
  actionSource: string;
  actionCoverageEnd?: string | null;
};
export type LedgerRow = LedgerSignal & { outcomes: Outcome[] };

export function ledgerOutcome(
  signal: LedgerSignal,
  horizon: Horizon,
  bars: readonly Bar[],
  days: readonly string[],
  calendarSource: string,
  actions: ActionEvidence,
  completedThrough: string,
): Outcome {
  const calendar = [...new Set(days)].sort();
  const index = calendar.indexOf(signal.observedDate);
  const entryDate = index < 0 ? null : (calendar[index + 1] ?? null);
  const exitDate = index < 0 ? null : (calendar[index + horizon] ?? null);
  const out: Outcome = {
    horizon,
    settled: false,
    entryDate,
    exitDate,
    entry: null,
    exit: null,
    returnPct: null,
    action: "除权状态未知",
    reasons: [],
    calendarSource,
    actionSource: actions.source,
    actionCoverageEnd: actions.coverageEnd ?? null,
  };
  if (index < 0) {
    out.reasons.push("交易日历缺少信号日");
    return out;
  }
  if (!exitDate || exitDate > completedThrough) {
    out.reasons.push(exitDate ? "T+N K线未完成" : "T+N未到期或交易日历不足");
    return out;
  }
  // Freeze the first due observation, including blanks, so late corrections or
  // future bars cannot silently rewrite the recorded forward experiment.
  out.settled = true;
  const window = calendar.slice(index + 1, index + horizon + 1);
  const byDate = new Map(
    bars.filter((b) => b.date <= exitDate).map((b) => [b.date, b]),
  );
  if (window.some((d) => !byDate.has(d)))
    out.reasons.push("持有区间行情缺失（可能停牌，不顺延）");
  if (window.some((d) => byDate.get(d)?.volume === 0))
    out.reasons.push("持有区间停牌或零成交");
  const entry = byDate.get(entryDate!)?.open;
  const exit = byDate.get(exitDate)?.close;
  out.entry = entry && Number.isFinite(entry) && entry > 0 ? entry : null;
  out.exit = exit && Number.isFinite(exit) && exit > 0 ? exit : null;
  if (out.entry === null || out.exit === null)
    out.reasons.push("入场或出场价格缺失/非法");
  // Include entry day conservatively: user requires any ex-date in the holding interval.
  if (actions.dates.some((d) => d >= entryDate! && d <= exitDate)) {
    out.action = "含除权，收益不可比";
    out.reasons.push(out.action);
  } else if (actions.coverageEnd && actions.coverageEnd >= exitDate) {
    out.action = "区间无除权";
  } else out.reasons.push(out.action);
  // Price change for BOTH directions. A short observation is not an executable
  // short portfolio; do not fabricate a short-selling P&L or reverse its sign.
  if (!out.reasons.length) out.returnPct = (out.exit! / out.entry! - 1) * 100;
  return out;
}

export function aggregateLedger(rows: readonly LedgerRow[]) {
  const groups = new Map<
    string,
    { strategy: LedgerSignal["strategy"]; quality: string; rows: LedgerRow[] }
  >();
  for (const row of rows) {
    const key = `${row.strategy}:${row.quality}`;
    const group = groups.get(key) ?? {
      strategy: row.strategy,
      quality: row.quality,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) =>
      `${a.strategy}:${a.quality}`.localeCompare(`${b.strategy}:${b.quality}`),
    )
    .flatMap((group) =>
      horizons.map((horizon) => {
        const outcomes = group.rows.map((r) =>
          r.outcomes.find((o) => o.horizon === horizon),
        );
        const values = outcomes
          .flatMap((o) => (o?.returnPct != null ? [o.returnPct] : []))
          .sort((a, b) => a - b);
        const wins = values.filter((v) => v > 0),
          losses = values.filter((v) => v < 0);
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
        const mid = Math.floor(values.length / 2);
        const reasons: Record<string, number> = {};
        for (const o of outcomes)
          if (!o || o.returnPct === null) {
            for (const reason of o?.reasons ?? ["等待回填"])
              reasons[reason] = (reasons[reason] ?? 0) + 1;
          }
        return {
          strategy: group.strategy,
          quality: group.quality,
          horizon,
          samples: group.rows.length,
          valid: values.length,
          blanks: group.rows.length - values.length,
          median: values.length
            ? values.length % 2
              ? values[mid]!
              : (values[mid - 1]! + values[mid]!) / 2
            : null,
          winRate: values.length ? (wins.length / values.length) * 100 : null,
          payoff:
            wins.length && losses.length
              ? mean(wins) / Math.abs(mean(losses))
              : null,
          reasons,
        };
      }),
    );
}
