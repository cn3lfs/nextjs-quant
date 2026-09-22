import { parseBars } from "./tdx";
import { historicalDateSchema } from "~/lib/historical-screen";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import {
  readFullDaySnapshot,
  fullDayRepairsSameDate,
} from "./tdx-full-day-cache";

/** Benchmark returns use a bounded warmup; strategy indicator histories do not. */
export function parseBenchmarkWindow(
  bytes: Buffer,
  start: string,
  end: string,
) {
  historicalDateSchema.parse(start);
  historicalDateSchema.parse(end);
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

export async function readBenchmarkSnapshot(
  root: string,
  start: string,
  end: string,
): Promise<Snapshot> {
  historicalDateSchema.parse(start);
  historicalDateSchema.parse(end);
  if (start > end) throw new Error("基准日期区间无效");
  let local: Snapshot | undefined;
  let failure: unknown;
  try {
    const path = join(resolve(root), "vipdoc/sh/lday/sh000001.day");
    const before = await stat(path),
      bytes = await readFile(path),
      after = await stat(path);
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("基准读取期间发生变化");
    const hash = createHash("sha256").update(bytes).digest("hex");
    local = {
      id: `benchmark-${hash}`,
      symbol: "sh000001",
      period: "day",
      source: "tdx-local",
      adjustment: "none",
      createdAt: Date.now(),
      hash,
      bars: parseBenchmarkWindow(bytes, start, end),
    };
  } catch (error) {
    failure = error;
  }
  const cached = readFullDaySnapshot("sh000001");
  if (cached) {
    const endBars = cached.bars.filter((bar) => bar.date <= end);
    const first = endBars.findIndex((bar) => bar.date >= start);
    const bars = endBars.slice(
      Math.max(0, (first < 0 ? endBars.length : first) - 250),
    );
    if (
      bars.length &&
      (!local?.bars.length ||
        bars.at(-1)!.date > local.bars.at(-1)!.date ||
        (bars.at(-1)!.date === local.bars.at(-1)!.date &&
          fullDayRepairsSameDate("sh000001")))
    )
      return {
        ...cached,
        bars,
        dataRoot: resolve(root),
        sourceNote: "上证基准使用完整包缓存",
      };
  }
  if (local) return local;
  throw failure ?? new Error("缺少基准日线");
}
