/** N1 A6 real-market acceptance, isolated SQLite and read-only TDX.
 * Run with QUANT_DATA_DIR set to a fresh isolated directory and pnpm exec tsx.
 * Controlled latest-source clock is for acceptance only, never production replay.
 * The separate outcome audit uses recent actual holding intervals, NOT fabricated
 * historical strategy signals, and never inserts these diagnostic intervals.
 */
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { closeCzsc } from "../src/server/strategies/chan/czsc";
import { sqlite } from "../src/server/db";
import { SignalLedgerStore } from "../src/server/monitoring/signal-ledger-store";
import { SignalLedgerWorker } from "../src/server/monitoring/signal-ledger-client";
import { localLedgerDependencies } from "../src/server/monitoring/signal-ledger-job";
import { readSnapshot, scan } from "../src/server/data-sources/tdx/tdx";
import {
  horizons,
  ledgerOutcome,
  type LedgerSignal,
} from "../src/lib/strategy-facts/signal-ledger";

const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !resolve(directory).startsWith(resolve(".test-data") + "\\") ||
  existsSync(join(directory, "quant.sqlite"))
)
  throw new Error(
    "Set QUANT_DATA_DIR to a fresh directory under .test-data before running",
  );
const root = process.env.N1_TDX_ROOT ?? "E:\\new_tdx64";
const db = sqlite();
db.prepare("INSERT INTO records VALUES ('settings','settings',?,1)").run(
  JSON.stringify({ tdxRoot: root }),
);
const store = new SignalLedgerStore(db);
const worker = new SignalLedgerWorker();
try {
  const symbols = (await scan(root)).securities
    .filter((s) => s.period === "day")
    .map((s) => s.symbol);
  const date = (await readSnapshot(root, "sh600519", "day")).bars.at(-1)!.date;
  console.log(
    JSON.stringify({ root, date, symbols: symbols.length, directory }),
  );
  let heartbeats = 0,
    maxHeartbeatGapMs = 0,
    last = performance.now(),
    lastLog = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last);
    last = now;
    heartbeats++;
  }, 100);
  let run;
  try {
    run = await worker.run(Date.parse(`${date}T15:05:00+08:00`), (progress) => {
      if (progress.scanned - lastLog >= 500) {
        lastLog = progress.scanned;
        console.log(
          JSON.stringify({
            phase: progress.phase,
            scanned: progress.scanned,
            total: progress.total,
          }),
        );
      }
    });
  } finally {
    clearInterval(timer);
  }
  const pass =
    !!run &&
    ["complete", "partial"].includes(run.status) &&
    run.scanned > 0 &&
    run.elapsedMs < 600000 &&
    heartbeats > 0 &&
    !run.errors.some(
      (e) => e.reason.includes("执行失败") || e.reason.startsWith("双突破："),
    );
  console.log(
    JSON.stringify({
      run: run && {
        ...run,
        errors: undefined,
        excludedOrFailed: run.errors.length,
        reasons: [...new Set(run.errors.map((e) => e.reason))],
      },
      heartbeats,
      maxHeartbeatGapMs,
      pass,
    }),
  );
  const actual = store.rows().flatMap((r) => r.outcomes);
  console.log(
    JSON.stringify({
      ledgerSignals: store.rows().length,
      settledOutcomes: actual.filter((o) => o.settled).length,
      pendingOutcomes: actual.filter((o) => !o.settled).length,
    }),
  );
  // Test the corrected adapter against real recent windows ending on the source day.
  // These are diagnostic symbol x horizon intervals, not forward ledger samples.
  const deps = localLedgerDependencies(root, []);
  const calendar = await deps.calendar();
  const actions = await deps.actions();
  const index = calendar.days.indexOf(date);
  const counts = {
    comparable: 0,
    incomparable: 0,
    unknown: 0,
    numericReturns: 0,
    otherBlanks: 0,
  };
  for (const symbol of symbols) {
    let bars: Awaited<ReturnType<typeof deps.bars>> = [];
    try {
      bars = await deps.bars(symbol);
    } catch {
      /* Keep missing prices blank. */
    }
    for (const horizon of horizons) {
      const signal = {
        symbol,
        observedDate: calendar.days[index - horizon]!,
      } as LedgerSignal;
      const outcome = ledgerOutcome(
        signal,
        horizon,
        bars,
        calendar.days,
        calendar.source,
        actions(symbol),
        date,
      );
      if (outcome.action === "区间无除权") counts.comparable++;
      else if (outcome.action === "含除权，收益不可比") counts.incomparable++;
      else counts.unknown++;
      if (outcome.returnPct !== null) counts.numericReturns++;
      else if (outcome.action === "区间无除权") counts.otherBlanks++;
    }
  }
  console.log(
    JSON.stringify({
      diagnosticOnly: true,
      intervalBasis:
        "all local A shares x T+5/T+10/T+20, all ending at latest source date; not strategy records",
      end: date,
      coverageEnd: actions("").coverageEnd,
      ...counts,
    }),
  );
  if (!pass || counts.comparable === 0) process.exitCode = 1;
} finally {
  await worker.close();
  await closeCzsc();
  db.close();
}
