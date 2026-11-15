import { task, config, json, readArtifact, delivery } from "./context";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
const sources = [];
for (const family of [
  "rps-multi",
  "double-breakout",
  "formula-ma",
  "formula-range",
  "formula-pullback",
  "historical-low",
]) {
  const p = await json<{
    complete: boolean;
    pointer: { path: string; sha256: string };
  }>(
    join(config.predecessor, `all-market-sensitivity-${family}-progress.json`),
  );
  if (!p.complete) throw new Error("Frozen sensitivity is incomplete");
  const group = await readArtifact<{ sensitivity: unknown[] }>(p.pointer);
  if (group.sensitivity.length !== 9)
    throw new Error("Missing frozen variants");
  sources.push({
    family,
    pointer: p.pointer,
    variants: group.sensitivity.length,
  });
}
const value = {
  status: "frozen-comparison",
  sources,
  scenarioRuns: 108,
  boundary:
    "Read-only 1975-name last-close/total-loss comparison; no new current-CSI800 simulation or fabricated financial data",
};
await writeFile(
  join(task, "sensitivity-sources.json"),
  JSON.stringify(value, null, 2),
);
await delivery({ sensitivity: value });
console.log(JSON.stringify(value));
process.exit(0);
