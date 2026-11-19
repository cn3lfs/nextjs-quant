import {
  navDetailPage,
  navPageSchema,
  navSummary,
} from "../../portfolio/trade-review-nav-page";
import { sortTableRows, tableSortSchema } from "~/lib/common/server-sort";
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
  executionPageSchema,
  pageExecutionQuality,
  executionDetail,
  exportExecutionQuality,
} from "../../portfolio/execution-quality-service";
import { costMethods, type ReviewRound } from "~/lib/portfolio/trade-review";
import {
  exportTradeReview,
  pageTradeReviewDrawdowns,
} from "../../portfolio/trade-review-service";
import {
  periodPageSchema,
  tradeReviewPeriodPage,
} from "../../research/performance/period-performance-service";
import { z } from "zod";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";

import { accountReview } from "./portfolio-review-source";

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

export const portfolioReviewRouter = createTRPCRouter({
  tradeReviewHoldingsCorrelation: p("portfolio", "read")
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
  tradeReviewPositionRisk: p("portfolio", "read")
    .input(positionRiskPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pagePositionRisk(review.snapshot.nav.days, input);
    }),
  tradeReviewRollingPerformance: p("portfolio", "read")
    .input(rollingPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewRollingPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  tradeReviewPeriodPerformance: p("portfolio", "read")
    .input(periodPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewPeriodPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  tradeReviewExecution: p("portfolio", "read")
    .input(executionPageSchema)
    .query(async ({ input }) =>
      pageExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewExecutionDetail: p("portfolio", "read")
    .input(
      z.object({
        account: z.string().trim().min(1),
        fillId: z.string().min(1).max(200),
      }),
    )
    .query(async ({ input }) =>
      executionDetail(
        (await accountReview(input.account)).snapshot,
        input.fillId,
      ),
    ),
  tradeReviewExecutionExport: p("portfolio", "read")
    .input(executionPageSchema)
    .query(async ({ input }) =>
      exportExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewSnapshot: p("portfolio", "read")
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
        monthOrder: tableSortSchema,
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
          ...navSummary(s, input.method),
          monthlyReturns: sortTableRows(
            s.nav.monthlyReturns,
            input.monthOrder,
            {
              month: (m) => m.month,
              tradingDays: (m) => m.tradingDays,
              return: (m) => m.return.value,
            },
          ).slice(input.monthPageIndex * 12, (input.monthPageIndex + 1) * 12),
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
        missingMarketData: s.missingMarketData,
        warnings: s.warnings,
        exceptions: s.exceptions,
        pendingRows: s.pendingRows,
      };
    }),
  // Further pages of the long review details (first pages ship with the snapshot).
  tradeReviewNavPage: p("portfolio", "read")
    .input(navPageSchema)
    .query(async ({ input }) =>
      navDetailPage(
        (await accountReview(input.account)).snapshot,
        input.kind,
        input.method,
        input.pageIndex,
      ),
    ),
  tradeReviewExport: p("portfolio", "read")
    .input(reviewInputSchema)
    .query(async ({ input }) =>
      exportTradeReview((await accountReview(input.account)).snapshot),
    ),
});
