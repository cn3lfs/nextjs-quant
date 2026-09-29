import type { NavDiagnostic } from "./trade-review-nav";

/** Daily NAV diagnostics grouped by normalized reason, with day counts and range. */
export function groupNavDiagnostics(rows: readonly NavDiagnostic[]) {
  const groups = new Map<
    string,
    { reason: string; count: number; dates: Set<string> }
  >();
  for (const row of rows) {
    // Only the display key is normalized; exported diagnostic evidence stays exact.
    const reason = row.reason
      .replace(/\d{4}-\d{2}-\d{2}\s*/g, "")
      .replace(/期初净值非正（[^）]*）/g, "期初净值非正")
      .replace(/资金流水 \d+/g, "资金流水")
      .replace(/原始行 \d+/g, "原始行");
    const group = groups.get(reason) ?? {
      reason,
      count: 0,
      dates: new Set<string>(),
    };
    group.count++;
    group.dates.add(row.date);
    groups.set(reason, group);
  }
  return [...groups.values()].map((g) => {
    const dates = [...g.dates].sort();
    return `${g.reason}：${dates.length} 天 / ${g.count} 条（${dates[0]} 至 ${dates.at(-1)}）`;
  });
}
