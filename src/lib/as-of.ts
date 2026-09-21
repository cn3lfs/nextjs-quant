import { z } from "zod";
import { researchDateSchema } from "./research-usage";

export const asOfDomains = [
  "finance",
  "capital",
  "institutions",
  "catalysts",
  "rs",
  "benchmarkCalendar",
] as const;
export type AsOfDomain = (typeof asOfDomains)[number];
const text = z.string().trim().min(1);
export const asOfTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "时间或时区偏移无效");
// A date-only effectiveAt denotes a business date (Shanghai midnight), never
// a publication time. availableAt/capturedAt always require an explicit offset.
export const asOfEffectiveSchema = z.union([
  researchDateSchema,
  asOfTimestampSchema,
]);
const time = (value: string) =>
  Date.parse(value.length === 10 ? `${value}T00:00:00+08:00` : value);
const identitySchema = z.object({
  domain: z.enum(asOfDomains),
  entity: text,
  field: text,
  effectiveAt: asOfEffectiveSchema,
});
export const asOfObservationSchema = identitySchema
  .extend({
    source: text,
    availableAt: asOfTimestampSchema,
    capturedAt: asOfTimestampSchema,
    // Identifies this exact published value version, not a file format version.
    versionId: text,
    availabilityEvidence: z
      .object({
        kind: z.literal("version-publication"),
        reference: text,
        // Optional because older frozen captures predate raw report type
        // preservation. New statement captures keep the platform's exact
        // categorical code without interpreting its business meaning.
        reporttypecode: z
          .union([
            z
              .string()
              .trim()
              .min(1)
              .refine(
                (value) => !/^[+-]?(?:nan|inf(?:inity)?)$/i.test(value),
                "reporttypecode 不能是非有限值哨兵文本",
              ),
            z.number().finite(),
          ])
          .nullable()
          .optional(),
      })
      .strict(),
    unit: text,
    value: z.unknown(),
  })
  .strict();
export type AsOfObservation = z.infer<typeof asOfObservationSchema>;
export type AsOfFieldRequest<T> = z.infer<typeof identitySchema> & {
  unit: string;
  schema: z.ZodType<T>;
  source?: string;
};
export type AsOfResult<T> =
  | {
      status: "available";
      value: T;
      provenance: Omit<AsOfObservation, "value">;
    }
  | { status: "missing"; value: null; code: string; reason: string };
const missing = (code: string, reason: string): AsOfResult<never> => ({
  status: "missing",
  value: null,
  code,
  reason,
});
const key = (r: z.infer<typeof identitySchema>) =>
  JSON.stringify([r.domain, r.entity, r.field, time(r.effectiveAt)]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Pure, offline adapter. Publication evidence is a caller-supplied assertion
 * about the EXACT value version; this validates the contract, not its truth.
 * No inferred publication dates, source fallback, or carry-forward to a new
 * effective date. capturedBy optionally freezes what the archive had ingested.
 */
export function createAsOfAdapter(
  raw: unknown,
  cutoff: { asOf: string; capturedBy?: string },
) {
  const clock = z
    .object({
      asOf: asOfTimestampSchema,
      capturedBy: asOfTimestampSchema.optional(),
    })
    .strict()
    .safeParse(cutoff);
  const input = z.array(z.unknown()).safeParse(raw);
  const index = new Map<string, unknown[]>();
  let invalidIdentity = false;
  if (input.success)
    for (const row of input.data) {
      const identity = identitySchema.safeParse(row);
      if (!identity.success) {
        invalidIdentity = true;
        continue;
      }
      const id = key(identity.data);
      index.set(id, [...(index.get(id) ?? []), row]);
    }
  return {
    read<T>(request: AsOfFieldRequest<T>): AsOfResult<T> {
      const identity = identitySchema.safeParse(request);
      if (!clock.success || !identity.success)
        return missing(
          "invalid-request",
          "查询时点须为带时区时间，字段身份和生效时点须明确",
        );
      if (!input.success || invalidIdentity)
        return missing(
          "invalid-input",
          "输入不是记录数组或存在无法归属的记录，不能静默丢弃",
        );
      const asOf = time(clock.data.asOf);
      if (time(request.effectiveAt) > asOf)
        return missing("not-effective", "请求的生效时点晚于研究时点");
      const selected: AsOfObservation[] = [];
      for (const rawRow of index.get(key(identity.data)) ?? []) {
        const row = rawRow as Record<string, unknown>;
        if (request.source !== undefined && row.source !== request.source)
          continue;
        const available = asOfTimestampSchema.safeParse(row.availableAt);
        if (!available.success)
          return missing(
            "missing-available-at",
            "缺少可信首次可知时间 availableAt；报告期、采集时间和文件mtime均不能替代",
          );
        if (time(available.data) > asOf) continue;
        const parsed = asOfObservationSchema.safeParse(row);
        if (!parsed.success)
          return missing(
            "invalid-provenance",
            `来源/版本/首次可知证据/采集时间或字段契约缺失：${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
          );
        const r = parsed.data;
        if (time(r.capturedAt) < time(r.availableAt))
          return missing(
            "invalid-capture-time",
            "公开数据的采集时间早于该版本首次可知时间",
          );
        if (
          clock.data.capturedBy &&
          time(r.capturedAt) > time(clock.data.capturedBy)
        )
          continue;
        selected.push(r);
      }
      if (!selected.length)
        return missing(
          "no-coverage",
          `${request.domain}/${request.entity}/${request.field}@${request.effectiveAt} 无截至研究时点可知的已覆盖版本`,
        );
      const sources = new Set(selected.map((r) => r.source));
      if (sources.size !== 1)
        return missing(
          "source-conflict",
          "同字段存在多个来源；须显式选择来源，不能静默择优",
        );
      const versions = new Map<string, string>();
      for (const r of selected) {
        const signature = canonical({
          availableAt: time(r.availableAt),
          unit: r.unit,
          value: r.value,
        });
        if (
          versions.has(r.versionId) &&
          versions.get(r.versionId) !== signature
        )
          return missing(
            "version-conflict",
            "同一公开版本包含冲突值或首次可知时间；修订必须有独立版本与可知时间",
          );
        versions.set(r.versionId, signature);
      }
      selected.sort(
        (a, b) =>
          time(b.availableAt) - time(a.availableAt) ||
          time(a.capturedAt) - time(b.capturedAt) ||
          canonical(a).localeCompare(canonical(b)),
      );
      const latest = selected[0]!;
      if (
        selected.some(
          (r) =>
            time(r.availableAt) === time(latest.availableAt) &&
            canonical({ value: r.value, unit: r.unit }) !==
              canonical({ value: latest.value, unit: latest.unit }),
        )
      )
        return missing(
          "value-conflict",
          "同一可知时点存在冲突值，不能按输入顺序选取",
        );
      if (latest.unit !== request.unit)
        return missing(
          "unit-mismatch",
          `字段单位应为${request.unit}，实际为${latest.unit}`,
        );
      const value = request.schema.safeParse(latest.value);
      if (latest.value === null || latest.value === undefined || !value.success)
        return missing(
          "invalid-value",
          "最新可知版本字段缺失或数值/结构非法；不回退旧值、不填零",
        );
      const { value: _value, ...provenance } = latest;
      return { status: "available", value: value.data, provenance };
    },
  };
}
