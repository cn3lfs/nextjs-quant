import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { csiPriceSchema, csiHash } from "./lib/csi800-factor-data.js";
import { csi800TradeEvaluation } from "./lib/csi800-trade-evaluation.js";

if (!process.argv[2] || !process.env.QUANT_DATA_DIR)
  throw new Error("传入冻结风控目录并设置新的隔离QUANT_DATA_DIR");
const source = resolve(process.argv[2]),
  out = resolve(process.env.QUANT_DATA_DIR);
if (source === out) throw new Error("不能覆盖冻结研究");
const sourceManifest = z
  .object({
    status: z.literal("complete"),
    inputs: z.object({ pricePath: z.string(), priceHash: z.string() }),
  })
  .parse(JSON.parse(await readFile(join(source, "manifest.json"), "utf8")));
const prices = await readFile(sourceManifest.inputs.pricePath);
if (csiHash(prices) !== sourceManifest.inputs.priceHash)
  throw new Error("冻结行情hash不一致");
const price = csiPriceSchema.parse(JSON.parse(prices.toString("utf8")));
const schema = z.object({
  result: z.object({
    fills: z.array(
      z.object({
        date: z.string(),
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        quantity: z.number(),
        price: z.number(),
        fee: z.number(),
      }),
    ),
    riskTrades: z
      .array(
        z.object({
          symbol: z.string(),
          openedAt: z.string(),
          closedAt: z.string(),
          realizedPnl: z.number(),
        }),
      )
      .optional(),
  }),
});
const files = [
  "scripts/evaluate-csi800-trades.ts",
  "scripts/lib/csi800-trade-evaluation.ts",
  "packages/quant-performance/src/trades.ts",
  "packages/quant-performance/src/performance.ts",
  "packages/quant-performance/src/index.ts",
  "packages/quant-performance/package.json",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, csiHash(await readFile(f))])),
  );
const codeHashes = await hashes(),
  summaries = [];
await mkdir(out);
for (const stage of ["baseline", "initial", "breakeven", "partial", "full"]) {
  const bytes = await readFile(join(source, stage + ".json.gz"));
  const { result } = schema.parse(
    JSON.parse(gunzipSync(bytes).toString("utf8")),
  );
  const { cycles, evaluation } = csi800TradeEvaluation(
    result.fills,
    price.stocks,
  );
  let maximumLedgerError: number | null = null;
  if (result.riskTrades) {
    const closed = cycles.filter((c) => c.closedAt !== null);
    if (closed.length !== result.riskTrades.length)
      throw new Error(`${stage} 闭合轮次与独立风险台账不一致`);
    const byKey = new Map(
      closed.map((c) => [`${c.symbol}:${c.openedAt}:${c.closedAt}`, c]),
    );
    maximumLedgerError = 0;
    for (const t of result.riskTrades) {
      const paired = byKey.get(`${t.symbol}:${t.openedAt}:${t.closedAt}`);
      if (!paired) throw new Error(`${stage} 缺少独立配对`);
      maximumLedgerError = Math.max(
        maximumLedgerError,
        Math.abs(paired.netPnl! - t.realizedPnl),
      );
    }
    if (maximumLedgerError > 1e-5)
      throw new Error(`${stage} 配对净损益与风险台账不一致`);
  }
  summaries.push({
    stage,
    sourceHash: csiHash(bytes),
    evaluation,
    maximumLedgerError,
  });
  await writeFile(
    join(out, stage + "-cycles.json.gz"),
    gzipSync(JSON.stringify(cycles)),
  );
}
if (JSON.stringify(await hashes()) !== JSON.stringify(codeHashes))
  throw new Error("评价期间代码改变");
await writeFile(
  join(out, "summary.json"),
  JSON.stringify(
    {
      version: "csi800-trade-evaluation-1",
      source,
      priceHash: sourceManifest.inputs.priceHash,
      codeHashes,
      summaries,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    summaries.map((s) => ({
      stage: s.stage,
      closed: s.evaluation.closedTrades,
      open: s.evaluation.openTrades,
      averageWin: s.evaluation.averageWin.value,
      averageLoss: s.evaluation.averageLoss.value,
      payoffRatio: s.evaluation.payoffRatio.value,
      winRate: s.evaluation.winRate.value,
      maximumLedgerError: s.maximumLedgerError,
    })),
    null,
    2,
  ),
);
