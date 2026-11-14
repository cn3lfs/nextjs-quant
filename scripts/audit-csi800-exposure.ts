import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { evaluatePerformance } from "quant-performance";
import { matchCsi800Exposure } from "../packages/quant-backtest/src/csi800-exposure.js";
import { csiHash, csiPriceSchema } from "./lib/csi800-factor-data.js";
import type { replayAllocationStudy } from "../packages/quant-backtest/src/allocation-profile.js";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离QUANT_DATA_DIR");
const out = resolve(process.argv[2] ?? process.env.QUANT_DATA_DIR);
const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
if (manifest.status !== "research-complete")
  throw new Error("先完成稳定代码重放");
const matrix = JSON.parse(
  await readFile(join(out, "matrix-summary.json"), "utf8"),
);
const selected: string = matrix.decision.selected ?? "combined-defensive";
if (!/^[a-z-]+$/.test(selected)) throw new Error("策略ID非法");
const raw = await readFile(manifest.inputs.pricePath),
  archive = await readFile(join(out, `${selected}.json.gz`));
if (csiHash(raw) !== manifest.inputs.priceHash)
  throw new Error("价格输入hash错误");
const price = csiPriceSchema.parse(JSON.parse(raw.toString("utf8")));
const { result }: { result: ReturnType<typeof replayAllocationStudy> } =
  JSON.parse(gunzipSync(archive).toString("utf8"));
const points = matchCsi800Exposure({
  initial: price.initial,
  curve: result.curve,
  snapshots: result.snapshots,
  benchmark: price.benchmark,
  stocks: price.stocks,
});
const segment = (start: string, end: string) => {
  const rows = points.filter((p) => p.date >= start && p.date <= end),
    i = points.findIndex((p) => p.date === rows[0]?.date);
  return evaluatePerformance(points[i - 1]?.value ?? price.initial, rows);
};
const data = {
  version: "csi800-realized-exposure-attribution-1",
  selected,
  sourceHashes: {
    prices: csiHash(raw),
    strategy: csiHash(archive),
    helper: csiHash(
      await readFile("packages/quant-backtest/src/csi800-exposure.ts"),
    ),
    script: csiHash(await readFile("scripts/audit-csi800-exposure.ts")),
  },
  limitation:
    "ex-post gross price-index attribution, not a tradable portfolio; dividend mismatch remains",
  evaluation: evaluatePerformance(price.initial, points),
  segments: {
    development: segment("2016-01-01", "2022-12-31"),
    validation: segment("2023-01-01", "2024-12-31"),
    observation: segment("2025-01-01", price.end),
  },
  averageOpenExposure: points.reduce(
    (s, p) => s + p.openExposure / points.length,
    0,
  ),
  points,
};
await writeFile(join(out, "exposure-audit.json"), JSON.stringify(data));
console.log(
  `实际仓位匹配价格指数：年化${((data.evaluation.annualReturn.value ?? 0) * 100).toFixed(2)}%，回撤${((data.evaluation.maxDrawdown.value ?? 0) * 100).toFixed(2)}%`,
);
