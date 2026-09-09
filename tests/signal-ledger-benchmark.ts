/** N1 A6 read-only local-market measurement. Ephemeral SQLite only; never
 * retain historical ledger records or modify TDX. Run with pnpm exec tsx.
 * Frozen source day is a controlled clock for this acceptance measurement,
 * not a production history-replay entry point.
 */
import Database from "better-sqlite3";
import { migrate } from "../src/server/db/migrations";
import { SignalLedgerStore } from "../src/server/signal-ledger-store";
import {
  localLedgerDependencies,
  runSignalLedger,
} from "../src/server/signal-ledger-job";
import { readSnapshot, scan } from "../src/server/tdx";
import { screenLocal } from "../src/server/screening";
import { defaultStrategy } from "../src/lib/domain";
import { closeCzsc } from "../src/server/czsc";

const root = process.env.N1_TDX_ROOT ?? "E:\\new_tdx64";
const db = new Database(":memory:");
try {
  const coverage = await scan(root);
  const symbols = coverage.securities
    .filter((s) => s.period === "day")
    .map((s) => s.symbol);
  const reference = await readSnapshot(root, "sh600519", "day");
  const date = reference.bars.at(-1)!.date;
  console.log(
    JSON.stringify({
      root,
      symbols: symbols.length,
      date,
      storage: ":memory:",
    }),
  );
  const baseline = await screenLocal({
    root,
    symbols,
    period: "day",
    strategy: defaultStrategy,
  });
  console.log(
    JSON.stringify({
      baselineMs: baseline.elapsedMs,
      cacheHit: baseline.cacheHit,
      errors: baseline.errors.length,
    }),
  );
  migrate(db);
  const deps = localLedgerDependencies(root, []);
  const analyze = deps.czsc;
  let count = 0;
  deps.czsc = async (bars) => {
    const result = await analyze(bars);
    if (++count % 100 === 0) console.log(`CZSC ${count}/${symbols.length}`);
    return result;
  };
  const run = await runSignalLedger(
    new SignalLedgerStore(db),
    deps,
    Date.parse(`${date}T15:05:00+08:00`),
  );
  const pass =
    !!run &&
    run.status !== "failed" &&
    count > 0 &&
    count === run.scanned &&
    !run.errors.some(
      (e) => e.reason.includes("执行失败") || e.reason.startsWith("双突破："),
    ) &&
    baseline.errors.length === 0 &&
    run.elapsedMs <= baseline.elapsedMs * 3;
  console.log(
    JSON.stringify({
      run: run
        ? {
            ...run,
            errors: undefined,
            excludedOrFailed: run.errors.length,
            reasons: [...new Set(run.errors.map((e) => e.reason))],
          }
        : null,
      czscEvaluations: count,
      ratio: run ? run.elapsedMs / baseline.elapsedMs : null,
      pass,
    }),
  );
  if (!pass) process.exitCode = 1;
} finally {
  db.close();
  await closeCzsc();
}
