import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readSnapshot, readGbbq } from "tstdx/local";
import {
  runCsi800Study,
  type Csi800Stock,
  type Csi800Options,
} from "../packages/quant-backtest/src/csi800-study.js";
import { evaluatePerformance, performancePeriods } from "quant-performance";
import { z } from "zod";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离 QUANT_DATA_DIR");
const root = process.env.TDX_ROOT ?? "E:/new_tdx64";
const out = resolve(process.env.QUANT_DATA_DIR, "csi800-study");
const replay = process.argv[2];
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
async function capture() {
  const poolPath =
    "docs/data-sources/wdz-blocks/2026-11-07/Blocks/市场分类/中证800.txt";
  const pool = await readFile(poolPath, "utf8");
  const symbols = [
    ...new Set(pool.match(/(?:SH|SZ)\d{6}/g)?.map((s) => s.toLowerCase())),
  ];
  if (symbols.length !== 800) throw new Error(`成分数量异常 ${symbols.length}`);
  const [index, actions] = await Promise.all([
    readSnapshot(root, "sh000906", "day"),
    readGbbq(root),
  ]);
  const benchmark = index.bars.map((b) => ({
    ...b,
    date: b.date.slice(0, 10),
  }));
  const end = benchmark.at(-1)!.date;
  const stocks: Csi800Stock[] = [],
    excluded: { symbol: string; reason: string }[] = [];
  const sources: Record<string, string> = {};
  for (let offset = 0; offset < symbols.length; offset += 16) {
    const batch = await Promise.allSettled(
      symbols.slice(offset, offset + 16).map(async (symbol) => {
        const snapshot = await readSnapshot(root, symbol, "day");
        if (snapshot.sourceNote) throw new Error(snapshot.sourceNote);
        const events = (actions.events.get(symbol) ?? []).filter(
          (e) => e.date >= "2014-01-01" && e.date <= end,
        );
        sources[symbol] = snapshot.hash;
        return {
          symbol,
          bars: snapshot.bars
            .filter((b) => b.date >= "2014-01-01")
            .map((b) => ({ ...b, date: b.date.slice(0, 10) })),
          actions: events
            .filter((e) => [1, 11, 12, 13, 14].includes(e.category))
            .map((e) => ({
              date: e.date,
              dividend: e.dividend ?? 0,
              bonus: e.bonusRatio ?? 0,
              rights: e.rightsRatio ?? 0,
              rightsPrice: e.rightsPrice ?? 0,
              unsupported: e.category !== 1,
            })),
        };
      }),
    );
    batch.forEach((r, i) =>
      r.status === "fulfilled"
        ? stocks.push(r.value)
        : excluded.push({
            symbol: symbols[offset + i]!,
            reason: String(r.reason),
          }),
    );
    console.log(`行情 ${Math.min(offset + 16, 800)}/800`);
  }
  return {
    version: "csi800-frozen-1",
    start: "2016-01-01",
    end,
    initial: 1_000_000,
    stocks,
    benchmark: benchmark.filter((b) => b.date >= "2014-01-01"),
    excluded,
    sources,
    poolPath,
    poolHash: hash(pool),
    indexHash: index.hash,
    gbbqHash: hash(await readFile(actions.path)),
    capturedAt: new Date().toISOString(),
  };
}
const number = z.number().finite();
const barSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: number.positive(),
  high: number.positive(),
  low: number.positive(),
  close: number.positive(),
  amount: number.nonnegative(),
  volume: number.nonnegative(),
});
const inputSchema = z
  .object({
    version: z.literal("csi800-frozen-1"),
    start: z.string(),
    end: z.string(),
    initial: number.positive(),
    stocks: z
      .array(
        z.object({
          symbol: z.string().regex(/^(sh|sz)\d{6}$/),
          bars: z.array(barSchema),
          actions: z.array(
            z.object({
              date: z.string(),
              dividend: number.nonnegative(),
              bonus: number.nonnegative(),
              rights: number.nonnegative().optional(),
              rightsPrice: number.nonnegative().optional(),
              unsupported: z.boolean(),
            }),
          ),
        }),
      )
      .min(1),
    benchmark: z.array(barSchema).min(271),
    excluded: z.array(z.object({ symbol: z.string(), reason: z.string() })),
  })
  .passthrough();
const input = inputSchema.parse(
  replay ? JSON.parse(await readFile(replay, "utf8")) : await capture(),
);
await mkdir(out, { recursive: true });
const body = JSON.stringify(input);
await writeFile(join(out, "input.json"), body);
const codeFiles = [
  "packages/quant-backtest/src/csi800-study.ts",
  "scripts/backtest-csi800.ts",
  "pnpm-lock.yaml",
];
const codeHashes = Object.fromEntries(
  await Promise.all(codeFiles.map(async (f) => [f, hash(await readFile(f))])),
);
const warnings = [
  "按用户要求忽略幸存者偏差：固定2026-11-07当前成分回溯。",
  "简化研究：没有历史ST/行业分类，不执行ST过滤与行业30%上限；上市250日以行情条数近似。",
  "涨跌停按普通主板/创业板/科创板情景推算，不认证历史限价或排队成交。",
  "现金分红按除息日立即到账、未扣红利税；送配股按除权日立即到账/缴款可用，公司行动源覆盖未认证；配股现金不足或持仓遇缩股停止该实验。",
  "缺失行情按上次价格估值并阻止交易；源自动修复证券排除，另有数据可用性选择偏差。",
  "成交量过滤使用当日零量这一事后可成交性假设；不代表真实开盘成交保证。",
  "历史区间已用于研发，2025年以后仅作分段报告，不声称未见样本外业绩。",
];
const modes: Csi800Options["mode"][] = [
  "equal-pool",
  "momentum",
  "risk-weighted",
  "regime",
];
const summary: unknown[] = [];
for (const slippageBps of [10, 20, 30])
  for (const mode of modes) {
    console.log(`回测 ${mode} 滑点${slippageBps}bp`);
    try {
      const result = runCsi800Study(input.stocks, input.benchmark, {
        start: input.start,
        end: input.end,
        initial: input.initial,
        mode,
        slippageBps,
      });
      const base =
        input.benchmark.findIndex((b) => b.date === result.curve[0]!.date) - 1;
      const indices = new Map(input.benchmark.map((b, i) => [b.date, i]));
      const points = result.curve.map((p) => {
        const i = indices.get(p.date)!;
        return {
          date: p.date,
          value: p.equity,
          benchmarkReturn:
            input.benchmark[i]!.close / input.benchmark[i - 1]!.close - 1,
        };
      });
      const evaluation = evaluatePerformance(input.initial, points);
      const annual = performancePeriods(input.initial, points, "year");
      const segments = [
        ["开发", "2016-01-01", "2022-12-31"],
        ["验证", "2023-01-01", "2024-12-31"],
        ["后段观察", "2025-01-01", input.end],
      ].map(([name, start, end]) => {
        const rows = points.filter((p) => p.date >= start! && p.date <= end!);
        const first = points.findIndex((p) => p.date === rows[0]?.date);
        return {
          name,
          evaluation: evaluatePerformance(
            points[first - 1]?.value ?? input.initial,
            rows,
          ),
        };
      });
      const stats = {
        mode,
        slippageBps,
        evaluation,
        annual,
        segments,
        trades: result.fills.length,
        rejected: result.rejected.length,
        fees: result.fills.reduce((s, f) => s + f.fee, 0),
        benchmarkPriceStart: input.benchmark[base]?.close,
      };
      summary.push(stats);
      await writeFile(
        join(out, `${mode}-${slippageBps}.json`),
        JSON.stringify({ ...stats, ...result }),
      );
    } catch (e) {
      summary.push({ mode, slippageBps, error: String(e) });
    }
  }
await writeFile(
  join(out, "summary.json"),
  JSON.stringify(
    {
      inputHash: hash(body),
      codeHashes,
      warnings,
      excluded: input.excluded,
      summary,
    },
    null,
    2,
  ),
);
console.log(`结果：${out}/summary.json`);
