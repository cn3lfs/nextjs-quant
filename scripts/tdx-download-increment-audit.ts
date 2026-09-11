import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    date: { type: "string" },
    symbols: { type: "string" },
    "a500-root": { type: "string" },
  },
});
if (
  !values.date ||
  (!values.symbols && !values["a500-root"]) ||
  (values.symbols && values["a500-root"])
)
  throw new Error(
    "需要 --date YYYY-MM-DD，并选择 --symbols 清单或 --a500-root 通达信目录",
  );
const directory = await mkdtemp(
  join(tmpdir(), "quant-increment-refresh-audit-"),
);
process.env.QUANT_DATA_DIR = directory;
const { refreshDailyIncrement } =
  await import("../src/server/tdx-increment-refresh");
let symbols = values.symbols?.split(",");
if (values["a500-root"]) {
  const { readTdxLocalBlocks } = await import("../src/server/tdx-local-blocks");
  symbols = (await readTdxLocalBlocks(values["a500-root"])).blocks.find(
    (block) => block.category === "index" && block.name === "中证A500",
  )?.members;
  if (symbols?.length !== 500) throw new Error("通达信A500成分不足500只");
}
const result = await refreshDailyIncrement(values.date, symbols!);
const report = join(directory, "refresh-audit.json");
await writeFile(report, JSON.stringify(result, null, 2), { flag: "wx" });
console.log(
  JSON.stringify({
    report,
    status: result.status,
    snapshots: "snapshots" in result ? result.snapshots.length : 0,
  }),
);
