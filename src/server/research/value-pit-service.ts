import { isAStock, readLocalTradingDates, readSnapshot } from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import { financialVisibleAt } from "tstdx/financial-model";
import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import type { Bar } from "trading-strategy-core/bars";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import {
  evaluateMacroClockEtfRotation,
  evaluatePairSwitchZScore,
  rankDividendLowVolPit,
  rankFScoreLocal8Pit,
  rankGarpPit,
  rankMagicFormulaPit,
  spotPairPresets,
  type ValuePitCandidate,
} from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { evaluateFinancialTheory } from "trading-strategies/research/financial-theory";
import { z } from "zod";
import { beijingClock } from "~/lib/market/market-session";
import { financialSymbol } from "~/lib/financial/local-financial";
import { readRecordSnapshot } from "../db";
import { readMacroObservations } from "../db/macro-store";
import { readLocalFinancialHistory } from "../data-sources/tdx/local-financial-files";
import {
  verifyLocalFinancialArchive,
  type LocalFinancialArchive,
} from "../financial/local-financial-archive";
import { settings } from "../infra/settings";
import {
  causalResearchPrices,
  readResearchPriceActions,
} from "./causal-price-basis";
import { researchJsonHash } from "./research-run";

export const macroClockPreviewInput = z
  .object({ asOfDate: researchDateSchema.optional() })
  .strict()
  .default({});

export function previewMacroClockAllocation(options?: { asOfDate?: string }) {
  const { asOfDate } = macroClockPreviewInput.parse(options);
  const date = asOfDate ?? beijingClock(Date.now()).date;
  const observations = readMacroObservations({ asOf: date });
  const { regime, targets, diagnostics, reason } =
    evaluateMacroClockEtfRotation({
      asOf: date,
      observations,
    });
  return {
    strategyId: "macro-clock-etf-rotation" as const,
    date,
    availableAt: date,
    sourceHash: researchJsonHash({ date, observations }),
    regime,
    targets,
    scores: diagnostics,
    disclosure: `${reason}。仅使用截止日可见的本机宏观版本，发布日期不明时沿用源记录的保守滞后。`,
  };
}

export const pairSwitchPreviewInput = z
  .object({
    pairId: z.enum([
      spotPairPresets[0].id,
      ...spotPairPresets.slice(1).map(({ id }) => id),
    ]),
    asOfDate: researchDateSchema,
  })
  .strict();

type ReadPairBars = (
  symbol: string,
  asOfDate: string,
) => readonly Bar[] | Promise<readonly Bar[]>;
type ReadPairCalendar = (
  asOfDate: string,
) => readonly string[] | Promise<readonly string[]>;

function visibleDailyBars(bars: readonly Bar[], asOf: string, now: number) {
  const completed = completedBarFilter("day", now);
  const visible = bars.filter((bar) => bar.date <= asOf && completed(bar.date));
  for (const [i, bar] of visible.entries()) {
    if (
      !researchDateSchema.safeParse(bar.date).success ||
      (i > 0 && visible[i - 1]!.date >= bar.date)
    )
      throw new Error("本地日线日期无效、无序或重复");
  }
  return visible;
}

async function localPriceActions(root: string) {
  if (!root) return null;
  try {
    return await readResearchPriceActions(root);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
}

async function localDailyBars(
  root: string,
  symbol: string,
  allowFunds = false,
) {
  if (!root) return [];
  try {
    return (await readSnapshot(root, symbol, "day", { allowFunds })).bars;
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
}

async function localPairCalendar(root: string) {
  if (!root) return [];
  try {
    return (await readLocalTradingDates(root)).days;
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
}

function missingFile(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

type PriceActions = Awaited<ReturnType<typeof localPriceActions>>;
function symbolActionIssues(
  actions: NonNullable<PriceActions>,
  symbol: string,
) {
  return actions.issues.filter(
    (issue) => !issue.symbol || issue.symbol === symbol,
  );
}

function completeTrade(bar: Bar) {
  return Number.isFinite(bar.close) && bar.close > 0 && bar.volume > 0;
}

export async function previewPairSwitchAllocation({
  pairId,
  asOfDate,
  tdxRoot,
  readBars,
  readCalendar,
}: {
  pairId: string;
  asOfDate: string;
  tdxRoot?: string;
  readBars?: ReadPairBars;
  readCalendar?: ReadPairCalendar;
}) {
  const { asOfDate: date } = pairSwitchPreviewInput.parse({ pairId, asOfDate });
  const pair = spotPairPresets.find(({ id }) => id === pairId)!;
  const now = Date.now();
  const root = tdxRoot ?? (readBars ? "" : settings().tdxRoot);
  const actions = await localPriceActions(root);
  const read = async (symbol: string) => {
    const raw = visibleDailyBars(
      await (readBars
        ? readBars(symbol, date)
        : localDailyBars(root, symbol, true)),
      date,
      now,
    );
    if (!actions || !raw.length) return raw;
    if (symbolActionIssues(actions, symbol).length) return [];
    const events = actions.events.get(symbol) ?? [];
    return causalResearchPrices(raw, events, "TDX GBBQ", []).bars;
  };
  const [a, b, sessions] = await Promise.all([
    read(pair.legA),
    read(pair.legB),
    readCalendar ? readCalendar(date) : localPairCalendar(root),
  ]);
  const completed = completedBarFilter("day", now);
  const calendar = sessions.filter(
    (session) => session <= date && completed(session),
  );
  const decisionSession = calendar.at(-1) === date;
  const sourceHash = researchJsonHash({
    pairId,
    date,
    adjusted: !!actions,
    calendar,
    a,
    b,
  });
  const snapshot = evaluatePairSwitchZScore({
    pairId: pair.id,
    asOf: date,
    calendar,
    legA: {
      symbol: pair.legA,
      bars: decisionSession ? a.filter(completeTrade) : [],
    },
    legB: {
      symbol: pair.legB,
      bars: decisionSession ? b.filter(completeTrade) : [],
    },
  });
  const { strategyId, status, zScore, beta, correlation, activeLeg, targets } =
    snapshot;
  return {
    strategyId,
    pairId: pair.id,
    date,
    availableAt: date,
    sourceHash,
    status,
    zScore,
    beta,
    correlation,
    activeLeg,
    targets: status === "unknown" ? {} : targets,
    scores:
      zScore === null ? {} : { [pair.legA]: -zScore, [pair.legB]: zScore },
    disclosure: [
      snapshot.disclosure,
      actions ? "本地 GBBQ 固定起点因果复权。" : "使用本地未复权收盘价。",
      !decisionSession
        ? "上证指数交易日历缺少决策日的已完成记录，目标为空。"
        : status === "unknown"
          ? "两腿缺少连续配对的已完成日线或回归结果不可用，目标为空。"
          : "",
    ].join(" "),
  };
}

const valuePitRankers = {
  "value-magic-formula-pit": rankMagicFormulaPit,
  "value-fscore-local8-pit": (
    candidates: readonly ValuePitCandidate[],
    date: string,
    topK?: number,
  ) => rankFScoreLocal8Pit(candidates, date, { topK }),
  "value-dividend-lowvol-pit": rankDividendLowVolPit,
  "value-garp-pit": rankGarpPit,
};
type ValuePitStrategyId = keyof typeof valuePitRankers;
const localFinancialVintage = "local-financial-archive";
const currentGbbqVintage = "current-local-file-exdate-filtered";

function localValueBasis(hasGbbq: boolean) {
  return {
    vintageBasis: localFinancialVintage,
    gbbqVintageBasis: hasGbbq ? currentGbbqVintage : null,
    priceBasis: hasGbbq ? "raw-close-and-gbbq-first-raw-anchor-1" : "raw-close",
  } as const;
}

export const valuePitPreviewInput = z
  .object({
    strategyId: z.enum(
      Object.keys(valuePitRankers) as [
        ValuePitStrategyId,
        ...ValuePitStrategyId[],
      ],
    ),
    symbols: z.array(financialSymbol).min(1),
    asOfDate: researchDateSchema,
    topK: z.number().int().safe().nonnegative().optional(),
  })
  .strict();

type CandidateRows = ValuePitCandidate | readonly ValuePitCandidate[] | null;
type LoadCandidate = (
  symbol: string,
  asOfDate: string,
) => CandidateRows | Promise<CandidateRows>;

const ratio = (num: number | null, den: number | null) =>
  num !== null && den !== null && den > 0 ? num / den : null;
type Report = FinancialReportSnapshot | undefined;
const field = sourceFinancialValue;

function combine(
  values: readonly (number | null)[],
  fn: (v: readonly number[]) => number,
) {
  return values.every((v) => v !== null) ? fn(values) : null;
}

function yearAgo(period: string) {
  return `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
}

function trailingField(
  byPeriod: ReadonlyMap<string, FinancialReportSnapshot>,
  report: FinancialReportSnapshot,
  id: number,
) {
  if (report.reportDate.endsWith("-12-31")) return field(report, id);
  return combine(
    [
      field(report, id),
      field(
        byPeriod.get(`${Number(report.reportDate.slice(0, 4)) - 1}-12-31`),
        id,
      ),
      field(byPeriod.get(yearAgo(report.reportDate)), id),
    ],
    ([current, annual, prior]) => current! + annual! - prior!,
  );
}

function fScoreFacts(report: Report, prior: Report) {
  const openingAssets = field(prior, 40);
  const sales = field(report, 74);
  return {
    roa: ratio(field(report, 95), openingAssets),
    cfoToAssets: ratio(field(report, 107), openingAssets),
    leverage: ratio(
      combine(
        [field(report, 55), field(report, 56)],
        ([loan, bond]) => loan! + bond!,
      ),
      combine(
        [field(report, 40), openingAssets],
        ([close, open]) => (close! + open!) / 2,
      ),
    ),
    currentRatio: ratio(field(report, 21), field(report, 54)),
    grossMargin: ratio(
      combine(
        [sales, field(report, 75)],
        ([revenue, cost]) => revenue! - cost!,
      ),
      sales,
    ),
    assetTurnover: ratio(sales, openingAssets),
  };
}

function volatility60d(bars: readonly Bar[]) {
  const window = bars.slice(-61);
  if (window.length < 61 || !window.every(completeTrade)) return null;
  const returns = window
    .slice(1)
    .map(({ close }, i) => close / window[i]!.close - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1),
  );
}

function readFinancialArchives(symbols: readonly string[], asOf: string) {
  // A downloaded DAT may have been revised after the requested close. Only a
  // local archive already saved by that close can attest to the earlier bytes.
  const close = Date.parse(`${asOf}T15:00:00+08:00`);
  const requested = new Set(symbols);
  return readRecordSnapshot(
    "local-financial-archive",
    (records: Iterable<LocalFinancialArchive>) => {
      const bySymbol = new Map<string, LocalFinancialArchive[]>();
      for (const archive of records) {
        if (!requested.has(archive.symbol) || !(archive.createdAt <= close))
          continue;
        const existing = bySymbol.get(archive.symbol);
        if (existing) existing.push(archive);
        else bySymbol.set(archive.symbol, [archive]);
      }
      return bySymbol;
    },
  );
}

function matchArchivedReports(
  archives: LocalFinancialArchive[],
  reports: readonly FinancialReportSnapshot[],
) {
  const eligible = new Map(reports.map((r) => [r.reportDate, r]));
  const frozen = new Map<string, FinancialReportSnapshot>();
  for (const archive of archives.sort((a, b) => b.createdAt - a.createdAt)) {
    if (frozen.size === eligible.size) break;
    for (const report of verifyLocalFinancialArchive(archive).reports) {
      const dated = eligible.get(report.reportDate);
      if (
        dated &&
        !frozen.has(report.reportDate) &&
        report.announcementDate === dated.announcementDate
      )
        frozen.set(report.reportDate, {
          ...report,
          availableFrom: dated.availableFrom,
        });
    }
  }
  return [...frozen.values()];
}

function totalShares(
  events: readonly TdxXdxr[],
  latest: FinancialReportSnapshot,
) {
  const change = events
    .filter(
      (event) =>
        event.date >= latest.reportDate && event.totalSharesAfter !== undefined,
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return change ? (change.totalSharesAfter ?? null) : field(latest, 238);
}

async function localValueCandidate(
  root: string,
  symbol: string,
  asOf: string,
  now: number,
  actions: PriceActions,
  archives: LocalFinancialArchive[],
): Promise<(ValuePitCandidate & ReturnType<typeof localValueBasis>) | null> {
  if (!root || !isAStock(symbol) || !archives.length) return null;
  const raw = visibleDailyBars(await localDailyBars(root, symbol), asOf, now);
  const last = raw.at(-1);
  if (!last || last.date !== asOf || !completeTrade(last)) return null;

  const history = await readLocalFinancialHistory(root, symbol, {
    asOf,
    strict: true,
  }).catch((error: unknown) => {
    if (missingFile(error)) return null;
    throw error;
  });
  if (!history) return null;
  const visible = history.reports.filter(
    (report) => !!report.availableFrom && financialVisibleAt(report, asOf),
  );
  const reports = matchArchivedReports(archives, visible).sort((a, b) =>
    b.reportDate.localeCompare(a.reportDate),
  );
  const latest = reports[0];
  if (!latest?.availableFrom) return null;
  const byPeriod = new Map(
    reports.map((report) => [report.reportDate, report]),
  );
  const annual = reports.find((report) => report.reportDate.endsWith("-12-31"));
  const priorAnnual = annual && byPeriod.get(yearAgo(annual.reportDate));
  const olderAnnual =
    priorAnnual && byPeriod.get(yearAgo(priorAnnual.reportDate));
  const priorReport = byPeriod.get(yearAgo(latest.reportDate));
  const current = fScoreFacts(
    annual?.financialCompany === false ? annual : undefined,
    priorAnnual,
  );
  const prior = fScoreFacts(
    priorAnnual?.financialCompany === false ? priorAnnual : undefined,
    olderAnnual,
  );
  const companyActions =
    actions && !symbolActionIssues(actions, symbol).length
      ? (actions.events.get(symbol) ?? []).filter((event) => event.date <= asOf)
      : null;
  const shares = companyActions ? totalShares(companyActions, latest) : null;
  const marketCap = shares !== null && shares > 0 ? last.close * shares : null;
  const debt = combine(
    [41, 52, 55, 56].map((id) => field(annual, id)),
    (values) => values.reduce((sum, value) => sum + value, 0),
  );
  const magic = evaluateFinancialTheory(reports, {
    asOf,
    strict: true,
    marketCapitalization: {
      value: marketCap,
      unit: "元",
      source: "TDX 日线收盘与本地股本",
      asOf,
    },
    ...(annual
      ? {
          interestBearingDebt: {
            value: debt,
            unit: "元",
            source: annual.sourceSha256,
            asOf: annual.reportDate,
          },
        }
      : {}),
  }).magic;
  const netIncome = trailingField(byPeriod, latest, 96);
  const priorNetIncome = priorReport
    ? trailingField(byPeriod, priorReport, 96)
    : null;
  const profitRatio = ratio(netIncome, priorNetIncome);
  const cutoff = new Date(Date.parse(asOf) - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dividends = companyActions?.filter(
    (event) => event.category === 1 && event.date > cutoff,
  );
  const adjusted = companyActions
    ? causalResearchPrices(raw.slice(-61), companyActions, "TDX GBBQ", []).bars
    : [];
  return {
    ...localValueBasis(companyActions !== null),
    symbol,
    asOf,
    // The ranker's vintage date is for the financial report. GBBQ has only an ex-date cutoff.
    availableAt: latest.availableFrom,
    isFinancial: annual?.financialCompany === true,
    price: last.close,
    marketCap,
    enterpriseValue:
      annual?.financialCompany === false ? magic.enterpriseValue.value : null,
    ebit: magic.ebit.value,
    investedCapital: magic.investedCapital.value,
    peTtm: ratio(marketCap, netIncome),
    netProfitGrowthYoY: profitRatio === null ? null : profitRatio - 1,
    operatingCashFlow: trailingField(byPeriod, latest, 107),
    netIncome,
    ...current,
    priorRoa: prior.roa,
    priorLeverage: prior.leverage,
    priorCurrentRatio: prior.currentRatio,
    priorGrossMargin: prior.grossMargin,
    priorAssetTurnover: prior.assetTurnover,
    ttmCashDividendPerShare:
      dividends?.reduce((sum, event) => sum + (event.dividend ?? 0), 0) ?? null,
    volatility60d: volatility60d(adjusted),
  };
}

export async function evaluateValuePitSnapshot({
  symbols,
  strategyId,
  asOfDate,
  topK,
  tdxRoot,
  loadCandidate,
}: {
  strategyId: ValuePitStrategyId;
  symbols: readonly string[];
  asOfDate: string;
  topK?: number;
  tdxRoot?: string;
  loadCandidate?: LoadCandidate;
}) {
  const date = researchDateSchema.parse(asOfDate);
  const requested = [...new Set(symbols)].sort();
  const now = Date.now();
  const root = tdxRoot ?? (loadCandidate ? "" : settings().tdxRoot);
  const actions = loadCandidate ? null : await localPriceActions(root);
  const archives =
    !loadCandidate && root ? readFinancialArchives(requested, date) : null;
  const candidates: ValuePitCandidate[] = [];
  for (const symbol of requested) {
    const loaded = loadCandidate
      ? await loadCandidate(symbol, date)
      : await localValueCandidate(
          root,
          symbol,
          date,
          now,
          actions,
          archives?.get(symbol) ?? [],
        );
    if (!loaded) continue;
    const rows = "symbol" in loaded ? [loaded] : loaded;
    candidates.push(
      ...rows.filter(
        (row) =>
          row.symbol === symbol &&
          researchDateSchema.safeParse(row.asOf).success &&
          researchDateSchema.safeParse(row.availableAt).success &&
          row.asOf <= date &&
          row.availableAt <= date,
      ),
    );
  }
  const { disclosure, weights, scores } = valuePitRankers[strategyId](
    candidates,
    date,
    topK,
  );
  const gbbqDisclosure = actions
    ? "股息、股本变动与波动率复权使用当前本地 GBBQ，仅保留除权除息日不晚于决策日的事件。历史截面无法排除追溯修订。波动率使用 60 个固定起点复权日收益。"
    : "当前本机 GBBQ 不可用，依赖股息、股本或复权波动率的因子缺少依据。";
  return {
    strategyId,
    date,
    availableAt: date,
    ...(loadCandidate ? {} : localValueBasis(actions !== null)),
    sourceHash: researchJsonHash({
      strategyId,
      date,
      topK,
      requested,
      candidates,
    }),
    targets: Object.freeze(weights),
    scores: Object.freeze(scores),
    excluded: requested.filter((symbol) => !Object.hasOwn(scores, symbol)),
    disclosure: loadCandidate
      ? disclosure
      : `时点限制：当日或未归档的本地通达信财务文件可能含收盘后刷新；报告期/公告日元数据与 availableFrom 仍依赖当前本地财务 DAT 索引（若后续发生公告日更正或删改可能影响历史准入）。含当天在内的截面仅使用截至决策日收盘已归档的财报版本，按公告及下一交易日过滤，缺档证券排除。${disclosure} 估值使用未复权收盘价。${gbbqDisclosure}`,
  };
}
