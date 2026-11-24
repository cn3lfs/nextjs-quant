import { resolve } from "node:path";
import { z } from "zod";
import { parseFinancialSeries } from "tstdx";
import {
  financialDirectory,
  isAStock,
  readStableFinancialFile,
} from "tstdx/local";
import { validateStrategyBars } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { financialDate } from "trading-strategy-core/financial";

type Provenance = {
  symbol: string;
  sourcePath: string;
  sourceSha256: string;
  effectiveDate: string;
  knownAt: string | null;
};

type Gp29Record = Provenance & {
  kind: "GP29";
  offset: number;
  suspendedSessions: number;
};

/** Inclusive calendar dates. effectiveDate is the first day of the notice's
 * suspension window. recordId locates the notice in its hashed source. */
export type SuspensionAnnouncement = Provenance & {
  kind: "announcement";
  throughDate: string;
  recordId: string;
};

export type Gp29Evidence =
  | { status: "available"; records: readonly Gp29Record[] }
  | { status: "absent" | "invalid"; sourcePath: string; reason: string };

export type CertifiedSuspensionDay = {
  symbol: string;
  date: string;
  resumptionDate: string;
  sources: readonly (Gp29Record | SuspensionAnnouncement)[];
};

export type SessionEvidenceSummary = {
  certifiedSuspensions: CertifiedSuspensionDay[];
  unknownDates: string[];
};

/** Snapshot observation time proves this exact revision was available for
 * post-hoc scoring. The GP29 effective date does not prove publication time. */
export async function readGp29Evidence(
  root: string,
  symbol: string,
): Promise<Gp29Evidence> {
  if (!isAStock(symbol)) throw new Error("GP29 requires an A-share symbol");
  const sourcePath = resolve(financialDirectory(root), `gp${symbol}.dat`);
  try {
    const { body, loadedAt } = await readStableFinancialFile(sourcePath);
    const { records, sourceSha256 } = parseFinancialSeries(body);
    const result: Gp29Record[] = [];
    for (const record of records) {
      if (record.group !== 29) continue;
      const effectiveDate = financialDate(record.date ?? 0);
      if (!effectiveDate)
        throw new Error(`Undated GP29 at offset ${record.offset}`);
      const [suspendedSessions, renameCode] = record.values;
      if (
        !Number.isSafeInteger(suspendedSessions) ||
        suspendedSessions < 0 ||
        !Number.isInteger(renameCode) ||
        renameCode < 0 ||
        renameCode > 5
      )
        throw new Error(`Invalid GP29 at offset ${record.offset}`);
      result.push({
        kind: "GP29",
        symbol,
        sourcePath,
        sourceSha256,
        effectiveDate,
        knownAt: new Date(loadedAt).toISOString(),
        offset: record.offset,
        suspendedSessions,
      });
    }
    return { status: "available", records: result };
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "absent"
          : "invalid",
      sourcePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const dateLabel = z.string().date();
const timestamp = z.string().datetime({ offset: true });
// Date-only evidence has end-of-day precision on the A-share clock.
function instant(label: string | null) {
  if (dateLabel.safeParse(label).success)
    return Date.parse(`${label}T23:59:59.999+08:00`);
  return label && timestamp.safeParse(label).success ? Date.parse(label) : NaN;
}

/** Supply the independent snapshot calendar and raw bars of the replay
 * prefix. asOf is the observation cutoff for the evidence snapshot, which
 * can be later than the historical replay. Nothing here supplies a price. */
export function resolveSessionEvidence(input: {
  symbol: string;
  /** All market-open sessions in the evidence snapshot, including after replayEnd. */
  calendar: readonly string[];
  replayEnd?: string;
  bars: readonly Bar[];
  asOf: string;
  gp29?: Gp29Evidence;
  announcements?: readonly SuspensionAnnouncement[];
}): SessionEvidenceSummary {
  const { symbol, bars, gp29 } = input;
  const { replayEnd } = input;
  const calendar = replayEnd
    ? input.calendar.filter((date) => date <= replayEnd)
    : input.calendar;
  const barIndices = new Map(bars.map((bar, index) => [bar.date, index]));
  const unknownDates = calendar.filter((date) => !barIndices.has(date));
  const unresolved = { certifiedSuspensions: [], unknownDates };
  const cutoff = instant(input.asOf);
  if (
    !unknownDates.length ||
    !isAStock(symbol) ||
    !Number.isFinite(cutoff) ||
    gp29?.status === "invalid" ||
    input.calendar.some(
      (date, i) =>
        !dateLabel.safeParse(date).success ||
        (i > 0 && date <= input.calendar[i - 1]!),
    )
  )
    return unresolved;
  try {
    validateStrategyBars(bars);
  } catch {
    return unresolved;
  }
  const gp = gp29?.status === "available" ? gp29.records : [];
  const notices = (input.announcements ?? []).filter(
    (f) => f.symbol === symbol,
  );
  if (
    gp.some(
      (f) =>
        f.symbol !== symbol || !dateLabel.safeParse(f.effectiveDate).success,
    ) ||
    notices.some(
      (f) =>
        !dateLabel.safeParse(f.effectiveDate).success ||
        !dateLabel.safeParse(f.throughDate).success ||
        f.throughDate < f.effectiveDate,
    )
  )
    return unresolved;
  const calendarIndex = new Map(input.calendar.map((date, i) => [date, i]));
  const certified = new Map<string, CertifiedSuspensionDay>();
  for (let i = 0; i < calendar.length;) {
    if (barIndices.has(calendar[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < calendar.length && !barIndices.has(calendar[i]!)) i++;
    const previous = calendar[start - 1],
      resume = calendar[i];
    if (!previous || !resume) continue;
    const index = barIndices.get(resume)!;
    if (
      index !== barIndices.get(previous)! + 1 ||
      bars[index]!.volume <= 0 ||
      Date.parse(`${resume}T15:00:00+08:00`) > cutoff
    )
      continue;
    const first = calendar[start]!,
      last = calendar[i - 1]!;
    // A second claim whose implied window intersects this gap also conflicts,
    // even if its GP29 record appears after the apparent resumption.
    const rows = gp.filter((f) => {
      if (f.effectiveDate >= first && f.effectiveDate <= resume) return true;
      const end = calendarIndex.get(f.effectiveDate);
      return end !== undefined && end > i && end - f.suspendedSessions <= i;
    });
    if (
      rows.length > 1 ||
      rows.some(
        (f) =>
          f.effectiveDate !== resume ||
          f.suspendedSessions !== i - start ||
          !Number.isSafeInteger(f.offset) ||
          f.offset < 0 ||
          f.offset % 13 !== 0 ||
          !(instant(f.knownAt) >= Date.parse(`${resume}T00:00:00+08:00`)),
      )
    )
      continue;
    const overlapping = notices.filter(
      (f) => f.effectiveDate <= resume && f.throughDate >= previous,
    );
    if (
      overlapping.some(
        (f) =>
          f.effectiveDate <= previous ||
          f.effectiveDate > first ||
          f.throughDate < last ||
          f.throughDate >= resume ||
          !f.recordId?.trim(),
      )
    )
      continue;
    const sources = [...rows, ...overlapping];
    if (
      !sources.length ||
      sources.some(
        (f) =>
          !f.sourcePath?.trim() ||
          !/^[0-9a-f]{64}$/i.test(f.sourceSha256) ||
          !(instant(f.knownAt) <= cutoff),
      )
    )
      continue;
    for (const date of calendar.slice(start, i))
      certified.set(date, { symbol, date, resumptionDate: resume, sources });
  }
  return {
    certifiedSuspensions: [...certified.values()],
    unknownDates: unknownDates.filter((date) => !certified.has(date)),
  };
}
