import { readArchiveRecord } from "../../db/archive-records";
import { mxQuerySchema } from "~/lib/market/mx-data";
import { mxDataStatus, queryMxData } from "../../data-sources/mx/mx-data";
import { tradePositionState } from "../../portfolio/trade-ledger-service";
import { TradeLedgerStore } from "../../db/trade-ledger-store";
import { indexDirectory } from "../../market/index-directory";
import {
  chartBars,
  chartBarsInput,
  compareBars,
  compareBarsInput,
} from "../../charts/chart-bars";
import { ChartViewStore } from "../../db/chart-view-store";
import { chartKeySchema, chartSaveSchema } from "~/lib/chart/chart-view";
import { sqlite as chartSqlite } from "../../db";
import { securityProfile } from "../../market/securities";
import { verifySecurityLifecycle } from "../../market/security-lifecycle";
import { verifySecurityTradingStatus } from "../../market/security-trading-status";
import { verifySecurityIdentity } from "../../market/security-identity";
import { z } from "zod";
import { periodSchema, type Coverage } from "~/lib/domain";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { get } from "../../db";
import { settings } from "../../infra/settings";
import {
  localReportLag,
  readLocalFinancials,
  resolveFinanceReportPeriod,
} from "../../data-sources/tdx/tdx-financial-reports";
import { searchSecurities } from "../../market/security-search";
import { securityDirectory, securityNameMap } from "../../market/securities";
import {
  TDX_HOSTS,
  barPage,
  companyInfoCategories,
  companyInfoContent,
  configuredHosts,
  finance,
  historyMinutes,
  historyTransactionPage,
  indexBarPage,
  minutes,
  saveHosts,
  securityQuotes,
  transactionPage,
} from "../../data-sources/tdx/tdx-quotes";
import { KLINE, PAGE_LIMIT, QUOTES_BATCH_LIMIT } from "tstdx/wire";
import { limitSentiment } from "../../market/limit-sentiment";
import { limitHistory } from "../../market/limit-history";
import { marketBreadth } from "../../market/market-breadth";
import { stockEvents } from "../../research/stock-events";
import { capitalProfile } from "../../market/capital-profile";
import { macroRates } from "../../data-sources/macro/macro-rates";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
const klineSchema = z.enum(
  Object.keys(KLINE) as [keyof typeof KLINE, ...(keyof typeof KLINE)[]],
);
const pageSchema = z.object({
  symbol: symbolSchema,
  start: z.number().int().min(0).max(65535).default(0),
  count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});
const tradingDateSchema = z.number().int().min(19900101).max(21001231);
export const marketRouter = createTRPCRouter({
  mxDataStatus: p("market", "read").query(() => mxDataStatus()),
  mxDataQuery: p("market", "compute")
    .input(mxQuerySchema)
    .mutation(({ input, signal }) => queryMxData(input, signal)),
  chartPosition: p("portfolio", "read")
    .input(symbolSchema)
    .query(
      // Runs alongside chartBars on every chart open: skip the book entirely
      // for an untraded symbol, and never read the signal ledger (the full
      // dashboard took ~14s and blocked the chart's own requests).
      async ({ input }) =>
        new TradeLedgerStore(chartSqlite())
          .trades()
          .some((t) => t.symbol === input)
          ? ((await tradePositionState()).positions.find(
              (p) => p.symbol === input,
            ) ?? null)
          : null,
    ),
  chartBars: p("market", "read")
    .input(chartBarsInput)
    .query(({ input }) => chartBars(input)),
  compareBars: p("market", "read")
    .input(compareBarsInput)
    .query(({ input }) => compareBars(input)),
  chartView: p("market", "read")
    .input(chartKeySchema)
    .query(({ input }) => new ChartViewStore(chartSqlite()).read(input)),
  saveChartView: p("market", "configure")
    .input(chartSaveSchema)
    .mutation(({ input }) => new ChartViewStore(chartSqlite()).save(input)),
  chartSharedDrawings: p("market", "read")
    .input(chartKeySchema)
    .query(({ input }) => new ChartViewStore(chartSqlite()).shared(input)),
  tdxHosts: p("market", "read").query(() => ({
    hosts: [...configuredHosts()],
    builtin: [...TDX_HOSTS],
    fromEnv: Boolean(process.env.TDX_HOSTS),
  })),
  tdxSaveHosts: p("settings", "configure")
    .input(z.array(z.string().trim().max(253)).max(50))
    .mutation(({ input }) => ({ hosts: saveHosts(input) })),
  tdxQuotes: p("market", "read")
    .input(
      z
        .array(symbolSchema)
        .min(1)
        .max(QUOTES_BATCH_LIMIT * 10),
    )
    .query(({ input }) => securityQuotes(input)),
  tdxBars: p("market", "read")
    .input(
      z.object({
        symbol: symbolSchema,
        kline: klineSchema.default("day"),
        start: z.number().int().min(0).max(65535).default(0),
        count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
        index: z.boolean().default(false),
      }),
    )
    .query(({ input }) =>
      (input.index ? indexBarPage : barPage)(
        input.symbol,
        input.kline,
        input.start,
        input.count,
      ),
    ),
  tdxMinutes: p("market", "read")
    .input(
      z.object({ symbol: symbolSchema, date: tradingDateSchema.optional() }),
    )
    .query(({ input }) =>
      input.date === undefined
        ? minutes(input.symbol)
        : historyMinutes(input.symbol, input.date),
    ),
  tdxTransactions: p("market", "read")
    .input(pageSchema.extend({ date: tradingDateSchema.optional() }))
    .query(({ input }) =>
      input.date === undefined
        ? transactionPage(input.symbol, input.start, input.count)
        : historyTransactionPage(
            input.symbol,
            input.date,
            input.start,
            input.count,
          ),
    ),
  tdxLocalFinancials: p("market", "read")
    .input(symbolSchema)
    .query(({ input }) => readLocalFinancials(settings().tdxRoot, input)),
  tdxFinance: p("market", "read")
    .input(symbolSchema)
    .query(async ({ input }) => {
      const snapshot = await finance(input);
      const root = settings().tdxRoot;
      const period = await resolveFinanceReportPeriod(root, input, snapshot);
      const local = await readLocalFinancials(root, input);
      return {
        finance: snapshot,
        period,
        lag: localReportLag(local.financials, period),
      };
    }),
  tdxCompanyInfo: p("market", "read")
    .input(symbolSchema)
    .query(({ input }) => companyInfoCategories(input)),
  tdxCompanyInfoContent: p("market", "read")
    .input(
      z.object({
        symbol: symbolSchema,
        filename: z.string().min(1).max(120),
        start: z.number().int().min(0).max(0x7fffffff),
        length: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
      }),
    )
    .query(({ input }) =>
      companyInfoContent(
        input.symbol,
        input.filename,
        input.start,
        input.length,
      ),
    ),
  securityNames: p("market", "read").query(() => securityNameMap()),
  securityProfile: p("market", "read")
    .input(symbolSchema)
    .query(({ input }) => securityProfile(input)),
  verifySecurityLifecycle: p("market", "compute")
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityLifecycle(input)),
  verifySecurityTradingStatus: p("market", "compute")
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityTradingStatus(input)),
  indexDirectory: p("market", "read").query(() =>
    indexDirectory(settings().tdxRoot),
  ),
  securities: p("market", "read")
    .input(
      z.object({
        query: z.string().default(""),
        period: periodSchema.default("day"),
      }),
    )
    .query(async ({ input }) => {
      const directory = await securityDirectory();
      return searchSecurities(
        [
          ...(get<Coverage>("coverage")?.securities ?? []).map((item) => ({
            ...item,
            name: directory.entries[item.symbol]?.name ?? item.name,
          })),
          ...(await indexDirectory(settings().tdxRoot, input.period)),
        ],
        input.query,
        input.period,
      );
    }),
  securityIdentity: p("market", "compute")
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityIdentity(input)),
  identityRecord: p("market", "read")
    .input(symbolSchema)
    .query(
      ({ input }) =>
        readArchiveRecord("security-identity", `identity-${input}`) ?? null,
    ),
  limitSentiment: p("market", "read")
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(({ input, signal }) => limitSentiment(input.date, signal)),
  /** 通达信本地涨跌停按日复盘；只读本地文件，不混入东财刷新与网络抓取。 */
  limitHistory: p("market", "read")
    .input(z.object({ date: researchDateSchema }))
    .query(({ input }) => limitHistory(settings().tdxRoot, input.date)),
  /** 通达信本地 SC31 市场涨跌家数；只读本地文件，按北京时间自然日截止。 */
  marketBreadth: p("market", "read").query(() =>
    marketBreadth(settings().tdxRoot),
  ),
  stockEvents: p("market", "read")
    .input(symbolSchema)
    .query(({ input, signal }) => stockEvents(input, signal)),
  capitalProfile: p("market", "read")
    .input(symbolSchema)
    .query(({ input, signal }) => capitalProfile(input, signal)),
  macroRates: p("market", "read").query(({ signal }) => macroRates(signal)),
});
