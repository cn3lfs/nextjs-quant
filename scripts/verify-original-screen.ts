import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import type { Job, Snapshot, Candidate, Strategy } from "../src/lib/domain";

const originalId = "job-e0dfbd0e-c8e1-4c55-97c3-832603569f6c";
const root = "E:/new_tdx64";
const dbPath = join(
  process.env.LOCALAPPDATA!,
  "QuantWorkbench",
  "quant.sqlite",
);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const record = (id: string) =>
  (
    db.prepare("SELECT payload FROM records WHERE id=?").get(id) as
      { payload: string } | undefined
  )?.payload;
const rawJob = record(originalId);
assert.ok(rawJob, "原案例任务不存在，不能用新任务冒充原案例");
const job = JSON.parse(rawJob) as Job;
const input = job.input as {
  strategy: Strategy;
  period: "day";
  symbols: string[];
};
const original = job.result as {
  candidates: Candidate[];
  errors: { symbol: string; error: string }[];
  total: number;
};
assert.equal(original.candidates.length, 434);
const asOf = "2026-09-07";
const stale = original.candidates.filter((c) => c.metrics.date !== asOf);
const unnamed = original.candidates.filter(
  (c) => !c.name || c.name === c.symbol,
);
assert.equal(stale.length, 33);
assert.equal(unnamed.length, 31);
// Runtime modules may use an application DB; they must never write to the source archive.
process.env.QUANT_DATA_DIR = await mkdtemp(
  join(tmpdir(), "quant-original-screen-"),
);
const { screenLocal } = await import("../src/server/screening");
const { metrics } = await import("../src/server/quant");
const { pageScreenResults, exportScreenResults } =
  await import("../src/server/screen-results");
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sourceHashes = new Map<string, string>();
const snapshots = new Map<string, Snapshot>();
const snapshotHashes = new Map<string, string>();
const archiveIssues: { symbol: string; reason: string }[] = [];
for (const candidate of original.candidates) {
  const raw = record(candidate.snapshotId);
  if (!raw) {
    archiveIssues.push({ symbol: candidate.symbol, reason: "原快照缺失" });
    continue;
  }
  const snapshot = JSON.parse(raw) as Snapshot;
  snapshotHashes.set(candidate.snapshotId, hash(raw));
  snapshots.set(candidate.symbol, snapshot);
  if (
    JSON.stringify(metrics(snapshot.bars, input.strategy)) !==
    JSON.stringify(candidate.metrics)
  )
    archiveIssues.push({
      symbol: candidate.symbol,
      reason: "原快照重算与原指标不一致",
    });
  const market = candidate.symbol.slice(0, 2),
    path = join(root, "vipdoc", market, "lday", `${candidate.symbol}.day`);
  try {
    sourceHashes.set(path, hash(await readFile(path)));
  } catch {
    archiveIssues.push({
      symbol: candidate.symbol,
      reason: "当前本地行情文件缺失",
    });
  }
}
const replay = await screenLocal({
  root,
  symbols: original.candidates.map((c) => c.symbol),
  period: input.period,
  strategy: input.strategy,
  asOf,
});
// Reconstruct only archived bar values in an isolated fixture. This is not an
// assertion that today's raw TDX files are identical to the historical source.
const fixtureRoot = join(process.env.QUANT_DATA_DIR!, "archived-bars");
for (const [symbol, snapshot] of snapshots) {
  const directory = join(fixtureRoot, "vipdoc", symbol.slice(0, 2), "lday");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(snapshot.bars.length * 32);
  snapshot.bars.forEach((bar, index) => {
    const offset = index * 32;
    bytes.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
    [bar.open, bar.high, bar.low, bar.close].forEach((price, i) =>
      bytes.writeUInt32LE(Math.round(price * 100), offset + 4 + i * 4),
    );
    bytes.writeFloatLE(bar.amount, offset + 20);
    bytes.writeUInt32LE(bar.volume, offset + 24);
  });
  await writeFile(join(directory, `${symbol}.day`), bytes);
}
const archivedReplay = await screenLocal({
  root: fixtureRoot,
  symbols: original.candidates.map((c) => c.symbol),
  names: Object.fromEntries(original.candidates.map((c) => [c.symbol, c.name])),
  period: input.period,
  strategy: input.strategy,
  asOf,
});
assert.equal(archivedReplay.candidates.length, 401);
assert.equal(archivedReplay.excluded.length, 33);
assert.equal(archivedReplay.errors.length, 0);
for (const candidate of archivedReplay.candidates) {
  assert.deepEqual(
    candidate.metrics,
    original.candidates.find((c) => c.symbol === candidate.symbol)!.metrics,
  );
  assert.deepEqual(
    archivedReplay.snapshots.find((s) => s.symbol === candidate.symbol)!.bars,
    snapshots.get(candidate.symbol)!.bars,
  );
}
const accepted = new Map(replay.candidates.map((c) => [c.symbol, c]));
const excluded = new Map(replay.excluded.map((c) => [c.symbol, c]));
const replaySources = new Map(replay.snapshots.map((s) => [s.symbol, s]));
const comparisons = original.candidates.map((candidate) => {
  const current = accepted.get(candidate.symbol),
    previous = snapshots.get(candidate.symbol),
    source = replaySources.get(candidate.symbol);
  return {
    symbol: candidate.symbol,
    originalName: candidate.name,
    originalDate: candidate.metrics.date,
    currentDate:
      current?.metrics.date ?? excluded.get(candidate.symbol)?.date ?? null,
    originalUnnamed: unnamed.includes(candidate),
    accepted: !!current,
    currentName: current?.name ?? excluded.get(candidate.symbol)?.name ?? null,
    reason:
      excluded.get(candidate.symbol)?.reason ??
      replay.errors.find((e) => e.symbol === candidate.symbol)?.error ??
      (current ? null : "当前规则未命中"),
    metricsUnchanged: current
      ? JSON.stringify(current.metrics) === JSON.stringify(candidate.metrics)
      : null,
    pricesUnchanged:
      source && previous
        ? JSON.stringify(source.bars) === JSON.stringify(previous.bars)
        : null,
  };
});
const paged: Candidate[] = [];
for (let page = 0; page < Math.ceil(original.candidates.length / 50); page++)
  paged.push(
    ...pageScreenResults(original, {
      page,
      query: "",
      excludedPage: 0,
      errorPage: 0,
    }).candidates,
  );
assert.deepEqual(paged, original.candidates);
const exported = exportScreenResults(job);
assert.deepEqual(exported.candidates, original.candidates);
assert.equal(exported.asOf, null);
assert.ok(exported.warnings.length);
const changedSources: string[] = [];
for (const [path, before] of sourceHashes)
  if (hash(await readFile(path)) !== before) changedSources.push(path);
assert.equal(record(originalId), rawJob);
for (const [id, before] of snapshotHashes)
  assert.equal(hash(record(id)!), before);
db.close();
const result = {
  originalId,
  originalJobHash: hash(rawJob),
  asOf,
  scope: "仅回放原434候选，不冒称6143全池或历史证券池完整性证明",
  isolatedDirectory: process.env.QUANT_DATA_DIR,
  originalCount: original.candidates.length,
  staleCount: stale.length,
  unnamedCount: unnamed.length,
  replayCount: replay.candidates.length,
  archivedReplayCount: archivedReplay.candidates.length,
  archivedExcludedCount: archivedReplay.excluded.length,
  excludedCount: replay.excluded.length,
  errors: replay.errors,
  archiveIssues,
  changedSources,
  sourceFiles: [...sourceHashes].map(([path, sha256]) => ({ path, sha256 })),
  metricsChanged: comparisons.filter((c) => c.metricsUnchanged === false),
  pricesChanged: comparisons.filter((c) => c.pricesUnchanged === false),
  originalPages: Math.ceil(paged.length / 50),
  exportedCount: exported.candidates.length,
  archiveUnchanged: true,
  comparisons,
};
await mkdir(resolve("output"), { recursive: true });
await writeFile(
  "output/original-screen-verification.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    ...result,
    comparisons: undefined,
    sourceFiles: undefined,
    isolatedDirectory: undefined,
  }),
);
assert.equal(archiveIssues.length, 0);
assert.equal(changedSources.length, 0);
assert.equal(replay.errors.length, 0);
assert.ok(
  stale.every(
    (c) => excluded.get(c.symbol)?.reason === "行情日期落后于选股基准日",
  ),
);
assert.ok(unnamed.every((c) => excluded.has(c.symbol)));
assert.equal(result.metricsChanged.length, 0);
assert.equal(result.pricesChanged.length, 0);
const additional = comparisons.filter(
  (c) => !c.accepted && c.originalDate === asOf,
);
assert.deepEqual(
  additional.map((c) => c.symbol).sort(),
  [
    "bj920748",
    "bj920075",
    "bj920436",
    "bj920970",
    "bj920826",
    "bj920275",
    "bj920392",
    "bj920729",
    "bj920394",
    "bj920981",
  ].sort(),
);
assert.ok(
  additional.every(
    (c) =>
      c.currentDate === "2025-09-30" && c.reason === "行情日期落后于选股基准日",
  ),
);
assert.equal(replay.candidates.length, 391);
