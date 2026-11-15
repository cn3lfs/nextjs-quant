import {
  task,
  json,
  prior,
  readArtifact,
  artifact,
  equity,
  calculationIdentity,
  digest,
  delivery,
} from "./lib/research-r2a4";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { researchCandidates } from "trading-strategies";
import {
  projectCandidate,
  numericNeighbors,
} from "../src/server/research/validation-replay";
import {
  runCandidateCheckpoint,
  type CandidateCheckpoint,
} from "../src/server/research/validation-scale";
import type { FrozenValidationInput } from "../src/server/research/validation-capture";
const status = await json<{ chanSubset: { status: string } }>(
  ".codex-runs/delivery.json",
);
if (status.chanSubset.status !== "capture-complete")
  throw new Error("Native fixed-prefix capture incomplete");
const progress = await json<{
  chunks: { path: string; sha256: string }[];
  completed: string[];
}>(join(task, "native-progress.json"));
const allNative = (
  await Promise.all(
    progress.chunks.map((p) =>
      readArtifact<FrozenValidationInput["native"]>(p),
    ),
  )
).flat();
const plan = await prior<{ order: string[] }>("native-plan");
let count = 0;
while (
  count < allNative.length &&
  allNative[count]!.symbol === plan.order[count]
)
  count++;
const native = allNative.slice(0, count);
if (count < 21) throw new Error("Original fixed-prefix ordering lost");
const { dataset, base } = await equity(native.map((n) => n.symbol));
base.native = native;
const policy = {
  ...base.input.policy,
  trainBars: Math.floor(dataset.dates.length * 0.4),
  testBars: Math.floor(dataset.dates.length * 0.1),
};
const identity = digest(
  JSON.stringify({
    build: await calculationIdentity("cn-equity"),
    sources: dataset.sources,
    native: progress.chunks,
    policy,
    adapter: digest(
      (await readFile(new URL(import.meta.url), "utf8")).replaceAll(
        "\r\n",
        "\n",
      ),
    ),
  }),
);
let checkpoints: CandidateCheckpoint[] = [];
const progressPath = join(task, "all-market-native-progress.json");
try {
  const saved = await json<{
    identity: string;
    pointer: { path: string; sha256: string };
  }>(progressPath);
  if (saved.identity !== identity)
    throw new Error("Native study calculation changed on resume");
  checkpoints = (
    await readArtifact<{ checkpoints: CandidateCheckpoint[] }>(saved.pointer)
  ).checkpoints;
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const cache = new Map();
for (const c of researchCandidates(
  dataset.instruments.map((i) => i.symbol),
  "cn-equity",
)
  .filter((c) => c.family === "chan-third-buy")
  .flatMap((c) => [c, ...numericNeighbors(c)])) {
  if (checkpoints.some((p) => p.row.id === c.strategy.id)) continue;
  const p = projectCandidate(c, dataset, base, cache)!;
  checkpoints.push(runCandidateCheckpoint(p, dataset, policy));
  const pointer = await artifact("all-market-native", {
    identity,
    policy,
    symbols: dataset.instruments.map((i) => i.symbol),
    checkpoints,
    scope:
      "fixed broad420 order completed prefix only; supplements tagged separately",
  });
  await writeFile(
    progressPath,
    JSON.stringify(
      { identity, pointer, complete: checkpoints.length === 9 },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase: "broad-native-candidate",
      complete: checkpoints.length,
      at: new Date().toISOString(),
    }),
  );
  await delivery({
    activeNativeStudy: { complete: checkpoints.length, pointer },
  });
}
process.exit(0);
