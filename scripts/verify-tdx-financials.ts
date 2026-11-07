/** Read-only real-source acceptance. Worker/database paths are always isolated. */
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { securityNames, isAStock } from "tstdx/local";
import {
  localFinancialView,
  localFinancialSeriesView,
} from "../src/server/financial/local-financial-service";
import type {
  LocalFinancialWork,
  LocalFinancialScreen,
} from "../src/server/financial/local-financial-work";
import type { LocalFinancialArchive } from "../src/server/financial/local-financial-archive";

const root = process.argv[2];
if (!root)
  throw new Error(
    "用法：pnpm exec tsx scripts/verify-tdx-financials.ts <通达信目录>",
  );
const parent = resolve(tmpdir()),
  sandbox = await mkdtemp(join(parent, "quant-financial-acceptance-"));
const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
let peakRss = process.memoryUsage().rss;
const timer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
const worker = new Worker(resolve("runtime/worker.cjs"), {
  env: { ...process.env, QUANT_DATA_DIR: sandbox },
});
function run<T>(work: LocalFinancialWork): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("财务验收worker超时"));
    }, 180000);
    const error = (error: Error) => {
      cleanup();
      reject(error);
    };
    const message = (value: { error?: string; result?: T; phase?: string }) => {
      if (value.error) {
        cleanup();
        reject(new Error(value.error));
      } else if (value.result !== undefined) {
        cleanup();
        resolve(value.result);
      }
    };
    function cleanup() {
      clearTimeout(timeout);
      worker.off("message", message);
      worker.off("error", error);
    }
    worker.on("message", message);
    worker.on("error", error);
    worker.postMessage(work);
  });
}
try {
  const representative = [];
  for (const symbol of [
    "sh600519",
    "sh600036",
    "sh601318",
    "sh600030",
    "sz300750",
    "sh688981",
    "sz000001",
  ]) {
    const start = performance.now(),
      view = await localFinancialView(root, { symbol, limit: 12 }),
      coldMs = performance.now() - start;
    const warm = performance.now();
    await localFinancialView(root, {
      symbol,
      limit: 12,
      section: "资产负债表",
    });
    representative.push({
      symbol,
      periods: view.periods.length,
      fields: view.rowCount,
      report: view.selected?.reportDate,
      industry: view.financialCompany,
      coldMs: Math.round(coldMs),
      warmMs: Math.round(performance.now() - warm),
    });
  }
  const series = await Promise.all(
    ["sz000001", "sh880301", "sh999999"].map(async (symbol) => {
      const start = performance.now(),
        view = await localFinancialSeriesView(root, { symbol });
      return {
        symbol,
        namespace: view.namespace,
        records: view.rowCount,
        groups: view.groups.length,
        ms: Math.round(performance.now() - start),
      };
    }),
  );
  const names = Object.fromEntries(
    (
      await Promise.all(["sh", "sz"].map((m) => securityNames(root, m)))
    ).flatMap((m) => [...m]),
  );
  const symbols = Object.keys(names).filter(isAStock).sort();
  const started = performance.now();
  const screen = await run<LocalFinancialScreen>({
    type: "local-financial",
    operation: "screen",
    root,
    input: {
      asOf: date,
      strict: true,
      mode: "all",
      conditions: [{ field: "FN96", operator: "gt", threshold: 0 }],
      technical: [],
    },
    symbols,
    names,
    rps: null,
    poolSource: {
      hash: createHash("sha256").update(JSON.stringify(symbols)).digest("hex"),
      description: "当前本地TNF沪深A股池，非历史成员池",
    },
  });
  const screenMs = Math.round(performance.now() - started);
  const archiveStart = performance.now(),
    archive = await run<LocalFinancialArchive>({
      type: "local-financial",
      operation: "archive",
      root,
      symbol: "sh600519",
    });
  console.log(
    JSON.stringify(
      {
        date,
        representative,
        series,
        worker: {
          screenMs,
          counts: screen.counts,
          sourceVersions: screen.versions,
          archiveMs: Math.round(performance.now() - archiveStart),
          archiveReports: archive.reports.length,
          archiveId: archive.id,
        },
        sampledPeakRssMiB: Math.round(peakRss / 1024 / 1024),
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(timer);
  await worker.terminate();
  if (dirname(resolve(sandbox)) !== parent)
    throw new Error("验收临时目录边界非法");
  await rm(sandbox, { recursive: true, force: true });
}
