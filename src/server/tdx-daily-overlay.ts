import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { readDailyIncrementRange } from "./tdx-daily-cache";

/** Only local, unadjusted day files use the same raw volume convention as MD1.
 * Online providers and historical research snapshots are not rewritten here. */
export function overlayDailyIncrements(
  source: Snapshot,
  today: string,
): Snapshot {
  if (
    !["tdx-local", "tdx-full-package"].includes(source.source) ||
    source.historicalAsOf !== undefined ||
    source.adjustment !== "none" ||
    source.period !== "day" ||
    !source.bars.length
  )
    return source;
  const increments = readDailyIncrementRange(
    source.symbol,
    source.bars[0]!.date,
    today,
  );
  if (!increments.length) return source;
  const bars = new Map(source.bars.map((bar) => [bar.date, bar]));
  for (const { record } of increments)
    bars.set(record.bar.date, { ...record.bar });
  const merged = [...bars.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const versions = [
    ...(source.sourceVersions ?? []),
    ...increments.map(({ snapshot }) => snapshot.id),
  ];
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: "tdx-daily-overlay-1",
        base: source.hash,
        versions,
        bars: merged,
      }),
    )
    .digest("hex");
  return {
    ...source,
    id: `snapshot-${source.symbol}-day-${hash.slice(0, 20)}`,
    hash,
    bars: merged,
    source: `${source.source}+g4day`,
    volumeUnit: "通达信原始单位",
    sourceVersions: versions,
    sourceNote: `${source.source === "tdx-full-package" ? "完整包缓存" : "本地日线"}加通达信日线增量，共${increments.length}个日期；保留增量原始精度，缺失日期未补造`,
  };
}
