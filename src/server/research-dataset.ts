import { readBenchmarkSnapshot } from "./tdx-benchmark";
import { needsCanslimMarket } from "~/lib/research-canslim-market-strategies";
import type { CanslimResearchMarket } from "./research-canslim-market-score";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { ResearchSpec } from "~/lib/strategy-research";
import { isRpsMarketSymbol } from "~/lib/rps";
import { settings } from "./settings";
import { readMarketPool } from "./market-pool-files";
import { scan, readSnapshot } from "./tdx";
import { assertGrowthIntradayWindow } from "~/lib/research-growth-intraday";
import { isOpening, openingMinuteStart } from "~/lib/research-opening";
import { readLocalDailySnapshot } from "./local-daily-snapshot";
import { readGbbq } from "./tdx-gbbq";
import {
  researchMethodSnapshot,
  type ResearchMethodSnapshot,
} from "./research-method";
// g4day 暂停：import { overlayDailyIncrements } from "./tdx-daily-overlay";

export const researchHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ResearchDataset = Omit<
  Awaited<ReturnType<typeof captureResearchDataset>>,
  "method"
> & {
  method?: ResearchMethodSnapshot;
};

export { parseBenchmarkWindow as parseResearchBenchmark } from "./tdx-benchmark";

export async function captureResearchDataset(
  spec: ResearchSpec,
  cancelled: () => boolean = () => false,
  progress: (symbol: string, count: number, total: number) => void = () => {},
) {
  if (spec.management?.growthIntraday)
    assertGrowthIntradayWindow(spec.start, spec.end);
  const config = settings(),
    root = resolve(config.tdxRoot);
  const pool = spec.pool
    ? await readMarketPool(config.industryBlocksRoot, spec.pool, config.tdxRoot)
    : null;
  const symbols = [
    ...new Set(
      spec.symbols ??
        pool?.members ??
        (await scan(root)).securities
          .filter((row) => row.period === "day")
          .map((row) => row.symbol),
    ),
  ]
    .filter(isRpsMarketSymbol)
    .sort();
  // g4day 暂停（见 docs/decisions.md WF3）：基准只读本地/完整包缓存快照。
  const benchmarkSource = await readBenchmarkSnapshot(
    root,
    spec.start,
    spec.end,
  );
  const benchmark = benchmarkSource.bars;
  if (!benchmark.some((bar) => bar.date >= spec.start))
    throw new Error("研究区间缺少上证指数基准行情");
  const calendar = benchmark.map((bar) => bar.date);
  const minuteStart =
    spec.management?.growthIntraday && isOpening(spec.management.growthIntraday)
      ? openingMinuteStart(calendar, spec.start)
      : spec.start;
  let canslimMarket: CanslimResearchMarket | undefined;
  if (
    needsCanslimMarket(spec.strategy) ||
    spec.management?.growthDaily === "CA-D-distribution5" ||
    spec.management?.growthDaily === "CA-P-add23"
  ) {
    const snapshot = await readLocalDailySnapshot(root, "sh000300");
    const marketBars = snapshot.bars.filter((bar) => bar.date <= spec.end);
    canslimMarket = {
      symbol: snapshot.symbol,
      source: snapshot.source,
      bars: marketBars,
      hash: researchHash(marketBars),
    };
  }
  let actions: Awaited<ReturnType<typeof readGbbq>> | null = null;
  try {
    actions = await readGbbq(root);
  } catch {
    /* Explicit missing metadata below. */
  }
  const stocks: {
    symbol: string;
    name: string;
    bars: Bar[];
    minuteBars?: Bar[];
    minuteSource?: {
      source: string;
      hash: string;
      start: string | null;
      end: string | null;
    };
    hash: string;
    source?: string;
    sourceVersions?: string[];
    actions: NonNullable<typeof actions>["events"] extends Map<string, infer T>
      ? T
      : never;
  }[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  let payloadBytes = Buffer.byteLength(JSON.stringify(benchmark));
  for (const [index, symbol] of symbols.entries()) {
    if (cancelled()) throw new Error("研究采集已取消");
    try {
      // g4day 暂停：研究数据集只读本地日线，不叠加通达信增量。
      const snapshot = await readLocalDailySnapshot(root, symbol);
      const bars = snapshot.bars.filter((bar) => bar.date <= spec.end);
      const minute = spec.management?.growthIntraday
        ? await readSnapshot(root, symbol, "5m")
        : null;
      const minuteBars = minute?.bars.filter(
        (b) =>
          b.date.slice(0, 10) >= minuteStart && b.date.slice(0, 10) <= spec.end,
      );
      const raw = {
        symbol,
        name: snapshot.name ?? symbol,
        bars,
        ...(minute
          ? {
              minuteBars,
              minuteSource: {
                source: minute.source,
                hash: minute.hash,
                start: minute.bars[0]?.date ?? null,
                end: minute.bars.at(-1)?.date ?? null,
              },
            }
          : {}),
        source: snapshot.source,
        ...(snapshot.sourceVersions?.length
          ? { sourceVersions: snapshot.sourceVersions }
          : {}),
        actions: (actions?.events.get(symbol) ?? []).filter(
          (event) => event.date <= spec.end,
        ),
      };
      payloadBytes += Buffer.byteLength(JSON.stringify(raw));
      if (payloadBytes > 512 * 1024 * 1024)
        throw new Error("研究行情快照超过512MiB，请缩小证券池");
      stocks.push({ ...raw, hash: researchHash(raw) });
    } catch (error) {
      if (payloadBytes > 512 * 1024 * 1024) throw error;
      excluded.push({
        symbol,
        reason: error instanceof Error ? error.message : "读取行情失败",
      });
    }
    progress(symbol, index + 1, symbols.length);
  }
  const content = {
    version: "research-dataset-1" as const,
    method: researchMethodSnapshot(spec),
    source:
      benchmarkSource.source.startsWith("tdx-full-package") ||
      stocks.some((stock) => stock.source?.startsWith("tdx-full-package"))
        ? ("mixed-tdx-files-full-package" as const)
        : benchmarkSource.sourceVersions?.length ||
            stocks.some((stock) => stock.sourceVersions?.length)
          ? ("tdx-local+g4day" as const)
          : ("tdx-local" as const),
    root,
    adjustment: "none" as const,
    membership: {
      mode: "current-snapshot" as const,
      symbols,
      source: pool,
      warning: "当前成分名单回溯存在生存者偏差，并非历史成分",
    },
    benchmark: {
      symbol: "sh000001",
      bars: benchmark,
      ...(benchmarkSource.sourceVersions?.length
        ? { sourceVersions: benchmarkSource.sourceVersions }
        : {}),
    },
    ...(canslimMarket ? { canslimMarket } : {}),
    calendar,
    stocks,
    excluded,
    actionCoverage: actions ? ("partial" as const) : ("missing" as const),
    actionSource: actions
      ? { path: actions.path, modified: actions.modified }
      : null,
  };
  return { ...content, capturedAt: Date.now(), hash: researchHash(content) };
}
