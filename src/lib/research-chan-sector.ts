import { z } from "zod";
import { maSeries } from "./indicators";
import { asOfTimestampSchema } from "./as-of";
import { researchDateSchema } from "./research-usage";
import { symbolSchema } from "./domain";

export const chanSectorBoundary =
  "CH11 第106课具名工程版 sector-ma20-breadth-v1：同一冻结板块池、同一20交易日窗口，使用观察日已生效且已可知的历史成分，并核验窗口内逐日成分覆盖，计算收盘严格高于MA20的成员占比。按占比降序、板块ID稳定排序，并列同名次；前50%且占比严格大于50%的板块准入，其他板块退出/禁入，缺失不作卖出。20/50%是工程参数，非原文唯一规则。输入必须有逐日成员、价格、source/effectiveAt/availableAt/capturedAt，当前成分不能回溯，不使用双基准RS。作为待数据的板块准入组件与既有入场基线组合，下一合法开盘、T+1、资金规则由基线执行器负责；不证明轮动收益。";
export const chanSectorCurrentMembershipBoundary =
  "CH11 具名工程版 current-membership-v1：为技术分析研究提供最新板块成分回溯对照，使用同一20交易日价格窗口与MA20广度参数。该版本明确含成分偏差与存活偏差，不可声称时点正确；当前成分隐含后来仍存活且仍属该板块的信息，偏差方向不保守，结论只作参考。结果必须与任何时点正确版本分开统计、使用不同比较表；不把当前成分回溯描述为解决历史成分缺口。";
const snapshot = z
  .object({
    source: z.string().trim().min(1),
    effectiveAt: researchDateSchema,
    availableAt: asOfTimestampSchema,
    capturedAt: asOfTimestampSchema,
    members: z.array(symbolSchema).min(1),
  })
  .strict();
export const chanSectorInputSchema = z
  .object({
    universeAvailableAt: asOfTimestampSchema,
    source: z.string().trim().min(1),
    universe: z.array(z.string().trim().min(1)).min(2),
    calendar: z.array(researchDateSchema).length(20),
    sectors: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            membership: z.array(snapshot).min(1),
          })
          .strict(),
      )
      .min(2),
    prices: z.array(
      z
        .object({
          symbol: symbolSchema,
          date: researchDateSchema,
          close: z.number().finite().positive(),
          source: z.string().trim().min(1),
          availableAt: asOfTimestampSchema,
          capturedAt: asOfTimestampSchema,
        })
        .strict(),
    ),
  })
  .strict();

/** Waiting-data adapter: never reads today's Blocks as historical membership. */
export function evaluateChanSectorRotation(raw: unknown, asOf: string) {
  const missing = (reason: string) => ({
    status: "missing" as const,
    reason,
    rows: [],
    boundary: chanSectorBoundary,
  });
  const parsed = chanSectorInputSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(Date.parse(asOf)))
    return missing("缺历史时点板块成分、同窗价格或必需可用时间");
  const input = parsed.data,
    cutoff = Date.parse(asOf),
    date = asOf.slice(0, 10);
  const validStamp = (v: { availableAt: string; capturedAt: string }) =>
    Date.parse(v.availableAt) <= cutoff &&
    Date.parse(v.capturedAt) >= Date.parse(v.availableAt);
  if (
    Date.parse(input.universeAvailableAt) > cutoff ||
    new Set(input.universe).size !== input.universe.length ||
    new Set(input.sectors.map((s) => s.id)).size !== input.sectors.length ||
    input.sectors.length !== input.universe.length ||
    input.sectors.some((s) => !input.universe.includes(s.id)) ||
    input.calendar.at(-1) !== date ||
    input.calendar.some((d, i) => i > 0 && d <= input.calendar[i - 1]!) ||
    cutoff < Date.parse(`${date}T15:00:00+08:00`)
  )
    return missing("板块池、同窗日历或收盘时点不一致");
  const prices = new Map<string, (typeof input.prices)[number]>();
  for (const p of input.prices) {
    const key = `${p.symbol}:${p.date}`;
    if (
      prices.has(key) ||
      !validStamp(p) ||
      Date.parse(p.availableAt) < Date.parse(`${p.date}T15:00:00+08:00`)
    )
      return missing("价格重复、提前标注可用或尚不可知");
    prices.set(key, p);
  }
  const rows: {
    sector: string;
    breadth: number;
    members: string[];
    rank: number;
    eligible: boolean;
  }[] = [];
  for (const sector of input.sectors) {
    if (
      sector.membership.some(
        (m) => !validStamp(m) || new Set(m.members).size !== m.members.length,
      )
    )
      return missing("成分可用时间非法或成员重复");
    const versions = [...sector.membership].sort((a, b) =>
      a.effectiveAt.localeCompare(b.effectiveAt),
    );
    if (
      versions.some(
        (m, i) => i > 0 && m.effectiveAt === versions[i - 1]!.effectiveAt,
      )
    )
      return missing("成分生效版本冲突");
    // Prove every window day's membership; a current list is insufficient.
    for (const day of input.calendar) {
      const m = versions
        .filter(
          (m) =>
            m.effectiveAt <= day &&
            Date.parse(m.availableAt) <= Date.parse(`${day}T15:00:00+08:00`),
        )
        .at(-1);
      if (!m) return missing(`${sector.id}缺${day}可知的历史成分`);
    }
    const members = versions
      .filter(
        (m) => m.effectiveAt <= date && Date.parse(m.availableAt) <= cutoff,
      )
      .at(-1)!.members;
    let above = 0;
    for (const symbol of members) {
      const closes = input.calendar.map(
        (day) => prices.get(`${symbol}:${day}`)?.close,
      );
      if (closes.some((v) => v === undefined))
        return missing(`${sector.id}/${symbol}缺完整20日价格`);
      const ma = maSeries(closes as number[], 20).at(-1);
      if (ma == null) return missing("板块均线不可用");
      if (closes.at(-1)! > ma) above++;
    }
    rows.push({
      sector: sector.id,
      breadth: above / members.length,
      members: [...members].sort(),
      rank: 0,
      eligible: false,
    });
  }
  rows.sort(
    (a, b) => b.breadth - a.breadth || a.sector.localeCompare(b.sector),
  );
  for (const row of rows) {
    row.rank = 1 + rows.filter((r) => r.breadth > row.breadth).length;
    row.eligible = row.breadth > 0.5 && row.rank <= Math.ceil(rows.length / 2);
  }
  return {
    status: "available" as const,
    reason: null,
    rows,
    boundary: chanSectorBoundary,
  };
}

/**
 * Deliberately separate comparison version. The latest membership snapshot is
 * allowed even when it was captured after the historical as-of date, but the
 * returned boundary keeps the survivorship and membership bias explicit.
 */
export function evaluateChanSectorCurrentMembership(
  raw: unknown,
  asOf: string,
) {
  const missing = (reason: string) => ({
    status: "missing" as const,
    reason,
    rows: [],
    boundary: chanSectorCurrentMembershipBoundary,
    methodVersion: "current-membership-v1" as const,
    comparisonGroup: "current-membership-v1" as const,
    bias: "membership-and-survivorship" as const,
  });
  const parsed = chanSectorInputSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(Date.parse(asOf)))
    return missing("缺当前板块成分、同窗价格或可解析观察日");
  const input = parsed.data,
    date = asOf.slice(0, 10),
    cutoff = Date.parse(asOf);
  if (
    input.calendar.at(-1) !== date ||
    input.calendar.some((d, i) => i > 0 && d <= input.calendar[i - 1]!) ||
    new Set(input.universe).size !== input.universe.length ||
    new Set(input.sectors.map((s) => s.id)).size !== input.sectors.length ||
    input.sectors.length !== input.universe.length ||
    input.sectors.some((s) => !input.universe.includes(s.id))
  )
    return missing("当前板块池或同窗日历不一致");
  const prices = new Map<string, (typeof input.prices)[number]>();
  for (const p of input.prices) {
    const key = `${p.symbol}:${p.date}`;
    if (
      prices.has(key) ||
      Date.parse(p.capturedAt) < Date.parse(p.availableAt) ||
      Date.parse(p.availableAt) < Date.parse(`${p.date}T15:00:00+08:00`) ||
      Date.parse(p.availableAt) > cutoff
    )
      return missing("价格重复、提前标注可用或晚于观察日");
    prices.set(key, p);
  }
  const rows: {
    sector: string;
    breadth: number;
    members: string[];
    rank: number;
    eligible: boolean;
  }[] = [];
  for (const sector of input.sectors) {
    const latest = [...sector.membership].sort(
      (a, b) =>
        b.effectiveAt.localeCompare(a.effectiveAt) ||
        b.capturedAt.localeCompare(a.capturedAt),
    )[0];
    if (!latest || new Set(latest.members).size !== latest.members.length)
      return missing(`${sector.id}当前成分为空或重复`);
    const closes = latest.members.map((symbol) =>
      input.calendar.map((day) => prices.get(`${symbol}:${day}`)?.close),
    );
    if (closes.some((series) => series.some((value) => value === undefined)))
      return missing(`${sector.id}当前成员缺完整20日价格`);
    let above = 0;
    for (const series of closes) {
      const ma = maSeries(series as number[], 20).at(-1);
      if (ma == null) return missing("板块均线不可用");
      if (series.at(-1)! > ma) above++;
    }
    rows.push({
      sector: sector.id,
      breadth: above / latest.members.length,
      members: [...latest.members].sort(),
      rank: 0,
      eligible: false,
    });
  }
  rows.sort(
    (a, b) => b.breadth - a.breadth || a.sector.localeCompare(b.sector),
  );
  for (const row of rows) {
    row.rank = 1 + rows.filter((r) => r.breadth > row.breadth).length;
    row.eligible = row.breadth > 0.5 && row.rank <= Math.ceil(rows.length / 2);
  }
  return {
    status: "available" as const,
    reason: null,
    rows,
    boundary: chanSectorCurrentMembershipBoundary,
    methodVersion: "current-membership-v1" as const,
    comparisonGroup: "current-membership-v1" as const,
    bias: "membership-and-survivorship" as const,
  };
}

export function chanSectorAdmission(
  raw: unknown,
  asOf: string,
  symbol: string,
  baselineEntry: boolean,
  mode: "historical" | "current-membership-v1" = "current-membership-v1",
) {
  const result =
    mode === "current-membership-v1"
      ? evaluateChanSectorCurrentMembership(raw, asOf)
      : evaluateChanSectorRotation(raw, asOf);
  const owned = result.rows.filter((r) => r.members.includes(symbol));
  return {
    ...result,
    entry:
      result.status === "available" &&
      baselineEntry &&
      owned.some((r) => r.eligible),
    exit:
      result.status === "available" &&
      owned.length > 0 &&
      owned.every((r) => !r.eligible),
    combination: "native-third-buy/sector-ma20-breadth-v1",
  };
}
