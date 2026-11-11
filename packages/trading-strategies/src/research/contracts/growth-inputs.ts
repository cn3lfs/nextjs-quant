import { z } from "zod";
import { symbolSchema } from "./security.js";
import { researchDateSchema } from "./date.js";
const number = z.number().finite();
const positive = number.positive();
const count = number.int().nonnegative();
const ratio = number.min(0).max(100);
const text = z.string().trim().min(1);
// B6b supplementary fields share the same publication/version contract.
const dates = z
  .array(researchDateSchema)
  .min(1)
  .refine(
    (rows) => rows.every((d, i) => i === 0 || d > rows[i - 1]!),
    "日期必须严格递增且无重复",
  );
const bar = z
  .object({
    date: researchDateSchema,
    open: positive,
    high: positive,
    low: positive,
    close: positive,
    volume: positive,
    amount: number.nonnegative(),
  })
  .strict()
  .refine(
    (b) =>
      b.high >= Math.max(b.open, b.close, b.low) &&
      b.low <= Math.min(b.open, b.close),
  );
export const growthHistorySchema = z
  .object({
    symbol: symbolSchema,
    benchmarkId: z.literal("sh000300"),
    adjustment: z.literal("backward-split-only"),
    comparabilityEvidence: text,
    calendar: dates,
    bars: z.array(bar).min(1),
    benchmarkBars: z.array(bar).min(1),
  })
  .strict()
  .refine(
    (r) =>
      [r.bars, r.benchmarkBars].every(
        (bs) =>
          bs.length === r.calendar.length &&
          bs.every((b, i) => b.date === r.calendar[i]),
      ),
    "行情须逐日完整对齐冻结日历；停牌缺口不补造K线",
  );
export const growthCrossSectionSchema = z
  .object({
    universeId: text,
    start: researchDateSchema,
    end: researchDateSchema,
    calendar: dates,
    adjustment: z.literal("backward-split-only"),
    comparabilityEvidence: text,
    membershipEvidence: text,
    rows: z
      .array(
        z
          .object({
            symbol: symbolSchema,
            startPrice: positive.nullable(),
            endPrice: positive.nullable(),
            suspended: z.boolean(),
            listingDate: researchDateSchema,
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine(
    (r) =>
      r.calendar[0] === r.start &&
      r.calendar.at(-1) === r.end &&
      new Set(r.rows.map((v) => v.symbol)).size === r.rows.length,
  );
export const growthSectorsSchema = z
  .object({
    start: researchDateSchema,
    end: researchDateSchema,
    calendar: dates,
    classificationVersion: text,
    membershipEvidence: text,
    comparabilityEvidence: text,
    adjustment: z.literal("backward-split-only"),
    rows: z
      .array(
        z
          .object({
            id: text,
            startPrice: positive,
            endPrice: positive,
            members: z
              .array(
                z
                  .object({
                    symbol: symbolSchema,
                    startPrice: positive,
                    endPrice: positive,
                  })
                  .strict(),
              )
              .min(1)
              .refine((r) => new Set(r.map((v) => v.symbol)).size === r.length),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (r) =>
      r.calendar[0] === r.start &&
      r.calendar.at(-1) === r.end &&
      new Set(r.rows.map((v) => v.id)).size === r.rows.length,
  );
export const growthSecuritySchema = z
  .object({
    listingDate: researchDateSchema,
    listingTradingDays: count,
    st: z.boolean(),
    delistingRisk: z.boolean(),
    exchange: z.enum(["SH", "SZ", "BJ"]),
    resumedAfterSuspensionDays: count,
    limitUpPrice: positive,
    totalMarketCap: positive,
    speculativeTurnoverPct: ratio,
  })
  .strict();
export const growthEntrySchema = z
  .object({
    pivot: positive,
    plannedPrice: positive,
    stopPrice: positive,
    accountRiskPct: ratio,
    positionPct: ratio,
    sessionsSinceStop: count,
  })
  .strict();
export const growthEarningsSchema = z
  .object({
    // These dates are frozen known schedules, never subsequently realized dates.
    calendar: dates,
    scheduledDate: researchDateSchema,
    lastReportedDate: researchDateSchema,
    actualEps: number,
    consensusEps: number,
    consensusAvailableAt: z.string().datetime({ offset: true }),
    reportAvailableAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const growthEntryEventsSchema = z
  .array(
    z
      .object({
        id: text,
        kind: z.enum([
          "earnings-surprise",
          "analyst-upgrade",
          "institution-visit",
        ]),
        origin: z.enum(["rule", "human"]),
        classificationVersion: text,
        evidence: text,
        date: researchDateSchema,
        withdrawn: z.boolean(),
      })
      .strict(),
  )
  .refine((r) => new Set(r.map((v) => v.id)).size === r.length);

export const growthTrainingSchema = z
  .object({
    start: researchDateSchema,
    cutoff: researchDateSchema,
    trades: z.array(
      z
        .object({
          event: z
            .object({
              symbol: symbolSchema,
              key: text,
              observedDate: researchDateSchema,
              partition: text,
            })
            .strict(),
          entryDate: researchDateSchema,
          exitDate: researchDateSchema.nullable(),
          profit: number.nullable(),
          remainingQuantity: count,
        })
        .strict(),
    ),
    wyckoffTarget: positive,
  })
  .strict();
export const growthOverrideSchema = z
  .object({
    version: text,
    frozenAt: z.string().datetime({ offset: true }),
    origin: z.enum(["rule", "human"]),
    evidence: text,
    // Only the total-score threshold may be relaxed. No risk or market veto is overridable.
    allowedWeakness: z.literal("total-score-65-to-69"),
  })
  .strict();
