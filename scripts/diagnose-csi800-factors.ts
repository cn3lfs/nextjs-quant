import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  csiPriceSchema,
  classicPanelSchema,
  csiHash,
} from "./lib/csi800-factor-data.js";
import { runClassicDiagnostics } from "./lib/csi800-factor-diagnostics.js";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离QUANT_DATA_DIR");
const out = resolve(process.argv[2] ?? process.env.QUANT_DATA_DIR);
const manifest = z
  .object({
    inputs: z.object({ pricePath: z.string(), priceHash: z.string() }),
    panel: z.object({
      path: z.string(),
      contentHash: z.string(),
      fileHash: z.string(),
    }),
    firstSignal: z.string(),
  })
  .parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
const prices = await readFile(manifest.inputs.pricePath),
  compressed = await readFile(manifest.panel.path);
if (
  csiHash(prices) !== manifest.inputs.priceHash ||
  csiHash(compressed) !== manifest.panel.fileHash
)
  throw new Error("价格或面板文件hash错误");
const raw = gunzipSync(compressed);
if (csiHash(raw) !== manifest.panel.contentHash)
  throw new Error("面板内容hash错误");
const price = csiPriceSchema.parse(JSON.parse(prices.toString("utf8"))),
  weeks = classicPanelSchema.parse(JSON.parse(raw.toString("utf8")));
const result = await runClassicDiagnostics(
  price,
  weeks,
  manifest.firstSignal,
  out,
);
console.log(
  `诊断完成：${result.factors}项因子、${result.observations}个成熟周观测`,
);
