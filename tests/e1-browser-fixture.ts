// Persistent manual review fixture. Only writes .test-data/e1-browser; remove that
// isolated tree after stopping its server. No user data or subscriptions copied.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { settingsSchema } from "../src/lib/domain";
import { put, sqlite } from "../src/server/db";
import { RpsStore } from "../src/server/screening/rps-store";
import { scan } from "../src/server/data-sources/tdx/tdx";
import { rpsBars, rpsDay } from "./rps-fixture";
import { readIndustryBlocks } from "../src/server/market/industry-blocks";
import { aggregateIndustryRps } from "../src/lib/screening/industry-rps";
import { rpsHash } from "~/server/infra/content-hash";

const directory = resolve(".test-data/e1-browser");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== directory)
  throw new Error(
    "QUANT_DATA_DIR must be the isolated .test-data/e1-browser path",
  );
const root = join(directory, "tdx"),
  blocks = join(directory, "Blocks");
for (const path of [
  join(root, "vipdoc/sz/lday"),
  join(root, "T0002/hq_cache"),
  ...["概念", "申万行业", "中证指数"].map((name) => join(blocks, name)),
])
  await mkdir(path, { recursive: true });
const names = Buffer.alloc(50 + 25 * 360);
for (let i = 0; i < 25; i++) {
  const code = String(i).padStart(6, "0");
  names.write(code, 50 + i * 360, "ascii");
  names.write(`Sample${i}`, 50 + i * 360 + 31, "ascii");
  const bars = rpsBars(i).slice(0, 521),
    bytes = Buffer.alloc(bars.length * 32);
  for (const [j, bar] of bars.entries()) {
    const offset = j * 32;
    bytes.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
    for (const [k, value] of [bar.open, bar.high, bar.low, bar.close].entries())
      bytes.writeUInt32LE(Math.round(value * 100), offset + 4 + k * 4);
    bytes.writeFloatLE(bar.amount, offset + 20);
    bytes.writeUInt32LE(bar.volume, offset + 24);
  }
  await writeFile(join(root, `vipdoc/sz/lday/sz${code}.day`), bytes);
}
await writeFile(join(root, "T0002/hq_cache/szs.tnf"), names);
await writeFile(
  join(blocks, "中证指数/中证A500.txt"),
  "SZ000009\r\nSZ000001\r\nSZ000024\r\n",
);
await writeFile(join(blocks, "概念/测试概念.txt"), "SZ000009\r\nSZ000001\r\n");
await writeFile(join(blocks, "概念/较弱概念.txt"), "SZ000001\r\n");
await writeFile(join(blocks, "申万行业/测试行业.txt"), "SZ000001\r\n");
put(
  "settings",
  "settings",
  settingsSchema.parse({
    tdxRoot: root,
    industryBlocksRoot: blocks,
    autoAnalysis: false,
    autoNewsAnalysis: false,
  }),
);
put("coverage", "coverage", await scan(root));
const { day, rows } = rpsDay();
new RpsStore(sqlite()).saveDay(
  { ...day, source: { ...day.source, root } },
  rows,
);
const concept = aggregateIndustryRps(
  await readIndustryBlocks(blocks, () => {}, "concept"),
  { rows, excluded: day.excluded },
);
new RpsStore(sqlite(), "concept").saveDay(
  {
    ...day,
    source: { ...day.source, root },
    total: concept.rows.length,
    pool: concept.pool,
    counts: concept.counts,
    missing: concept.missing,
    industry: concept.industry,
    inputHash: rpsHash(concept),
  },
  concept.rows,
);
sqlite().close();
console.log(
  "E1 fixture ready: 25 stocks, 3 sample A500 members, 10 RPS rows. Not a real index snapshot.",
);
