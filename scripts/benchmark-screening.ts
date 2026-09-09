import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { screenLocal, type ScreeningResult } from "../src/server/screening";
import { runWorker } from "../src/server/jobs";
import {
  defaultStrategy,
  type Coverage,
  type Candidate,
  type Strategy,
} from "../src/lib/domain";
const db = new Database(
  join(
    process.env.QUANT_DATA_DIR ??
      join(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench"),
    "quant.sqlite",
  ),
  { readonly: true },
);
const coverage = JSON.parse(
  (
    db
      .prepare("SELECT payload FROM records WHERE kind='coverage' LIMIT 1")
      .get() as { payload: string }
  ).payload,
) as Coverage;
const old = JSON.parse(
  (
    db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get("job-e0dfbd0e-c8e1-4c55-97c3-832603569f6c") as { payload: string }
  ).payload,
) as { input: { strategy: Strategy }; result: { candidates: Candidate[] } };
const rounds = Number(
  process.argv.find((arg) => arg.startsWith("--rounds="))?.split("=")[1] ?? 1,
);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20)
  throw new Error("rounds must be 1..20");
const useWorker = process.argv.includes("--worker");
const measurements: Record<string, number[]> = { day: [], "5m": [] };
const baselineResults = new Map<string, string>();
for (let round = 1; round <= rounds; round++) {
  for (const period of ["day", "5m"] as const) {
    const input = {
      root: coverage.root,
      symbols: coverage.securities
        .filter((s) => s.period === period)
        .map((s) => s.symbol),
      period,
      strategy: old.input.strategy ?? defaultStrategy,
    };
    const started = performance.now();
    const result = useWorker
      ? await runWorker<ScreeningResult>({ type: "screen", ...input })
      : await screenLocal(input);
    const wallMs = Math.round(performance.now() - started);
    const resultHash = createHash("sha256")
      .update(
        JSON.stringify({
          candidates: result.candidates,
          poolContext: result.poolContext,
          excluded: result.excluded,
          errors: result.errors,
          asOf: result.asOf,
          total: result.total,
          snapshots: result.snapshots
            .map((snapshot) => ({
              symbol: snapshot.symbol,
              hash: snapshot.hash,
            }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        }),
      )
      .digest("hex");
    const consistent =
      !baselineResults.has(period) ||
      baselineResults.get(period) === resultHash;
    if (!consistent)
      throw new Error(
        `${period} result changed between rounds; inspect data changes before accepting this benchmark`,
      );
    baselineResults.set(period, resultHash);
    measurements[period]!.push(wallMs);
    const map = new Map(old.result.candidates.map((c) => [c.symbol, c]));
    console.log(
      JSON.stringify({
        period,
        round,
        mode: useWorker ? "resident-worker" : "direct",
        wallMs,
        total: result.total,
        ms: result.elapsedMs,
        cacheHit: result.cacheHit ?? false,
        consistent,
        asOf: result.asOf,
        candidates: result.candidates.length,
        excluded: result.excluded.length,
        errors: result.errors.length,
        missingNames: result.candidates.filter(
          (c) => !c.name || c.name === c.symbol,
        ).length,
        ...(period === "day"
          ? {
              unchanged: result.candidates.filter(
                (c) =>
                  JSON.stringify(c.metrics) ===
                  JSON.stringify(map.get(c.symbol)?.metrics),
              ).length,
            }
          : {}),
      }),
    );
  }
}
for (const [period, values] of Object.entries(measurements)) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      stage: "summary",
      period,
      rounds,
      firstMs: values[0],
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      repeatRounds: values.length - 1,
      repeatMedianMs:
        values.length > 1
          ? [...values.slice(1)].sort((a, b) => a - b)[
              Math.floor((values.length - 1) / 2)
            ]
          : null,
      repeatP95Ms:
        values.length > 1
          ? [...values.slice(1)].sort((a, b) => a - b)[
              Math.ceil((values.length - 1) * 0.95) - 1
            ]
          : null,
    }),
  );
}
db.close();
