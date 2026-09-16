import { z } from "zod";
import type { Bar } from "./domain";
import { researchWyckoffSeries } from "./research-wyckoff";
import {
  structureEventMachine,
  type StructureEvent,
} from "./research-structure-events";

const stamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
const barSchema = z
  .object({
    date: stamp,
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volume: z.number().finite().positive(),
    amount: z.number().finite().nonnegative(),
  })
  .strict()
  .refine(
    (b) =>
      b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close),
  );
export const wyckoffHourlyInputsSchema = z
  .array(
    z
      .object({
        symbol: z.string().regex(/^(sh|sz)\d{6}$/),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        source: z.string().trim().min(1),
        availableAt: stamp,
        adjustment: z.literal("none"),
        hours: z.array(barSchema).length(24),
      })
      .strict(),
  )
  .max(100000)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.symbol}:${row.date}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: `小时证据重复：${key}` });
      seen.add(key);
    }
  });
export type WyckoffHourlyInput = z.infer<
  typeof wyckoffHourlyInputsSchema
>[number];
export const wyckoffHourlyIds = ["wy-daily-hourly"] as const;
export type WyckoffHourlyId = (typeof wyckoffHourlyIds)[number];
export const isWyckoffHourly = (id: string): id is WyckoffHourlyId =>
  id === "wy-daily-hourly";
export const wyckoffHourlyBoundary =
  "WY09日线区域小时确认工程v1：复用日线60根四极值TR，区域在当日首小时之前已知；小时候选冻结该区域，不用确认日新区域替换。默认只读本地五分钟并复用hourlyBars，按历史完成K线时戳建模可知时点，不证明供应商当时发布延迟；显式JSON含空数组优先且不回退。输入为既有hourlyBars适配器的24根已完成小时（最近六个研究交易日每日10:30/11:30/14:00/15:00），逐槽对齐且量价有效，四小时聚合OHLC/量额须与同源日线一致（相对容差1e-8）；不一致保留待数据，不混合单位或竞价口径；同一证券相邻快照重叠小时字节必须一致，修订不回填。小时Spring下穿支撑且量低于前20小时均量，UT上穿阻力；后续最多3根守住候选极值并收回区域，确认量至少为候选前20小时均量1.5倍。Spring入场、UT仅退出已有多仓，同日退出优先；低点守卫3日及最长持有期沿用。候选与确认保留小时时戳，日频收盘汇总后下一合法开盘成交，不宣称盘中成交或完整微观TR识别。前20小时量、3根及1.5倍是工程版本，不把小时整根量解释为逐笔下探/拉回分量。缺日/缺小时/晚知/无来源不可用并取消候选；不降级为日线。窗口2000-01-04至2022-11-30，只有不复权原始小时；公司行动证明沿用研究准入。固定输入不是盈利证据。";
export const wyckoffHourlyStrategies = {
  "wy-daily-hourly": {
    label: "威科夫 · 日线区域小时Spring/UT确认",
    family: "威科夫多周期",
    signal: "technical" as const,
    version: "wy-daily-hourly-engineering-1",
    description: wyckoffHourlyBoundary,
    sources: [
      "wyckoff-trader/SKILL.md",
      "wyckoff-trader/references/wyckoff-mtf-guide.md",
    ],
  },
};
type Facts = {
  support: number;
  resistance: number;
  regionAt: string;
  low: number;
  high: number;
  meanVolume: number;
  sequence: number;
};
export function researchWyckoffHourlySeries(
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((b) => b.date),
  inputs: readonly WyckoffHourlyInput[] = [],
  symbol = "",
) {
  const dailyByDate = new Map(bars.map((b) => [b.date, b]));
  const same = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  const daily = researchWyckoffSeries("wy-spring-daily", bars, calendar);
  const machine = structureEventMachine<Facts>();
  const knownHours = new Map<string, string>();
  let sequence = 0;
  return bars.map((b, i) => {
    const matches = inputs.filter(
      (r) => r.symbol === symbol && r.date === b.date,
    );
    const row = matches.length === 1 ? matches[0] : undefined;
    const end = `${b.date}T15:00:00+08:00`;
    const day = calendar.indexOf(b.date);
    const dates = calendar.slice(Math.max(0, day - 5), day + 1);
    const expected = dates.flatMap((d) =>
      ["10:30", "11:30", "14:00", "15:00"].map((t) => `${d}T${t}:00+08:00`),
    );
    const parsed = row ? wyckoffHourlyInputsSchema.safeParse([row]) : null;
    const ready =
      !!row &&
      parsed?.success === true &&
      b.date >= "2000-01-04" &&
      b.date <= "2022-11-30" &&
      row.availableAt <= end &&
      row.availableAt >= row.hours.at(-1)!.date &&
      expected.length === 24 &&
      dates.every((date, k) => {
        const d = dailyByDate.get(date),
          h = row.hours.slice(k * 4, k * 4 + 4);
        return (
          !!d &&
          h.length === 4 &&
          same(h[0]!.open, d.open) &&
          same(h[3]!.close, d.close) &&
          same(Math.max(...h.map((x) => x.high)), d.high) &&
          same(Math.min(...h.map((x) => x.low)), d.low) &&
          same(
            h.reduce((a, x) => a + x.volume, 0),
            d.volume,
          ) &&
          same(
            h.reduce((a, x) => a + x.amount, 0),
            d.amount,
          )
        );
      }) &&
      row.hours.every(
        (h, j) =>
          h.date === expected[j] &&
          ![0, 6].includes(new Date(h.date.slice(0, 10)).getUTCDay()) &&
          (!knownHours.has(h.date) ||
            knownHours.get(h.date) === JSON.stringify(h)),
      );
    const reason =
      daily[i]!.reason ??
      (ready
        ? null
        : "待数据：需要当日15:00前已知、最近六交易日完整24小时原始量价与来源，小时聚合必须与同源日线量价一致，禁止快照修订回填");
    const events: StructureEvent<Facts>[] = [];
    if (reason || !row) {
      sequence += 4;
      events.push(
        ...machine.observe(
          end,
          [],
          () => ({ state: "waiting", reason: "" }),
          reason,
        ),
      );
    } else {
      for (const h of row.hours) knownHours.set(h.date, JSON.stringify(h));
      for (let j = 20; j < 24; j++) {
        const h = row.hours[j]!;
        sequence++;
        const region = daily[i]!.structure;
        const average =
          row.hours.slice(j - 20, j).reduce((s, h) => s + h.volume, 0) / 20;
        const seeds: { key: string; kind: string; facts: Facts }[] = [];
        if (region?.asOf && region.asOf < b.date) {
          const facts = {
            support: region.support,
            resistance: region.resistance,
            regionAt: region.asOf,
            low: h.low,
            high: h.high,
            meanVolume: average,
            sequence,
          };
          if (h.low < region.support && h.volume < average)
            seeds.push({ key: `spring:${h.date}`, kind: "spring", facts });
          if (h.high > region.resistance)
            seeds.push({ key: `ut:${h.date}`, kind: "ut", facts });
        }
        events.push(
          ...machine.observe(h.date, seeds, (e) => {
            const f = e.facts,
              spring = e.kind === "spring";
            if (
              sequence - f.sequence > 3 ||
              (spring ? h.low < f.low : h.high > f.high)
            )
              return { state: "cancelled", reason: "小时候选超时或极值失守" };
            if (
              (spring ? h.close > f.support : h.close < f.resistance) &&
              h.volume >= 1.5 * f.meanVolume
            )
              return { state: "confirmed", reason: "小时回收区域且放量确认" };
            return { state: "waiting", reason: "等待后续小时回收" };
          }),
        );
      }
    }
    const confirms = events.filter((e) => e.state === "confirmed");
    const buy = confirms.find((e) => e.kind === "spring");
    const exit = confirms.some((e) => e.kind === "ut");
    return {
      date: b.date,
      entry: !!buy && !exit,
      exit,
      reason,
      events,
      structure: daily[i]!.structure,
      values: {
        close: b.close,
        hourlySource: row?.source ?? null,
        availableAt: row?.availableAt ?? null,
      },
      ...(buy
        ? {
            candidateAt: buy.candidateAt.slice(0, 10),
            ruleStop: {
              price: buy.facts.low,
              days: 3,
              reason: "小时Spring冻结低点",
            },
          }
        : {}),
    };
  });
}
