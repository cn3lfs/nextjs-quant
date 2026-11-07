import {
  financialCatalog,
  financialMappingVersion,
  type FinancialDefinition,
} from "./catalog.js";
export type FinancialCell = {
  code: string;
  label: string;
  section: string;
  slot: number;
  raw: number | null;
  value: number | null;
  unit: string;
  rawUnit: string;
  scale: number;
  timing: FinancialDefinition["timing"];
  status: "value" | "source-zero" | "missing" | "not-applicable" | "unverified";
  reason: string | null;
};
export type FinancialReportSnapshot = {
  symbol: string;
  financialCompany: boolean | null;
  reportDate: string;
  announcementDate: string | null;
  availableFrom?: string | null;
  calendar?: { hash: string | null; source: string };
  sourceFilename: string;
  sourceSha256: string;
  contentSha256: string;
  recordOffset: number;
  mappingVersion: string;
  fields: FinancialCell[];
  warnings: string[];
};

export function financialDate(
  value: number,
  reportYear?: number,
): string | null {
  if (!Number.isInteger(value) || value <= 0) return null;
  let text = String(value);
  if (text.length <= 6) {
    text = text.padStart(6, "0");
    if (reportYear === undefined) return null;
    const century = Math.floor(reportYear / 100) * 100;
    let year = century + Number(text.slice(0, 2));
    if (year < reportYear - 50) year += 100;
    if (year > reportYear + 50) year -= 100;
    text = String(year) + text.slice(2);
  }
  if (!/^\d{8}$/.test(text)) return null;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

export function projectFinancialFields(
  values: readonly number[],
  financialCompany: boolean | null,
  selectedSlots?: readonly number[],
  reportYear?: number,
): FinancialCell[] {
  const mapped = new Map(
    financialCatalog
      .filter((f) => f.namespace === "FN" && f.slot !== null)
      .map((f) => [f.slot!, f]),
  );
  const slots =
    selectedSlots ?? Array.from({ length: values.length }, (_, slot) => slot);
  return slots
    .filter((slot) => slot >= 0 && slot < values.length)
    .map((slot) => {
      const raw = values[slot]!;
      const definition = mapped.get(slot);
      if (!definition)
        return {
          code: `RAW${slot + 1}`,
          label: `未核验槽位 ${slot + 1}`,
          section: "未知/保留槽位",
          slot,
          raw,
          value: null,
          unit: "原单位",
          rawUnit: "未知",
          scale: 1,
          timing: "unknown",
          status: "unverified",
          reason: "缺少权威物理映射，原值保留但不参与业务计算",
        };
      let status: FinancialCell["status"] = "value",
        reason: string | null = null;
      if (definition.mappingStatus !== "mapped") {
        status = "unverified";
        reason = "官方未提供业务含义或该槽位属于保留项";
      } else if (
        (definition.financialOnly && financialCompany === false) ||
        (definition.nonFinancialOnly && financialCompany === true)
      ) {
        status = "not-applicable";
        reason = "该字段不适用于证券所属行业";
      } else if (!Number.isFinite(raw)) {
        status = "missing";
        reason = "字段不是有限数";
      } else if (raw === 0 && definition.id !== 336) {
        status = "source-zero";
        reason = "来源以0同时表示部分空值；保留原值，不能据此认证业务零值";
      } else if (definition.unit === "原单位") {
        status = "unverified";
        reason = "字段名称已识别，单位尚未核验，不参与标准化计算";
      }
      let normalized = raw * definition.scale;
      if (definition.unit === "日期" && raw !== 0) {
        const parsed = financialDate(raw, reportYear);
        if (parsed) normalized = Number(parsed.replaceAll("-", ""));
        else {
          status = "missing";
          reason = "日期非法或无法确认世纪";
        }
      }
      return {
        code: definition.code,
        label: definition.label,
        section: definition.section,
        slot,
        raw: Number.isFinite(raw) ? raw : null,
        value:
          status === "not-applicable" || status === "missing"
            ? null
            : normalized,
        unit: definition.unit,
        rawUnit: definition.rawUnit,
        scale: definition.scale,
        timing: definition.timing,
        status,
        reason,
      };
    });
}
export const sourceFinancialValue = (
  report: FinancialReportSnapshot | undefined,
  id: number,
): number | null => {
  const field = report?.fields.find((field) => field.code === `FN${id}`);
  return field?.status === "value" ? field.value : null;
};

/** First observed trading date after a date-only announcement; never invent a calendar. */
export function financialAvailableFrom(
  announcement: string | null,
  tradingDays: readonly string[],
): string | null {
  if (!announcement) return null;
  let left = 0,
    right = tradingDays.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tradingDays[middle]! <= announcement) left = middle + 1;
    else right = middle;
  }
  return tradingDays[left] ?? null;
}

/** Calendar-qualified inputs additionally require the observed next trading date. */
export function financialVisibleAt(
  report: FinancialReportSnapshot,
  asOf: string,
): boolean {
  return (
    !!report.announcementDate &&
    report.announcementDate > report.reportDate &&
    report.announcementDate < asOf &&
    (report.availableFrom === undefined ||
      (!!report.availableFrom && report.availableFrom <= asOf)) &&
    report.reportDate <= asOf
  );
}
