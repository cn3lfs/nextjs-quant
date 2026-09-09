import type { Snapshot } from "~/lib/domain";
import type { ScreeningResult } from "./screening";

export type PackedScreen = Omit<ScreeningResult, "snapshots"> & {
  snapshots: (Omit<Snapshot, "bars"> & { offset: number; count: number })[];
  dates: string[];
  dateIndexes: Uint32Array<ArrayBuffer>;
  values: Float64Array<ArrayBuffer>;
};
type PackedBars = Pick<PackedScreen, "dates" | "dateIndexes" | "values"> & {
  offset: number;
  count: number;
};
const deferred = new WeakMap<
  Snapshot,
  PackedBars & { getter: () => Snapshot["bars"] }
>();
/** Only an untouched deferred bars property may use the columnar comparison. */
export function packedSnapshotBars(snapshot: Snapshot): PackedBars | undefined {
  const entry = deferred.get(snapshot);
  if (
    entry &&
    Object.getOwnPropertyDescriptor(snapshot, "bars")?.get === entry.getter
  )
    return entry;
  deferred.delete(snapshot);
}
/** Lossless IPC representation; this never changes stored snapshots or bar units. */
export function packScreen(result: ScreeningResult): PackedScreen {
  const count = result.snapshots.reduce(
    (sum, snapshot) => sum + snapshot.bars.length,
    0,
  );
  const values = new Float64Array(count * 6),
    dateIndexes = new Uint32Array(count);
  const dates: string[] = [],
    dateIds = new Map<string, number>();
  let cursor = 0;
  const snapshots = result.snapshots.map(({ bars, ...metadata }) => {
    const offset = cursor;
    for (const bar of bars) {
      let id = dateIds.get(bar.date);
      if (id === undefined) {
        id = dates.length;
        dates.push(bar.date);
        dateIds.set(bar.date, id);
      }
      dateIndexes[cursor] = id;
      const index = cursor++ * 6;
      values[index] = bar.open;
      values[index + 1] = bar.high;
      values[index + 2] = bar.low;
      values[index + 3] = bar.close;
      values[index + 4] = bar.volume;
      values[index + 5] = bar.amount;
    }
    return { ...metadata, offset, count: bars.length };
  });
  return { ...result, snapshots, dates, dateIndexes, values };
}
export function unpackScreen(
  packet: PackedScreen,
  lazy = false,
): ScreeningResult {
  const { dates, dateIndexes, values, snapshots, ...result } = packet;
  if (
    !(values instanceof Float64Array) ||
    !(dateIndexes instanceof Uint32Array) ||
    values.length !== dateIndexes.length * 6
  )
    throw new Error("选股计算结果传输不完整");
  for (const index of dateIndexes)
    if (typeof dates[index] !== "string") throw new Error("选股日期索引不合法");
  let consumed = 0;
  const restored = snapshots.map(({ offset, count, ...metadata }) => {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      offset !== consumed ||
      offset + count > dateIndexes.length
    )
      throw new Error("选股快照边界不合法");
    consumed += count;
    const restore = () => {
      const bars: Snapshot["bars"] = [];
      for (let row = offset; row < offset + count; row++) {
        const date = dates[dateIndexes[row]!],
          index = row * 6;
        bars.push({
          date: date!,
          open: values[index]!,
          high: values[index + 1]!,
          low: values[index + 2]!,
          close: values[index + 3]!,
          volume: values[index + 4]!,
          amount: values[index + 5]!,
        });
      }
      return bars;
    };
    if (!lazy) return { ...metadata, bars: restore() };
    const snapshot = { ...metadata } as Snapshot;
    const assign = (bars: Snapshot["bars"]) => {
      deferred.delete(snapshot);
      Object.defineProperty(snapshot, "bars", {
        value: bars,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return bars;
    };
    const getter = () => assign(restore());
    Object.defineProperty(snapshot, "bars", {
      enumerable: true,
      configurable: true,
      get: getter,
      set: assign,
    });
    deferred.set(snapshot, {
      dates,
      dateIndexes,
      values,
      offset,
      count,
      getter,
    });
    return snapshot;
  });
  if (consumed !== dateIndexes.length) throw new Error("选股快照长度不一致");
  return { ...result, snapshots: restored };
}
