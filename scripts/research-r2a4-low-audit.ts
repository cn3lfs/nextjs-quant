import {
  task,
  json,
  prior,
  artifact,
  delivery,
  digest,
} from "./lib/research-r2a4";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPortfolio } from "quant-backtest";
import { projectCandidate } from "../src/server/research/validation-replay";
import type { FrozenValidationInput } from "../src/server/research/validation-capture";
import type { CandidateCheckpoint } from "../src/server/research/validation-scale";
import { lowZoneCycles, type LowZoneObservation } from "trading-strategies";
import { auditPortfolio } from "../tests/helpers/portfolio-execution-audit";
const bytes = await readFile(
  ".test-data/r2a/data/research-validation/input-f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f.json",
);
if (
  digest(bytes) !==
  "f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f"
)
  throw new Error("Low audit original input drift");
const base = JSON.parse(bytes.toString()) as FrozenValidationInput;
const dataset = base.datasets[0]!;
const candidate = base.candidateMenu.find(
  (c) => c.family === "historical-low" && c.variant === "atr",
)!;
const p = projectCandidate(candidate, dataset, base, new Map())!;
const result = runPortfolio(p.request);
const audit = auditPortfolio(p.request, result, { period: 14, multiple: 6 });
const pointer = await artifact("low-tranche-audit", {
  ...audit,
  inputHash: digest(bytes),
  scope:
    "R2a fixed8 raw/forward prices; canonical ATR low-zone staged strategy; audit only",
});
const old = await prior<{ checkpoints: CandidateCheckpoint[] }>(
  "candidate-cnlowzone-historical-low",
);
const rps = JSON.parse(await prior<string>("rps-root")) as { dates: string[] };
const input = await prior<{
  benchmark: { observations: LowZoneObservation[] };
}>("low-input");
const cycles = lowZoneCycles(input.benchmark.observations).filter(
  (c) => c.start >= "2010-01-01",
);
const contributions = old.checkpoints.map((c) => {
  const score = c.fullPeriod;
  if (score.daily.length !== rps.dates.length)
    throw new Error("Low contribution date axis mismatch");
  let equity = 1000000,
    inside = 0,
    outside = 0;
  for (let i = 0; i < score.daily.length; i++) {
    const r = score.daily[i];
    if (r == null) throw new Error("Low contribution missing return");
    const change = equity * r;
    equity += change;
    if (cycles.some((c) => rps.dates[i]! >= c.start && rps.dates[i]! <= c.end))
      inside += change;
    else outside += change;
  }
  if (Math.abs(equity / 1000000 - 1 - score.return!) > 1e-8)
    throw new Error("Low PnL decomposition does not reconcile");
  return {
    id: c.row.id,
    fullReturn: score.return,
    indexCyclePnl: inside,
    outsideIndexCyclePnl: outside,
    totalPnl: equity - 1000000,
    residual: equity - 1000000 - inside - outside,
  };
});
await writeFile(
  join(task, "low-contributions.json"),
  JSON.stringify(
    {
      cycles,
      contributions,
      basis:
        "Continuous account daily cash PnL from frozen fullPeriod.daily; includes fees/dividends. Descriptive index timing, not independent reset accounts.",
    },
    null,
    2,
  ),
);
await delivery({
  lowZoneExecutionAudit: {
    status: audit.differences.length ? "differences-investigating" : "passed",
    fills: audit.fills,
    samples: audit.samples.length,
    additionalTrancheSamples: audit.samples.filter(
      (s) => s.additionalTranche === true,
    ).length,
    differences: audit.differences,
    pointer,
    contributions: ".test-data/r2a4/low-contributions.json",
  },
});
console.log(
  JSON.stringify({
    fills: audit.fills,
    samples: audit.samples.length,
    differences: audit.differences.slice(0, 5),
    additionalTrancheSamples: audit.samples.filter(
      (s) => s.additionalTranche === true,
    ).length,
  }),
);
process.exit(audit.differences.length ? 1 : 0);
