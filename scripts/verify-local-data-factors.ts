/** Read-only acceptance against local client files and the actual bundled worker. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { financialDate } from "trading-strategy-core/financial";
import { localDataFactorCatalog } from "trading-strategy-core/factors";
import type {
  LocalFinancialScreen,
  LocalFinancialWork,
} from "../src/server/financial/local-financial-work";

const root = process.argv[2];
if (!root)
  throw new Error(
    "用法：pnpm exec tsx scripts/verify-local-data-factors.ts <通达信根目录>",
  );
const sandbox = await mkdtemp(join(tmpdir(), "quant-local-factor-acceptance-"));
process.env.QUANT_DATA_DIR = sandbox;
let worker: Worker | undefined;
function run(
  activeWorker: Worker,
  work: LocalFinancialWork,
): Promise<LocalFinancialScreen> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("本地数据因子worker验收超时"));
    }, 180000);
    function cleanup() {
      clearTimeout(timeout);
      activeWorker.off("message", message);
      activeWorker.off("error", error);
      activeWorker.off("exit", exit);
    }
    function error(cause: Error) {
      cleanup();
      reject(cause);
    }
    function exit(code: number) {
      error(new Error(`worker提前退出：${code}`));
    }
    function message(value: { result?: LocalFinancialScreen; error?: string }) {
      if (value.error) error(new Error(value.error));
      else if (value.result) {
        cleanup();
        resolve(value.result);
      }
    }
    activeWorker.on("message", message);
    activeWorker.on("error", error);
    activeWorker.on("exit", exit);
    activeWorker.postMessage(work);
  });
}
try {
  const { readLocalFinancialSeries } =
    await import("../src/server/data-sources/tdx/local-financial-files");
  worker = new Worker(resolve("runtime/worker.cjs"), {
    env: { ...process.env, QUANT_DATA_DIR: sandbox },
  });
  const ids = [
    "GP16-0",
    "GP21-0",
    "log-market-cap",
    "pe-ttm",
    "pb",
    "financing-to-cap",
    "amount-to-cap",
    "SC3-0",
    "BK5-0",
    "market-beta-60",
    "market-correlation-60",
    "residual-volatility-60",
  ];
  const output = [];
  for (const symbol of ["sh600519", "sh600036", "sz000001", "sz300750"]) {
    const source = await readLocalFinancialSeries(root, symbol);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const cap = source.records
      .filter(
        (r) =>
          r.group === 16 &&
          r.date &&
          financialDate(r.date)! < today &&
          r.values[0] > 0,
      )
      .sort((a, b) => b.date! - a.date!)[0];
    assert.ok(cap, `${symbol}没有可验收的历史总市值序列`);
    const asOf = financialDate(cap.date!)!;
    const started = performance.now();
    const result = await run(worker, {
      type: "local-financial",
      operation: "screen",
      root,
      input: {
        asOf,
        strict: true,
        mode: "all",
        conditions: [],
        technical: [],
        factorBlockSymbol: "sh880301",
        dataFactors: ids.map((id) => ({
          id,
          operator: "gt",
          threshold: -Number.MAX_VALUE,
        })),
      },
      symbols: [symbol],
      names: {},
      rps: null,
      poolSource: {
        hash: "explicit-acceptance-pool",
        description: "显式单股只读验收池，非历史行业归属",
      },
    });
    const factors = result.rows[0]!.dataFactors;
    assert.equal(factors[0]!.value, cap.values[0] * 10000);
    assert.equal(result.dataFactorVersion, "local-data-factors-v1");
    assert.equal(result.priceBasis, "local-unadjusted-day");
    assert.ok(factors[0]!.inputs[0]!.sourceSha256.match(/^[a-f0-9]{64}$/));
    output.push({
      symbol,
      asOf,
      milliseconds: Math.round(performance.now() - started),
      factors: factors.map(({ id, value, reason }) => ({ id, value, reason })),
    });
  }
  console.log(
    JSON.stringify(
      { catalogCount: localDataFactorCatalog.length, results: output },
      null,
      2,
    ),
  );
} finally {
  await worker?.terminate();
  // Only the exact temporary directory allocated by this script is removed.
  await rm(sandbox, { recursive: true, force: true });
}
