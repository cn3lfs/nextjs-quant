import { z } from "zod";
import { asOfTimestampSchema, type AsOfDomain } from "../evidence/as-of";
import { researchDateSchema } from "../workflow/research-usage";
import { symbolSchema } from "../../domain";
import { classifyCode } from "../evidence/delivery-import";

const text = z.string().trim().min(1);
const percentile = z.number().finite().min(0).max(100);
export const indexValuationSchema = z
  .object({
    indexId: text,
    calculationDate: researchDateSchema,
    windowStart: researchDateSchema,
    windowEnd: researchDateSchema,
    calendar: z.array(researchDateSchema).min(2),
    methodology: text,
    membershipVersion: text,
    evidence: text,
    samples: z
      .array(
        z
          .object({
            date: researchDateSchema,
            pe: z.number().finite().positive(),
            pb: z.number().finite().positive(),
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine(
    (r) =>
      r.windowStart === r.calendar[0] &&
      r.windowEnd === r.calendar.at(-1) &&
      r.calculationDate === r.windowEnd &&
      r.samples.length === r.calendar.length &&
      r.calendar.every(
        (d, i) =>
          (i === 0 || d > r.calendar[i - 1]!) && r.samples[i]!.date === d,
      ),
    "冻结估值窗口必须完整对齐日历且截止计算日",
  );
export const indexEtfMappingSchema = z
  .object({
    indexId: text,
    version: text,
    frozenAt: asOfTimestampSchema,
    validFrom: researchDateSchema,
    validThrough: researchDateSchema,
    evidence: text,
    rows: z
      .array(
        z
          .object({
            symbol: symbolSchema,
            instrument: z.literal("domestic-equity-etf"),
            listingDate: researchDateSchema,
            trackingIndex: text,
            weight: z.number().finite().positive().max(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (r) =>
      r.validThrough >= r.validFrom &&
      new Set(r.rows.map((x) => x.symbol)).size === r.rows.length &&
      Math.abs(r.rows.reduce((s, x) => s + x.weight, 0) - 1) < 1e-10,
    "映射有效期、唯一ETF及合计权重1必须有效",
  );
export const indexPolicySchema = z
  .object({
    version: z.literal("gf-engineering-1"),
    frozenAt: asOfTimestampSchema,
    windowStart: researchDateSchema,
    windowEnd: researchDateSchema,
    entryBelow: percentile,
    exitAt: percentile,
    middleAt: percentile,
    evidence: text,
  })
  .strict()
  .refine(
    (r) =>
      r.windowStart < r.windowEnd &&
      r.entryBelow < r.middleAt &&
      r.middleAt < r.exitAt,
  );
export const indexFactorRules: Record<string, string> = {
  GF01: "冻结PE/PB完整历史窗口，严格更低样本分位取较高者；低于冻结入场阈值准入、达到退出阈值退出；只输出有效映射ETF，不撮合指数",
  GF02: "冻结分位三阈值分档：低于入场线100%、至中线50%、至退出线25%、其上0%；作用于25%研究配置上限",
  GF03: "同一冻结指数估值及有效期内境内股票ETF映射，按事前冻结权重分配25%研究上限；不依据今天热门榜回填历史",
};
export function indexFactorInputs(
  at: string,
): { domain: AsOfDomain; field: string; effectiveAt: string }[] {
  return ["indexValuation", "indexEtfMapping", "indexPolicy"].map((field) => ({
    domain: "capital",
    field,
    effectiveAt: at,
  }));
}
export function evaluateIndexFactor(
  id: string,
  req: { observationDate: string; asOf: string; symbol: string },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  if (!Object.hasOwn(indexFactorRules, id)) throw new Error("未知指数方法");
  const take = (field: string) => read("capital", field, req.observationDate);
  const v = indexValuationSchema.parse(take("indexValuation")),
    m = indexEtfMappingSchema.parse(take("indexEtfMapping")),
    p = indexPolicySchema.parse(take("indexPolicy"));
  const start = Date.parse(`${v.windowStart}T00:00:00+08:00`);
  if (
    v.calculationDate !== req.observationDate ||
    p.windowStart !== v.windowStart ||
    p.windowEnd !== v.windowEnd ||
    Date.parse(p.frozenAt) > start ||
    Date.parse(m.frozenAt) > Date.parse(req.asOf) ||
    m.indexId !== v.indexId ||
    m.validFrom > req.observationDate ||
    m.validThrough < req.observationDate ||
    m.rows.some(
      (x) =>
        x.trackingIndex !== v.indexId ||
        x.listingDate > req.observationDate ||
        x.symbol === v.indexId ||
        classifyCode(x.symbol.slice(2)).instrument !== "fund" ||
        classifyCode(x.symbol.slice(2)).market !== x.symbol.slice(0, 2),
    ) ||
    !m.rows.some((x) => x.symbol === req.symbol)
  )
    throw new Error("估值日期/事前窗口/映射有效期/目标ETF不匹配；不撮合指数");
  const last = v.samples.at(-1)!;
  const pe =
    (100 * v.samples.filter((x) => x.pe < last.pe).length) / v.samples.length;
  const pb =
    (100 * v.samples.filter((x) => x.pb < last.pb).length) / v.samples.length;
  const score = Math.max(pe, pb),
    enter = score < p.entryBelow,
    exit = score >= p.exitAt;
  const scale =
    score < p.entryBelow
      ? 1
      : score < p.middleAt
        ? 0.5
        : score < p.exitAt
          ? 0.25
          : 0;
  const eligible = id === "GF02" ? scale > 0 : enter;
  return {
    points: Number(eligible),
    participation: "rule" as const,
    details: {
      buyEligible: eligible,
      exit,
      action: exit ? "exit" : eligible ? "enter" : "hold",
      pePercentile: pe,
      pbPercentile: pb,
      score,
      calculationDate: v.calculationDate,
      window: {
        start: v.windowStart,
        end: v.windowEnd,
        samples: v.samples.length,
        methodology: v.methodology,
      },
      mappingVersion: m.version,
      allocation: m.rows.map((x) => ({
        symbol: x.symbol,
        weightPct: 25 * x.weight * (id === "GF02" ? scale : exit ? 0 : 1),
      })),
      executionBoundary:
        "仅ETF待数据候选；下一合法成交时点、T+1和共享交易规则，单组合25%上限、最长365日工程对照；未撮合，指数不交易",
      thresholds: p,
    },
  };
}
