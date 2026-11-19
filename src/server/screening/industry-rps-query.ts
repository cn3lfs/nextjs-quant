import { type RpsRow, type RpsValue } from "quant-rps";
import { sortTableRows } from "~/lib/common/server-sort";
import { industryPageSchema } from "~/lib/screening/industry-rps";
import type { RpsDay } from "~/lib/screening/rps";
import { RpsStore } from "../db/rps-store";
import type { RpsObservation } from "./rps-observation";

/**
 * Decode each published vector once, then read the display period and every
 * condition period from that same batch. Periods absent from the batch simply
 * have no map, so a condition can never borrow a value from another day.
 */
function valueMaps(
  rows: readonly RpsRow[],
  day: RpsDay,
  periods: readonly number[],
) {
  const indexes = new Map(periods.map((p) => [p, day.periods.indexOf(p)]));
  const maps = new Map(periods.map((p) => [p, new Map<string, RpsValue>()]));
  for (const row of rows)
    for (const [period, index] of indexes) {
      if (index < 0) continue;
      const value = row.values[index];
      if (value) maps.get(period)!.set(row.symbol, value);
    }
  return maps;
}

/** All ordering and pagination stay server-side, including unranked industries. */
export function industryRpsPage(
  store: RpsStore,
  input: unknown,
  observation?: RpsObservation | null,
) {
  const query = industryPageSchema.parse(input);
  const stored = query.date ? store.day(query.date) : store.latest();
  const group =
    !query.date &&
    observation &&
    store.target !== "stock" &&
    (!stored ||
      observation.date > stored.date ||
      (observation.date === stored.date &&
        observation.createdAt > stored.createdAt))
      ? observation.groups[store.target]
      : undefined;
  const day = group?.day ?? stored;
  if (!day?.industry)
    return {
      day: null,
      ...(query.conditions.length
        ? {
            conditions: query.conditions.map((condition) => ({
              ...condition,
              count: null,
              periodMissing: true,
            })),
          }
        : {}),
      rows: [],
      total: 0,
    };
  const periods = [
    query.period,
    ...query.conditions.map((condition) => condition.period),
  ];
  const maps = valueMaps(group?.rows ?? store.rows(day.date), day, periods);
  const main = maps.get(query.period)!;
  const index = day.periods.indexOf(query.period);
  const files = new Map(day.industry.snapshot.files.map((f) => [f.name, f]));
  const ranked = day.industry.members
    .map((m) => {
      const conditionValues = query.conditions.length
        ? Object.fromEntries(
            query.conditions.map((condition) => [
              String(condition.period),
              maps.get(condition.period)!.get(m.name) ?? null,
            ]),
          )
        : undefined;
      return {
        ...m,
        value: main.get(m.name) ?? null,
        valid: m.included[index] ?? null,
        endpointMissing: m.missing[index] ?? null,
        reason: index < 0 ? ("period-unavailable" as const) : m.empty[index]!,
        file: files.get(m.name)!,
        ...(conditionValues ? { conditionValues } : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.value?.rank ?? Infinity) - (b.value?.rank ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
  // Missing values never match, even at threshold 0; filtering keeps each
  // value's original rank so the displayed RPS is never recomputed.
  const filtered = ranked.filter((row) =>
    query.conditions.every((condition) => {
      const rps = row.conditionValues?.[String(condition.period)]?.rps;
      return (
        rps !== null &&
        rps !== undefined &&
        (condition.side === "gte"
          ? rps >= condition.value
          : rps <= condition.value)
      );
    }),
  );
  const all = sortTableRows(filtered, query.order, {
    name: (row) => row.name,
    rank: (row) => row.value?.rank,
    members: (row) => row.total,
    coverage: (row) => row.total,
    excluded: (row) =>
      Object.values(row.excluded as Record<string, number>).reduce(
        (sum, n) => sum + (n ?? 0),
        0,
      ),
    source: (row) => row.file.file,
  });
  // Membership arrays are audit evidence, not a full-pool UI response.
  return {
    day: {
      date: day.date,
      mode: day.mode,
      count: day.counts[index] ?? null,
      hash: day.industry.snapshot.hash,
      root: day.industry.snapshot.root,
      classification:
        day.industry.snapshot.classification ??
        (store.target === "concept" ? "external-concept" : "sw-industry"),
      source: day.source,
    },
    ...(query.conditions.length
      ? {
          conditions: query.conditions.map((condition) => {
            const conditionIndex = day.periods.indexOf(condition.period);
            return {
              ...condition,
              count:
                conditionIndex < 0
                  ? null
                  : (day.counts[conditionIndex] ?? null),
              periodMissing: conditionIndex < 0,
            };
          }),
        }
      : {}),
    rows: all
      .slice(query.page * 20, (query.page + 1) * 20)
      .map(({ file, ...row }) => ({
        ...row,
        file: { file: file.file, hash: file.hash, mtimeMs: file.mtimeMs },
      })),
    total: all.length,
  };
}
