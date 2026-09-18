import { z } from "zod";
import { asOfObservationSchema } from "./as-of";
import { researchDateSchema } from "./research-usage";
import { symbolSchema } from "./domain";

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

export const supermindDisclosureRawSchema = z
  .object({
    /** Platform table the row came from, e.g. `income`. */
    table: z.literal("income"),
    /** Platform code, e.g. `600519.SH`. */
    symbol: z.string().min(1),
    /** `date` column: the point-in-time snapshot the row was read at. */
    snapshotDate: researchDateSchema,
    /** 公布日. Never the report period. */
    reportDate: researchDateSchema,
    /** 报告期. */
    statDate: researchDateSchema,
    changeId: z.number().int().nonnegative(),
    /** 营业总收入, frozen as decimal text so no binary float is stored. */
    overallIncome: decimalText.nullable(),
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
    rowCount: z.number().int().nonnegative(),
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
  return raw.map((row) => ({
    domain: "finance" as const,
    entity: toLocalSymbol(row.symbol),
    field: "quarterlyOverallIncome",
    effectiveAt: row.statDate,
    source: supermindSources["disclosure-dates"],
    availableAt: dateOnlyKnowableAt(row.reportDate),
    versionId: `${row.table}:${row.statDate}:${row.reportDate}:chg${row.changeId}`,
    availabilityEvidence: {
      kind: "version-publication" as const,
      reference: `supermind:${row.table}:report_date=${row.reportDate}&change_id=${row.changeId}`,
    },
    unit: "CNY-statement",
    value: row.overallIncome,
  }));
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
