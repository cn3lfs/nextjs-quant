import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const base = process.env.BASE ?? "http://127.0.0.1:3231";
async function read(name, input) {
  const start = performance.now();
  const response = await fetch(
    `${base}/api/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    { headers: { "x-quant-client": "workbench", origin: base } },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 500));
  return {
    data: JSON.parse(text).result.data.json,
    ms: performance.now() - start,
    bytes: Buffer.byteLength(text),
  };
}
const measurements = {};
for (const [name, input] of Object.entries({
  all: { account: fixture.accounts.stress },
  difference: { account: fixture.accounts.stress, status: "difference" },
  last: { account: fixture.accounts.stress, pageIndex: 499 },
  large: { account: fixture.accounts.large },
})) {
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const value = await read("cashWorkspace", input);
    if (i >= 5) samples.push(value.ms);
    bytes = value.bytes;
    assert.ok(bytes <= 65536);
    assert.ok(value.data.rows.every((row) => !("evidence" in row)));
  }
  samples.sort((a, b) => a - b);
  measurements[name] = {
    n: samples.length,
    p50: samples[14],
    p95: samples[28],
    max: samples.at(-1),
    bytes,
  };
}
const summary = (
  await read("cashWorkspace", { account: fixture.accounts.stress })
).data;
assert.deepEqual(
  [
    summary.summary.matchedDays,
    summary.summary.differenceDays,
    summary.summary.unavailableDays,
    summary.summary.conflictDays,
  ],
  [2500, 2500, 2500, 2500],
);
const dates = [];
for (let pageIndex = 0; pageIndex < 500; pageIndex++) {
  const page = (
    await read("cashWorkspace", { account: fixture.accounts.stress, pageIndex })
  ).data;
  assert.equal(page.version, summary.version);
  dates.push(...page.rows.map((row) => row.date));
}
assert.deepEqual(dates, [...fixture.calendar].reverse());
const exported = (
  await read("cashWorkspaceExport", {
    account: fixture.accounts.stress,
    version: summary.version,
  })
).data;
const old = (
  await read("tradeReviewCashReconciliationExport", {
    account: fixture.accounts.stress,
  })
).data;
assert.deepEqual(exported.evidence, old);
assert.equal(
  createHash("sha256").update(JSON.stringify(exported.evidence)).digest("hex"),
  exported.evidenceHash,
);
const sourceSummary = (
  await read("cashWorkspace", { account: fixture.accounts.sources })
).data;
const identity = {
  account: fixture.accounts.sources,
  version: sourceSummary.version,
  date: fixture.calendar[0],
};
const sourceIds = [];
for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
  const page = (await read("cashWorkspaceDate", { ...identity, pageIndex }))
    .data;
  assert.equal(page.sources.total, 1000);
  sourceIds.push(...page.sources.rows.map((row) => row.batchId));
}
assert.equal(new Set(sourceIds).size, 1000);
const openings = [];
for (let pageIndex = 0; pageIndex < 50; pageIndex++)
  openings.push(
    ...(await read("cashWorkspaceOpening", { ...identity, pageIndex })).data
      .rows,
  );
assert.equal(openings.length, 1000);
assert.equal(new Set(openings.map((row) => row.batchId)).size, 1000);
const sourceExport = (await read("cashWorkspaceExport", identity)).data;
const oldSourceExport = (
  await read("tradeReviewCashReconciliationExport", {
    account: fixture.accounts.sources,
  })
).data;
assert.deepEqual(sourceExport.evidence, oldSourceExport);
assert.deepEqual(
  sourceExport.evidence.days[0].evidence.map((source) => source.batchId),
  sourceIds,
);
assert.equal(
  createHash("sha256")
    .update(JSON.stringify(sourceExport.evidence))
    .digest("hex"),
  sourceExport.evidenceHash,
);
const largeSummary = (
  await read("cashWorkspace", { account: fixture.accounts.large })
).data;
const largeIdentity = {
  account: fixture.accounts.large,
  version: largeSummary.version,
  date: fixture.calendar[0],
  batchId: "cash-pressure-large",
};
const evidenceRows = [];
for (let pageIndex = 0; pageIndex < 1000; pageIndex++)
  evidenceRows.push(
    ...(await read("cashWorkspaceRows", { ...largeIdentity, pageIndex })).data
      .rows,
  );
assert.deepEqual(
  evidenceRows.map((row) => row.rowIndex),
  Array.from({ length: 20000 }, (_, i) => i + 1),
);
const largeExport = (
  await read("cashWorkspaceExport", {
    account: fixture.accounts.large,
    version: largeSummary.version,
  })
).data;
assert.equal(largeExport.evidence.days.length, 20);
assert.equal(
  largeExport.evidence.days
    .flatMap((day) => day.evidence)
    .filter((source) => source.batchId === "cash-pressure-large")
    .reduce((n, source) => n + source.rows.length, 0),
  400000,
);
assert.equal(
  createHash("sha256")
    .update(JSON.stringify(largeExport.evidence))
    .digest("hex"),
  largeExport.evidenceHash,
);
const result = {
  build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  measurements,
  allDates: dates.length,
  sources: sourceIds.length,
  exportedSources: sourceIds.length,
  openings: openings.length,
  evidenceRows: evidenceRows.length,
  largeExportRows: 400000,
  oldNewCashEqual: true,
};
writeFileSync(join(logs, "q3-http.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
