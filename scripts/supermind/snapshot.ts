import { readFileSync } from "node:fs";
import {
  captureDirectory,
  freezeSupermindSnapshot,
  listSupermindCaptures,
  readSupermindSnapshot,
  supermindSnapshotRoot,
  verifySupermindSnapshots,
} from "../../src/server/research-supermind-store";
import {
  supermindDatasets,
  type SupermindDataset,
} from "../../src/lib/research-supermind-snapshot";

/**
 * CLI for the frozen SuperMind snapshot store.
 *
 *   pnpm tsx scripts/supermind/snapshot.ts freeze --dataset <name> --raw <file> \
 *       [--request <json>] [--captured-at <iso>] [--root <dir>]
 *   pnpm tsx scripts/supermind/snapshot.ts list   [--dataset <name>] [--root <dir>]
 *   pnpm tsx scripts/supermind/snapshot.ts verify [--root <dir>]
 *
 * `--raw` is the JSON a `scripts/supermind/fetch_*.py` run downloaded from the
 * remote kernel. Freezing is the only step that can write to the store; a
 * backtest reads it with `readSupermindSnapshot` and never calls the cloud.
 */

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]!;
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${key} 缺少取值`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return { command, options };
}

function datasetOf(options: Map<string, string>): SupermindDataset {
  const value = options.get("dataset");
  const match = supermindDatasets.find((name) => name === value);
  if (!match)
    throw new Error(
      `--dataset 须为 ${supermindDatasets.join(" / ")}，收到 ${String(value)}`,
    );
  return match;
}

const args = process.argv.slice(2);
const { command, options } = parseArgs(args);
const root = options.get("root") ?? supermindSnapshotRoot();
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

if (command === "freeze") {
  const dataset = datasetOf(options);
  const rawPath = options.get("raw");
  if (!rawPath) throw new Error("freeze 需要 --raw <file>");
  const request = JSON.parse(options.get("request") ?? "{}");
  const capturedAt = options.get("captured-at") ?? new Date().toISOString();
  const result = freezeSupermindSnapshot({
    dataset,
    raw: JSON.parse(readFileSync(rawPath, "utf8")),
    request,
    capturedAt,
    root,
  });
  out({
    ...result,
    root,
    directory: captureDirectory(dataset, result.captureId, root),
  });
} else if (command === "list") {
  const dataset = options.has("dataset") ? datasetOf(options) : undefined;
  out({ root, captures: listSupermindCaptures(dataset, root) });
} else if (command === "verify") {
  out(verifySupermindSnapshots(root));
} else if (command === "read") {
  const dataset = datasetOf(options);
  const captureId = options.get("capture-id");
  const result = readSupermindSnapshot({ dataset, captureId, root });
  out({
    envelope: result.envelope,
    payloadHash: result.payloadHash,
    rowCount: result.rows.length,
    firstObservation: result.observations[0] ?? null,
  });
} else {
  throw new Error("用法：freeze | list | verify | read");
}
