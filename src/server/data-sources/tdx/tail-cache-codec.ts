import { serialize, deserialize } from "node:v8";
import type { Snapshot } from "~/lib/domain";

/** Internal cache for validated TDX bars; all six numeric fields remain Float64. */
export function encodeTail(snapshot: Snapshot): Buffer {
  const { bars, ...metadata } = snapshot;
  const values = new Float64Array(bars.length * 6);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!,
      offset = i * 6;
    values[offset] = bar.open;
    values[offset + 1] = bar.high;
    values[offset + 2] = bar.low;
    values[offset + 3] = bar.close;
    values[offset + 4] = bar.volume;
    values[offset + 5] = bar.amount;
  }
  return serialize({ metadata, dates: bars.map((bar) => bar.date), values });
}
export function decodeTail(payload: Buffer): Snapshot {
  const { metadata, dates, values } = deserialize(payload) as {
    metadata: Omit<Snapshot, "bars">;
    dates: string[];
    values: Float64Array;
  };
  if (
    !Array.isArray(dates) ||
    !(values instanceof Float64Array) ||
    values.length !== dates.length * 6
  )
    throw new Error("尾窗缓存数据不完整");
  return {
    ...metadata,
    bars: dates.map((date, i) => {
      if (typeof date !== "string") throw new Error("尾窗缓存日期不合法");
      const offset = i * 6;
      return {
        date,
        open: values[offset]!,
        high: values[offset + 1]!,
        low: values[offset + 2]!,
        close: values[offset + 3]!,
        volume: values[offset + 4]!,
        amount: values[offset + 5]!,
      };
    }),
  };
}
