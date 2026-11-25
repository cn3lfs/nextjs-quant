import type { MacroObservation, MacroSeriesId } from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { z } from "zod";
import { beijingClock } from "~/lib/market/market-session";
import { macroStoreSummary, upsertMacroSeries } from "../../db/macro-store";
import {
  datacenterQuery,
  dcDay,
  dcNum,
  dcText,
  type DatacenterRow,
} from "../eastmoney/em-datacenter";
import { EM_USER_AGENT } from "../eastmoney/em-fetch";
import { parseChinabondHtml, parseRepoCsv } from "./macro-rates";

const dayMs = 86400000;
const pageSize = 500;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const addCalendarDays = (day: string, days: number) =>
  isoDay(new Date(Date.parse(day) + days * dayMs));
const dateTimeSchema = z.string().datetime({ local: true, offset: true });
const percentSchema = z.union([
  z.number().finite(),
  z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i),
]);

function readDay(row: DatacenterRow, field: string, text = dcText(row, field)) {
  const date = dcDay(row, field);
  if (!date || !text || !researchDateSchema.safeParse(date).success)
    return null;
  return text === date ||
    dateTimeSchema.safeParse(text.replace(" ", "T")).success
    ? date
    : null;
}

function readPublicationDay(
  row: DatacenterRow,
  field: string,
  reportPeriod: string,
) {
  const text = dcText(row, field);
  const day = readDay(row, field, text);
  if (!day || !text) return null;
  if (text === day) return day >= reportPeriod ? day : null;

  const timestamp = text.replace(" ", "T");
  const instant = Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp)
      ? timestamp
      : `${timestamp}+08:00`,
  );
  if (!Number.isFinite(instant)) return null;
  const { date, minutes } = beijingClock(instant);
  if (date < reportPeriod) return null;
  return minutes >= 15 * 60 ? addCalendarDays(date, 1) : date;
}

function readPercent(row: DatacenterRow, field: string) {
  const value =
    typeof row[field] === "string" ? dcText(row, field) : row[field];
  return percentSchema.safeParse(value).success ? dcNum(row, field) : null;
}

function parseEconomicRows(
  rows: readonly DatacenterRow[],
  seriesId: MacroSeriesId,
  valueField: string,
  nextMonthDay: number,
): MacroObservation[] {
  return rows.flatMap<MacroObservation>((row) => {
    const date = readDay(row, "REPORT_DATE");
    const value = readPercent(row, valueField);
    if (!date || value === null) return [];

    // Eastmoney dates monthly and quarterly reports on the first of the
    // reporting month. GDP uses the last month of the quarter.
    const period = new Date(date);
    const month = period.getUTCMonth();
    period.setUTCMonth(month + 1, 0);
    const reportPeriod = isoDay(period);
    for (const field of ["PUBLISH_DATE", "NOTICE_DATE"]) {
      const availableAt = readPublicationDay(row, field, reportPeriod);
      if (availableAt) {
        return [
          {
            seriesId,
            reportPeriod,
            availableAt,
            value,
            publicationBasis: "official",
          },
        ];
      }
    }

    period.setUTCMonth(month + 1, nextMonthDay);
    return [
      {
        seriesId,
        reportPeriod,
        availableAt: isoDay(period),
        value,
        publicationBasis: "conservative-lag",
      },
    ];
  });
}

export function parseEastmoneyPmiRows(rows: readonly DatacenterRow[]) {
  return parseEconomicRows(rows, "pmi-mfg", "MAKE_INDEX", 1);
}

export function parseEastmoneyCpiRows(rows: readonly DatacenterRow[]) {
  return parseEconomicRows(rows, "cpi-yoy", "NATIONAL_SAME", 16);
}

export function parseEastmoneyPpiRows(rows: readonly DatacenterRow[]) {
  return parseEconomicRows(rows, "ppi-yoy", "BASE_SAME", 16);
}

export function parseEastmoneyGdpRows(rows: readonly DatacenterRow[]) {
  return parseEconomicRows(rows, "gdp-yoy", "SUM_SAME", 20);
}

function dailyObservation(
  seriesId: MacroSeriesId,
  date: string,
  value: number,
): MacroObservation {
  return {
    seriesId,
    reportPeriod: date,
    availableAt: date,
    value,
    publicationBasis: "official",
  };
}

function parseLprRows(rows: readonly DatacenterRow[]) {
  return rows.flatMap((row) => {
    const date = readDay(row, "TRADE_DATE");
    const value = readPercent(row, "LPR1Y");
    return date && value !== null
      ? [dailyObservation("lpr-1y", date, value)]
      : [];
  });
}

async function fetchText(
  url: string | URL,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  referer?: string,
) {
  const timeout = AbortSignal.timeout(15000);
  const headers = new Headers({ "user-agent": EM_USER_AGENT });
  if (referer) headers.set("referer", referer);
  const response = await fetcher(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchTreasury(
  start: string,
  end: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  const observations: MacroObservation[] = [];
  const until = Date.parse(end);
  for (let from = Date.parse(start); from <= until;) {
    // Queries are inclusive and the provider silently drops year-long ranges.
    const to = Math.min(from + 349 * dayMs, until);
    const url = new URL(
      "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery",
    );
    url.search = new URLSearchParams({
      startDate: isoDay(new Date(from)),
      endDate: isoDay(new Date(to)),
      gjqx: "0",
      qxId: "hzsylqx",
      locale: "cn_ZH",
    }).toString();
    const html = await fetchText(url, fetcher, signal);
    for (const { date, "1y": oneYear, "10y": tenYear } of parseChinabondHtml(
      html,
    )) {
      const time = Date.parse(date);
      if (
        !researchDateSchema.safeParse(date).success ||
        time < from ||
        time > to
      )
        continue;
      if (oneYear !== null)
        observations.push(dailyObservation("bond-1y", date, oneYear));
      if (tenYear !== null)
        observations.push(dailyObservation("bond-10y", date, tenYear));
    }
    from = to + dayMs;
  }
  return observations;
}

async function fetchRepo(fetcher: typeof fetch, signal?: AbortSignal) {
  const csv = await fetchText(
    "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/frr-chrt.csv",
    fetcher,
    signal,
    "https://www.chinamoney.com.cn/chinese/bkfrr/",
  );
  return parseRepoCsv(csv).flatMap(({ date, fr007 }) =>
    researchDateSchema.safeParse(date).success
      ? [dailyObservation("fr007", date, fr007)]
      : [],
  );
}

const eastmoneyReports = [
  {
    seriesId: "pmi-mfg",
    report: "RPT_ECONOMY_PMI",
    parse: parseEastmoneyPmiRows,
  },
  {
    seriesId: "cpi-yoy",
    report: "RPT_ECONOMY_CPI",
    parse: parseEastmoneyCpiRows,
  },
  {
    seriesId: "ppi-yoy",
    report: "RPT_ECONOMY_PPI",
    parse: parseEastmoneyPpiRows,
  },
  {
    seriesId: "gdp-yoy",
    report: "RPT_ECONOMY_GDP",
    parse: parseEastmoneyGdpRows,
  },
  { seriesId: "lpr-1y", report: "RPTA_WEB_RATE", parse: parseLprRows },
] as const;

async function fetchEastmoney(
  config: (typeof eastmoneyReports)[number],
  start: string,
  end: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  const isLpr = config.seriesId === "lpr-1y";
  const dateField = isLpr ? "TRADE_DATE" : "REPORT_DATE";
  const from = isLpr ? start : `${start.slice(0, 7)}-01`;
  const filter = `(${dateField}>='${from}')`;
  const observations: MacroObservation[] = [];
  let before = addCalendarDays(end, 1);
  for (;;) {
    const rows = await datacenterQuery(
      {
        report: config.report,
        columns: isLpr ? "TRADE_DATE,LPR1Y" : "ALL",
        sortColumns: dateField,
        pageSize,
        filter: `${filter}(${dateField}<'${before}')`,
      },
      signal,
      fetcher,
    );
    observations.push(...config.parse(rows));
    if (rows.length < pageSize) return observations;
    // datacenterQuery serves page one. Walk backwards by date for daily LPR.
    const oldest = readDay(rows.at(-1)!, dateField);
    if (!oldest || oldest >= before)
      throw new Error("东方财富历史日期游标未推进");
    if (oldest <= from) return observations;
    before = oldest;
  }
}

type RawResponse = { status: number; bodyPreview: string };

function sanitizedPreview(body: string) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<([a-z][\w:-]*)\b[^>]*>/gi, "<$1>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[已脱敏链接]")
    .replace(
      /((?:\b(?:user(?:name|_id)?|account|pass(?:word|wd)?|pwd|secret|api[_-]?key|[\w-]*token|authorization|(?:set-)?cookie|session(?:[_-]?id)?)\b|用户名|账号|密码|密钥|令牌)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+\S+|[^\s,;}\]<>]+)/gi,
      "$1[已脱敏]",
    )
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/_=.~-]+/gi, "[已脱敏凭据]")
    .trim()
    .slice(0, 1024);
}

export async function syncMacroHistory(options?: {
  years?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const years = z
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(options?.years ?? 3);
  const { signal, fetcher = fetch } = options ?? {};
  const end = isoDay(new Date(Date.now() + 8 * 3600000));
  const cutoff = new Date(end);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  const start = isoDay(cutoff);

  async function syncSource(
    seriesIds: readonly MacroSeriesId[],
    source: string,
    load: (fetcher: typeof fetch) => Promise<MacroObservation[]>,
  ) {
    const rawResponses: RawResponse[] = [];
    const capture: typeof fetch = async (input, init) => {
      signal?.throwIfAborted();
      const response = await fetcher(input, { ...init, credentials: "omit" });
      const diagnostic = { status: response.status, bodyPreview: "" };
      rawResponses.push(diagnostic);
      const body = await response.clone().text();
      const table = source === "chinabond" ? body.lastIndexOf("<table") : -1;
      diagnostic.bodyPreview = sanitizedPreview(
        table < 0 ? body : body.slice(table),
      );
      return response;
    };
    const synced: {
      seriesId: MacroSeriesId;
      count: number;
      rawResponses: RawResponse[];
    }[] = [];
    const failures: {
      seriesId: MacroSeriesId;
      message: string;
      rawResponses: RawResponse[];
    }[] = [];
    const recordFailure = (seriesId: MacroSeriesId, error: unknown) => {
      failures.push({
        seriesId,
        message:
          error instanceof Error ? sanitizedPreview(error.message) : "查询失败",
        rawResponses,
      });
    };
    let rows: MacroObservation[];
    signal?.throwIfAborted();
    try {
      rows = await load(capture);
    } catch (error) {
      signal?.throwIfAborted();
      for (const seriesId of seriesIds) recordFailure(seriesId, error);
      return { synced, failures };
    }
    for (const seriesId of seriesIds) {
      signal?.throwIfAborted();
      try {
        const selected = rows.filter(
          (row) =>
            row.seriesId === seriesId &&
            row.reportPeriod >= start &&
            row.reportPeriod <= end,
        );
        if (!selected.length) throw new Error("指定区间内无有效观测");
        upsertMacroSeries(seriesId, selected, {
          source,
          fetchedAt: Date.now(),
        });
        synced.push({ seriesId, count: selected.length, rawResponses });
      } catch (error) {
        recordFailure(seriesId, error);
      }
    }
    return { synced, failures };
  }

  const outcomes = await Promise.all([
    syncSource(["bond-1y", "bond-10y"], "chinabond", (fetcher) =>
      fetchTreasury(start, end, fetcher, signal),
    ),
    syncSource(["fr007"], "chinamoney", (fetcher) =>
      fetchRepo(fetcher, signal),
    ),
    ...eastmoneyReports.map((config) =>
      syncSource([config.seriesId], "eastmoney", (fetcher) =>
        fetchEastmoney(config, start, end, fetcher, signal),
      ),
    ),
  ]);
  return {
    synced: outcomes.flatMap((outcome) => outcome.synced),
    failures: outcomes.flatMap((outcome) => outcome.failures),
    summary: macroStoreSummary(),
  };
}
