import { z } from "zod";
import type { Bar } from "./domain";
import { ma } from "./indicators";
import { researchWyckoffSeries } from "./research-wyckoff";
import { structureEventMachine } from "./research-structure-events";

const at = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
export const wyckoffInputsSchema = z
  .array(
    z
      .object({
        symbol: z.string().regex(/^(sh|sz)\d{6}$/),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        availableAt: at,
        source: z.string().trim().min(1),
        limit: z.boolean(),
        corporateAction: z.boolean(),
        openingCrash: z.boolean(),
        specialDate: z.boolean(),
        marketCapYuan: z.number().finite().positive(),
      })
      .strict(),
  )
  .max(100000)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.symbol}:${r.date}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: `威科夫日证据重复：${key}` });
      seen.add(key);
    }
  });
export type WyckoffInput = z.infer<typeof wyckoffInputsSchema>[number];
export const wyckoffVsaProfiles = {
  "wy-stopping-volume": ["WY12", "Stopping Volume 后续无供给确认", "stopping"],
  "wy-no-supply": ["WY13", "No Supply 支撑反弹确认", "no-supply"],
  "wy-no-demand": ["WY14", "No Demand 阻力回落退出", "no-demand"],
  "wy-absorption": ["WY15", "低位 TR Absorption 确认", "absorption"],
  "wy-churning": ["WY16", "高位 TR Churning 退出", "churning"],
  "wy-climax": ["WY17", "SC/BC 三日及 AR/ST 确认", "sc-bc"],
} as const;
export type WyckoffVsaId = keyof typeof wyckoffVsaProfiles;
export const wyckoffVsaIds = Object.keys(wyckoffVsaProfiles) as WyckoffVsaId[];
export const isWyckoffVsa = (id: string): id is WyckoffVsaId =>
  Object.hasOwn(wyckoffVsaProfiles, id);
export const wyckoffVsaBoundary =
  "VSA工程v1，单事件候选与确认逐项记录，交易组合共用日线TR工程状态机。量与价差基准为前20根（不含当前）；Stopping候选价<MA60、量>1.5倍、收位>0.5，确认另需候选量>3倍、后续无新低且5根内出现近低1%的No Supply；No Supply/No Demand为阴/阳、量<0.5、价差<1倍且TR内，分别需此前20根止跌量/高量滞涨证据、距支撑/阻力1%内，再下一根收盘越候选高/低确认。Absorption连续3根各量>1.2倍，三根总波幅<2%或各价差<0.8倍，冻结低位TR内且无突破，前20根缩量下跌数>放量下跌数；下一根越候选高点确认。Churning量>2倍、价差<0.3倍、收位[0.3,0.7]，高位TR且前20根缩量上涨数>放量上涨数，次根跌破候选低点退出。高低位以价相对MA60作代理，不宣称主力意图。SC/BC量>3倍、价差>2倍、破前5根低/高、收位>0.6/<0.4；候选后至少3根不创新极值，先出现距极值>1% AR，再10根内缩量ST触及原极值1%区域才确认。盘中先后未知不得同根认AR/ST。卖出事件以同一JAC基线入场，仅退出已有多仓；其余入场及MA20下穿/最长持有退出。逐日历史涨跌停/除权/开盘跳水/特殊日期和市值证据必须在15:00前已知，缺失或冲突不可用，异常取消候选；市值<50亿元保守禁入。百分比距离、窗口、收盘确认及小盘禁入是显式工程解释。不是完整体系或盈利证据。";
export const wyckoffVsaStrategies = Object.fromEntries(
  wyckoffVsaIds.map((id) => [
    id,
    {
      label: `威科夫 VSA · ${wyckoffVsaProfiles[id][1]}`,
      family: "威科夫VSA",
      signal: "technical" as const,
      version: `${id}-engineering-1`,
      description: wyckoffVsaBoundary,
      sources: [
        "wyckoff-trader/SKILL.md",
        "wyckoff-trader/references/wyckoff-vsa-signals.md",
      ],
    },
  ]),
) as Record<
  WyckoffVsaId,
  {
    label: string;
    family: string;
    signal: "technical";
    version: string;
    description: string;
    sources: string[];
  }
>;
export type VsaFacts = {
  index: number;
  low: number;
  high: number;
  close: number;
  volume: number;
  ratio: number;
  support: number | null;
  resistance: number | null;
};
export type VsaContext = {
  b: Bar;
  meanVolume: number;
  meanSpread: number;
  ma60: number;
  support: number | null;
  resistance: number | null;
  low5: number;
  high5: number;
};
/** Source thresholds only. Context/confirmation is evaluated by the state machine. */
export function wyckoffVsaPatterns(c: VsaContext) {
  const { b } = c,
    spread = b.high - b.low;
  if (
    ![
      b.open,
      b.close,
      b.high,
      b.low,
      b.volume,
      c.meanVolume,
      c.meanSpread,
      c.ma60,
    ].every((v) => Number.isFinite(v) && v > 0) ||
    spread <= 0 ||
    b.low > Math.min(b.open, b.close) ||
    b.high < Math.max(b.open, b.close)
  )
    return [];
  const ratio = b.volume / c.meanVolume,
    width = spread / c.meanSpread,
    position = (b.close - b.low) / spread;
  const inside =
    c.support !== null &&
    c.resistance !== null &&
    b.low >= c.support &&
    b.high <= c.resistance;
  const kinds: string[] = [];
  if (b.close < c.ma60 && ratio > 1.5 && position > 0.5) kinds.push("stopping");
  if (inside && b.close < b.open && ratio < 0.5 && width < 1)
    kinds.push("no-supply");
  if (inside && b.close > b.open && ratio < 0.5 && width < 1)
    kinds.push("no-demand");
  if (
    inside &&
    b.close > c.ma60 &&
    ratio > 2 &&
    width < 0.3 &&
    position >= 0.3 &&
    position <= 0.7
  )
    kinds.push("churning");
  if (ratio > 3 && width > 2 && b.low < c.low5 && position > 0.6)
    kinds.push("sc");
  if (ratio > 3 && width > 2 && b.high > c.high5 && position < 0.4)
    kinds.push("bc");
  return kinds;
}
export function researchWyckoffVsaSeries(
  id: WyckoffVsaId,
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((b) => b.date),
  inputs: readonly WyckoffInput[] = [],
  symbol = "",
) {
  const base = researchWyckoffSeries("wy-sos-jac-daily", bars, calendar),
    means = ma(bars, 60);
  const rows = new Map<string, WyckoffInput[]>();
  for (const r of inputs.filter((r) => r.symbol === symbol))
    rows.set(r.date, [...(rows.get(r.date) ?? []), r]);
  const machine = structureEventMachine<VsaFacts>();
  const ar = new Set<string>();
  const contexts: VsaContext[] = [];
  let previousStopping: VsaFacts | null = null,
    previousStall: VsaFacts | null = null;
  const availability: (string | null)[] = [];
  return bars.map((b, i) => {
    const p = base[i]!,
      prior = bars.slice(Math.max(0, i - 20), i),
      s = p.structure;
    const e = rows.get(b.date);
    const rowValid =
      e?.length === 1 && wyckoffInputsSchema.safeParse(e).success;
    const known =
      rowValid &&
      e?.length === 1 &&
      e[0]!.source.trim() &&
      Number.isFinite(Date.parse(e[0]!.availableAt)) &&
      e[0]!.availableAt <= `${b.date}T15:00:00+08:00`
        ? e[0]
        : undefined;
    const reason =
      p.reason ??
      (!known
        ? "缺少当日15:00已知的VSA排除/市值证据"
        : known.limit ||
            known.corporateAction ||
            known.openingCrash ||
            known.specialDate
          ? "涨跌停/除权/开盘跳水/特殊日期隔离"
          : known.marketCapYuan < 5e9
            ? "市值不足50亿元，VSA保守禁入"
            : null);
    availability.push(reason);
    const context: VsaContext = {
      b,
      meanVolume: prior.reduce((v, b) => v + b.volume, 0) / 20,
      meanSpread: prior.reduce((v, b) => v + b.high - b.low, 0) / 20,
      ma60: means[i] ?? NaN,
      support: s?.support ?? null,
      resistance: s?.resistance ?? null,
      low5: Math.min(...prior.slice(-5).map((b) => b.low)),
      high5: Math.max(...prior.slice(-5).map((b) => b.high)),
    };
    contexts.push(context);
    const found = reason ? [] : wyckoffVsaPatterns(context);
    const facts: VsaFacts = {
      index: i,
      low: b.low,
      high: b.high,
      close: b.close,
      volume: b.volume,
      ratio: b.volume / context.meanVolume,
      support: context.support,
      resistance: context.resistance,
    };
    const seeds: { key: string; kind: string; facts: VsaFacts }[] = [];
    const seed = (kind: string) =>
      seeds.push({ key: `${kind}:${b.date}`, kind, facts });
    if (reason) {
      previousStopping = null;
      previousStall = null;
      ar.clear();
    } else {
      for (const k of found) {
        if (
          k === "no-supply" &&
          !(
            previousStopping &&
            i - previousStopping.index <= 20 &&
            s &&
            b.low <= s.support * 1.01
          )
        )
          continue;
        if (
          k === "no-demand" &&
          !(
            previousStall &&
            i - previousStall.index <= 20 &&
            s &&
            b.high >= s.resistance * 0.99
          )
        )
          continue;
        if (k === "churning") {
          const up = prior.filter(
            (x, k) => k > 0 && x.close > prior[k - 1]!.close,
          );
          if (
            up.filter((x) => x.volume < context.meanVolume * 0.5).length <=
            up.filter((x) => x.volume > context.meanVolume * 1.5).length
          )
            continue;
        }
        seed(k);
      }
      if (
        s &&
        b.close < context.ma60 &&
        i >= 2 &&
        availability.slice(i - 2, i + 1).every((r) => r === null)
      ) {
        const three = contexts.slice(i - 2, i + 1),
          range =
            Math.max(...three.map((c) => c.b.high)) /
              Math.min(...three.map((c) => c.b.low)) -
            1;
        const down = prior.filter(
          (x, k) => k > 0 && x.close < prior[k - 1]!.close,
        );
        if (
          three.every(
            (c) =>
              c.b.volume > c.meanVolume * 1.2 &&
              c.b.low >= s.support &&
              c.b.high <= s.resistance,
          ) &&
          (range < 0.02 ||
            three.every((c) => c.b.high - c.b.low < c.meanSpread * 0.8)) &&
          down.filter((x) => x.volume < context.meanVolume * 0.5).length >
            down.filter((x) => x.volume > context.meanVolume * 1.5).length
        )
          seed("absorption");
      }
    }
    const events = machine.observe(
      b.date,
      seeds,
      (c) => {
        const f = c.facts,
          age = i - f.index,
          bull = ["stopping", "no-supply", "absorption", "sc"].includes(c.kind);
        if (
          (bull ? b.low < f.low : b.high > f.high) ||
          age >
            (["sc", "bc"].includes(c.kind) ? 10 : c.kind === "stopping" ? 5 : 1)
        ) {
          ar.delete(c.key);
          return { state: "cancelled", reason: "突破冻结极值或超时" };
        }
        let confirm = false;
        if (c.kind === "sc" || c.kind === "bc") {
          const hadAr = ar.has(c.key);
          confirm =
            age >= 3 &&
            hadAr &&
            b.volume < f.volume * 0.5 &&
            (bull
              ? b.low <= f.low * 1.01 && b.close > f.low
              : b.high >= f.high * 0.99 && b.close < f.high);
          if (bull ? b.close > f.low * 1.01 : b.close < f.high * 0.99)
            ar.add(c.key);
        } else if (c.kind === "stopping")
          confirm =
            f.ratio > 3 && found.includes("no-supply") && b.low <= f.low * 1.01;
        else confirm = bull ? b.close > f.high : b.close < f.low;
        if (confirm) ar.delete(c.key);
        return {
          state: confirm ? "confirmed" : "waiting",
          reason: confirm ? "后续VSA确认条件满足" : "等待后续确认",
        };
      },
      reason,
    );
    if (!reason && found.includes("stopping")) previousStopping = facts;
    if (!reason && (found.includes("bc") || found.includes("churning")))
      previousStall = facts;
    const confirmed = events.filter((e) => e.state === "confirmed"),
      kind = wyckoffVsaProfiles[id][2];
    const sell = kind === "no-demand" || kind === "churning";
    const buy = confirmed.find((e) =>
      kind === "sc-bc" ? e.kind === "sc" : e.kind === kind,
    );
    const exit =
      !reason &&
      (p.exit ||
        confirmed.some((e) =>
          kind === "sc-bc" ? e.kind === "bc" : sell && e.kind === kind,
        ));
    const entry = !reason && !exit && (sell ? p.entry : !!buy);
    return {
      date: b.date,
      entry,
      exit,
      reason,
      decision:
        reason ??
        (exit ? "VSA确认多仓退出" : entry ? "VSA组合确认入场" : "等待VSA确认"),
      values: { ...p.values, patterns: found },
      events,
      structure: s,
      ...(entry
        ? {
            candidateAt: buy?.candidateAt ?? p.candidateAt,
            ruleStop: {
              price: buy?.facts.low ?? p.ruleStop!.price,
              days: 3,
              reason: "VSA候选冻结低点",
            },
          }
        : {}),
    };
  });
}
