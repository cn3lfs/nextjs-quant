import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readFinancialPoolHistory } from "../../src/server/data-sources/tdx/local-financial-files";
import {
  readStableFinancialFile,
  financialDirectory,
  parseFinancialSeries,
} from "tstdx/local";
import {
  financialDate,
  seriesValueDefinition,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import {
  classicFinancialFeatures,
  classicTechnicalSeries,
  csi800ClassicFactors,
} from "../../packages/trading-strategies/src/csi800-factors.js";
import {
  classicCommonWindow,
  type ClassicWeek,
} from "../../packages/trading-strategies/src/csi800-composite.js";
import type { Csi800Stock } from "trading-strategies";
import { csi800SignalBars } from "../../packages/trading-strategies/src/csi800-signal.js";

export const csiHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const num = z.number().finite(),
  date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bar = z.object({
  date,
  open: num.positive(),
  high: num.positive(),
  low: num.positive(),
  close: num.positive(),
  amount: num.nonnegative(),
  volume: num.nonnegative(),
});
const action = z.object({
  date,
  dividend: num.nonnegative(),
  bonus: num.nonnegative(),
  rights: num.nonnegative().optional(),
  rightsPrice: num.nonnegative().optional(),
  unsupported: z.boolean(),
});
export const classicPanelSchema = z.array(
  z.object({
    date,
    nextDate: date,
    marketBudget: num.min(0).max(1),
    rows: z.array(
      z.object({
        symbol: z.string().regex(/^(sh|sz)\d{6}$/),
        values: z.array(num.nullable()).length(csi800ClassicFactors.length),
        volatility: num.positive(),
        amihud: num.nonnegative().nullable(),
        positiveEquity: z.boolean(),
        reportDate: date.nullable(),
        announcementDate: date.nullable(),
        availableFrom: date.nullable(),
        marketCap: num.positive().nullable(),
      }),
    ),
  }),
);
export const csiPriceSchema = z
  .object({
    version: z.literal("csi800-frozen-1"),
    start: date,
    end: date,
    initial: num.positive(),
    stocks: z
      .array(
        z.object({
          symbol: z.string().regex(/^(sh|sz)\d{6}$/),
          bars: z.array(bar),
          actions: z.array(action),
        }),
      )
      .min(1),
    benchmark: z.array(bar).min(271),
  })
  .passthrough();
const reportSchema: z.ZodType<FinancialReportSnapshot> = z.object({
  symbol: z.string(),
  financialCompany: z.boolean().nullable(),
  reportDate: date,
  announcementDate: date.nullable(),
  availableFrom: date.nullable().optional(),
  calendar: z
    .object({ hash: z.string().nullable(), source: z.string() })
    .optional(),
  sourceFilename: z.string(),
  sourceSha256: z.string(),
  contentSha256: z.string(),
  recordOffset: num.int(),
  mappingVersion: z.string(),
  warnings: z.array(z.string()),
  fields: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      section: z.string(),
      slot: num.int(),
      raw: num.nullable(),
      value: num.nullable(),
      unit: z.string(),
      rawUnit: z.string(),
      scale: num,
      timing: z.enum([
        "balance",
        "cumulative",
        "single-quarter",
        "ttm",
        "forecast",
        "flash",
        "event",
        "unknown",
      ]),
      status: z.enum([
        "value",
        "source-zero",
        "missing",
        "not-applicable",
        "unverified",
      ]),
      reason: z.string().nullable(),
    }),
  ),
});
const financialSchema = z.object({
  version: z.literal("csi800-financial-1"),
  priceHash: z.string(),
  reports: z.record(z.array(reportSchema)),
  caps: z.record(z.record(num.positive().nullable())),
  issues: z.array(z.object({ filename: z.string(), reason: z.string() })),
  seriesSources: z.record(
    z.object({ hash: z.string(), groups: z.record(num.int()) }),
  ),
  capturedAt: z.string(),
});
export type ClassicFinancialInput = z.infer<typeof financialSchema>;
export type ClassicPriceInput = z.infer<typeof csiPriceSchema>;
export async function saveCompressed(path: string, value: unknown) {
  const body = JSON.stringify(value),
    compressed = gzipSync(body);
  await writeFile(path, compressed);
  return {
    path,
    contentHash: csiHash(body),
    fileHash: csiHash(compressed),
    bytes: compressed.length,
  };
}
export async function captureClassicFinancial(
  root: string,
  price: ClassicPriceInput,
  priceHash: string,
): Promise<ClassicFinancialInput> {
  console.log("读取68期财务池；按公告日/交易日历筛选，保持后续修订限制");
  const source = await readFinancialPoolHistory(
    root,
    price.stocks.map((s) => s.symbol),
    {
      asOf: price.end,
      strict: true,
      limit: 68,
      fieldIds: [11, 17, 35, 40, 54, 63, 74, 75, 95, 96, 107, 114, 206, 271],
      progress: (done, total) => {
        if (done % 12 === 0) console.log(`财报包 ${done}/${total}`);
      },
    },
  );
  const result: ClassicFinancialInput = {
    version: "csi800-financial-1",
    priceHash,
    reports: Object.fromEntries(source.reports),
    caps: {},
    issues: [...source.issues],
    seriesSources: {},
    capturedAt: new Date().toISOString(),
  };
  const scale = seriesValueDefinition("GP", 16, 0)?.scale;
  if (!scale) throw new Error("GP16单位定义缺失");
  for (let i = 0; i < price.stocks.length; i++) {
    const symbol = price.stocks[i]!.symbol,
      filename = `gp${symbol}.dat`;
    try {
      const file = await readStableFinancialFile(
        join(financialDirectory(root), filename),
      );
      const parsed = parseFinancialSeries(file.body);
      const caps: Record<string, number | null> = {},
        groups: Record<string, number> = {};
      for (const r of parsed.records) {
        groups[String(r.group)] = (groups[String(r.group)] ?? 0) + 1;
        if (r.group !== 16 || r.date === null) continue;
        const day = financialDate(r.date);
        if (!day || day > price.end) continue;
        const value = r.values[0] * scale;
        caps[day] =
          Object.hasOwn(caps, day) || !Number.isFinite(value) || value <= 0
            ? null
            : value;
      }
      result.caps[symbol] = caps;
      result.seriesSources[symbol] = { hash: parsed.sourceSha256, groups };
    } catch (e) {
      result.issues.push({ filename, reason: String(e) });
    }
    if ((i + 1) % 100 === 0)
      console.log(`GP序列 ${i + 1}/${price.stocks.length}`);
  }
  return result;
}
export async function loadClassicInputs(
  pricePath: string,
  financialPath: string | undefined,
  root: string,
  out: string,
) {
  await mkdir(out, { recursive: true });
  const raw = await readFile(resolve(pricePath));
  const price = csiPriceSchema.parse(JSON.parse(raw.toString("utf8"))),
    priceHash = csiHash(raw);
  const financial = financialPath
    ? financialSchema.parse(
        JSON.parse(
          gunzipSync(await readFile(resolve(financialPath))).toString("utf8"),
        ),
      )
    : await captureClassicFinancial(root, price, priceHash);
  if (financial.priceHash !== priceHash)
    throw new Error("财务冻结输入与价格hash不一致");
  const archive = await saveCompressed(
    join(out, "financial-input.json.gz"),
    financial,
  );
  return {
    price,
    financial,
    manifest: { pricePath: resolve(pricePath), priceHash, financial: archive },
  };
}

const average = (values: number[]) =>
  values.reduce((s, v) => s + v / values.length, 0);
const week = (date: string) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
/** Factors are kept at weekly observations; daily risk history is shared once. */
export function buildClassicPanel(
  price: ClassicPriceInput,
  financial: ClassicFinancialInput,
) {
  const dates = price.benchmark.map((b) => b.date);
  const weeks: ClassicWeek[] = dates.flatMap((date, i) => {
    if (
      date < "2016-01-01" ||
      !dates[i + 1] ||
      week(date) === week(dates[i + 1]!)
    )
      return [];
    const closes = price.benchmark.map((b) => b.close);
    const marketBudget =
      (Number(closes[i]! > average(closes.slice(i - 249, i + 1))) +
        Number(
          average(closes.slice(i - 119, i + 1)) >
            average(closes.slice(i - 139, i - 19)),
        )) /
      2;
    return [{ date, nextDate: dates[i + 1]!, marketBudget, rows: [] }];
  });
  const dateIndices = new Map(dates.map((d, i) => [d, i]));
  const riskHistory = new Map<string, Map<string, number>>();
  const evidence: {
    symbol: string;
    date: string;
    reportDate: string | null;
    announcementDate: string | null;
    availableFrom: string | null;
    equity: number | null;
    marketCap: number | null;
  }[] = [];
  for (let si = 0; si < price.stocks.length; si++) {
    const stock = price.stocks[si]!,
      computed = classicTechnicalSeries(stock),
      bars = stock.bars;
    const indices = new Map(bars.map((b, i) => [b.date, i]));
    riskHistory.set(
      stock.symbol,
      new Map(computed.bars.map((b) => [b.date, b.close])),
    );
    const factors = new Map(computed.series.map((s) => [s.id, s.values]));
    const reports = financial.reports[stock.symbol] ?? [];
    // Cache by the full visible set, not merely the latest report: late older
    // filings can change TTM or CAGR even when the latest period is unchanged.
    let signature = "",
      cached: ReturnType<typeof classicFinancialFeatures> = null;
    for (const w of weeks) {
      const i = indices.get(w.date),
        bi = dateIndices.get(w.date)!;
      if (
        i === undefined ||
        i < 250 ||
        average(bars.slice(i - 19, i + 1).map((b) => b.amount)) < 50_000_000 ||
        bars[i]!.volume <= 0
      )
        continue;
      if (
        i < 60 ||
        bars.slice(i - 60, i + 1).some((b, j) => b.date !== dates[bi - 60 + j])
      )
        continue;
      const visible = reports.filter(
        (r) =>
          r.announcementDate &&
          r.announcementDate < w.date &&
          r.availableFrom &&
          r.availableFrom <= w.date &&
          r.reportDate < r.announcementDate,
      );
      const key = visible
        .map((r) => `${r.reportDate}:${r.sourceSha256}`)
        .join("|");
      if (key !== signature) {
        cached = classicFinancialFeatures(visible, w.date);
        signature = key;
      }
      const snapshot =
        cached &&
        (Date.parse(w.date) - Date.parse(cached.reportDate)) / 86400000 <= 550
          ? cached
          : null;
      const cap = financial.caps[stock.symbol]?.[w.date] ?? null;
      const values = csi800ClassicFactors.map((f) => {
        if (f.spec) return factors.get(f.id)?.[i] ?? null;
        if (f.family === "value") {
          const numerator = snapshot?.valuationNumerators[f.id];
          return numerator !== null &&
            numerator !== undefined &&
            cap !== null &&
            cap > 0
            ? numerator / cap
            : null;
        }
        return snapshot?.values[f.id] ?? null;
      });
      const volatility = (factors.get("volatility-60")?.[i] ?? 0) / 100;
      if (!(volatility > 0)) continue;
      const row = {
        symbol: stock.symbol,
        values,
        volatility,
        amihud: factors.get("amihud-20")?.[i] ?? null,
        positiveEquity:
          !!snapshot && snapshot.equity !== null && snapshot.equity > 0,
        reportDate: snapshot?.reportDate ?? null,
        announcementDate: snapshot?.announcementDate ?? null,
        availableFrom: snapshot?.availableFrom ?? null,
        marketCap: cap,
      };
      w.rows.push(row);
      if (snapshot)
        evidence.push({
          symbol: stock.symbol,
          date: w.date,
          reportDate: row.reportDate,
          announcementDate: row.announcementDate,
          availableFrom: row.availableFrom,
          equity: snapshot.equity,
          marketCap: cap,
        });
    }
    if ((si + 1) % 50 === 0)
      console.log(`技术/财务面板 ${si + 1}/${price.stocks.length}`);
  }
  const riskAt = (symbol: string, date: string) => {
    const i = dateIndices.get(date),
      series = riskHistory.get(symbol);
    if (i === undefined || i < 60 || !series) return null;
    const closes = dates.slice(i - 60, i + 1).map((d) => series.get(d));
    if (closes.some((c) => c === undefined || !(c > 0))) return null;
    return closes.slice(1).map((c, j) => c! / closes[j]! - 1);
  };
  return { weeks, riskAt, evidence, common: classicCommonWindow(weeks) };
}
