import {
  evaluateMacroClockEtfRotation,
  macroSeriesIds,
  type MacroObservation,
  type MacroSeriesId,
} from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { z } from "zod";
import { beijingClock } from "~/lib/market/market-session";
import { atomic, get, put, sqlite } from ".";

const recordKind = "macro-pit-series";
const recordId = (seriesId: MacroSeriesId) => `macro-pit-series-v1:${seriesId}`;
const seriesIdSchema = z.enum(macroSeriesIds);
const observationSchema = z
  .object({
    seriesId: seriesIdSchema,
    reportPeriod: researchDateSchema,
    availableAt: researchDateSchema,
    value: z.number().finite(),
    publicationBasis: z.enum(["official", "conservative-lag"]),
  })
  .refine((row) => row.availableAt >= row.reportPeriod, {
    path: ["availableAt"],
    message: "可用日期不能早于报告期",
  });
const seriesSchema = z
  .object({
    seriesId: seriesIdSchema,
    rows: z.array(observationSchema),
    source: z.string().trim().min(1),
    fetchedAt: z.number().int().nonnegative(),
  })
  .refine(
    (series) => series.rows.every((row) => row.seriesId === series.seriesId),
    {
      path: ["rows"],
      message: "观测值与记录的宏观序列不一致",
    },
  );

const compareObservations = (a: MacroObservation, b: MacroObservation) =>
  a.reportPeriod.localeCompare(b.reportPeriod) ||
  a.availableAt.localeCompare(b.availableAt) ||
  a.seriesId.localeCompare(b.seriesId);

function nextDay(day: string) {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
}

function revisionAvailableAt(fetchedAt: number) {
  const { date, minutes } = beijingClock(fetchedAt);
  return minutes >= 15 * 60 ? nextDay(date) : date;
}

function readSeries(seriesId: MacroSeriesId) {
  const payload = get<unknown>(recordId(seriesId));
  if (payload === undefined) return undefined;
  return seriesSchema
    .refine((series) => series.seriesId === seriesId, "宏观序列记录键不匹配")
    .parse(payload);
}

export function upsertMacroSeries(
  seriesId: MacroSeriesId,
  rows: readonly MacroObservation[],
  meta: { source: string; fetchedAt: number },
) {
  const incoming = seriesSchema.parse({ ...meta, seriesId, rows });
  const fetchedDay = revisionAvailableAt(incoming.fetchedAt);
  return atomic(() => {
    const vintages = new Map<string, MacroObservation>();
    const latest = new Map<string, MacroObservation>();
    const remember = (row: MacroObservation) => {
      vintages.set(`${row.reportPeriod}:${row.availableAt}`, row);
      const prior = latest.get(row.reportPeriod);
      if (!prior || row.availableAt > prior.availableAt)
        latest.set(row.reportPeriod, row);
    };
    const previous = readSeries(seriesId);
    for (const row of previous?.rows ?? []) remember(row);
    for (const row of incoming.rows) {
      const mostRecent = latest.get(row.reportPeriod);
      if (!mostRecent) {
        remember(row);
        continue;
      }
      if (mostRecent.value === row.value) continue;

      // Keep every earlier vintage visible on its original replay date.
      const availableAt =
        row.availableAt > fetchedDay ? row.availableAt : fetchedDay;
      remember({
        ...row,
        availableAt:
          availableAt > mostRecent.availableAt
            ? availableAt
            : nextDay(mostRecent.availableAt),
      });
    }
    return put(recordKind, recordId(seriesId), {
      ...incoming,
      rows: [...vintages.values()].sort(compareObservations),
    });
  });
}

export function readMacroObservations(options?: {
  seriesIds?: readonly MacroSeriesId[];
  asOf?: string;
}): MacroObservation[] {
  const asOf = researchDateSchema.optional().parse(options?.asOf);
  const ids = new Set(
    z.array(seriesIdSchema).parse(options?.seriesIds ?? macroSeriesIds),
  );
  return sqlite().transaction(() =>
    [...ids]
      .flatMap((seriesId) => readSeries(seriesId)?.rows ?? [])
      .filter((row) => asOf === undefined || row.availableAt <= asOf)
      .sort(compareObservations),
  )();
}

export function macroStoreSummary() {
  const asOf = beijingClock(Date.now()).date;
  const records = sqlite().transaction(() => macroSeriesIds.map(readSeries))();
  const series = macroSeriesIds.map((seriesId, index) => {
    const record = records[index];
    const rows = record?.rows ?? [];
    let lastAvailableAt: string | null = null;
    for (const row of rows) {
      if (lastAvailableAt === null || row.availableAt > lastAvailableAt) {
        lastAvailableAt = row.availableAt;
      }
    }
    return {
      seriesId,
      count: rows.length,
      firstReportPeriod: rows[0]?.reportPeriod ?? null,
      lastReportPeriod: rows.at(-1)?.reportPeriod ?? null,
      lastAvailableAt,
      fetchedAt: record?.fetchedAt ?? null,
      source: record?.source ?? null,
    };
  });
  const macroClock = evaluateMacroClockEtfRotation({
    asOf,
    observations: records.flatMap((record) => record?.rows ?? []),
  });
  return { asOf, series, macroClock };
}
