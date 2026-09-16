import { z } from "zod";
import type { ResearchManagement } from "./research-management";

export const contextRiskProfiles = {
  "sw-emotion": ["SW11-emotion-gate", "人工情绪交易开关"],
  "sw-emotion-week": ["SW-P-emotion-week", "情绪失控暂停至少五交易日"],
  "sw-discipline-week": ["SW-P-discipline-week", "纪律违规暂停至少五交易日"],
  "sw-news-exit": ["SW-P-news-exit", "重大利空或利好兑现退出"],
  "sw-preflight": ["SW-P-preflight", "交易前七项联合检查"],
  "rk-fresh-entry": ["RK-D-fresh-entry-exit", "持续买入资格失效退出"],
  "rk-thesis": ["RK-A6-thesis", "冻结逻辑证伪与灾难线"],
} as const;
export type ContextRiskId = keyof typeof contextRiskProfiles;
export const contextRiskIds = Object.keys(contextRiskProfiles) as [
  ContextRiskId,
  ...ContextRiskId[],
];
const timestamp = z.string().datetime({ offset: true });
export const contextRiskInputSchema = z
  .object({
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    effectiveAt: timestamp,
    availableAt: timestamp,
    capturedAt: timestamp,
    emotion: z.enum(["normal", "impaired"]).optional(),
    discipline: z.enum(["compliant", "violated"]).optional(),
    // Complete coverage is mandatory even for a negative event classification.
    news: z
      .object({
        coverageComplete: z.literal(true),
        classification: z.enum(["none", "major-negative", "positive-realized"]),
        publishedAt: timestamp,
        criteriaVersion: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    environment: z.boolean().optional(),
    eventWindow: z.boolean().optional(),
    freshEntry: z
      .object({
        eligible: z.boolean(),
        predicateVersion: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    thesis: z
      .object({
        id: z.string().trim().min(1),
        frozenAt: timestamp,
        invalidation: z.string().trim().min(1),
        invalidated: z.boolean(),
        evidence: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export const contextRiskInputsSchema = z
  .array(contextRiskInputSchema)
  .max(100000);
export type ContextRiskInput = z.infer<typeof contextRiskInputSchema>;
export const contextRiskBoundary =
  "B2人工/事件输入工程v1：固定双突破入场、2%含费风险、20%单股、60%总仓位、最多3只、60交易日上限、初始5%收盘保护。逐证券逐日输入必须有source/version/effectiveAt/availableAt/capturedAt且当日15:00前已知；无输入或事后补录missing，不从价格/LLM推断情绪或补新闻。情绪/纪律暂停当日确认后随后至少5个研究交易日，且恢复须有当日正常/合规输入，缺日不提前恢复。事件分类需完整覆盖、真实发布时间、可重现分类版本和证据，重大利空/利好兑现收盘确认下一可成交开盘退出。七项预检在前收核对环境、真实双突破事件、事件窗口、情绪，开盘用冻结目标/止损和费用重算2R及2%预算。持续资格独立于单次突破，有明确否才排队退出。逻辑证伪须入场前冻结命题和失效条件，持有期间同一命题；禁止补理由，另有入场价减2倍初始风险距离的日线最低价灾难确认（次日执行，不冒充盘中成交）。固定输入不是历史业绩。";
export function contextRiskTemplate(id: ContextRiskId): ResearchManagement {
  return {
    contextRisk: id,
    stop: { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
    maxTotalWeight: 0.6,
  };
}
export function contextRiskPoint(
  id: ContextRiskId,
  inputs: readonly ContextRiskInput[],
  symbol: string,
  date: string,
  calendar: readonly string[],
  frozenThesis?: ContextRiskInput["thesis"],
  checkWindow = true,
) {
  const missing = (reason: string) => ({
    status: "missing" as const,
    allow: false,
    exit: false,
    reason,
    evidence: null,
  });
  const cutoff = Date.parse(`${date}T15:00:00+08:00`);
  const rows = inputs.filter((r) => r.symbol === symbol && r.date === date);
  if (rows.length !== 1) return missing("缺唯一当日事件/人工状态输入");
  const parsed = contextRiskInputSchema.safeParse(rows[0]);
  if (!parsed.success) return missing("事件/人工输入结构非法");
  const e = parsed.data;
  if (
    !Number.isFinite(cutoff) ||
    [e.effectiveAt, e.availableAt, e.capturedAt].some(
      (t) => Date.parse(t) > cutoff,
    ) ||
    Date.parse(e.effectiveAt) > Date.parse(e.availableAt) ||
    Date.parse(e.availableAt) > Date.parse(e.capturedAt)
  )
    return missing("人工/事件输入当时不可知或事后补录");
  let allow = true,
    exit = false;
  if (
    id === "sw-emotion" ||
    id === "sw-emotion-week" ||
    id === "sw-preflight"
  ) {
    if (e.emotion === undefined) return missing("缺明确人工情绪状态");
    allow = e.emotion === "normal";
    // Emotion is account-wide even when evidence was recorded against a particular instrument.
    if (
      inputs.some(
        (r) =>
          r.date === date &&
          r.emotion === "impaired" &&
          [r.effectiveAt, r.availableAt, r.capturedAt].every(
            (t) => Number.isFinite(Date.parse(t)) && Date.parse(t) <= cutoff,
          ),
      )
    )
      allow = false;
  }
  if (id === "sw-discipline-week") {
    if (e.discipline === undefined) return missing("缺明确纪律审计状态");
    allow = e.discipline === "compliant";
    if (
      inputs.some(
        (r) =>
          r.date === date &&
          r.discipline === "violated" &&
          [r.effectiveAt, r.availableAt, r.capturedAt].every(
            (t) => Number.isFinite(Date.parse(t)) && Date.parse(t) <= cutoff,
          ),
      )
    )
      allow = false;
  }
  if (
    checkWindow &&
    (id === "sw-emotion-week" || id === "sw-discipline-week")
  ) {
    const end = calendar.indexOf(date);
    if (end < 5) return missing("暂停期限缺至少五个先前研究交易日");
    // A missing/invalid historical record is unknown, never a manufactured clean interval.
    for (const prior of calendar.slice(Math.max(0, end - 5), end)) {
      const check = contextRiskPoint(
        id,
        inputs,
        symbol,
        prior,
        calendar,
        undefined,
        false,
      );
      if (check.status === "missing")
        return missing("冷静期前五交易日记录不完整");
      if (!check.allow) allow = false;
    }
  }
  if (id === "sw-news-exit") {
    if (!e.news || Date.parse(e.news.publishedAt) > cutoff)
      return missing("缺完整历史事件覆盖、分类或可知发布时间");
    exit = e.news.classification !== "none";
    allow = !exit;
  }
  if (id === "sw-preflight") {
    if (e.environment === undefined || e.eventWindow === undefined)
      return missing("缺盘前环境或事件窗口判断");
    allow = allow && e.environment && !e.eventWindow;
  }
  if (id === "rk-fresh-entry") {
    if (!e.freshEntry) return missing("缺持续买入资格及谓词证据");
    allow = e.freshEntry.eligible;
    exit = !allow;
  }
  if (id === "rk-thesis") {
    if (!e.thesis || Date.parse(e.thesis.frozenAt) > cutoff)
      return missing("缺入场前书面冻结的命题及失效事实");
    if (
      frozenThesis &&
      (e.thesis.id !== frozenThesis.id ||
        e.thesis.invalidation !== frozenThesis.invalidation ||
        e.thesis.frozenAt !== frozenThesis.frozenAt)
    )
      return missing("持仓期间命题或失效条件被替换");
    exit = e.thesis.invalidated;
    allow = !exit;
  }
  return {
    status: "available" as const,
    allow,
    exit,
    reason: allow ? null : "具名事件/人工状态门槛未通过",
    evidence: e,
  };
}
