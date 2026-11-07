import { parseBars } from "./quotes.js";
import { validateLocalDate } from "./types.js";
/** Benchmark returns use a bounded warmup; strategy indicator histories do not. */
export function parseBenchmarkWindow(
  bytes: Buffer,
  start: string,
  end: string,
) {
  validateLocalDate(start);
  validateLocalDate(end);
  if (start > end) throw new Error("基准日期区间无效");
  if (bytes.length % 32) throw new Error("研究基准日线记录不完整");
  const startDate = Number(start.replaceAll("-", ""));
  const endDate = Number(end.replaceAll("-", ""));
  let first = 0,
    last = 0;
  while (
    first < bytes.length / 32 &&
    bytes.readUInt32LE(first * 32) < startDate
  )
    first++;
  while (last < bytes.length / 32 && bytes.readUInt32LE(last * 32) <= endDate)
    last++;
  return parseBars(
    bytes.subarray(Math.max(0, first - 250) * 32, last * 32),
    "day",
  );
}
