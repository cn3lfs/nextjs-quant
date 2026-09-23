import { z } from "zod";
import { asOfObservationSchema } from "../evidence/as-of";
import { researchDateSchema } from "./research-usage";
import { symbolSchema } from "../../domain";

/**
 * Frozen SuperMind cloud snapshots.
 *
 * SuperMind is used only for what the local 通达信 corpus cannot produce:
 * disclosure dates (公布日), point-in-time index membership and historical
 * industry classification. Quotes stay local. Everything pulled from the cloud
 * is written to a content-addressed frozen store before a backtest may read it,
 * so a run never fetches live data mid-flight.
 *
 * Frozen rows ARE `AsOfObservation`s, minus `capturedAt`:
 *
 *  - `effectiveAt` is the business date the value describes (报告期 / 成分日).
 *  - `availableAt` is the first instant the value could be known. It is a
 *    REQUIRED input, never derived from the report period, the capture time or
 *    a file mtime.
 *  - `capturedAt` identifies the capture, not the value, so it lives in the
 *    envelope instead of the payload. Two captures of the same request then
 *    produce byte-identical payloads, and re-capturing after a restatement
 *    produces a different payload hash that is kept alongside the old one.
 */

export const supermindDatasets = ["disclosure-dates", "index-members"] as const;
export type SupermindDataset = (typeof supermindDatasets)[number];

/**
 * A-share disclosures and index lists are date-only. A report dated D may reach
 * the market at any point during D — including after the 15:00 close — so
 * claiming it was known at D 00:00 would be look-ahead. Rounding up to the
 * start of the next Shanghai day is never earlier than reality, which is the
 * only direction that keeps a backtest honest. It costs one day of freshness;
 * that is the deliberate price of not inventing a publication timestamp.
 */
export function dateOnlyKnowableAt(date: string) {
  const parsed = researchDateSchema.safeParse(date);
  if (!parsed.success) throw new Error(`日期无效：${date}`);
  const [year, month, day] = parsed.data.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  // China Standard Time has no DST, so UTC arithmetic on the calendar date is
  // exact and needs no timezone database.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00+08:00`;
}

/** `600519.SH` (platform) -> `sh600519` (this repository). */
export function toLocalSymbol(code: string) {
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code.trim().toUpperCase());
  if (!match) throw new Error(`无法识别的证券代码：${code}`);
  return `${match[2]!.toLowerCase()}${match[1]!}`;
}

// ---------------------------------------------------------------------------
// Raw shapes as delivered by the remote fetch scripts. Platform-native names,
// so a change in what the platform returns is caught here rather than silently
// shifting a frozen value.
// ---------------------------------------------------------------------------

const decimalText = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const reporttypecodeText = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !/^[+-]?(?:nan|inf(?:inity)?)$/i.test(value),
    "reporttypecode 不能是非有限值哨兵文本",
  );
const reporttypecodeSchema = z.union([reporttypecodeText, z.number().finite()]);

/**
 * The four statement tables the 217 factor methods read. `profit_report` is
 * deliberately NOT here: it is the 业绩快报 table and only carries a few hundred
 * symbols per snapshot, while these four cover the whole market.
 */
export const supermindStatementTables = [
  "income",
  "balance",
  "cashflow",
  "valuation",
] as const;
export type SupermindStatementTable = (typeof supermindStatementTables)[number];

/** One frozen field id and unit per table; the value is the metric object. */
export const supermindStatementFields: Record<
  SupermindStatementTable,
  { field: string; unit: string }
> = {
  income: { field: "incomeStatement", unit: "CNY-statement" },
  balance: { field: "balanceStatement", unit: "CNY-statement" },
  cashflow: { field: "cashflowStatement", unit: "CNY-statement" },
  // 市值类为人民币、倍数为无量纲，不做单位换算，如实标为混合。
  valuation: { field: "valuationMultiples", unit: "CNY-and-ratio" },
};

export const supermindDisclosureRawSchema = z
  .object({
    /** Platform table the row came from. */
    table: z.enum(supermindStatementTables),
    /** Platform code, e.g. `600519.SH`. */
    symbol: z.string().min(1),
    /** `date` column: the point-in-time snapshot the row was read at. */
    snapshotDate: researchDateSchema,
    /** 公布日. Never the report period. */
    reportDate: researchDateSchema,
    /** 报告期. */
    statDate: researchDateSchema,
    /** `valuation` has no change_id column; null is not the same as 0. */
    changeId: z.number().int().nonnegative().nullable(),
    /** Raw platform report type; preserved but not interpreted here. */
    reporttypecode: reporttypecodeSchema.nullable().optional(),
    /**
     * Metric name -> exact decimal text. Nulls are dropped upstream, so a key
     * that is absent means "the platform returned null for it" or "this table
     * has no such column"; the exact requested column list lives in the fetch
     * script and in the envelope's `request`, which is what makes that
     * unambiguous.
     */
    metrics: z.record(z.string(), decimalText),
  })
  .strict();
export type SupermindDisclosureRaw = z.infer<
  typeof supermindDisclosureRawSchema
>;

export const supermindIndexMembersRawSchema = z
  .object({
    /** Platform index code, e.g. `000300.SH`. */
    indexCode: z.string().min(1),
    /** The date the membership was requested for. */
    snapshotDate: researchDateSchema,
    symbols: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SupermindIndexMembersRaw = z.infer<
  typeof supermindIndexMembersRawSchema
>;

// ---------------------------------------------------------------------------
// Frozen row shape: a full as-of observation without the capture stamp.
// ---------------------------------------------------------------------------

export const supermindFrozenRowSchema = asOfObservationSchema.omit({
  capturedAt: true,
});
export type SupermindFrozenRow = z.infer<typeof supermindFrozenRowSchema>;

export const supermindEnvelopeSchema = z
  .object({
    version: z.literal(1),
    dataset: z.enum(supermindDatasets),
    captureId: z.string().min(1),
    /** The four as-of time fields, split by what they identify. */
    capturedAt: z.string().datetime({ offset: true }),
    request: z.record(z.string(), z.unknown()),
    /** Frozen rows, i.e. lines in payload.jsonl after canonical de-duplication. */
    rowCount: z.number().int().nonnegative(),
    /**
     * Raw records handed in, summed over shards; overlaps show up here.
     * Optional because captures written before sharded fetching predate the
     * field. Absent means "not recorded", never "zero": the store is
     * append-only and an older envelope is never rewritten to add it.
     */
    inputRowCount: z.number().int().nonnegative().optional(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    payloadBytes: z.number().int().nonnegative(),
  })
  .strict();
export type SupermindEnvelope = z.infer<typeof supermindEnvelopeSchema>;

/** Deterministic key order + no insignificant whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const rowOrder = (row: SupermindFrozenRow) =>
  JSON.stringify([
    row.domain,
    row.entity,
    row.field,
    row.effectiveAt,
    row.versionId,
  ]);

/**
 * Canonical payload text: rows validated against the frozen schema, sorted by
 * identity and de-duplicated. Re-capturing the same facts at a later snapshot
 * date therefore collapses onto the same bytes, and a payload hash identifies
 * the facts rather than the moment they were fetched.
 */
export function canonicalSupermindPayload(rows: SupermindFrozenRow[]) {
  const parsed = rows.map((row, index) => {
    const result = supermindFrozenRowSchema.safeParse(row);
    if (!result.success)
      throw new Error(
        `冻结行 ${index} 不符合 as-of 契约：${result.error.issues
          .map((issue) => issue.path.join("."))
          .join(", ")}`,
      );
    return result.data;
  });
  const unique = new Map<string, string>();
  for (const row of parsed) unique.set(canonical(row), rowOrder(row));
  const text = [...unique.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([line]) => line)
    .join("\n");
  return text.length ? `${text}\n` : "";
}

/** `2024-05-01T15:00:00+08:00` -> `20240501T070000000Z`. */
export function captureStamp(capturedAt: string) {
  const parsed = z.string().datetime({ offset: true }).safeParse(capturedAt);
  if (!parsed.success) throw new Error(`采集时间无效：${capturedAt}`);
  return new Date(parsed.data)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export const supermindCaptureId = (capturedAt: string, payloadHash: string) =>
  `${captureStamp(capturedAt)}-${payloadHash.slice(0, 12)}`;

// ---------------------------------------------------------------------------
// Raw -> as-of rows
// ---------------------------------------------------------------------------

export const supermindSources = {
  "disclosure-dates": "supermind.income",
  "index-members": "supermind.get_index_stocks",
} as const;

export function buildDisclosureRows(
  raw: SupermindDisclosureRaw[],
): SupermindFrozenRow[] {
  return raw.map((row) => {
    const { field, unit } = supermindStatementFields[row.table];
    const change = row.changeId === null ? "none" : String(row.changeId);
    // Metric keys are emitted in sorted order so the frozen bytes never depend
    // on the order the platform happened to return columns in.
    const metrics = Object.fromEntries(
      Object.entries(row.metrics).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    const availabilityEvidence = {
      kind: "version-publication" as const,
      reference: `supermind:${row.table}:report_date=${row.reportDate}&change_id=${change}`,
      ...(row.reporttypecode !== undefined
        ? { reporttypecode: row.reporttypecode }
        : {}),
    };
    const reporttypeVersion =
      row.reporttypecode === undefined
        ? ""
        : `:reporttype=${encodeURIComponent(JSON.stringify(row.reporttypecode))}`;
    return {
      domain: "finance" as const,
      entity: toLocalSymbol(row.symbol),
      field,
      effectiveAt: row.statDate,
      source: supermindSources["disclosure-dates"],
      availableAt: dateOnlyKnowableAt(row.reportDate),
      versionId: `${row.table}:${toLocalSymbol(row.symbol)}:${row.statDate}:${row.reportDate}:chg${change}${reporttypeVersion}`,
      availabilityEvidence,
      unit,
      value: metrics,
    };
  });
}

export function buildIndexMemberRows(
  raw: SupermindIndexMembersRaw[],
): SupermindFrozenRow[] {
  return raw.map((row) => {
    const members = row.symbols
      .map(toLocalSymbol)
      .filter((symbol) => symbolSchema.safeParse(symbol).success);
    if (!members.length)
      throw new Error(`${row.indexCode} ${row.snapshotDate} 无可用成分`);
    if (new Set(members).size !== members.length)
      throw new Error(`${row.indexCode} ${row.snapshotDate} 成分重复`);
    return {
      domain: "rs" as const,
      entity: row.indexCode,
      field: "members",
      effectiveAt: row.snapshotDate,
      source: supermindSources["index-members"],
      availableAt: dateOnlyKnowableAt(row.snapshotDate),
      versionId: `${row.indexCode}:${row.snapshotDate}`,
      availabilityEvidence: {
        kind: "version-publication" as const,
        reference: `supermind:get_index_stocks:${row.indexCode}@${row.snapshotDate}`,
      },
      unit: "security",
      value: members,
    };
  });
}

export function buildSupermindRows(
  dataset: SupermindDataset,
  raw: unknown,
): SupermindFrozenRow[] {
  if (dataset === "disclosure-dates") {
    const parsed = z.array(supermindDisclosureRawSchema).safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `disclosure-dates 原始数据不符合契约：${parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    return buildDisclosureRows(parsed.data);
  }
  if (dataset === "index-members") {
    const parsed = z.array(supermindIndexMembersRawSchema).safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `index-members 原始数据不符合契约：${parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    return buildIndexMemberRows(parsed.data);
  }
  // Exhaustive: a new dataset must add a branch rather than fall through.
  const never: never = dataset;
  throw new Error(`未知数据集：${String(never)}`);
}

/** Re-attach the capture stamp, yielding rows the as-of adapter accepts. */
export function materializeSupermindRows(
  rows: SupermindFrozenRow[],
  capturedAt: string,
) {
  const parsed = z.string().datetime({ offset: true }).safeParse(capturedAt);
  if (!parsed.success) throw new Error(`采集时间无效：${capturedAt}`);
  return rows.map((row, index) => {
    const result = asOfObservationSchema.safeParse({
      ...row,
      capturedAt: parsed.data,
    });
    if (!result.success)
      throw new Error(
        `冻结行 ${index} 补上 capturedAt 后不符合 as-of 契约：${result.error.issues
          .map((issue) => issue.path.join("."))
          .join(", ")}`,
      );
    return result.data;
  });
}
