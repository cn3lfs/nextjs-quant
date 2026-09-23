import { z } from "zod";
import type { Bar } from "../../domain";
import type { ResearchExecutionRules } from "./research-execution";

export const intradayExecutionProfiles = {
  "RK-X-market-stop": "五分钟触发市价退出代理",
  "RK-X-stop-limit1": "止损触发下方1%限价",
  "RK-X-profit-limit": "2R止盈限价对照",
  "RK-X-manual": "历史人工触发时点回放",
  "RK-X-conditional": "条件单有效时段与临停",
  "RK-X-t0-old": "底仓卖旧买新回转",
  "RK-X-gap10": "入场下方10%灾难预算",
  "RK-X-limit-news": "跌停伴已知利空退出",
  "RK-X-limit-budget": "高位一个跌停预算",
  "RK-X-halt-cap": "已知停牌风险单股降至10%",
  "RK-X-auction-queue": "一字跌停后竞价排队证据回放",
  "RK-X-event5": "已公告未来5交易日事件避让",
} as const;
export type IntradayExecutionId = keyof typeof intradayExecutionProfiles;
export const intradayExecutionIds = Object.keys(
  intradayExecutionProfiles,
) as IntradayExecutionId[];
export function isIntradayExecution(id: string): id is IntradayExecutionId {
  return Object.hasOwn(intradayExecutionProfiles, id);
}
const timestamp = z.string().datetime({ offset: true });
export const intradayExecutionInputSchema = z
  .object({
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    effectiveAt: timestamp,
    availableAt: timestamp,
    capturedAt: timestamp,
    manualCoverage: z.literal(true).optional(),
    manual: z
      .object({
        id: z.string().min(1),
        at: timestamp,
        price: z.number().finite().positive(),
        action: z.enum(["exit", "rotate"]),
      })
      .strict()
      .optional(),
    session: z
      .object({
        coverageComplete: z.literal(true),
        intervals: z.array(
          z.object({ from: timestamp, to: timestamp }).strict(),
        ),
        halts: z.array(z.object({ from: timestamp, to: timestamp }).strict()),
      })
      .strict()
      .optional(),
    negativeNews: z
      .object({
        coverageComplete: z.literal(true),
        negative: z.boolean(),
        publishedAt: timestamp,
      })
      .strict()
      .optional(),
    highPosition: z.boolean().optional(),
    haltRisk: z.boolean().optional(),
    events: z
      .object({
        coverageComplete: z.literal(true),
        through: z.string(),
        rows: z.array(
          z
            .object({
              date: z.string(),
              announcedAt: timestamp,
              kind: z.enum(["report", "unlock", "major"]),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    auction: z
      .object({
        queueId: z.string().min(1),
        submittedAt: timestamp,
        limitPrice: z.number().finite().positive(),
        filledQuantity: z.number().int().nonnegative(),
        fillPrice: z.number().finite().positive().nullable(),
        filledAt: timestamp.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const intradayExecutionInputsSchema = z
  .array(intradayExecutionInputSchema)
  .max(100000);
export type IntradayExecutionInput = z.infer<
  typeof intradayExecutionInputSchema
>;
export const intradayExecutionBoundary =
  "RK-X工程v1，双突破固定入场与5%初始线对照，复用48根五分钟引擎/逐批账本。市价只是下一根open代理，不保证离场；low<=止损触发并锁存。止损限价固定初始触发线×0.99，止盈目标工程固定2R；仅后续open经滑点后仍不低于限价才模拟成交，不用K内high触价保证排队成交，直到结束保留挂单（无自动撤改单）。人工退出/回转需当时冻结manual{id,at,price,action}且价格落在对应已完成5分钟范围内，下一根执行，缺记录不可用。条件单需要带完整覆盖的有效intervals与halts，触发及执行均检查；盘前盘后无效，临停期间保留已确认请求。卖旧买新先按既有可卖批次成交，再在下一根边界买回不超过实际已卖数量，现金/成本/风险限制有效，新批次继续T+1；不能将新仓充作底仓。跳空预算以入场价下方10%计算，和5%止损费用后预算取更严。一个跌停预算仅高位=true时启用当日真实跌停价格，入场前即约束仓位，不固定套10%；持仓后不回填未来跌停规则。停牌风险true时单股上限10%（工程参数），现有持仓减一半一次；false需显式历史否定证据。未来5个交易日已知财报/解禁/重大事件禁入并减一半，每证券每日一次；事件日/未来5日均纳入，需要完整日历和事先公告，非事后发生日期。跌停伴利空需同一观察时点已发布公告，退出锁存，跌停受阻不虚构成交。一字跌停后次日竞价排队仅保存意图，成交必须有queueId/submittedAt/limitPrice/filledAt/filledQuantity/fillPrice可知证明；无竞价/队列数据为待数据，5分钟开盘不替代竞价成交。研究窗口2000-01-04..2022-11-30，不自动交易，不代表真实策略业绩。";

export function intradayExecutionEvidence(
  rows: readonly IntradayExecutionInput[],
  symbol: string,
  date: string,
  at: string,
) {
  const known = rows
    .filter(
      (r) =>
        r.symbol === symbol &&
        r.date === date &&
        Date.parse(r.effectiveAt) <= Date.parse(at) &&
        Date.parse(r.availableAt) <= Date.parse(at) &&
        Date.parse(r.availableAt) >= Date.parse(r.effectiveAt) &&
        Date.parse(r.capturedAt) >= Date.parse(r.availableAt),
    )
    .sort((a, b) => Date.parse(b.availableAt) - Date.parse(a.availableAt));
  return !known[0] ||
    (known[1] &&
      Date.parse(known[1].availableAt) === Date.parse(known[0].availableAt))
    ? null
    : known[0];
}
export function intradaySessionActive(
  row: IntradayExecutionInput | null,
  at: string,
) {
  const t = Date.parse(at),
    s = row?.session;
  return (
    !!s &&
    s.intervals.some((i) => Date.parse(i.from) <= t && t < Date.parse(i.to)) &&
    !s.halts.some((i) => Date.parse(i.from) <= t && t < Date.parse(i.to))
  );
}
export function intradayEventWindow(
  row: IntradayExecutionInput | null,
  date: string,
  calendar: readonly string[],
  at: string,
) {
  const index = calendar.indexOf(date),
    e = row?.events;
  if (
    index < 0 ||
    !calendar[index + 5] ||
    !e ||
    e.through < calendar[index + 5]! ||
    e.rows.some(
      (x) =>
        Date.parse(x.announcedAt) > Date.parse(at) ||
        !calendar.includes(x.date),
    )
  )
    return null;
  return e.rows.some(
    (x) =>
      calendar.indexOf(x.date) >= index &&
      calendar.indexOf(x.date) <= index + 5,
  );
}
export function intradayEntryPolicy(
  id: IntradayExecutionId,
  row: IntradayExecutionInput | null,
  date: string,
  calendar: readonly string[],
  at: string,
  price: number,
  rule: ResearchExecutionRules | null,
) {
  let maxWeight = 1,
    stop = price * 0.95,
    missing: string | null = null,
    allow = true;
  if (id === "RK-X-gap10") stop = price * 0.9;
  if (id === "RK-X-limit-budget") {
    if (row?.highPosition === undefined || rule?.limitDown == null)
      missing = "历史高位分类与真实跌停价";
    else if (row.highPosition) stop = Math.min(stop, rule.limitDown);
  }
  if (id === "RK-X-halt-cap") {
    if (row?.haltRisk === undefined) missing = "历史停牌/重组风险证据";
    else if (row.haltRisk) maxWeight = 0.1;
  }
  if (id === "RK-X-event5") {
    const near = intradayEventWindow(row, date, calendar, at);
    if (near === null) missing = "未来五日已公告事件与完整覆盖";
    else allow = !near;
  }
  if (id === "RK-X-manual" || id === "RK-X-t0-old") {
    if (!row?.manualCoverage) missing = "人工触发记录覆盖";
  }
  if (id === "RK-X-conditional" && !row?.session)
    missing = "条件单运行时段/临停覆盖";
  if (id === "RK-X-limit-news" && !row?.negativeNews)
    missing = "历史公告分类完整覆盖";
  return { allow: allow && !missing, maxWeight, riskStop: stop, missing };
}
export function intradayExitPolicy(
  id: IntradayExecutionId,
  input: {
    row: IntradayExecutionInput | null;
    date: string;
    calendar: readonly string[];
    at: string;
    previous: Bar | undefined;
    entry: number;
    stop: number;
    rule: ResearchExecutionRules | null;
  },
) {
  const { row, previous: b, entry, stop, at, date, calendar, rule } = input;
  const result = (
    fraction: number,
    reason: string,
    limit: number | null = null,
    rotation = false,
    missing: string | null = null,
  ) => ({ fraction, reason, limit, rotation, missing });
  if (id === "RK-X-manual" || id === "RK-X-t0-old") {
    const m = row?.manual;
    if (!m)
      return result(
        0,
        "",
        null,
        false,
        row?.manualCoverage ? null : "人工触发记录覆盖",
      );
    if (
      !b ||
      Date.parse(m.at) > Date.parse(b.date) ||
      Date.parse(m.at) <= Date.parse(b.date) - 5 * 60000 ||
      m.price < b.low ||
      m.price > b.high
    )
      return result(0, "");
    return result(
      1,
      `人工记录${m.id}`,
      null,
      id === "RK-X-t0-old" && m.action === "rotate",
    );
  }
  if (id === "RK-X-conditional") {
    if (!row?.session)
      return result(0, "", null, false, "条件单有效时段与临停");
    if (
      !b ||
      !intradaySessionActive(
        row,
        new Date(Date.parse(b.date) - 300000).toISOString(),
      ) ||
      !intradaySessionActive(
        row,
        new Date(Date.parse(b.date) - 1).toISOString(),
      )
    )
      return result(0, "");
  }
  if (id === "RK-X-limit-news") {
    const news = row?.negativeNews;
    if (!news || rule?.limitDown == null)
      return result(0, "", null, false, "公告首次可知时点与跌停价");
    if (
      b &&
      b.close <= rule.limitDown &&
      news.negative &&
      Date.parse(news.publishedAt) <= Date.parse(b.date)
    )
      return result(1, "跌停伴已知利空，退出锁存");
  }
  if (id === "RK-X-halt-cap" && row?.haltRisk)
    return result(0.5, "已知停牌风险减半");
  if (id === "RK-X-event5") {
    const near = intradayEventWindow(row, date, calendar, at);
    if (near === null)
      return result(0, "", null, false, "未来五日已公告事件覆盖");
    if (near) return result(0.5, "已公告未来五交易日事件减半");
  }
  if (id === "RK-X-auction-queue") return result(0, "");
  if (b && b.low <= stop)
    return result(
      1,
      "完成五分钟触发止损",
      id === "RK-X-stop-limit1" ? stop * 0.99 : null,
    );
  if (id === "RK-X-profit-limit" && b && b.high >= entry + 2 * (entry - stop))
    return result(1, "完成五分钟触发2R止盈限价", entry + 2 * (entry - stop));
  return result(0, "");
}
