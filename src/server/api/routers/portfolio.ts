import {
  disciplineRequestSchema,
  startDiscipline,
  disciplineStatus,
  cancelDiscipline,
  exportDiscipline,
} from "../../portfolio/discipline-service";
import {
  holdingsCorrelationPageSchema,
  pageHoldingsCorrelation,
} from "../../portfolio/holdings-correlation-service";
import { keyTrades } from "~/lib/research/analysis/key-trades";
import {
  positionRiskPageSchema,
  pagePositionRisk,
} from "../../portfolio/position-risk-service";
import {
  rollingPageSchema,
  tradeReviewRollingPage,
} from "../../research/performance/rolling-performance-service";
import {
  admissionPageSchema,
  tradeReviewAdmissionSource,
  pageStrategyAdmission,
  exportStrategyAdmission,
} from "../../research/performance/strategy-admission-service";
import {
  executionPageSchema,
  pageExecutionQuality,
  exportExecutionQuality,
} from "../../portfolio/execution-quality-service";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { importOptionsSchema } from "~/lib/research/evidence/delivery-import";
import { costMethods, type ReviewRound } from "~/lib/portfolio/trade-review";
import {
  cashReconciliationPage,
  cashReconciliationPageSchema,
} from "~/lib/portfolio/cash-reconciliation";
import {
  previewDeliveryImport,
  commitDeliveryImport,
} from "../../portfolio/delivery-import-service";
import { DeliveryStore } from "../../portfolio/delivery-store";
import {
  buildTradeReviewSnapshot,
  exportTradeReview,
  pageTradeReviewDrawdowns,
} from "../../portfolio/trade-review-service";
import { fullLocalCalendarReference } from "../../market/data-health";
import {
  periodPageSchema,
  tradeReviewPeriodPage,
} from "../../research/performance/period-performance-service";
import { sqlite as chartSqlite } from "../../db";
import { z } from "zod";
import { settings } from "../../infra/settings";
import { snapshot } from "../../market/snapshot";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
const deliveryPathSchema = z.string().trim().min(1).max(2048);
const deliveryInputSchema = importOptionsSchema.extend({
  path: deliveryPathSchema,
  account: z.string().trim().min(1).max(64),
});
const reviewInputSchema = z.object({
  account: z.string().trim().min(1).max(64),
});
const roundSortFields = [
  "security",
  "openingDate",
  "closingDate",
  "holdingTradingDays",
  "buyAveragePrice",
  "sellAveragePrice",
  "quantity",
  "totalFees",
  "netProfit",
  "netReturn",
] as const;
async function deliveryBytes(path: string) {
  if (![".xls", ".txt", ".csv"].includes(extname(path).toLowerCase()))
    throw new Error("仅支持 .xls / .txt / .csv 交割单文件");
  return readFile(path);
}
async function accountReview(account: string) {
  const config = settings();
  const calendar = await fullLocalCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  if (!calendar.days.length)
    throw new Error("交易日历不可用，请先配置交易日历或本地指数日线后重试");
  const db = chartSqlite();
  const store = new DeliveryStore(db);
  const dates = [
    ...store.fills(account).map((f) => f.tradeDate),
    ...store.cashFlows(account).map((f) => f.flowDate),
  ].sort();
  const start = dates[0];
  const end = dates.at(-1);
  if (!start || !end)
    throw new Error("该账户暂无可复盘的成交或资金流水，请先导入");
  if (calendar.days[0]! > start || calendar.days.at(-1)! < end)
    throw new Error(
      `交易日历未覆盖账户流水区间：日历实际覆盖 ${calendar.coverage.start} 至 ${calendar.coverage.end}，账户流水 ${start} 至 ${end}；日历共 ${calendar.coverage.count} 条；请补齐本地日历后重试`,
    );
  const tradingDays = calendar.days.filter((day) => day >= start && day <= end);
  if (!tradingDays.length) throw new Error("流水区间内没有可用交易日历");
  const snapshot = await buildTradeReviewSnapshot(
    {
      account,
      tdxRoot: config.tdxRoot,
      blocksRoot: config.industryBlocksRoot || undefined,
      tradingDays,
    },
    db,
  );
  return {
    snapshot,
    fullTradingDays: calendar.days,
    calendar: {
      source: calendar.source,
      hash: calendar.hash,
      coverage: calendar.coverage,
      start: tradingDays[0],
      end: tradingDays.at(-1),
    },
  };
}
export const portfolioRouter = createTRPCRouter({
  disciplineStart: p.input(disciplineRequestSchema).mutation(({ input }) => {
    const store = new DeliveryStore(chartSqlite()),
      config = settings();
    const ledger = store.db.transaction(() => ({
      fills: store.fills(input.account),
      cashFlows: store.cashFlows(input.account),
    }))();
    return startDiscipline(input.account, {
      ...ledger,
      openingCash: input.openingCash,
      stopCosts: input.stopCosts,
      tdxRoot: config.tdxRoot,
      calendar: config.calendar,
    });
  }),
  disciplineStatus: p
    .input(z.string().uuid())
    .query(({ input }) => disciplineStatus(input)),
  disciplineCancel: p
    .input(z.string().uuid())
    .mutation(({ input }) => cancelDiscipline(input)),
  disciplineExport: p
    .input(z.string().uuid())
    .query(({ input }) => exportDiscipline(input)),
  deliveryFiles: p.input(deliveryPathSchema).query(async ({ input }) => {
    const directory = resolve(input);
    const entries = await readdir(directory, { withFileTypes: true });
    return Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            [".xls", ".txt", ".csv"].includes(
              extname(entry.name).toLowerCase(),
            ),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (entry) => {
          const path = resolve(directory, entry.name);
          const info = await stat(path);
          return {
            name: entry.name,
            path,
            size: info.size,
            modifiedAt: info.mtimeMs,
          };
        }),
    );
  }),
  deliveryPreview: p
    .input(deliveryInputSchema)
    .query(async ({ input }) =>
      previewDeliveryImport(
        await deliveryBytes(input.path),
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      ),
    ),
  deliveryImport: p
    .input(
      deliveryInputSchema.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    )
    .mutation(async ({ input }) => {
      const bytes = await deliveryBytes(input.path);
      if (createHash("sha256").update(bytes).digest("hex") !== input.hash)
        throw new Error("文件已改变，请重新预览后确认导入");
      return commitDeliveryImport(
        bytes,
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      );
    }),
  deliveryBatches: p.query(() =>
    new DeliveryStore(chartSqlite()).batches().map(({ payload, ...batch }) => ({
      ...batch,
      statistics: payload.statistics,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.statementOpeningCash !== undefined
        ? { statementOpeningCash: payload.statementOpeningCash }
        : {}),
      ...(payload.counts ? { counts: payload.counts } : {}),
    })),
  ),
  deliveryRevoke: p
    .input(z.string().min(1).max(128))
    .mutation(({ input }) =>
      new DeliveryStore(chartSqlite()).revokeBatch(input),
    ),
  tradeReviewAdmission: p
    .input(admissionPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pageStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input,
        false,
      );
    }),
  tradeReviewAdmissionExport: p
    .input(
      admissionPageSchema
        .pick({ params: true })
        .extend({ account: z.string().trim().min(1) }),
    )
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return exportStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input.params,
        false,
      );
    }),
  tradeReviewHoldingsCorrelation: p
    .input(
      holdingsCorrelationPageSchema.extend({
        account: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pageHoldingsCorrelation(
        {
          days: review.snapshot.nav.days,
          tradingDays: review.fullTradingDays,
          bars: review.snapshot.replayInput.trades.bars ?? {},
        },
        input,
      );
    }),
  tradeReviewPositionRisk: p
    .input(positionRiskPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pagePositionRisk(review.snapshot.nav.days, input);
    }),
  tradeReviewRollingPerformance: p
    .input(rollingPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewRollingPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  tradeReviewPeriodPerformance: p
    .input(periodPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewPeriodPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  tradeReviewExecution: p
    .input(executionPageSchema)
    .query(async ({ input }) =>
      pageExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewCashReconciliation: p
    .input(
      cashReconciliationPageSchema.extend({
        account: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) =>
      cashReconciliationPage(
        (await accountReview(input.account)).snapshot.cashReconciliation,
        input,
      ),
    ),
  tradeReviewCashReconciliationExport: p
    .input(z.object({ account: z.string().trim().min(1) }))
    .query(
      async ({ input }) =>
        (await accountReview(input.account)).snapshot.cashReconciliation,
    ),
  tradeReviewExecutionExport: p
    .input(executionPageSchema)
    .query(async ({ input }) =>
      exportExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewSnapshot: p
    .input(
      reviewInputSchema.extend({
        method: z.enum(costMethods).default("movingAverage"),
        keyTradesN: z.number().int().min(1).max(20).default(3),
        pageIndex: z.number().int().min(0).max(1000000).default(0),
        pageSize: z.number().int().min(1).max(100).default(20),
        pointPageIndex: z.number().int().min(0).max(1000000).default(0),
        pointPageSize: z.number().int().min(1).max(100).default(10),
        pointSort: z.enum(["fillIndex", "security"]).default("fillIndex"),
        pointDesc: z.boolean().default(false),
        attributionPageIndex: z.number().int().min(0).max(1000000).default(0),
        attributionPageSize: z.number().int().min(1).max(100).default(10),
        attributionSort: z
          .enum(["dimension", "name", "sampleCount", "netProfitTotal"])
          .default("dimension"),
        attributionDesc: z.boolean().default(false),
        drawdownPageIndex: z.number().int().min(0).max(1000000).default(0),
        drawdownPageSize: z.number().int().min(1).max(100).default(10),
        drawdownSort: z
          .enum([
            "peakDate",
            "troughDate",
            "recoveryDate",
            "drawdown",
            "drawdownTradingDays",
            "recoveryTradingDays",
            "underwaterTradingDays",
          ])
          .default("drawdown"),
        drawdownDesc: z.boolean().default(true),
        monthPageIndex: z.number().int().min(0).max(10000).default(0),
        sort: z.enum(roundSortFields).default("openingDate"),
        desc: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const { snapshot: s, calendar } = await accountReview(input.account);
      const selected = s.trades[input.method];
      const rounds = [...selected.closedRounds, ...selected.openPositions].map(
        (round, index) => ({ ...round, id: `${input.method}-${index}` }),
      );
      const field = (round: ReviewRound) => {
        const v = round[input.sort];
        return typeof v === "object" && v !== null ? v.value : v;
      };
      rounds.sort((a, b) => {
        const x = field(a),
          y = field(b);
        if (x === null || y === null)
          return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
        return (input.desc ? -order : order) || a.id.localeCompare(b.id);
      });
      const excludedCashFlows = s.excludedCashFlows.map((row) => {
        const batch = s.replayInput.batches.find((b) => b.id === row.batchId)!;
        const index = batch.payload.mapping.columns.netAmount;
        const raw =
          index === undefined
            ? ""
            : (row.cells[index] ?? "").replaceAll(",", "").trim();
        const amount =
          /^[+-]?\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
        return {
          ...row,
          amount,
          amountReason:
            amount === null ? "作废行缺少可识别的发生金额，未计入合计" : null,
        };
      });
      const page = <T>(rows: T[], index: number, size: number) =>
        rows.slice(index * size, (index + 1) * size);
      const compare = (
        x: string | number | null,
        y: string | number | null,
        desc: boolean,
      ) => {
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
        return desc ? -order : order;
      };
      const tradePoints = [...s.trades.tradePoints].sort(
        (a, b) =>
          compare(a[input.pointSort], b[input.pointSort], input.pointDesc) ||
          a.fillIndex - b.fillIndex,
      );
      const drawdownPage = pageTradeReviewDrawdowns(s.nav.segments, {
        pageIndex: input.drawdownPageIndex,
        pageSize: input.drawdownPageSize,
        sort: input.drawdownSort,
        desc: input.drawdownDesc,
      });
      const attribution = s.attribution[input.method].groups
        .flatMap((group) =>
          group.items.map(
            ({ rounds: _rounds, roundIndices: _indices, ...item }) => ({
              ...item,
              dimension: group.dimension,
              sampleNote: group.sampleNote,
              id: `${group.dimension}:${item.name}`,
            }),
          ),
        )
        .sort(
          (a, b) =>
            compare(
              a[input.attributionSort],
              b[input.attributionSort],
              input.attributionDesc,
            ) || a.id.localeCompare(b.id),
        );
      return {
        account: s.account,
        basis: s.basis,
        calendar,
        rounds: rounds.slice(
          input.pageIndex * input.pageSize,
          (input.pageIndex + 1) * input.pageSize,
        ),
        rowCount: rounds.length,
        keyTrades: keyTrades(
          [...selected.closedRounds, ...selected.openPositions],
          input.keyTradesN,
        ),
        tradePoints: page(
          tradePoints,
          input.pointPageIndex,
          input.pointPageSize,
        ),
        pointCount: tradePoints.length,
        nav: {
          ...s.nav,
          segments: drawdownPage.segments,
          monthlyReturns: s.nav.monthlyReturns.slice(
            input.monthPageIndex * 12,
            (input.monthPageIndex + 1) * 12,
          ),
        },
        drawdowns: drawdownPage.drawdowns,
        drawdownCount: drawdownPage.drawdownCount,
        monthCount: s.nav.monthlyReturns.length,
        attribution: page(
          attribution,
          input.attributionPageIndex,
          input.attributionPageSize,
        ),
        attributionCount: attribution.length,
        unexplainedCashResidual: s.unexplainedCashResidual,
        excludedCashFlows,
        feeSources: s.replayInput.trades.fills.map((fill, index) => ({
          index,
          security: fill.symbol ?? fill.code,
          date: fill.tradeDate,
          sources: rounds
            .flatMap((r) => r.feeSources)
            .concat(s.reverseRepo.feeSources)
            .filter((f) => f.fillIndex === index)
            .slice(0, 1),
        })),
        missingMarketData: s.missingMarketData,
        warnings: s.warnings,
        exceptions: s.exceptions,
        pendingRows: s.pendingRows,
      };
    }),
  tradeReviewExport: p
    .input(reviewInputSchema)
    .query(async ({ input }) =>
      exportTradeReview((await accountReview(input.account)).snapshot),
    ),
});
