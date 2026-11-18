import { z } from "zod";

import { confirmationEpoch, type CompletedPeriod } from "trading-strategies";

export const researchReadinessAxes = [
  "engineering",
  "ruleCheck",
  "dataQualification",
  "independentValidation",
  "forwardObservation",
] as const;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString().slice(0, 10) === value,
    "日期无效",
  );
// Evaluation/availability times must carry an explicit zone. A timezone-less
// string is ambiguous across machines and cannot be used as causal evidence.
// The shared parser also rejects impossible calendar dates that Date.parse
// would otherwise roll over (for example 2026-02-30).
const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/,
    "时间必须包含日期、时间和 Z 或数值时区偏移",
  )
  .refine((value) => confirmationEpoch(value) !== null, "时间无效");
const text = z.string().trim().min(1);
const nullableText = text.nullable();
const reason = nullableText.optional();

const barSchema = z
  .object({
    date: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), "bar 日期无效"),
    open: z.number().finite(),
    high: z.number().finite(),
    low: z.number().finite(),
    close: z.number().finite(),
    volume: z.number().finite(),
    amount: z.number().finite(),
  })
  .strict()
  .refine(
    (bar) =>
      bar.open > 0 &&
      bar.high > 0 &&
      bar.low > 0 &&
      bar.close > 0 &&
      bar.volume >= 0 &&
      bar.amount >= 0 &&
      bar.high >= Math.max(bar.open, bar.close, bar.low) &&
      bar.low <= Math.min(bar.open, bar.close),
    "OHLCV 无效",
  );

const slotSchema = z
  .object({
    availableAt: timestampSchema,
    bar: barSchema.nullable(),
    priceScale: z.number().finite().positive().optional(),
    reason: text.optional(),
  })
  .strict();

const seriesSchema = z
  .object({
    instrument: text,
    period: text,
    sourceHash: nullableText,
    adjustmentId: nullableText,
    calendarHash: nullableText,
    // expectedSlots and the bounds come from the frozen market calendar and
    // period, never from slots.length; otherwise a truncated file can look complete.
    expectedSlots: z.number().int().positive(),
    expectedFirstAvailableAt: timestampSchema,
    expectedLastAvailableAt: timestampSchema,
    requiredBars: z.number().int().nonnegative(),
    slots: z.array(slotSchema),
  })
  .strict()
  .superRefine((series, ctx) => {
    if (
      Date.parse(series.expectedFirstAvailableAt) >
      Date.parse(series.expectedLastAvailableAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "expectedFirstAvailableAt 不能晚于 expectedLastAvailableAt",
        path: ["expectedFirstAvailableAt"],
      });
    let previous = -Infinity;
    for (const [index, slot] of series.slots.entries()) {
      const time = Date.parse(slot.availableAt);
      if (time <= previous)
        ctx.addIssue({
          code: "custom",
          message: "availableAt 必须严格递增",
          path: ["slots", index, "availableAt"],
        });
      previous = time;
      if (!slot.bar) continue;
      if (
        (series.period === "day" || series.period === "week") &&
        !dateSchema.safeParse(slot.bar.date).success
      )
        ctx.addIssue({
          code: "custom",
          message: "日/周 bar 日期必须是 YYYY-MM-DD",
          path: ["slots", index, "bar", "date"],
        });
      if (time < Date.parse(slot.bar.date))
        ctx.addIssue({
          code: "custom",
          message: "availableAt 不能早于完成 bar 日期",
          path: ["slots", index, "availableAt"],
        });
    }
  });

const financialSchema = z
  .object({
    requiredFacts: z.array(text),
    missingFacts: z.array(z.object({ fact: text, reason: text }).strict()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.requiredFacts).size !== value.requiredFacts.length)
      ctx.addIssue({ code: "custom", message: "requiredFacts 不能重复" });
    const required = new Set(value.requiredFacts);
    const missing = new Set<string>();
    for (const [index, item] of value.missingFacts.entries()) {
      if (!required.has(item.fact))
        ctx.addIssue({
          code: "custom",
          message: "missingFacts 必须声明在 requiredFacts 中",
          path: ["missingFacts", index, "fact"],
        });
      if (missing.has(item.fact))
        ctx.addIssue({
          code: "custom",
          message: "missingFacts 不能重复",
          path: ["missingFacts", index, "fact"],
        });
      missing.add(item.fact);
    }
  });

const usedRangeSchema = z
  .object({
    start: dateSchema,
    end: dateSchema,
    configHash: nullableText.optional(),
  })
  .strict()
  .refine((range) => range.start <= range.end, "起点不能晚于终点");
const checkSchema = z
  .object({
    id: text,
    outcome: z.enum(["passed", "failed", "unknown"]),
    evidenceRef: nullableText.optional(),
    range: z
      .object({ start: dateSchema, end: dateSchema })
      .strict()
      .refine((range) => range.start <= range.end, "起点不能晚于终点"),
  })
  .strict();

const inputSchema = z
  .object({
    asOf: dateSchema,
    evaluatedAt: timestampSchema,
    instrument: text,
    market: z.enum(["cn-equity", "crypto"]),
    engineering: z
      .object({ runnable: z.boolean().nullable(), reason })
      .strict(),
    ruleCheck: z
      .object({
        evaluated: z.boolean().nullable(),
        evidenceRef: nullableText.optional(),
        failed: z.boolean().nullable().optional(),
        checkedAt: timestampSchema.nullable().optional(),
        reason,
      })
      .strict(),
    window: z.object({ start: dateSchema, end: dateSchema }).strict(),
    series: z.array(seriesSchema).optional(),
    warmup: z
      .object({
        decisionStart: dateSchema,
        // Optional causal instant inside decisionStart's market day. When
        // omitted, readiness keeps using the market midnight of decisionStart.
        decisionAvailableAt: timestampSchema.optional(),
      })
      .strict(),
    financial: financialSchema.optional(),
    pointInTime: z
      .object({
        status: z.enum(["verified", "limited", "unavailable", "unknown"]),
        reason,
      })
      .strict(),
    holdout: z
      .object({
        start: dateSchema.nullable(),
        end: dateSchema.nullable(),
        usedRanges: z.array(usedRangeSchema),
        checks: z.array(checkSchema).optional(),
      })
      .strict()
      .optional(),
    forward: z
      .object({
        source: z.enum(["natural-forward", "synthetic", "historical-replay"]),
        evidenceRef: nullableText.optional(),
        observedDates: z.array(dateSchema),
        minimumDays: z.number().int().positive(),
      })
      .strict()
      .refine(
        (value) =>
          new Set(value.observedDates).size === value.observedDates.length,
        "observedDates 不能重复",
      )
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    // A declared date is a business date in the declared market. CN equities
    // close on Beijing time; crypto uses UTC and must not inherit +08:00.
    const offset = input.market === "crypto" ? "Z" : "+08:00";
    const dayStart = (date: string) => Date.parse(`${date}T00:00:00${offset}`);
    const dayEnd = (date: string) =>
      Date.parse(`${date}T23:59:59.999${offset}`);
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", message, path });
    if (input.window.start > input.window.end)
      issue(["window"], "window 起点不能晚于终点");
    if (input.window.end > input.asOf)
      issue(["window", "end"], "window 终点不能晚于 asOf");
    if (
      input.warmup.decisionStart < input.window.start ||
      input.warmup.decisionStart > input.asOf
    )
      issue(
        ["warmup", "decisionStart"],
        "decisionStart 必须位于 window 与 asOf 之间",
      );
    // An explicit decision instant only shifts the warmup cutoff inside the
    // declared decision day. It cannot jump to a future day or past the data
    // or evaluation cutoff to harvest extra warmup bars.
    if (input.warmup.decisionAvailableAt !== undefined) {
      const decisionAt = confirmationEpoch(input.warmup.decisionAvailableAt)!;
      if (
        decisionAt < dayStart(input.warmup.decisionStart) ||
        decisionAt > dayEnd(input.warmup.decisionStart)
      )
        issue(
          ["warmup", "decisionAvailableAt"],
          "decisionAvailableAt 必须位于 decisionStart 的同一市场日",
        );
      if (decisionAt > dayEnd(input.window.end))
        issue(
          ["warmup", "decisionAvailableAt"],
          "decisionAvailableAt 不能晚于 window.end 数据截止",
        );
      if (decisionAt > dayEnd(input.asOf))
        issue(
          ["warmup", "decisionAvailableAt"],
          "decisionAvailableAt 不能晚于 asOf 数据截止",
        );
      if (decisionAt > Date.parse(input.evaluatedAt))
        issue(
          ["warmup", "decisionAvailableAt"],
          "decisionAvailableAt 不能晚于 evaluatedAt",
        );
    }
    // asOf is the historical data cutoff; the check may have happened later.
    // It still cannot claim to have happened after the actual evaluation time.
    if (
      input.ruleCheck.checkedAt &&
      Date.parse(input.ruleCheck.checkedAt) > Date.parse(input.evaluatedAt)
    )
      issue(
        ["ruleCheck", "checkedAt"],
        "checkedAt 不能晚于 evaluatedAt（历史 asOf 不是执行时间）",
      );
    const startTime = dayStart(input.window.start);
    const endTime = dayEnd(input.window.end);
    for (const [index, series] of (input.series ?? []).entries()) {
      if (series.instrument !== input.instrument)
        issue(
          ["series", index, "instrument"],
          "同一 readiness 输入只能属于一个标的",
        );
      const expectedFirst = Date.parse(series.expectedFirstAvailableAt);
      const expectedLast = Date.parse(series.expectedLastAvailableAt);
      if (expectedFirst < startTime || expectedLast > endTime)
        issue(
          ["series", index, "expectedFirstAvailableAt"],
          "expected 首末槽边界必须位于 window 内",
        );
      for (const [slotIndex, slot] of series.slots.entries()) {
        const time = Date.parse(slot.availableAt);
        if (time < startTime || time > endTime)
          issue(
            ["series", index, "slots", slotIndex, "availableAt"],
            "availableAt 超出 window",
          );
        if (time > dayEnd(input.asOf))
          issue(
            ["series", index, "slots", slotIndex, "availableAt"],
            "晚于 asOf 的 availableAt 不能被观察",
          );
      }
    }
    if (input.holdout) {
      const { start, end, checks = [] } = input.holdout;
      if ((start === null) !== (end === null))
        issue(["holdout"], "留出 start 与 end 必须同时提供或同时为 null");
      if (start !== null && end !== null) {
        if (start > end) issue(["holdout"], "留出起点不能晚于终点");
        if (end > input.asOf)
          issue(["holdout", "end"], "留出终点不能晚于 asOf");
      }
      for (const [index, range] of input.holdout.usedRanges.entries())
        if (range.end > input.asOf)
          issue(
            ["holdout", "usedRanges", index, "end"],
            "已用区间不能晚于 asOf",
          );
      if (new Set(checks.map((check) => check.id)).size !== checks.length)
        issue(["holdout", "checks"], "检查 id 不能重复");
      for (const [index, check] of checks.entries())
        if (check.range.end > input.asOf)
          issue(["holdout", "checks", index, "range"], "检查区间不能晚于 asOf");
    }
    for (const [index, date] of (input.forward?.observedDates ?? []).entries())
      if (date > input.asOf)
        issue(["forward", "observedDates", index], "前向日期不能晚于 asOf");
  });

export type ResearchReadinessInput = z.input<typeof inputSchema>;
export type ReadinessSeries = z.input<typeof seriesSchema>;

type EngineeringAxis = {
  status: "runnable" | "blocked" | "unknown";
  reason: string | null;
};
type RuleCheckAxis = {
  status: "checked" | "checked-partial" | "failed" | "not-checked" | "unknown";
  evaluated: boolean | null;
  evidenceRef: string | null;
  checkedAt: string | null;
  completeSlots: number | null;
  incompleteSlots: number | null;
  reason: string | null;
};
type SeriesQualification = {
  instrument: string;
  period: string;
  identityMissing: boolean;
  expectedSlots: number;
  expected: {
    firstAvailableAt: string;
    lastAvailableAt: string;
  };
  observed: {
    firstAvailableAt: string | null;
    lastAvailableAt: string | null;
  };
  truncated: { start: boolean; end: boolean };
  slots: {
    total: number;
    complete: number;
    incomplete: number;
  };
  incomplete: readonly { availableAt: string; reason: string }[];
  warmup: {
    requiredBars: number;
    consecutiveCompleteBeforeStart: number;
    status: "met" | "unmet";
  };
};
type DataQualificationAxis = {
  status: "qualified" | "partial" | "unqualified" | "unknown";
  series: readonly SeriesQualification[];
  source: {
    adjustmentId: string | null;
    calendarHash: string | null;
    consistent: boolean;
  };
  window: { start: string; end: string };
  warmup: {
    decisionStart: string;
    /** Resolved cutoff instant: the explicit instant or the market midnight. */
    decisionAvailableAt?: string;
    series: readonly {
      period: string;
      requiredBars: number;
      consecutiveCompleteBeforeStart: number;
      status: "met" | "unmet";
    }[];
    status: "met" | "unmet" | "unknown";
  };
  financial: {
    status: "complete" | "partial" | "missing" | "not-applicable" | "unknown";
    requiredFacts: number;
    missingFacts: readonly { fact: string; reason: string }[];
  };
  pointInTime: {
    status: "verified" | "limited" | "unavailable" | "unknown";
    reason: string | null;
  };
  reasons: readonly string[];
};
type IndependentValidationAxis = {
  status:
    | "unknown"
    | "no-holdout"
    | "exposed"
    | "unused"
    | "incomplete"
    | "passed"
    | "failed";
  holdoutStart: string | null;
  holdoutEnd: string | null;
  touchedRanges: readonly {
    start: string;
    end: string;
    configHash: string | null;
  }[];
  checks: {
    total: number;
    independent: number;
    evidenced: number;
    passed: number;
    failed: number;
    unknown: number;
  };
  reason: string | null;
};
type ForwardObservationAxis = {
  status: "unknown" | "not-actual" | "none" | "accumulating" | "minimum-met";
  source: "natural-forward" | "synthetic" | "historical-replay" | null;
  evidenceRef: string | null;
  observedDays: number | null;
  declaredDays: number | null;
  firstDate: string | null;
  lastDate: string | null;
  minimumDays: number | null;
  reason: string | null;
};

export type ResearchReadiness = {
  asOf: string;
  evaluatedAt: string;
  instrument: string;
  market: "cn-equity" | "crypto";
  axes: typeof researchReadinessAxes;
  engineering: EngineeringAxis;
  ruleCheck: RuleCheckAxis;
  dataQualification: DataQualificationAxis;
  independentValidation: IndependentValidationAxis;
  forwardObservation: ForwardObservationAxis;
  disclaimer: string;
};

const disclaimer =
  "各轴独立：工程可运行、没有报错、历史盈利或覆盖卡存在，都不构成规则自检、数据合格、独立验证或前向观察证据。调用方须按标的分别汇总，不跨证券混合复权身份。";

function consecutiveBefore(slots: readonly CompletedPeriod[], start: number) {
  let count = 0;
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index]!;
    if (Date.parse(slot.availableAt) >= start) continue;
    if (!slot.bar) return count;
    count++;
  }
  return count;
}

/** Pure readiness evaluation for one instrument. All axes are independent;
 * unknown or absent facts remain unknown and never become a passing result. */
export function evaluateResearchReadiness(
  raw: ResearchReadinessInput,
): ResearchReadiness {
  const input = inputSchema.parse(raw);
  const offset = input.market === "crypto" ? "Z" : "+08:00";
  const decisionAvailableAt =
    input.warmup.decisionAvailableAt ??
    `${input.warmup.decisionStart}T00:00:00${offset}`;
  const decisionCutoff = confirmationEpoch(decisionAvailableAt)!;
  const engineering: EngineeringAxis =
    input.engineering.runnable === true
      ? { status: "runnable", reason: input.engineering.reason ?? null }
      : input.engineering.runnable === false
        ? { status: "blocked", reason: input.engineering.reason ?? null }
        : { status: "unknown", reason: input.engineering.reason ?? null };

  const qualifications = (input.series ?? []).map(
    (series): SeriesQualification => {
      const complete = series.slots.filter((slot) => slot.bar !== null).length;
      const incomplete = series.slots
        .filter((slot) => slot.bar === null)
        .map((slot) => ({
          availableAt: slot.availableAt,
          reason: slot.reason ?? "incomplete-slot",
        }));
      const warmupBars = consecutiveBefore(series.slots, decisionCutoff);
      const firstAvailableAt = series.slots[0]?.availableAt ?? null;
      const lastAvailableAt = series.slots.at(-1)?.availableAt ?? null;
      const expectedFirst = Date.parse(series.expectedFirstAvailableAt);
      const expectedLast = Date.parse(series.expectedLastAvailableAt);
      return {
        instrument: series.instrument,
        period: series.period,
        identityMissing:
          series.sourceHash === null ||
          series.adjustmentId === null ||
          series.calendarHash === null,
        expectedSlots: series.expectedSlots,
        expected: {
          firstAvailableAt: series.expectedFirstAvailableAt,
          lastAvailableAt: series.expectedLastAvailableAt,
        },
        observed: { firstAvailableAt, lastAvailableAt },
        truncated: {
          start:
            firstAvailableAt === null ||
            Date.parse(firstAvailableAt) > expectedFirst,
          end:
            lastAvailableAt === null ||
            Date.parse(lastAvailableAt) < expectedLast,
        },
        slots: {
          total: series.slots.length,
          complete,
          incomplete: incomplete.length,
        },
        incomplete,
        warmup: {
          requiredBars: series.requiredBars,
          consecutiveCompleteBeforeStart: warmupBars,
          status: warmupBars >= series.requiredBars ? "met" : "unmet",
        },
      };
    },
  );
  const identities = (input.series ?? []).map((series) => [
    series.adjustmentId,
    series.calendarHash,
  ]);
  const adjustments = new Set(identities.map(([value]) => value));
  const calendars = new Set(identities.map(([, value]) => value));
  const source = {
    adjustmentId: adjustments.size === 1 ? [...adjustments][0]! : null,
    calendarHash: calendars.size === 1 ? [...calendars][0]! : null,
    consistent: adjustments.size === 1 && calendars.size === 1,
  };
  const financial = !input.financial
    ? ({
        status: "unknown",
        requiredFacts: 0,
        missingFacts: [],
      } as const)
    : (() => {
        const missingSet = new Set(
          input.financial.missingFacts.map((item) => item.fact),
        );
        const status =
          input.financial.requiredFacts.length === 0
            ? ("not-applicable" as const)
            : input.financial.missingFacts.length === 0
              ? ("complete" as const)
              : input.financial.requiredFacts.every((fact) =>
                    missingSet.has(fact),
                  )
                ? ("missing" as const)
                : ("partial" as const);
        return {
          status,
          requiredFacts: input.financial.requiredFacts.length,
          missingFacts: input.financial.missingFacts,
        };
      })();
  const pointInTime = {
    status: input.pointInTime.status,
    reason: input.pointInTime.reason ?? null,
  };
  const warmupStatus =
    qualifications.length === 0
      ? ("unknown" as const)
      : qualifications.some((item) => item.warmup.status === "unmet")
        ? ("unmet" as const)
        : ("met" as const);

  let dataStatus: DataQualificationAxis["status"];
  const reasons: string[] = [];
  if (!input.series) {
    dataStatus = "unknown";
    reasons.push("未提供行情/多周期序列，数据资格未知");
  } else if (input.series.length === 0) {
    dataStatus = "unqualified";
    reasons.push("序列数组为空，不能形成数据资格");
  } else {
    const downgrade = (next: "partial" | "unqualified") => {
      if (dataStatus !== "unqualified") dataStatus = next;
    };
    dataStatus = "qualified";
    if (
      !source.consistent ||
      identities.some(([a, c]) => a === null || c === null)
    ) {
      reasons.push("缺少复权/交易日历身份，或同一标的的多周期身份不一致");
      downgrade("unqualified");
    }
    if (qualifications.some((item) => item.identityMissing)) {
      reasons.push("至少一个序列缺少 source/adjustment/calendar 身份");
      downgrade("unqualified");
    }
    if (
      qualifications.some((item) => item.slots.total !== item.expectedSlots)
    ) {
      reasons.push("实际槽数与显式 expectedSlots 不一致");
      downgrade("unqualified");
    }
    if (
      qualifications.some((item) => item.truncated.start || item.truncated.end)
    ) {
      reasons.push(
        "至少一个序列未覆盖 expected 首末槽边界；截断窗口不能作为完整覆盖",
      );
      downgrade("unqualified");
    }
    if (qualifications.some((item) => item.slots.complete === 0)) {
      reasons.push("至少一个必需序列没有任何完整槽，无法形成可计算历史");
      downgrade("unqualified");
    }
    if (pointInTime.status === "unavailable") {
      reasons.push("时点数据不可用，不能作为当时已知证据");
      downgrade("unqualified");
    } else if (
      pointInTime.status === "limited" ||
      pointInTime.status === "unknown"
    ) {
      reasons.push(
        pointInTime.reason ??
          (pointInTime.status === "limited"
            ? "时点数据受限，不能证明历史当时可见"
            : "未声明时点资格"),
      );
      downgrade("partial");
    }
    if (financial.status === "missing") {
      reasons.push("必需财务事实全部缺失");
      downgrade("unqualified");
    } else if (financial.status === "partial") {
      reasons.push(
        `财务事实部分缺失：${financial.missingFacts
          .map((item) => item.fact)
          .join("、")}`,
      );
      downgrade("unqualified");
    } else if (financial.status === "unknown") {
      reasons.push("未提供财务事实声明，不能视为财务合格");
      downgrade("partial");
    }
    const incomplete = qualifications.reduce(
      (sum, item) => sum + item.slots.incomplete,
      0,
    );
    if (incomplete > 0) {
      reasons.push(`存在 ${incomplete} 个已观察缺失槽；不补造 OHLC`);
      downgrade("partial");
    }
    for (const item of qualifications)
      if (item.warmup.status === "unmet") {
        reasons.push(
          `${item.period} 在 decisionStart 前只有 ${item.warmup.consecutiveCompleteBeforeStart} 根连续完整槽，少于预热要求 ${item.warmup.requiredBars}`,
        );
        downgrade("partial");
      }
    if (dataStatus === "qualified")
      reasons.push(
        "单标的来源一致、槽数与窗口符合、预热满足、财务与时点声明合格",
      );
  }
  const completeSlots = input.series
    ? qualifications.reduce((sum, item) => sum + item.slots.complete, 0)
    : null;
  const incompleteSlots = input.series
    ? qualifications.reduce((sum, item) => sum + item.slots.incomplete, 0)
    : null;
  const ruleCheck: RuleCheckAxis = {
    status: "unknown",
    evaluated: input.ruleCheck.evaluated,
    evidenceRef: input.ruleCheck.evidenceRef ?? null,
    checkedAt: input.ruleCheck.checkedAt ?? null,
    completeSlots,
    incompleteSlots,
    reason: input.ruleCheck.reason ?? null,
  };
  if (input.ruleCheck.evaluated === false) {
    ruleCheck.status = "not-checked";
    ruleCheck.reason = input.ruleCheck.reason ?? "规则自检尚未执行";
  } else if (input.ruleCheck.evaluated === true) {
    if (input.ruleCheck.failed === true) {
      ruleCheck.status = "failed";
      ruleCheck.reason = input.ruleCheck.reason ?? "规则自检显式失败";
    } else if (input.ruleCheck.failed !== false) {
      ruleCheck.status = "unknown";
      ruleCheck.reason =
        input.ruleCheck.reason ??
        "未显式声明 failed=false；null/缺失不等于检查通过";
    } else if (!ruleCheck.evidenceRef) {
      ruleCheck.status = "not-checked";
      ruleCheck.reason =
        input.ruleCheck.reason ??
        "缺少明确规则自检证据引用；未因没有报错或盈利结果推定已检查";
    } else if (incompleteSlots !== null && incompleteSlots > 0) {
      ruleCheck.status = "checked-partial";
      ruleCheck.reason =
        input.ruleCheck.reason ??
        `规则自检覆盖 ${completeSlots ?? 0} 个完整槽，仍有 ${incompleteSlots} 个缺失槽`;
    } else {
      ruleCheck.status = "checked";
    }
  } else {
    ruleCheck.reason = input.ruleCheck.reason ?? "未声明是否已执行规则自检";
  }

  const independentValidation: IndependentValidationAxis = {
    status: "unknown",
    holdoutStart: null,
    holdoutEnd: null,
    touchedRanges: [],
    checks: {
      total: 0,
      independent: 0,
      evidenced: 0,
      passed: 0,
      failed: 0,
      unknown: 0,
    },
    reason: input.holdout
      ? null
      : "未提供留出起点、终点与已用区间台账，独立验证状态未知",
  };
  if (input.holdout) {
    independentValidation.holdoutStart = input.holdout.start;
    independentValidation.holdoutEnd = input.holdout.end;
    const checks = input.holdout.checks ?? [];
    independentValidation.checks.total = checks.length;
    if (input.holdout.start === null) {
      independentValidation.status = "no-holdout";
      independentValidation.reason =
        "未设置留出起点与终点，不能声称存在独立留出窗口";
    } else {
      const start = input.holdout.start;
      const end = input.holdout.end!;
      independentValidation.touchedRanges = input.holdout.usedRanges
        .filter((range) => range.start <= end && range.end >= start)
        .map((range) => ({
          ...range,
          configHash: range.configHash ?? null,
        }));
      if (independentValidation.touchedRanges.length > 0) {
        independentValidation.status = "exposed";
        independentValidation.checks.independent = 0;
        independentValidation.checks.evidenced = 0;
        independentValidation.checks.passed = 0;
        independentValidation.checks.failed = 0;
        independentValidation.checks.unknown = checks.length;
        independentValidation.reason = `已有 ${independentValidation.touchedRanges.length} 个已用区间触碰留出窗口 [${start}, ${end}]；即使检查标记通过也不能称独立验证`;
      } else {
        const independent = checks.filter(
          (check) => check.range.start >= start && check.range.end <= end,
        );
        const failed = independent.filter(
          (check) => check.outcome === "failed",
        ).length;
        const evidenced = independent.filter(
          (check) =>
            check.evidenceRef !== null && check.evidenceRef !== undefined,
        ).length;
        const passed = independent.filter(
          (check) =>
            check.outcome === "passed" &&
            check.evidenceRef !== null &&
            check.evidenceRef !== undefined,
        ).length;
        independentValidation.checks = {
          total: checks.length,
          independent: independent.length,
          evidenced,
          passed,
          failed,
          unknown: checks.length - passed - failed,
        };
        if (checks.length === 0) {
          independentValidation.status = "unused";
          independentValidation.reason =
            "留出窗口未被已记录区间使用，但尚无独立验证检查；未使用不等于已验证";
        } else if (failed > 0) {
          independentValidation.status = "failed";
          independentValidation.reason = `留出窗口内有 ${failed} 个独立检查显式失败`;
        } else if (
          independent.length === checks.length &&
          passed === checks.length
        ) {
          independentValidation.status = "passed";
          independentValidation.reason =
            "留出窗口未被使用，且全部独立检查带明确证据并通过";
        } else {
          independentValidation.status = "incomplete";
          independentValidation.reason =
            "独立检查不完整：需全部位于留出窗口内、带明确证据引用且显式通过；缺失不能推定通过";
        }
      }
    }
  }

  const forwardObservation: ForwardObservationAxis = {
    status: "unknown",
    source: input.forward?.source ?? null,
    evidenceRef: input.forward?.evidenceRef ?? null,
    observedDays: null,
    declaredDays: null,
    firstDate: null,
    lastDate: null,
    minimumDays: input.forward?.minimumDays ?? null,
    reason: input.forward ? null : "未提供前向观察，前向状态未知",
  };
  if (input.forward) {
    const declared = [...input.forward.observedDates].sort();
    forwardObservation.declaredDays = declared.length;
    const actual =
      input.forward.source === "natural-forward" &&
      input.forward.evidenceRef !== null &&
      input.forward.evidenceRef !== undefined;
    if (!actual) {
      forwardObservation.status = "not-actual";
      forwardObservation.observedDays = 0;
      forwardObservation.reason =
        "仅自然前向来源且带明确证据引用才计入；合成或历史回放日期不构成真实前向观察";
    } else {
      forwardObservation.observedDays = declared.length;
      forwardObservation.firstDate = declared[0] ?? null;
      forwardObservation.lastDate = declared.at(-1) ?? null;
      if (declared.length === 0) {
        forwardObservation.status = "none";
        forwardObservation.reason = "尚无真实自然前向观察日期";
      } else if (declared.length < input.forward.minimumDays) {
        forwardObservation.status = "accumulating";
        forwardObservation.reason = `已观察 ${declared.length} 个真实日期，低于预设 ${input.forward.minimumDays} 日`;
      } else {
        forwardObservation.status = "minimum-met";
        forwardObservation.reason = `已达到预设 ${input.forward.minimumDays} 个真实观察日期；这只是观察数量，不是收益或统计显著结论`;
      }
    }
  }

  return {
    asOf: input.asOf,
    evaluatedAt: input.evaluatedAt,
    instrument: input.instrument,
    market: input.market,
    axes: researchReadinessAxes,
    engineering,
    ruleCheck,
    dataQualification: {
      status: dataStatus,
      series: qualifications,
      source,
      window: input.window,
      warmup: {
        decisionStart: input.warmup.decisionStart,
        decisionAvailableAt,
        series: qualifications.map((item) => ({
          period: item.period,
          requiredBars: item.warmup.requiredBars,
          consecutiveCompleteBeforeStart:
            item.warmup.consecutiveCompleteBeforeStart,
          status: item.warmup.status,
        })),
        status: warmupStatus,
      },
      financial,
      pointInTime,
      reasons,
    },
    independentValidation,
    forwardObservation,
    disclaimer,
  };
}
