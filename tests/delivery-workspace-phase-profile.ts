import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/server/db/migrations";
import { parseDeliveryTable } from "../src/lib/research/evidence/delivery-table";
import {
  importDeliveryTable,
  redactRow,
} from "../src/lib/research/evidence/delivery-import";
import { DeliveryStore } from "../src/server/portfolio/delivery-store";
const fixture = JSON.parse(
  readFileSync(
    join(tmpdir(), "logs/quant-delivery-import/fixture.json"),
    "utf8",
  ),
);
const files = [
  join(fixture.files, "large.csv"),
  ...readdirSync("tests/fixtures/delivery")
    .filter(
      (f) => f !== "cash-reconciliation.csv" && /\.(csv|txt|html)$/.test(f),
    )
    .map((f) => join("tests/fixtures/delivery", f)),
];
const results = [];
for (const file of files) {
  const db = new Database(":memory:");
  migrate(db);
  const store = new DeliveryStore(db);
  const samples: Record<string, number[]> = {
    read: [],
    parse: [],
    normalize: [],
    inspect: [],
    serialize: [],
    transaction: [],
    duplicateInspect: [],
    conflictInspect: [],
  };
  let format = "",
    encoding = "";
  function timed<T>(key: string, i: number, fn: () => T): T {
    const start = performance.now();
    const value = fn();
    if (i >= 5) samples[key]!.push(performance.now() - start);
    return value;
  }
  try {
    for (let i = 0; i < 35; i++) {
      const bytes = timed("read", i, () => readFileSync(file));
      const table = timed("parse", i, () => parseDeliveryTable(bytes));
      format = table.format;
      encoding = table.encoding;
      const parsed = timed("normalize", i, () => importDeliveryTable(table));
      const inspected = timed("inspect", i, () =>
        store.inspect("profile", parsed),
      );
      const rawRows = table.rows.map((row) => redactRow(row, parsed.mapping));
      timed("serialize", i, () =>
        JSON.stringify({ parsed, rawRows, inspected }),
      );
      const input = {
        account: "profile",
        source: "generic" as const,
        fileName: file,
        fileHash: createHash("sha256").update(bytes).digest("hex"),
        importedAt: 1700000000000,
        parsed,
        rawRows,
      };
      const saved = timed("transaction", i, () => store.commitImport(input));
      const duplicate = timed("duplicateInspect", i, () =>
        store.inspect("profile", parsed),
      );
      assert.ok(duplicate.every((row) => row.status === "duplicate"));
      if (parsed.fills.length) {
        const conflict = structuredClone(parsed);
        conflict.fills[0]!.amount += 1;
        const rows = timed("conflictInspect", i, () =>
          store.inspect("profile", conflict),
        );
        assert.ok(rows.some((row) => row.status === "conflict"));
      }
      store.revokeBatch(saved.batchId);
    }
    results.push({
      file,
      format,
      encoding,
      phases: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => {
          values.sort((a, b) => a - b);
          return [
            name,
            {
              n: values.length,
              p50: values[14] ?? null,
              p95: values[28] ?? null,
            },
          ];
        }),
      ),
    });
  } finally {
    db.close();
  }
}
const report = {
  results,
  scope:
    "isolated in-memory database; warm file read, table parsing, normalization, inspect, serialization, commit transaction including re-inspect; no end-to-end sum claim",
};
writeFileSync(
  join(tmpdir(), "logs/quant-delivery-import/workspace-phase-profile.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
