import { fileURLToPath } from "node:url";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, basename, relative, resolve } from "node:path";
import { readWdzLc5 } from "tstdx/native";
import { repairFiveMinuteFile } from "tstdx/native";
import { tdxImportTargets } from "./lib/tdx-import-paths";

export async function runRepairTdxZeroVolume(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      source: { type: "string" },
      "tdx-root": { type: "string" },
      "audit-report": { type: "string" },
      out: { type: "string" },
    },
  });
  if (
    !values.source ||
    !values["tdx-root"] ||
    !values["audit-report"] ||
    !values.out
  )
    throw new Error("--source --tdx-root --audit-report --out are required");
  const { root, targets } = await tdxImportTargets(values["tdx-root"]);
  const report = JSON.parse(await readFile(values["audit-report"], "utf8")) as {
    root: string;
    details: { path: string; counts?: number[] }[];
  };
  if (resolve(report.root).toLowerCase() !== root.toLowerCase())
    throw new Error("Audit report target differs");
  const wanted = new Set(
    report.details
      .filter((r) => r.counts?.[5])
      .map((r) => basename(r.path).slice(0, 8).toLowerCase()),
  );
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
  const files = (await find(resolve(values.source))).sort(
    (a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b),
  );
  const summary = {
    volumePolicy: "wdz-auto-v4-source-amount",
    root,
    source: resolve(values.source),
    candidates: wanted.size,
    archives: files.length,
    processed: 0,
    repaired: 0,
    uncoveredRanges: 0,
    errors: 0,
    seconds: 0,
  };
  const details: {
    archive: string;
    symbol: string;
    repaired?: number;
    error?: string;
  }[] = [];
  const started = performance.now();
  for (const archive of files) {
    try {
      for await (const item of readWdzLc5(
        archive,
        async (issue) => {
          if (issue.error) {
            summary.errors++;
            details.push({ archive, symbol: issue.symbol, error: issue.error });
          }
        },
        (symbol) => wanted.has(symbol.toLowerCase()),
      )) {
        const symbol = item.symbol.toLowerCase();
        try {
          const target = join(targets[symbol.slice(0, 2)]!, symbol + ".lc5"),
            size = (await stat(target)).size;
          // Only zeros may change; price/time and normalized OR raw source amount
          // must match exactly. Keep the existing amount and all other bytes.
          const result = repairFiveMinuteFile(
            target,
            size,
            item.data,
            Buffer.alloc(item.bars * 4),
            item.sourceAmounts,
          );
          if (!result) {
            summary.uncoveredRanges++;
            continue;
          }
          summary.repaired += result.repaired;
          if (result.repaired)
            details.push({ archive, symbol, repaired: result.repaired });
        } catch (error) {
          summary.errors++;
          details.push({ archive, symbol, error: String(error) });
        }
      }
    } catch (error) {
      summary.errors++;
      details.push({ archive, symbol: "", error: String(error) });
    }
    summary.processed++;
    summary.seconds = (performance.now() - started) / 1000;
    await writeFile(
      resolve(values.out),
      JSON.stringify({ ...summary, details }, null, 2),
    );
    console.log(
      `${summary.processed}/${files.length} ${basename(archive)} repaired=${summary.repaired} errors=${summary.errors} ${displayNumber(summary.seconds, 1)}s`,
    );
  }
  console.log(JSON.stringify(summary));
  return summary.errors ? 1 : 0;
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// On Windows, path.relative compares both spellings case-insensitively.
const isMainModule =
  process.argv[1] &&
  relative(
    canonicalPath(fileURLToPath(import.meta.url)),
    canonicalPath(process.argv[1]),
  ) === "";
if (isMainModule)
  process.exitCode = await runRepairTdxZeroVolume(process.argv.slice(2));
