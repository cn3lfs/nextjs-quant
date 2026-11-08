import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  classicPanelSchema,
  csiPriceSchema,
  csiHash,
} from "./lib/csi800-factor-data.js";
import { csi800SignalBars } from "../packages/quant-backtest/src/csi800-signal.js";
import { classicCommonWindow } from "../packages/quant-backtest/src/csi800-composite.js";
import { runClassicMatrix } from "./lib/csi800-factor-matrix.js";
import { runClassicDiagnostics } from "./lib/csi800-factor-diagnostics.js";
import { classicCodeHashes } from "./lib/csi800-research-manifest.js";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离QUANT_DATA_DIR");
const prepared = resolve(process.argv[2] ?? ""),
  out = resolve(process.env.QUANT_DATA_DIR);
const startedAt = new Date().toISOString(),
  codeHashes = await classicCodeHashes();
if (prepared === out) throw new Error("重放输出须是新目录，不覆盖原研究");
const manifest = z
  .object({
    inputs: z.object({
      pricePath: z.string(),
      priceHash: z.string(),
      financial: z.object({ path: z.string(), fileHash: z.string() }),
    }),
    panel: z.object({
      path: z.string(),
      fileHash: z.string(),
      contentHash: z.string(),
    }),
  })
  .parse(JSON.parse(await readFile(join(prepared, "manifest.json"), "utf8")));
const prices = await readFile(manifest.inputs.pricePath),
  compressed = await readFile(manifest.panel.path),
  financial = await readFile(manifest.inputs.financial.path);
if (
  csiHash(prices) !== manifest.inputs.priceHash ||
  csiHash(compressed) !== manifest.panel.fileHash ||
  csiHash(financial) !== manifest.inputs.financial.fileHash
)
  throw new Error("冻结输入文件hash不一致");
const raw = gunzipSync(compressed);
if (csiHash(raw) !== manifest.panel.contentHash)
  throw new Error("面板内容hash错误");
const price = csiPriceSchema.parse(JSON.parse(prices.toString("utf8"))),
  weeks = classicPanelSchema.parse(JSON.parse(raw.toString("utf8")));
const common = classicCommonWindow(weeks);
if (!common.start || !common.firstSignal) throw new Error("共同覆盖不足");
const series = new Map(
  price.stocks.map((s) => [
    s.symbol,
    new Map(csi800SignalBars(s).map((b) => [b.date, b.close])),
  ]),
);
const dates = price.benchmark.map((b) => b.date),
  indices = new Map(dates.map((d, i) => [d, i]));
const riskAt = (symbol: string, date: string) => {
  const i = indices.get(date),
    history = series.get(symbol);
  if (i === undefined || i < 60 || !history) return null;
  const closes = dates.slice(i - 60, i + 1).map((d) => history.get(d));
  return closes.some((c) => c === undefined || !(c > 0))
    ? null
    : closes.slice(1).map((c, j) => c! / closes[j]! - 1);
};
await mkdir(out);
await writeFile(
  join(out, "replay-source.json"),
  JSON.stringify(
    {
      prepared,
      manifest,
      commonStart: common.start,
      firstSignal: common.firstSignal,
    },
    null,
    2,
  ),
);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      version: "csi800-classics-replay-1",
      status: "running",
      startedAt,
      prepared,
      inputs: manifest.inputs,
      panel: manifest.panel,
      commonStart: common.start,
      firstSignal: common.firstSignal,
      codeHashes,
    },
    null,
    2,
  ),
);
await runClassicMatrix(
  price,
  weeks,
  common.start,
  common.firstSignal,
  riskAt,
  out,
);
await runClassicDiagnostics(price, weeks, common.firstSignal, out);
if (JSON.stringify(codeHashes) !== JSON.stringify(await classicCodeHashes()))
  throw new Error(
    "运行期间研究代码发生变化，请保留本次为中间实验并用稳定代码重放",
  );
const completed = JSON.parse(
  await readFile(join(out, "manifest.json"), "utf8"),
);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      ...completed,
      status: "research-complete",
      completedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`冻结重放研究完成：${out}`);
