import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { atomic, get, put, sqlite } from "../../db";
import { inspectFullDayPackage } from "./tdx-full-day-import";
import { isLocalFund } from "./tdx";
const fundDecoderVersion = "tdx-full-day-fund-3-v1";

type Pointer = {
  snapshotId: string;
  importedAt: number;
  repairSameDate?: boolean;
};
const pointerId = (symbol: string) => `tdx-full-day-current-${symbol}`;
export function fullDayRepairsSameDate(symbol: string) {
  symbolSchema.parse(symbol);
  return get<Pointer>(pointerId(symbol))?.repairSameDate === true;
}
export function fullDaySymbols() {
  const rows = sqlite()
    .prepare(
      "SELECT id FROM records WHERE kind='tdx-full-day-current' ORDER BY id",
    )
    .all() as { id: string }[];
  return rows.map(({ id }) =>
    symbolSchema.parse(id.slice("tdx-full-day-current-".length)),
  );
}

export function readFullDaySnapshot(symbol: string) {
  symbolSchema.parse(symbol);
  const pointer = get<Pointer>(pointerId(symbol));
  if (!pointer) return null;
  const snapshot = get<Snapshot>(pointer.snapshotId);
  if (
    !snapshot ||
    snapshot.symbol !== symbol ||
    snapshot.period !== "day" ||
    snapshot.source !== "tdx-full-package" ||
    !snapshot.bars.length
  )
    throw new Error("完整日线缓存证据不完整");
  // 旧基金缓存按两位精度解码；不能在三位精度修复后继续消费。
  if (
    isLocalFund(symbol) &&
    !snapshot.sourceVersions?.includes(fundDecoderVersion)
  )
    return null;
  return snapshot;
}

/** Import is atomic across the requested batch. Nothing is written to TDX. */
export async function publishFullDayPackage(
  path: string,
  symbols: string[],
  importedAt = Date.now(),
  repairSameDate = false,
) {
  if (!Number.isSafeInteger(importedAt) || importedAt <= 0)
    throw new Error("完整包导入时间无效");
  const parsed = await inspectFullDayPackage(path, symbols);
  if (parsed.missing.length)
    throw new Error(`完整包缺少所选证券：${parsed.missing.join("、")}`);
  return atomic(() => {
    const snapshots: Snapshot[] = [];
    for (const record of parsed.records) {
      const previousPointer = get<Pointer>(pointerId(record.symbol));
      const previous = readFullDaySnapshot(record.symbol);
      const hash = createHash("sha256")
        .update(
          `${isLocalFund(record.symbol) ? fundDecoderVersion : "tdx-full-day-1"}:${record.symbol}:${record.hash}`,
        )
        .digest("hex");
      const id = `tdx-full-day-${record.symbol}-${hash}`;
      if (previousPointer && previousPointer.importedAt > importedAt)
        throw new Error(`${record.symbol}已有更新的完整包导入`);
      if (previous && previous.bars.at(-1)!.date > record.bars.at(-1)!.date)
        throw new Error(`${record.symbol}完整包日期早于当前缓存，未回退`);
      if (
        previousPointer?.importedAt === importedAt &&
        previousPointer.snapshotId !== id
      )
        throw new Error(`${record.symbol}同一导入时点出现冲突版本`);
      const snapshot =
        get<Snapshot>(id) ??
        put("tdx-full-day-snapshot", id, {
          id,
          symbol: record.symbol,
          period: "day",
          adjustment: "none",
          source: "tdx-full-package",
          createdAt: importedAt,
          hash,
          bars: record.bars,
          sourceVersions: isLocalFund(record.symbol)
            ? [id, fundDecoderVersion]
            : [id],
          volumeUnit: "通达信原始单位",
        } satisfies Snapshot);
      put("tdx-full-day-current", pointerId(record.symbol), {
        snapshotId: id,
        importedAt,
        repairSameDate,
      } satisfies Pointer);
      snapshots.push(snapshot);
    }
    return snapshots;
  });
}
