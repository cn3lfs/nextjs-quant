import { parseArgs } from "node:util";
import {
  realpath,
  readdir,
  stat,
  mkdtemp,
  writeFile,
  appendFile,
  readFile,
} from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readWdzLc5 } from "../src/server/data-sources/tdx/wdz-native";
import { importFiveMinuteBuffer } from "../src/server/data-sources/tdx/five-minute-native";
import { tdxImportTargets } from "./lib/tdx-import-paths";
const volumePolicy = "wdz-auto-v4-source-amount";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "tdx-root": { type: "string" },
    workers: { type: "string", default: "4" },
    help: { type: "boolean" },
    "retry-report": { type: "string" },
    "resume-report": { type: "string" },
  },
});
if (values.help || !values.source || !values["tdx-root"]) {
  console.log(
    'pnpm wdz:import --source "WDZ文件或目录" --tdx-root "通达信目录" [--workers 4]',
  );
  process.exit(values.help ? 0 : 1);
}
const workers = Number(values.workers);
if (!Number.isInteger(workers) || workers < 1 || workers > 8)
  throw new Error("workers 必须为 1–8");
const source = await realpath(values.source);
const { root, targets } = await tdxImportTargets(values["tdx-root"]);
async function find(path: string): Promise<string[]> {
  if ((await stat(path)).isFile()) return /\.wdz$/i.test(path) ? [path] : [];
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(...(await find(join(path, entry.name))));
    else if (entry.isFile() && /\.wdz$/i.test(entry.name))
      result.push(join(path, entry.name));
  }
  return result;
}
const retryArchives = values["retry-report"]
  ? new Set(
      (await readFile(values["retry-report"], "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { archive: string; error?: string })
        .filter((row) => row.error)
        .map((row) => row.archive),
    )
  : undefined;
let completedArchives = new Set<string>();
if (values["resume-report"]) {
  const previous = JSON.parse(
    await readFile(values["resume-report"], "utf8"),
  ) as { stopped: boolean; root: string; volumePolicy?: string };
  if (previous.volumePolicy !== volumePolicy)
    throw new Error(
      "旧成交量规则报告不能用于本次续跑；请去掉 --resume-report 重新处理源文件。",
    );
  if (previous.root.toLowerCase() !== root.toLowerCase())
    throw new Error("续跑报告的通达信目录不一致");
  const records = (
    await readFile(
      join(dirname(values["resume-report"]), "archives.ndjson"),
      "utf8",
    )
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { archive: string; errors: number });
  completedArchives = new Set(
    records
      .filter(
        (row, i) =>
          !row.errors && (!previous.stopped || i < records.length - 1),
      )
      .map((row) => row.archive),
  );
}
const files = (await find(source))
  .filter((path) => !completedArchives.has(path))
  .filter((path) => !retryArchives || retryArchives.has(path))
  .sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
if (!files.length) throw new Error("没有找到 WDZ 文件");
const reportDir = await mkdtemp(join(tmpdir(), "quant-wdz-import-"));
const details = join(reportDir, "details.ndjson"),
  report = join(reportDir, "summary.json");
let logTail = Promise.resolve();
function detail(row: unknown) {
  const text = JSON.stringify(row) + "\n";
  logTail = logTail.then(() => appendFile(details, text));
  return logTail;
}
const started = performance.now();
const summary = {
  volumePolicy,
  source,
  resumedFrom: values["resume-report"],
  root,
  workers,
  archives: files.length,
  processed: 0,
  files: 0,
  bars: 0,
  added: 0,
  identical: 0,
  conflicts: 0,
  repaired: 0,
  overflow: 0,
  errors: 0,
  skipped: 0,
  sourceRowsSkipped: 0,
  stopped: false,
  seconds: 0,
};
process.on("SIGINT", () => {
  summary.stopped = true;
  console.log("停止分配，等待当前写入完成…");
});
console.log(
  `${files.length} 个 WDZ，直接写 LC5，${workers} 并发；无 CSV、无备份，修复有明确来源依据的成交量，其余冲突保留。\n报告：${report}`,
);
for (const archive of files) {
  if (summary.stopped) break;
  const before = { ...summary },
    pending = new Set<Promise<void>>(),
    symbols = new Map<string, Promise<void>>();
  async function consume(
    item: Awaited<ReturnType<ReturnType<typeof readWdzLc5>["next"]>>["value"],
  ) {
    if (!item) return;
    const symbol = item.symbol.toLowerCase();
    try {
      const result = await importFiveMinuteBuffer(
        item.data,
        join(targets[symbol.slice(0, 2)]!, `${symbol}.lc5`),
        item,
      );
      summary.added += result.added;
      summary.identical += result.identical;
      summary.conflicts += result.conflicts;
      summary.repaired += result.repaired;
      summary.overflow += result.overflowTimes.length;
      if (result.overflowTimes.length || result.conflicts || result.repaired)
        await detail({
          archive,
          symbol,
          added: result.added,
          conflicts: result.conflicts,
          repaired: result.repaired,
          overflowTimes: result.overflowTimes,
        });
    } catch (error) {
      summary.errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[失败] ${basename(archive)} ${symbol}: ${message}`);
      if ((error as NodeJS.ErrnoException).code === "ENOSPC")
        summary.stopped = true;
      await detail({ archive, symbol, error: message });
    }
    summary.files++;
    summary.bars += item.bars;
  }
  try {
    for await (const item of readWdzLc5(archive, async (issue) => {
      if (issue.skipped) {
        if (issue.records !== undefined)
          summary.sourceRowsSkipped += issue.records;
        else summary.skipped++;
      } else {
        summary.errors++;
        console.error(
          `[解码失败] ${basename(archive)} ${issue.symbol}: ${issue.error}`,
        );
      }
      await detail({ archive, ...issue });
    })) {
      if (summary.stopped) break;
      // Long history packages split the same symbol across several blocks.
      // Never let concurrent writers race on the same LC5 file.
      await symbols.get(item.symbol);
      const task = consume(item).finally(() => {
        pending.delete(task);
        symbols.delete(item.symbol);
      });
      symbols.set(item.symbol, task);
      pending.add(task);
      if (pending.size >= workers) await Promise.race(pending);
    }
  } catch (error) {
    summary.errors++;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[解码失败] ${archive}: ${message}`);
    await detail({ archive, error: message });
  }
  await Promise.all(pending);
  summary.processed++;
  summary.seconds = (performance.now() - started) / 1000;
  const delta = {
    archive,
    files: summary.files - before.files,
    bars: summary.bars - before.bars,
    added: summary.added - before.added,
    identical: summary.identical - before.identical,
    conflicts: summary.conflicts - before.conflicts,
    errors: summary.errors - before.errors,
  };
  await appendFile(
    join(reportDir, "archives.ndjson"),
    JSON.stringify(delta) + "\n",
  );
  await writeFile(report, JSON.stringify(summary, null, 2));
  console.log(
    `${summary.processed}/${files.length} ${basename(archive)} · 新增 ${delta.added} · 相同 ${delta.identical} · 错误 ${delta.errors} · 累计 ${summary.seconds.toFixed(1)} 秒`,
  );
}
console.log(JSON.stringify(summary, null, 2));
console.log(`报告：${reportDir}`);
if (summary.errors || summary.stopped) process.exitCode = 1;
