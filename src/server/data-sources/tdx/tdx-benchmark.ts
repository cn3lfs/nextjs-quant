import { resolveTdxRoot } from "tstdx/local";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import {
  readFullDaySnapshot,
  fullDayRepairsSameDate,
} from "~/server/market/bar-store/package-import";

import { parseBenchmarkWindow, readStableLocalFile } from "tstdx/local";
export { parseBenchmarkWindow } from "tstdx/local";
export async function readBenchmarkSnapshot(
  root: string,
  start: string,
  end: string,
): Promise<Snapshot> {
  researchDateSchema.parse(start);
  researchDateSchema.parse(end);
  if (start > end) throw new Error("基准日期区间无效");
  let local: Snapshot | undefined;
  let failure: unknown;
  try {
    const path = join(resolveTdxRoot(root), "vipdoc/sh/lday/sh000001.day");
    const before = await stat(path),
      bytes = (await readStableLocalFile(path)).body,
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
        dataRoot: root.trim() ? resolveTdxRoot(root) : "",
        sourceNote: "上证基准使用完整包缓存",
      };
  }
  if (local) return local;
  throw failure ?? new Error("缺少基准日线");
}
