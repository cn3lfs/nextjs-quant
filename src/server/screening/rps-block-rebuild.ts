import { rpsGroupExclusions, rankRps, type RpsRow } from "quant-rps";
import type { BlockEligibility } from "~/lib/market/block-eligibility";

import { type RpsDay } from "~/lib/screening/rps";
import { filterBlockSnapshot } from "../market/block-eligibility";
import { rpsHash } from "../infra/content-hash";

export type BlockRpsGroup = { day: RpsDay; rows: RpsRow[] };

/** Keep every historical return/null and membership; recompute only the population ranks. */
export function rebuildBlockRps(
  group: BlockRpsGroup,
  policy: BlockEligibility,
): BlockRpsGroup {
  const { day } = group;
  if (!day.industry) throw new Error("只能重算板块，不能修改个股 RPS");
  const snapshot = filterBlockSnapshot(day.industry.snapshot, policy);
  if (snapshot === day.industry.snapshot) return group;
  const originalNames = new Set(
    day.industry.snapshot.files.map((file) => file.name),
  );
  if (
    group.rows.length !== originalNames.size ||
    new Set(group.rows.map((row) => row.symbol)).size !== group.rows.length ||
    group.rows.some(
      (row) =>
        !originalNames.has(row.symbol) ||
        row.values.length !== day.periods.length,
    )
  )
    throw new Error("历史板块向量与成分快照不一致，拒绝重算");
  const allowed = new Set(snapshot.files.map((file) => file.name));
  const retained = group.rows.filter((row) => allowed.has(row.symbol));
  const rankings = day.periods.map((_, index) =>
    rankRps(
      retained.flatMap((row) => {
        const value = row.values[index];
        return value ? [{ symbol: row.symbol, return: value.return }] : [];
      }),
    ),
  );
  const rows = retained.map((row) => ({
    symbol: row.symbol,
    values: rankings.map((rank) => rank.get(row.symbol) ?? null),
  }));
  const members = day.industry.members.filter((member) =>
    allowed.has(member.name),
  );
  if (
    members.length !== allowed.size ||
    new Set(members.map((member) => member.name)).size !== allowed.size
  )
    throw new Error("历史板块审计不完整，拒绝重算");
  const excluded = { ...day.industry.excluded };
  for (const reason of rpsGroupExclusions)
    excluded[reason] = members.reduce(
      (sum, member) => sum + member.excluded[reason],
      0,
    );
  return {
    rows,
    day: {
      ...day,
      total: rows.length,
      pool: rows.filter((row) => row.values.some((value) => value !== null))
        .length,
      counts: rankings.map((rank) => rank.size),
      missing: rankings.map((rank) => rows.length - rank.size),
      industry: { ...day.industry, snapshot, members, excluded },
      inputHash: rpsHash({
        previous: day.inputHash,
        selection: policy.hash,
        rows,
      }),
    },
  };
}
