import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { seedTradeWorkspace } from "./helpers/trade-workspace-fixture";

const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-trade-ledger-"),
);
const logs = join(tmpdir(), "logs/quant-trade-ledger");
mkdirSync(logs, { recursive: true });
const { sqlite } = await import("../src/server/db");
const db = sqlite();
assert.equal(
  (db.prepare("SELECT count(*) n FROM trade_ledger").get() as { n: number }).n,
  0,
  "fresh isolated database required",
);
assert.equal(
  (db.prepare("SELECT count(*) n FROM records").get() as { n: number }).n,
  0,
);
const fixture = seedTradeWorkspace(db);
const root = join(directory, "synthetic-tdx"),
  dayDirectory = join(root, "vipdoc/sh/lday");
mkdirSync(dayDirectory, { recursive: true });
const bytes = Buffer.alloc(fixture.calendar.length * 32);
fixture.calendar.forEach((date, i) => {
  const offset = i * 32;
  bytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
  for (const field of [4, 8, 12, 16]) bytes.writeUInt32LE(1000, offset + field);
  bytes.writeFloatLE(100000, offset + 20);
  bytes.writeUInt32LE(10000, offset + 24);
});
// Deliberately leave one security without a quote; unknown must remain unknown.
for (let i = 0; i < 199; i++)
  writeFileSync(join(dayDirectory, `sh${600000 + i}.day`), bytes);
db.prepare(
  "INSERT OR REPLACE INTO records VALUES('settings','settings',?,1)",
).run(JSON.stringify({ tdxRoot: root, calendar: fixture.calendar }));
const facts = () =>
  JSON.stringify(db.prepare("SELECT * FROM trade_ledger ORDER BY id").all());
const hash = createHash("sha256").update(facts()).digest("hex");
const { tradeDashboard } =
  await import("../src/server/portfolio/trade-ledger-service");
const times: number[] = [];
let payloadBytes = 0;
for (let i = 0; i < 35; i++) {
  const start = performance.now(),
    value = await tradeDashboard();
  const elapsed = performance.now() - start;
  assert.equal(value.trades.length, 10000);
  assert.equal(value.positions.length, 200);
  assert.equal(value.adjustments.length, 1000);
  assert.equal(value.signals.length, 10000);
  assert.equal(
    value.positions.find((p) => p.symbol === "sh600199")?.quote,
    null,
  );
  if (i >= 5) times.push(elapsed);
  payloadBytes = Buffer.byteLength(JSON.stringify(value));
}
times.sort((a, b) => a - b);
assert.equal(createHash("sha256").update(facts()).digest("hex"), hash);
const result = {
  fixture: {
    ...fixture,
    calendar: `${fixture.calendar[0]}..${fixture.calendar.at(-1)}`,
  },
  hash,
  payloadBytes,
  service: { n: times.length, p50: times[15], p95: times[28] },
  node: process.version,
  cpu: cpus()[0]?.model,
  ram: totalmem(),
  source:
    "synthetic local files; GBBQ intentionally missing; no external requests",
};
writeFileSync(
  join(logs, "baseline-service.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
db.close();
