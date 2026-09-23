import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  importDeliveryTable,
  importOptionsSchema,
  redactRow,
} from "~/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { DeliveryStore } from "./delivery-store";

const optionsSchema = importOptionsSchema.extend({
  fileName: z.string().trim().min(1).max(255).default("交割单"),
});

function prepare(bytes: Uint8Array, options: unknown) {
  const validated = optionsSchema.parse(options);
  const table = parseDeliveryTable(bytes);
  const parsed = importDeliveryTable(table, validated);
  parsed.unresolved = parsed.unresolved.map((row) => ({
    ...row,
    cells: redactRow(row.cells, parsed.mapping),
  }));
  return {
    ...validated,
    fileHash: createHash("sha256").update(bytes).digest("hex"),
    parsed,
    rawRows: table.rows.map((row) => redactRow(row, parsed.mapping)),
  };
}

// Require an explicit connection: callers own its lifecycle and tests never
// import the default database singleton merely to preview a file.
export function previewDeliveryImport(
  bytes: Uint8Array,
  options: unknown,
  db: Database.Database,
) {
  const input = prepare(bytes, options);
  const rows = new DeliveryStore(db).inspect(input.account, input.parsed);
  return {
    ...input,
    rows,
    summary: {
      new: rows.filter((row) => row.status === "new").length,
      duplicate: rows.filter((row) => row.status === "duplicate").length,
      conflict: rows.filter((row) => row.status === "conflict").length,
      unresolved: input.parsed.unresolved.length,
      anomalies: input.parsed.fills.filter((row) => row.anomalies.length)
        .length,
      ...(input.parsed.cashFlowSummary
        ? { cashFlowSummary: input.parsed.cashFlowSummary }
        : {}),
      ...(input.parsed.counts ? { counts: input.parsed.counts } : {}),
    },
    mapping: input.parsed.mapping,
    unmapped: input.parsed.mapping.unmapped,
    diagnostics: input.parsed.diagnostics,
  };
}

export function commitDeliveryImport(
  bytes: Uint8Array,
  options: unknown,
  db: Database.Database,
) {
  return new DeliveryStore(db).commitImport({
    ...prepare(bytes, options),
    importedAt: Date.now(),
  });
}
