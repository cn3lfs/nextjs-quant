import { mxQuerySchema } from "~/lib/market/mx-data";
import { mxDataStatus, queryMxData } from "../../data-sources/mx/mx-data";
import { tradeDashboard } from "../../portfolio/trade-ledger-service";
import { indexDirectory } from "../../market/index-directory";
import { chartBars, chartBarsInput } from "../../charts/chart-bars";
import { ChartViewStore } from "../../charts/chart-view-store";
import { chartKeySchema, chartSaveSchema } from "~/lib/chart/chart-view";
import { sqlite as chartSqlite } from "../../db";
import { securityProfile } from "../../market/securities";
import { verifySecurityLifecycle } from "../../market/security-lifecycle";
import { verifySecurityTradingStatus } from "../../market/security-trading-status";
import {
  verifySecurityIdentity,
  type IdentityCheck,
} from "../../market/security-identity";
import { z } from "zod";
import { symbolSchema, periodSchema, type Coverage } from "~/lib/domain";
import { get } from "../../db";
import { settings } from "../../infra/settings";
import {
  localReportLag,
  readLocalFinancials,
  resolveFinanceReportPeriod,
} from "../../data-sources/tdx/tdx-financial-reports";
import { snapshot } from "../../market/snapshot";
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
import {
  KLINE,
  PAGE_LIMIT,
  QUOTES_BATCH_LIMIT,
} from "../../data-sources/tdx/tdx-wire";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
const klineSchema = z.enum(
  Object.keys(KLINE) as [keyof typeof KLINE, ...(keyof typeof KLINE)[]],
);
const pageSchema = z.object({
  symbol: symbolSchema,
  start: z.number().int().min(0).max(65535).default(0),
  count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});
const tradingDateSchema = z.number().int().min(19900101).max(21001231);
function recordOfKind<T>(kind: string, id: string): T | undefined {
  const row = chartSqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
export const marketRouter = createTRPCRouter({
  mxDataStatus: p.query(() => mxDataStatus()),
  mxDataQuery: p
    .input(mxQuerySchema)
    .mutation(({ input, signal }) => queryMxData(input, signal)),
  chartPosition: p
    .input(symbolSchema)
    .query(
      async ({ input }) =>
        (await tradeDashboard()).positions.find((p) => p.symbol === input) ??
        null,
    ),
  chartBars: p.input(chartBarsInput).query(({ input }) => chartBars(input)),
  chartView: p
    .input(chartKeySchema)
    .query(({ input }) => new ChartViewStore(chartSqlite()).read(input)),
  saveChartView: p
    .input(chartSaveSchema)
    .mutation(({ input }) => new ChartViewStore(chartSqlite()).save(input)),
  tdxHosts: p.query(() => ({
    hosts: [...configuredHosts()],
    builtin: [...TDX_HOSTS],
    fromEnv: Boolean(process.env.TDX_HOSTS),
  })),
  tdxSaveHosts: p
    .input(z.array(z.string().trim().max(253)).max(50))
    .mutation(({ input }) => ({ hosts: saveHosts(input) })),
  tdxQuotes: p
    .input(
      z
        .array(symbolSchema)
        .min(1)
        .max(QUOTES_BATCH_LIMIT * 10),
    )
    .query(({ input }) => securityQuotes(input)),
  tdxBars: p
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
  tdxMinutes: p
    .input(
      z.object({ symbol: symbolSchema, date: tradingDateSchema.optional() }),
    )
    .query(({ input }) =>
      input.date === undefined
        ? minutes(input.symbol)
        : historyMinutes(input.symbol, input.date),
    ),
  tdxTransactions: p
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
  tdxLocalFinancials: p
    .input(symbolSchema)
    .query(({ input }) => readLocalFinancials(settings().tdxRoot, input)),
  tdxFinance: p.input(symbolSchema).query(async ({ input }) => {
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
  tdxCompanyInfo: p
    .input(symbolSchema)
    .query(({ input }) => companyInfoCategories(input)),
  tdxCompanyInfoContent: p
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
  securityNames: p.query(() => securityNameMap()),
  securityProfile: p
    .input(symbolSchema)
    .query(({ input }) => securityProfile(input)),
  verifySecurityLifecycle: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityLifecycle(input)),
  verifySecurityTradingStatus: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityTradingStatus(input)),
  indexDirectory: p.query(() => indexDirectory(settings().tdxRoot)),
  securities: p
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
  securityIdentity: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityIdentity(input)),
  identityRecord: p
    .input(symbolSchema)
    .query(
      ({ input }) =>
        recordOfKind<IdentityCheck>("security-identity", `identity-${input}`) ??
        null,
    ),
});
