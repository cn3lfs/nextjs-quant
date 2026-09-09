import Database from "better-sqlite3";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { parseBars, readSnapshot, securityNames } from "../src/server/tdx";
import { metrics } from "../src/server/quant";
import {
  defaultStrategy,
  type Coverage,
  type Job,
  type Snapshot,
} from "../src/lib/domain";

const database = new Database(
  join(
    process.env.QUANT_DATA_DIR ??
      join(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench"),
    "quant.sqlite",
  ),
  { readonly: true },
);
const records = (kind: string, limit = 80) =>
  (
    database
      .prepare(
        "SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(kind, limit) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload));
const coverage = records("coverage", 1)[0] as Coverage;
if (!coverage) throw new Error("No scanned coverage");
const jobs = records("job") as Job[];
console.log(
  JSON.stringify({
    kind: "jobs",
    jobs: jobs
      .filter((j) => ["screen", "research"].includes(j.type))
      .map((j) => {
        const result = j.result as
          | {
              candidates?: {
                name: string;
                symbol: string;
                metrics: { date: string };
              }[];
              total?: number;
            }
          | undefined;
        return {
          id: j.id,
          type: j.type,
          status: j.status,
          elapsedSeconds: +((j.updatedAt - j.createdAt) / 1000).toFixed(2),
          period: (j.input as { period?: string })?.period,
          total: result?.total,
          candidates: result?.candidates?.length,
          missingNames: result?.candidates
            ?.filter((c) => !c.name || c.name === c.symbol)
            .map((c) => c.symbol)
            .slice(0, 20),
          dates: [
            ...new Set(result?.candidates?.map((c) => c.metrics.date)),
          ].slice(0, 10),
        };
      }),
  }),
);
console.log(
  JSON.stringify({
    kind: "polling",
    jobs: jobs.length,
    serializedBytes: Buffer.byteLength(JSON.stringify(jobs)),
  }),
);
const latestScreen = jobs.find(
  (j) =>
    j.type === "screen" &&
    (j.result as { candidates?: unknown[] })?.candidates?.length,
);
if (latestScreen) {
  const candidates = (
    latestScreen.result as {
      candidates: { name: string; symbol: string; metrics: { date: string } }[];
    }
  ).candidates;
  const dates = candidates.map((c) => c.metrics.date.slice(0, 10)).sort();
  const latest = dates.at(-1);
  console.log(
    JSON.stringify({
      kind: "candidateQuality",
      latestScreenId: latestScreen.id,
      total: candidates.length,
      missingNames: candidates.filter((c) => !c.name || c.name === c.symbol)
        .length,
      newestDate: latest,
      oldestDate: dates[0],
      notAtNewestDate: dates.filter((d) => d !== latest).length,
      currentMissing: candidates
        .filter(
          (c) =>
            c.metrics.date.slice(0, 10) === latest &&
            (!c.name || c.name === c.symbol),
        )
        .map((c) => c.symbol),
    }),
  );
}
const names = new Map(
  (
    await Promise.all(
      ["sh", "sz", "bj"].map((market) => securityNames(coverage.root, market)),
    )
  ).flatMap((m) => [...m]),
);
console.log(
  JSON.stringify({
    kind: "names",
    nameEntries: names.size,
    coverageEntries: coverage.securities.length,
    coverageMissing: coverage.securities.filter(
      (s) => s.name === s.symbol || !s.name,
    ).length,
    missingFromCurrentTnf: coverage.securities
      .filter((s) => !names.has(s.symbol))
      .map((s) => s.symbol)
      .slice(0, 30),
    oldSnapshotsMissing: (records("snapshot", 200) as Snapshot[]).filter(
      (s) => !s.name || s.name === s.symbol,
    ).length,
  }),
);
for (const period of (process.argv.includes("--summary")
  ? []
  : ["day", "5m"]) as ("day" | "5m")[]) {
  const all = coverage.securities.filter((s) => s.period === period);
  // Evenly sample the scanned universe so an exchange's earliest listings do not dominate.
  const sample = all
    .filter((_, i) => i % Math.max(1, Math.floor(all.length / 80)) === 0)
    .slice(0, 80);
  let fullMs = 0,
    tailMs = 0,
    bytes = 0,
    fullBars = 0,
    equal = 0,
    failures = 0;
  for (const item of sample) {
    const file = join(
      coverage.root,
      "vipdoc",
      item.market,
      period === "day" ? "lday" : "fzline",
      `${item.symbol}.${period === "day" ? "day" : "lc5"}`,
    );
    try {
      const started = performance.now();
      const snapshot = await readSnapshot(coverage.root, item.symbol, period);
      const original = metrics(snapshot.bars, defaultStrategy);
      fullMs += performance.now() - started;
      const tailStarted = performance.now(),
        info = await stat(file),
        count = Math.min(info.size, 300 * 32),
        handle = await open(file, "r");
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(count);
        await handle.read(buffer, 0, count, info.size - count);
      } finally {
        await handle.close();
      }
      const tail = metrics(parseBars(buffer, period), defaultStrategy);
      tailMs += performance.now() - tailStarted;
      bytes += info.size;
      fullBars += snapshot.bars.length;
      if (JSON.stringify(original) === JSON.stringify(tail)) equal++;
    } catch {
      failures++;
    }
  }
  console.log(
    JSON.stringify({
      kind: "sample",
      period,
      totalSecurities: all.length,
      sample: sample.length,
      fullMs: Math.round(fullMs),
      tailPrototypeMs: Math.round(tailMs),
      readMiB: +(bytes / 1024 / 1024).toFixed(2),
      fullBars,
      equal,
      failures,
      note: "Warm filesystem sample; tail prototype is diagnostic only, not production implementation or end-to-end SLA",
    }),
  );
}
database.close();
