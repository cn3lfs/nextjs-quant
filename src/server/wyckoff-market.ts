import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { Snapshot } from "~/lib/domain";
import { parseBars } from "./tdx";
import { completedBarFilter } from "./screening";
import { wyckoffRelativeStrength } from "./wyckoff-relative-strength";
import type { wyckoffFrames } from "./wyckoff-frames";
const signature = (s: Stats) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.birthtimeMs].join(":");

export function wyckoffMarketForReport(
  data: Awaited<ReturnType<typeof gatherWyckoffMarket>>,
  frames: ReturnType<typeof wyckoffFrames>,
) {
  if (
    data.benchmark.symbol !== "sh000300" ||
    !/^[a-f0-9]{64}$/.test(data.rawHash)
  )
    throw new Error("威科夫市场基准身份或来源哈希无效");
  const stock: Snapshot = {
    id: frames.daily.sourceId,
    source: frames.daily.source,
    symbol: frames.symbol,
    period: "day",
    adjustment: "none",
    createdAt: frames.cutoff,
    historicalAsOf: frames.asOf,
    hash: frames.hash,
    bars: frames.daily.bars,
  };
  const expected = wyckoffRelativeStrength(
    stock,
    data.benchmark,
    frames.daily.bars[0]!.date,
    frames.asOf,
  );
  if (JSON.stringify(expected) !== JSON.stringify(data.relativeStrength))
    throw new Error("威科夫市场RS与报告行情窗口不一致");
  return {
    rawHash: data.rawHash,
    benchmark: {
      id: data.benchmark.id,
      symbol: data.benchmark.symbol,
      source: data.benchmark.source,
      period: data.benchmark.period,
      adjustment: data.benchmark.adjustment,
      bars: data.benchmark.bars,
    },
    relativeStrength: expected,
    industry: {
      status: "missing",
      reason: "尚无已核验行业归属及同日期行业指数",
    },
    warnings: data.warnings,
  };
}

export async function gatherWyckoffMarket(
  source: Snapshot,
  root: string,
  now: number,
) {
  if (source.period !== "day" || !Number.isFinite(now))
    throw new Error("威科夫指数研究需要日线及有效截止时间");
  const completed = completedBarFilter("day", now);
  const stockBars = source.bars
    .filter(
      (bar) =>
        completed(bar.date) &&
        (!source.historicalAsOf || bar.date <= source.historicalAsOf),
    )
    .slice(-120);
  if (stockBars.length < 2)
    throw new Error("威科夫RS至少需要两个已完成日线观测");
  const start = stockBars[0]!.date,
    end = stockBars.at(-1)!.date;
  const path = join(root, "vipdoc", "sh", "lday", "sh000300.day");
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !before.size ||
      before.size % 32 ||
      before.size > 32 * 100000
    )
      throw new Error("沪深300本地日线文件长度无效");
    bytes = await handle.readFile();
    const after = await handle.stat(),
      current = await stat(path);
    if (
      bytes.length !== before.size ||
      signature(before) !== signature(after) ||
      signature(before) !== signature(current)
    )
      throw new Error("沪深300本地日线读取期间发生变化");
  } finally {
    await handle.close();
  }
  const rawHash = createHash("sha256").update(bytes).digest("hex");
  const bars = parseBars(bytes, "day").filter(
    (bar) => bar.date >= start && bar.date <= end,
  );
  const hash = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
  const benchmark: Snapshot = {
    id: `wyckoff-index-${hash}`,
    symbol: "sh000300",
    name: "沪深300",
    period: "day",
    adjustment: "none",
    source: "tdx-local/sh000300.day",
    createdAt: now,
    historicalAsOf: end,
    bars,
    hash,
  };
  const relativeStrength = wyckoffRelativeStrength(
    { ...source, bars: stockBars },
    benchmark,
    start,
    end,
  );
  return {
    version: "wyckoff-market-1",
    benchmark,
    rawHash,
    relativeStrength,
    industry: {
      status: "missing",
      reason: "尚无已核验行业归属及同日期行业指数",
    },
    warnings: [
      "本地固定沪深300文件作为市场基准，指数身份未做外部交叉核验",
      "基准点位与股票价格分别归一化，不是全市场RS排名",
      "历史序列为当前文件版本，不能证明历史时点已可获取；企业行动与流动性未核验",
    ],
  };
}
