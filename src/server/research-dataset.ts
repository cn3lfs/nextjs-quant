import { readBenchmarkSnapshot } from "./tdx-benchmark";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { ResearchSpec } from "~/lib/strategy-research";
import { isRpsMarketSymbol } from "~/lib/rps";
import { settings } from "./settings";
import { readMarketPool } from "./market-pool-files";
import { scan } from "./tdx";
import { readLocalDailySnapshot } from "./local-daily-snapshot";
import { readGbbq } from "./tdx-gbbq";
import { overlayDailyIncrements } from "./tdx-daily-overlay";

export const researchHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ResearchDataset = Awaited<
  ReturnType<typeof captureResearchDataset>
>;

export { parseBenchmarkWindow as parseResearchBenchmark } from "./tdx-benchmark";

export async function captureResearchDataset(
  spec: ResearchSpec,
  cancelled: () => boolean = () => false,
  progress: (symbol: string, count: number, total: number) => void = () => {},
) {
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
  const benchmarkSource = overlayDailyIncrements(
    await readBenchmarkSnapshot(root, spec.start, spec.end),
    spec.end,
  );
  const benchmark = benchmarkSource.bars;
  if (!benchmark.some((bar) => bar.date >= spec.start))
    throw new Error("研究区间缺少上证指数基准行情");
  const calendar = benchmark.map((bar) => bar.date);
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
      const snapshot = overlayDailyIncrements(
        await readLocalDailySnapshot(root, symbol),
        spec.end,
      );
      const bars = snapshot.bars.filter((bar) => bar.date <= spec.end);
      const raw = {
        symbol,
        name: snapshot.name ?? symbol,
        bars,
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
