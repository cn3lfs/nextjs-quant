import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    date: { type: "string" },
    symbols: { type: "string" },
  },
});
if (!values.input || !values.date || !values.symbols)
  throw new Error(
    "需要 --input 已解压COD/MD1目录 --date YYYY-MM-DD --symbols 逗号分隔清单",
  );
const { historicalDateSchema } = await import("../src/lib/historical-screen");
const { symbolSchema } = await import("../src/lib/domain");
const date = historicalDateSchema.parse(values.date);
const symbols = values.symbols
  .split(",")
  .map((symbol) => symbolSchema.parse(symbol));
const dataDir = await mkdtemp(join(tmpdir(), "quant-increment-cache-audit-"));
process.env.QUANT_DATA_DIR = dataDir;
const { publishDailyIncrement, readDailyIncrement } =
  await import("../src/server/tdx-daily-cache");
const results = [];
for (const market of ["sh", "sz", "bj"] as const) {
  const selected = symbols.filter((symbol) => symbol.startsWith(market));
  if (!selected.length) continue;
  const files = ["cod", "md1"].map((ext) =>
    join(values.input!, `${market}${date.replaceAll("-", "").slice(2)}.${ext}`),
  );
  const before = await Promise.all(files.map((file) => stat(file)));
  const bytes = await Promise.all(files.map((file) => readFile(file)));
  const after = await Promise.all(files.map((file) => stat(file)));
  if (
    before.some(
      (item, i) =>
        !item.isFile() ||
        item.size !== bytes[i]!.length ||
        item.size !== after[i]!.size ||
        item.mtimeMs !== after[i]!.mtimeMs ||
        item.ctimeMs !== after[i]!.ctimeMs ||
        item.ino !== after[i]!.ino,
    )
  )
    throw new Error("日线增量文件读取期间变化");
  const saved = publishDailyIncrement({
    market,
    date,
    symbols: selected,
    cod: bytes[0]!,
    md1: bytes[1]!,
    observedAt: Date.now(),
  });
  for (const symbol of selected)
    if (readDailyIncrement(symbol, date)?.snapshot.id !== saved.id)
      throw new Error("增量缓存回读不一致");
  results.push(saved);
}
const report = join(dataDir, "increment-cache-audit.json");
await writeFile(report, JSON.stringify({ dataDir, results }, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    report,
    dataDir,
    markets: results.length,
    records: results.reduce((n, result) => n + result.records.length, 0),
  }),
);
