import {
  task,
  json,
  readArtifact,
  digest,
  calculationIdentity,
} from "./lib/research-r2a4";
import { mainCrypto } from "./lib/research-r2a4-main-inputs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { researchCandidates } from "trading-strategies";
import {
  numericNeighbors,
  projectCandidate,
} from "../src/server/research/validation-replay";
import {
  runCandidateCheckpoint,
  type CandidateCheckpoint,
} from "../src/server/research/validation-scale";
import type { ValidationPolicy } from "quant-backtest";
const { dataset, base } = await mainCrypto("day"),
  family = "dual-ma-day";
const saved = await json<{
  identity: string;
  pointer: { path: string; sha256: string };
}>(join(task, `btc-eth-${family}-progress.json`));
const original = await readArtifact<{
  identity: string;
  policy: ValidationPolicy;
  checkpoints: CandidateCheckpoint[];
}>(saved.pointer);
const menu = researchCandidates(
  dataset.instruments.map((i) => i.symbol),
  "crypto",
)
  .filter((c) => c.family === family)
  .flatMap((c) => [c, ...numericNeighbors(c)]);
const identity = digest(
  JSON.stringify({
    calculationBuild: await calculationIdentity("crypto"),
    mode: "crypto",
    family,
    sources: dataset.sources,
    dates: dataset.dates,
    benchmark: dataset.benchmark.map((b) => [b.date, b.open, b.close]),
    menu,
  }),
);
if (identity !== saved.identity || identity !== original.identity)
  throw new Error("Current replay input/calculation identity drift");
const c = menu.find((c) => c.strategy.id === "r2a-crypto-dual-ma-day-atr")!;
const current = runCandidateCheckpoint(
    projectCandidate(c, dataset, base, new Map())!,
    dataset,
    original.policy,
  ),
  reference = original.checkpoints.find((p) => p.row.id === c.strategy.id)!;
const normalize = ({ elapsedMs: _elapsed, ...rest }: CandidateCheckpoint) =>
  JSON.parse(JSON.stringify(rest)) as unknown;
if (!isDeepStrictEqual(normalize(current), normalize(reference)))
  throw new Error("Main candidate numeric replay drift");
const rejected: string[] = [];
for (const [label, pointer] of [
  ["hash", { ...saved.pointer, sha256: "0".repeat(64) }],
  [
    "path",
    { ...saved.pointer, path: join(task, "../r2a3/artifacts/index.json") },
  ],
] as const) {
  try {
    await readArtifact(pointer);
    throw new Error("Expected rejection did not happen");
  } catch (e) {
    if (
      !(e instanceof Error) ||
      !e.message.includes(label === "hash" ? "hash mismatch" : "escapes task")
    )
      throw e;
    rejected.push(label);
  }
}
await writeFile(
  join(task, "current-replay-control.json"),
  JSON.stringify(
    {
      id: c.strategy.id,
      identity,
      exactNumericParity: true,
      includes: [
        "training",
        "allOos",
        "bothStresses",
        "holdout",
        "fullPeriod",
        "dailyReturns",
      ],
      rejected,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ exactNumericParity: true, rejected }));
process.exit(0);
