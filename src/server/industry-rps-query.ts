import { industryPageSchema } from "~/lib/industry-rps";
import { RpsStore } from "./rps-store";
import { observationRanking, type RpsObservation } from "./rps-observation";

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
  if (!day?.industry) return { day: null, rows: [], total: 0 };
  const index = day.periods.indexOf(query.period);
  const ranks = new Map(
    (group
      ? observationRanking(group, query.period)
      : store.ranking(day.date, query.period)
    ).map((r) => [r.symbol, r]),
  );
  const files = new Map(day.industry.snapshot.files.map((f) => [f.name, f]));
  const all = day.industry.members
    .map((m) => ({
      ...m,
      value: ranks.get(m.name) ?? null,
      valid: m.included[index]!,
      endpointMissing: m.missing[index]!,
      reason: m.empty[index]!,
      file: files.get(m.name)!,
    }))
    .sort(
      (a, b) =>
        (a.value?.rank ?? Infinity) - (b.value?.rank ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
  // Membership arrays are audit evidence, not a full-pool UI response.
  return {
    day: {
      date: day.date,
      mode: day.mode,
      count: day.counts[index]!,
      hash: day.industry.snapshot.hash,
      root: day.industry.snapshot.root,
      source: day.source,
    },
    rows: all
      .slice(query.page * 20, (query.page + 1) * 20)
      .map(({ file, ...row }) => ({
        ...row,
        file: { file: file.file, hash: file.hash, mtimeMs: file.mtimeMs },
      })),
    total: all.length,
  };
}
