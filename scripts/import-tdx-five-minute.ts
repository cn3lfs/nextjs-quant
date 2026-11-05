import { commonIndices } from "../src/lib/market/market-indices";
import { parseArgs } from "node:util";
import { realpath, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tdxImportTargets } from "./lib/tdx-import-paths";
import { importFiveMinuteDirect } from "../src/server/data-sources/tdx/five-minute-native";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "tdx-root": { type: "string" },
    workers: { type: "string", default: "4" },
    "common-indices": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help || !values.source || !values["tdx-root"]) {
  console.log(
    'pnpm tdx:import --source "CSV目录" --tdx-root "通达信目录" [--workers 4]',
  );
  process.exit(values.help ? 0 : 1);
}
const workers = Number(values.workers);
if (!Number.isInteger(workers) || workers < 1 || workers > 8)
  throw new Error("workers 必须为 1–8");
const source = await realpath(values.source);
const { root, targets } = await tdxImportTargets(values["tdx-root"]);
const entries = await readdir(source, { withFileTypes: true });
const directories = [
  source,
  ...entries
    .filter((e) => e.isDirectory() && /^(sh|sz)$/i.test(e.name))
    .map((e) => join(source, e.name)),
];
const files: { symbol: string; source: string; target: string }[] = [],
  seen = new Set<string>();
for (const directory of directories)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(sh|sz)\d{6}\.csv$/i.test(entry.name)) continue;
    const symbol = entry.name.slice(0, 8).toLowerCase();
    if (
      values["common-indices"] &&
      !commonIndices.some((i) => i.symbol === symbol)
    )
      continue;
    if (seen.has(symbol)) throw new Error(`重复代码：${symbol}`);
    seen.add(symbol);
    files.push({
      symbol,
      source: join(directory, entry.name),
      target: join(targets[symbol.slice(0, 2)]!, symbol + ".lc5"),
    });
  }
if (!files.length) throw new Error("没有找到沪深 CSV");
files.sort((a, b) => a.symbol.localeCompare(b.symbol));
let next = 0,
  completed = 0,
  added = 0,
  identical = 0,
  conflicts = 0,
  errors = 0,
  overflow = 0,
  repaired = 0,
  stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  console.log("停止分配新文件，等待当前写入完成…");
});
const started = Date.now(),
  results: Record<string, unknown>[] = [];
console.log(
  `直接导入 ${files.length} 文件，${workers} 并发；不创建备份，同时间保留旧记录。`,
);
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (!stopped && next < files.length) {
      const file = files[next++]!;
      try {
        const { data: _data, ...result } = await importFiveMinuteDirect(
          file.source,
          file.target,
        );
        added += result.added;
        repaired += result.repaired;
        identical += result.identical;
        conflicts += result.conflicts;
        overflow += result.overflowTimes.length;
        results.push({ ...file, ...result });
      } catch (error) {
        errors++;
        console.error(
          `[失败] ${file.symbol}：${error instanceof Error ? error.message : String(error)}`,
        );
        results.push({
          ...file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      completed++;
      if (completed % 250 === 0 || completed === files.length)
        console.log(
          `${completed}/${files.length} · ${((Date.now() - started) / 1000).toFixed(1)} 秒 · 错误 ${errors}`,
        );
    }
  }),
);
const reportDir = join(tmpdir(), `quant-lc5-import-${Date.now()}`);
await mkdir(reportDir, { recursive: true });
const report = join(reportDir, "results.json");
const summary = {
  source,
  root,
  workers,
  files: files.length,
  completed,
  added,
  identical,
  conflicts,
  overflow,
  repaired,
  errors,
  stopped,
  seconds: (Date.now() - started) / 1000,
};
await writeFile(report, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`明细：${report}`);
if (errors || stopped) process.exitCode = 1;
