import { sqlite } from "../../db";
import { readJob } from "../../db/jobs";
import {
  unifiedStrategyCatalog,
  evaluateStrategy,
  riskParityMaximumCandidates,
  isNativeStudyStrategy,
} from "trading-strategies";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import {
  strategyCenterJob,
  strategyCenterRunSchema,
} from "../../strategies/strategy-center-service";

import { z } from "zod";
import methodMap from "../../../../docs/trading-skills-method-map.json";
import {
  captureStrategyCandidates,
  strategyCenterCandidatesSchema,
} from "../../strategies/strategy-center-candidates";
import { settings } from "../../infra/settings";
import { strategyBuildHash } from "trading-strategies";
import { createHash } from "node:crypto";
import {
  executeStrategyCenterPortfolio,
  strategyCenterPortfolioSchema,
} from "../../strategies/strategy-center-portfolio";
import { background } from "../../jobs/jobs";
import { createPerformanceReport } from "quant-performance";
import {
  strategyCategories,
  strategyMethodClassification,
} from "trading-strategies";

function verifyStrategyArchive(result: unknown) {
  const archive = z
    .object({
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      frozen: z.unknown(),
    })
    .parse(result);
  if (
    createHash("sha256")
      .update(JSON.stringify(archive.frozen))
      .digest("hex") !== archive.inputHash
  )
    throw new Error("冻结输入摘要校验失败");
}

export const strategyCenterRouter = createTRPCRouter({
  strategyCenterCatalog: p("strategyCenter", "read").query(
    () => unifiedStrategyCatalog,
  ),
  strategyCenterCompare: p("strategyCenter", "read")
    .input(z.array(z.string().min(1)).min(2).max(12))
    .query(({ input }) => {
      let baseline: string | undefined;
      let nativeBaseline: string | undefined;
      return input.map((id) => {
        const job = readJob(id);
        if (
          !job ||
          (job.input as { type?: string })?.type !== "strategy-center" ||
          job.status !== "completed"
        )
          throw new Error("比较仅支持已完成的策略中心任务");
        verifyStrategyArchive(job.result);
        const archive = z
          .object({
            frozen: z.object({
              input: z.object({
                strategyId: z.string(),
                symbol: z.string().optional(),
                symbols: z.array(z.string()).optional(),
                start: z.string(),
                end: z.string(),
                initial: z.number().positive(),
              }),
              sourceHash: z.string().optional(),
              calendarHash: z.string().optional(),
              benchmarkHash: z.string().optional(),
              sources: z
                .array(z.object({ symbol: z.string(), hash: z.string() }))
                .optional(),
              options: z.unknown().optional(),
              strategyBuildHash: z.string(),
              dividends: z.unknown().optional(),
              stocks: z
                .array(z.object({ symbol: z.string(), actions: z.unknown() }))
                .optional(),
              native: z
                .object({
                  identity: z.object({
                    dllHash: z.string().regex(/^[a-f0-9]{64}$/),
                    apiVersion: z.literal(22),
                    buildCommit: z.string().min(1),
                    configId: z.string().min(1),
                    config: z.literal(0),
                    anchor: z.literal(1),
                  }),
                  originDate: z.string(),
                  baselineDate: z.string(),
                  priceBasis: z.string(),
                })
                .optional(),
            }),
            result: z.object({
              curve: z.array(
                z.object({ date: z.string(), equity: z.number().finite() }),
              ),
            }),
          })
          .parse(job.result);
        const f = archive.frozen;
        if (isNativeStudyStrategy(f.input.strategyId)) {
          if (!f.native) throw new Error("原生策略缺少冻结DLL与输入起点证据");
          const nativeContext = JSON.stringify(f.native);
          if (nativeBaseline !== undefined && nativeContext !== nativeBaseline)
            throw new Error(
              "原生策略比较要求相同DLL、配置、固定起点与价格口径",
            );
          nativeBaseline = nativeContext;
        }
        const context = JSON.stringify({
          symbol: f.input.symbol,
          symbols: f.input.symbols,
          start: f.input.start,
          end: f.input.end,
          initial: f.input.initial,
          sourceHash: f.sourceHash,
          calendarHash: f.calendarHash,
          benchmarkHash: f.benchmarkHash,
          sources: f.sources,
          options: f.options,
          strategyBuildHash: f.strategyBuildHash,
          dividends: f.dividends,
          stockActions: f.stocks,
        });
        if (baseline !== undefined && baseline !== context)
          throw new Error(
            "比较要求相同证券池、区间、本金、来源、成交假设与实现版本，请按同一配置重新运行",
          );
        baseline = context;
        return {
          id,
          strategyId: f.input.strategyId,
          overview: createPerformanceReport(
            f.input.initial,
            archive.result.curve.map((point) => ({
              date: point.date,
              value: point.equity,
            })),
          ).overview,
        };
      });
    }),
  strategyCenterEvaluation: p("strategyCenter", "read")
    .input(z.string().min(1))
    .query(({ input }) => {
      const job = readJob(input);
      if (
        !job ||
        (job.input as { type?: string })?.type !== "strategy-center" ||
        job.status !== "completed"
      )
        throw new Error("策略任务尚未完成");
      verifyStrategyArchive(job.result);
      const archive = z
        .object({
          frozen: z.object({
            input: z.object({ initial: z.number().positive() }),
          }),
          result: z.object({
            curve: z.array(
              z.object({ date: z.string(), equity: z.number().finite() }),
            ),
          }),
        })
        .parse(job.result);
      const { daily: _daily, ...report } = createPerformanceReport(
        archive.frozen.input.initial,
        archive.result.curve.map((point) => ({
          date: point.date,
          value: point.equity,
        })),
      );
      return report;
    }),
  strategyCenterPortfolio: p("strategyCenter", "compute")
    .input(strategyCenterPortfolioSchema)
    .mutation(({ input }) => {
      const root = settings().tdxRoot;
      return background(
        "backtest",
        { type: "strategy-center", ...input, portfolio: true },
        async (_job, signal) => {
          const result = await executeStrategyCenterPortfolio(
            input,
            root,
            undefined,
            signal,
          );
          if (signal.aborted) throw new Error("任务已取消");
          return result;
        },
      );
    }),
  strategyCenterLocalWeights: p("strategyCenter", "compute")
    .input(strategyCenterCandidatesSchema)
    .mutation(async ({ input }) => {
      const snapshot = await captureStrategyCandidates(
        input,
        settings().tdxRoot,
      );
      const result = evaluateStrategy(
        { strategyId: input.strategyId },
        { asOf: input.asOf, candidates: snapshot.candidates },
      );
      const frozen = { input, snapshot, strategyBuildHash };
      return {
        frozen,
        inputHash: createHash("sha256")
          .update(JSON.stringify(frozen))
          .digest("hex"),
        result,
      };
    }),
  strategyCenterMethods: p("strategyCenter", "read")
    .input(
      z.object({
        query: z.string().max(200).default(""),
        page: z.number().int().min(0).default(0),
        category: z
          .string()
          .refine(
            (value) => strategyCategories.some((c) => c.id === value),
            "策略分类无效",
          )
          .optional(),
      }),
    )
    .query(({ input }) => {
      const query = input.query.trim().toLowerCase();
      const methods = methodMap.methods
        .map((method) => ({
          ...method,
          ...strategyMethodClassification(method.sources),
        }))
        .filter(
          (method) =>
            (!input.category || method.category === input.category) &&
            `${method.id} ${method.title}`.toLowerCase().includes(query),
        );
      return {
        total: methods.length,
        methods: methods
          .slice(input.page * 20, (input.page + 1) * 20)
          .map((method) => ({
            id: method.id,
            title: method.title,
            status: method.status,
            boundary: method.boundary,
            implementation: method.implementation,
            category: method.category,
            kind: method.kind,
          })),
      };
    }),
  strategyCenterEvaluate: p("strategyCenter", "compute")
    .input(
      z
        .object({
          strategyId: z.string().min(1),
          asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          topK: z.number().int().min(1).max(10000).default(10),
          candidates: z
            .array(
              z.object({
                symbol: z.string().min(1),
                availableAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                values: z.record(z.number().finite().nullable()),
                returns: z
                  .array(
                    z.object({
                      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                      value: z.number().finite().gt(-1),
                    }),
                  )
                  .max(60)
                  .optional(),
              }),
            )
            .max(10000),
        })
        .refine(
          (input) =>
            input.strategyId !== "allocation-risk-parity" ||
            input.candidates.length <= riskParityMaximumCandidates,
          {
            message: `风险平价最多${riskParityMaximumCandidates}个候选`,
            path: ["candidates"],
          },
        ),
    )
    .mutation(({ input }) =>
      evaluateStrategy(
        { strategyId: input.strategyId, parameters: { topK: input.topK } },
        { asOf: input.asOf, candidates: input.candidates },
      ),
    ),
  strategyCenterRun: p("strategyCenter", "compute")
    .input(strategyCenterRunSchema)
    .mutation(({ input }) => strategyCenterJob(input)),
  strategyCenterHistory: p("strategyCenter", "read").query(
    () =>
      sqlite()
        .prepare(
          "SELECT id, json_extract(payload,'$.status') AS status, json_extract(payload,'$.input.strategyId') AS strategyId, json_extract(payload,'$.input.symbol') AS symbol FROM records WHERE kind='job' AND json_extract(payload,'$.input.type')='strategy-center' ORDER BY updated_at DESC LIMIT 30",
        )
        .all() as {
        id: string;
        status: string;
        strategyId: string;
        symbol: string;
      }[],
  ),
  strategyCenterExport: p("strategyCenter", "read")
    .input(z.string().min(1))
    .query(({ input }) => {
      const job = readJob(input);
      if (
        !job ||
        (job.input as { type?: string })?.type !== "strategy-center" ||
        job.status !== "completed"
      )
        throw new Error("策略中心任务尚未完成或不存在");
      verifyStrategyArchive(job.result);
      return job.result;
    }),
});
