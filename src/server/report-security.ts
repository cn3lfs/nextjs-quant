import { sqlite } from "./db";
import { symbolSchema } from "~/lib/domain";

/** Resolve only application-owned context links, never model prose or citations. */
export function reportSecurityContext(contextId: string) {
  const row = sqlite()
    .prepare(
      `
    SELECT c.kind, json_extract(c.payload, '$.type') AS type,
      json_extract(c.payload, '$.symbol') AS symbol,
      json_extract(c.payload, '$.name') AS name,
      json_extract(s.payload, '$.symbol') AS linkedSymbol,
      json_extract(s.payload, '$.name') AS linkedName
    FROM records c LEFT JOIN records s ON s.kind = 'snapshot' AND s.id =
      CASE WHEN c.kind = 'signal' THEN json_extract(c.payload, '$.snapshotId')
        WHEN c.kind = 'job' THEN json_extract(c.payload, '$.input.snapshotId') END
    WHERE c.id = ?
  `,
    )
    .get(contextId) as
    | {
        kind: string;
        type: string | null;
        symbol: unknown;
        name: unknown;
        linkedSymbol: unknown;
        linkedName: unknown;
      }
    | undefined;
  if (!row) return null;
  let symbol: unknown, name: unknown;
  if (row.kind === "snapshot") {
    symbol = row.symbol;
    name = row.name;
  } else if (row.kind === "signal") {
    symbol = row.symbol;
    if (row.linkedSymbol && row.linkedSymbol !== symbol) return null;
    name = row.linkedName;
  } else if (
    row.kind === "job" &&
    ["backtest", "walk-forward"].includes(row.type ?? "")
  ) {
    symbol = row.linkedSymbol;
    name = row.linkedName;
  } else return null;
  const parsed = symbolSchema.safeParse(symbol);
  return parsed.success
    ? {
        symbol: parsed.data,
        archivedName: typeof name === "string" ? name : undefined,
      }
    : null;
}
