import {
  rankRps,
  isRpsMarketSymbol,
  rpsExclusions,
  rpsPeriods,
  type RpsExclusion,
  type RpsRow,
} from "./rps.js";

export type RpsGroup = { name: string; members: readonly string[] };

export const rpsGroupExclusions = [...rpsExclusions, "unavailable"] as const;
export type RpsGroupExclusion = (typeof rpsGroupExclusions)[number];
export type RpsGroupMemberAudit = {
  name: string;
  total: number;
  eligible: number;
  excluded: Record<RpsGroupExclusion, number>;
  included: number[];
  missing: number[];
  empty: ("empty-list" | "all-filtered" | "missing-endpoints" | null)[];
};

/** docs/rps-plan.md §3.5: each period averages only eligible, available returns. */
export function aggregateGroupRps(
  groups: readonly RpsGroup[],
  stock: { rows: RpsRow[]; excluded: Record<RpsExclusion, string[]> },
  periods: readonly number[] = rpsPeriods,
) {
  const rowsBySymbol = new Map(stock.rows.map((r) => [r.symbol, r]));
  const reasons = new Map<string, RpsGroupExclusion>();
  for (const reason of rpsExclusions)
    for (const symbol of stock.excluded[reason]) reasons.set(symbol, reason);
  const inputs = periods.map(() => [] as { symbol: string; return: number }[]);
  const counts = () =>
    Object.fromEntries(rpsGroupExclusions.map((key) => [key, 0])) as Record<
      RpsGroupExclusion,
      number
    >;
  const excluded = counts();
  const members = groups.map((file): RpsGroupMemberAudit => {
    const audit: RpsGroupMemberAudit = {
      name: file.name,
      total: file.members.length,
      eligible: 0,
      excluded: counts(),
      included: periods.map(() => 0),
      missing: periods.map(() => 0),
      empty: periods.map(() => null),
    };
    const sums = periods.map(() => 0);
    for (const symbol of file.members) {
      const row = rowsBySymbol.get(symbol);
      const reason =
        reasons.get(symbol) ??
        (!row ? (isRpsMarketSymbol(symbol) ? "unavailable" : "market") : null);
      if (reason) {
        audit.excluded[reason]++;
        excluded[reason]++;
        continue;
      }
      audit.eligible++;
      periods.forEach((_, i) => {
        const value = row!.values[i];
        if (value) {
          sums[i] = sums[i]! + value.return;
          audit.included[i] = audit.included[i]! + 1;
        } else audit.missing[i] = audit.missing[i]! + 1;
      });
    }
    periods.forEach((_, i) => {
      const n = audit.included[i]!;
      if (n) inputs[i]!.push({ symbol: file.name, return: sums[i]! / n });
      else
        audit.empty[i] = !file.members.length
          ? "empty-list"
          : !audit.eligible
            ? "all-filtered"
            : "missing-endpoints";
    });
    return audit;
  });
  const rankings = inputs.map(rankRps);
  return {
    rows: groups.map((f) => ({
      symbol: f.name,
      values: rankings.map((r) => r.get(f.name) ?? null),
    })),
    pool: members.filter((m) => m.included.some((n) => n > 0)).length,
    counts: inputs.map((v) => v.length),
    missing: periods.map(
      (_, i) => members.filter((m) => !m.included[i]).length,
    ),
    members,
    excluded,
  };
}
