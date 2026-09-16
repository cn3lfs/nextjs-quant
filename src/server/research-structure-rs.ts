import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import { researchDateSchema } from "~/lib/research-usage";
import { wyckoffRelativeStrength } from "./wyckoff-relative-strength";
import type { CalendarReference } from "./data-health";

const stamp = z.string().datetime({ offset: true });
export const structureBenchmarkIdentitySchema = z
  .object({
    role: z.enum(["industry", "market"]),
    stock: z.string().regex(/^(sh|sz)\d{6}$/),
    benchmark: z.string().regex(/^(sh|sz)\d{6}$/),
    name: z.string().trim().min(1),
    source: z.string().trim().min(1),
    effectiveFrom: researchDateSchema,
    effectiveTo: researchDateSchema,
    availableAt: stamp,
    capturedAt: stamp,
  })
  .strict()
  .refine(
    (row) => row.effectiveFrom <= row.effectiveTo,
    "基准身份有效区间倒置",
  );
export type StructureBenchmarkIdentity = z.infer<
  typeof structureBenchmarkIdentitySchema
>;
export type StructureBenchmark = {
  snapshot: Snapshot;
  identity: StructureBenchmarkIdentity;
  availableAt: string;
};

/** Explicit historical membership and two independent index identities. Current
 * industry membership is never silently substituted for the historical one. */
export function researchStructureRs(
  stock: Snapshot,
  benchmarks: readonly StructureBenchmark[],
  calendar: CalendarReference,
  start: string,
  end: string,
  stockAvailableAt: string,
) {
  const cutoff = Date.parse(`${end}T15:05:00+08:00`);
  const gaps: string[] = [];
  const known = (value: string) =>
    stamp.safeParse(value).success && Date.parse(value) <= cutoff;
  if (
    !researchDateSchema.safeParse(start).success ||
    !researchDateSchema.safeParse(end).success ||
    start >= end
  )
    throw new Error("双基准RS区间无效");
  if (
    !known(stockAvailableAt) ||
    Date.parse(stockAvailableAt) < Date.parse(`${end}T15:00:00+08:00`)
  )
    gaps.push("标的日线可用时点缺失、早于收盘或晚于观察时点");
  const dates = calendar.days.filter((date) => date >= start && date <= end);
  if (!calendar.source.trim() || !calendar.hash)
    gaps.push("研究交易日历来源或哈希缺失");
  if (dates.some((date) => calendar.closedDays?.includes(date)))
    gaps.push("研究交易日历开闭市冲突");
  if (
    dates[0] !== start ||
    dates.at(-1) !== end ||
    dates.some(
      (date, i) =>
        !researchDateSchema.safeParse(date).success ||
        (i > 0 && date <= dates[i - 1]!),
    )
  )
    gaps.push("研究交易日历端点缺失或未严格递增");
  const cut = (s: Snapshot) => ({
    ...s,
    bars: s.bars.filter((b) => b.date >= start && b.date <= end),
  });
  const stockPrefix = cut(stock);
  const aligned = (s: Snapshot) =>
    s.bars.length === dates.length &&
    s.bars.every((b, i) => b.date === dates[i]);
  if (!aligned(stockPrefix)) gaps.push("标的缺少研究日历交易日");
  const results: Partial<
    Record<"industry" | "market", ReturnType<typeof wyckoffRelativeStrength>>
  > = {};
  for (const role of ["industry", "market"] as const) {
    const matches = benchmarks.filter((b) => b.identity.role === role);
    if (matches.length !== 1) {
      gaps.push(`${role}需唯一基准，当前${matches.length}个`);
      continue;
    }
    const row = matches[0]!,
      parsed = structureBenchmarkIdentitySchema.safeParse(row.identity);
    if (!parsed.success) {
      gaps.push(`${role}基准身份格式无效`);
      continue;
    }
    const identity = parsed.data;
    if (
      identity.stock !== stock.symbol ||
      identity.benchmark !== row.snapshot.symbol ||
      identity.effectiveFrom > start ||
      identity.effectiveTo < end ||
      !known(identity.availableAt) ||
      Date.parse(identity.availableAt) >
        Date.parse(`${start}T15:05:00+08:00`) ||
      Date.parse(identity.capturedAt) < Date.parse(identity.availableAt)
    )
      gaps.push(`${role}缺少覆盖整个窗口且基期已知的历史基准身份/行业归属`);
    if (
      !known(row.availableAt) ||
      Date.parse(row.availableAt) < Date.parse(`${end}T15:00:00+08:00`)
    )
      gaps.push(`${role}行情可用时点无效`);
    const prefix = cut(row.snapshot);
    if (!aligned(prefix)) gaps.push(`${role}缺少研究日历交易日`);
    if (
      !prefix.source.trim() ||
      !prefix.hash ||
      !stock.source.trim() ||
      !stock.hash
    )
      gaps.push(`${role}行情来源或快照哈希缺失`);
    try {
      const result = wyckoffRelativeStrength(stockPrefix, prefix, start, end);
      if (result.status !== "computed") gaps.push(`${role}RS窗口未对齐`);
      results[role] = result;
    } catch (e) {
      gaps.push(`${role}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (
    benchmarks.length !== 2 ||
    benchmarks[0]?.snapshot.symbol === benchmarks[1]?.snapshot.symbol
  )
    gaps.push("行业与市场需两个不同身份的基准");
  return {
    version: "research-dual-benchmark-ratio-1" as const,
    status: gaps.length ? ("missing" as const) : ("ready" as const),
    start,
    end,
    gaps,
    calendar: { source: calendar.source, hash: calendar.hash, days: dates },
    // Partial calculations are diagnostic evidence only, never an entry filter.
    evidence: results,
    identities: benchmarks.map((b) => b.identity),
    bothStronger: gaps.length
      ? null
      : results.industry!.changePercent! > 0 &&
        results.market!.changePercent! > 0,
    reason: gaps.length ? gaps.join("；") : null,
  };
}
