import { z } from "zod";
import { researchDateSchema } from "./research-usage";
import { researchStructureTargets } from "./research-structure-targets";
import { wyckoffDailyProfile } from "./research-wyckoff-profile";
import type { Bar } from "./domain";
import { confirmedExtrema, ma } from "./indicators";
import {
  structureEventMachine,
  type StructureEvent,
} from "./research-structure-events";

const stamp = z.string().datetime({ offset: true });
const text = z.string().trim().min(1);
const rawBar = z
  .object({
    date: researchDateSchema,
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volume: z.number().finite().nonnegative(),
    amount: z.number().finite().nonnegative(),
  })
  .strict()
  .refine(
    (b) =>
      b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close),
  );
const rawSnapshot = z
  .object({
    id: text,
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    name: text.optional(),
    period: z.literal("day"),
    source: text,
    adjustment: z.literal("none"),
    createdAt: z.number().finite().nonnegative(),
    hash: text,
    bars: z.array(rawBar),
    historicalAsOf: researchDateSchema.optional(),
    volumeUnit: text.optional(),
    sourceVersions: z.array(text).optional(),
  })
  .strict();
export const structureBenchmarkIdentitySchema = z
  .object({
    role: z.enum(["industry", "market"]),
    stock: z.string().regex(/^(sh|sz)\d{6}$/),
    benchmark: z.string().regex(/^(sh|sz)\d{6}$/),
    name: text,
    source: text,
    effectiveFrom: researchDateSchema,
    effectiveTo: researchDateSchema,
    availableAt: stamp,
    capturedAt: stamp,
  })
  .strict()
  .refine((r) => r.effectiveFrom <= r.effectiveTo, "基准身份有效区间倒置");
const score = z.number().finite().min(0).max(100);
export const wyckoffStructureInputsSchema = z
  .array(
    z
      .object({
        symbol: z.string().regex(/^(sh|sz)\d{6}$/),
        date: researchDateSchema,
        source: text,
        availableAt: stamp,
        weeklyAvailableAt: stamp.optional(),
        stock: rawSnapshot,
        calendar: z
          .object({
            days: z.array(researchDateSchema),
            closedDays: z.array(researchDateSchema),
            source: text,
            hash: text,
            availableAt: stamp,
          })
          .strict(),
        benchmarks: z
          .array(
            z
              .object({
                snapshot: rawSnapshot,
                identity: structureBenchmarkIdentitySchema,
                availableAt: stamp,
              })
              .strict(),
          )
          .optional(),
        assessment: z
          .object({
            phase: z.enum([
              "accumulation",
              "markup",
              "distribution",
              "markdown",
              "unknown",
            ]),
            quality: z.enum(["multi", "single", "weak"]),
            tr: score,
            vsa: score,
            mtf: score,
            rs: score,
            market: score,
            source: text,
            availableAt: stamp,
          })
          .strict()
          .optional(),
      })
      .strict(),
  )
  .max(100000)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.symbol}:${r.date}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: `结构输入重复：${key}` });
      seen.add(key);
    }
  });
export type WyckoffStructureInput = z.infer<
  typeof wyckoffStructureInputsSchema
>[number];
export const isWyckoffStructure = (id: string) =>
  [
    "wy-week-day-hour",
    "wy-dual-rs",
    "wy-target-pf",
    "wy-target-time",
    "wy-target-width",
    "wy-score-half-kelly",
  ].includes(id);
export const wyckoffStructureBoundary =
  "WY10：52个连续已完成周，右侧3周确认极值的最后两高两低均抬升，叠加WY09日线TR/小时Spring；weeklyAvailableAt须在小时候选前且不早于末周完成，非完整周线阶段诊断。WY11：JAC基线，候选前20研究日到确认日相对历史行业与市场归一化RS均>0。输入按证券/观察日保存原始日线、日历开闭市、基准身份和availableAt；显式空输入不回退，源日线必须与研究日线逐字对齐。WY19：JAC确认冻结突破前TR，格值为宽度10%，单格收盘反转P&F/原文宽度时间列数/宽度1-2-3三模型独立命名；非传统三格P&F。前两目标各减初始仓位1/3，最后目标清仓；单目标模型清仓。收盘触达后次合法开盘成交，原文非单调目标按原顺序不排序，每次仅处理一个档位。WY20：时点人工阶段与五项评分原始证据，25/25/20/15/15加权≥70及非派发/下跌/未知，JAC单强信号；0.55/0.48/0.40仅原方法假设展示，实际仓位复用B2开发段闭合样本净回报半凯利，风险2%且单股≤30%，样本不足拒绝验证段入场。评分70、52周、RS20日是工程参数；不宣称自动完整阶段识别或盈利证据。";
export function wyckoffScore(assessment: WyckoffStructureInput["assessment"]) {
  if (!assessment) return null;
  return {
    value:
      assessment.tr * 0.25 +
      assessment.vsa * 0.25 +
      assessment.mtf * 0.2 +
      assessment.rs * 0.15 +
      assessment.market * 0.15,
    assumedWinRate: { multi: 0.55, single: 0.48, weak: 0.4 }[
      assessment.quality
    ],
    probabilitySource: "原方法假设，非实测胜率",
    phase: assessment.phase,
  };
}

export const wyckoffProfiles = {
  "wy-week-day-hour": ["WY10", "周日小时对齐 · 52周确认结构", "mtf"],
  "wy-dual-rs": ["WY11", "JAC · 历史行业/市场双RS", "rs"],
  "wy-target-pf": ["WY19", "JAC · 收盘单格P&F目标", "target"],
  "wy-target-time": ["WY19", "JAC · 原文时间列数目标", "target"],
  "wy-target-width": ["WY19", "JAC · 原文宽度1/2/3目标", "target"],
  "wy-score-half-kelly": ["WY20", "JAC · 阶段评分/训练半凯利", "score"],
  "wy-vp-daily-estimate": ["WY18", "日线均匀分配估算VP · JAC上沿HVN过滤", "vp"],
  "wy-spring-daily": ["WY01", "Spring 日线回收确认", "spring"],
  "wy-sos-daily": ["WY02", "SOS 中轴突破后一日守位", "sos"],
  "wy-sos-jac-daily": ["WY02", "SOS/JAC 后一日守位", "jac"],
  "wy-lps-daily": ["WY03", "LPS 缩量回踩", "lps"],
  "wy-reaccumulation-daily": ["WY04", "再吸筹 LPS 延续", "reaccumulation"],
  "wy-ut-exit-daily": ["WY05", "UT/UTAD 风险退出", "ut"],
  "wy-sow-lpsy-daily": ["WY06", "SOW/LPSY 反弹减半", "lpsy"],
  "wy-ice-exit-daily": ["WY07", "破冰退出", "ice"],
  "wy-trend-pullback-daily": [
    "WY08",
    "非标准威科夫入场 · 无 TR 趋势回调",
    "trend",
  ],
} as const;
export type WyckoffId = keyof typeof wyckoffProfiles;
type Kind = (typeof wyckoffProfiles)[WyckoffId][2];
export const wyckoffIds = Object.keys(wyckoffProfiles) as WyckoffId[];
export const isWyckoff = (id: string): id is WyckoffId =>
  Object.hasOwn(wyckoffProfiles, id);
export const wyckoffBoundary =
  "日线结构工程v1：TR以前一日已知60根内最后4个交替极值识别，极值各需右侧3根确认；两高/两低差各≤1%，区间宽≤20%，不是完整五阶段自动诊断。冻结区间后观察，不用全区间最终结构回填。均量/价差用候选日前20根；长实体≥全幅50%，放量≥1.5倍，Spring日线回收量≥1.5倍只是盘中拉回放量的近似，UT同理。Spring/UT先越界候选，最多3根收回且放量才确认；次根跌破/突破候选极值取消。SOS越中轴/JAC越上沿放量长阳，下一根不失守冻结线确认；LPS在SOS/JAC后10根内缩量回踩不超过涨幅50%，触及冻结线至其上1%，下一根收盘超过回踩最高价确认。再吸筹另需此前MA20>MA60且MA60上升。SOW为放量长阴跌穿中轴，LPSY镜像反弹不超过跌幅50%，确认后减当时剩余多仓50%；破冰放量长阴下穿冻结下沿当日确认退出。无TR回调需MA20>MA60、MA20上升，缩量回踩MA20并守住，下一根放量收盘越回踩高点。退出类以同一JAC确认入场作对照，仅入场开盘守冻结TR下沿，持有后按具名UT/LPSY/破冰或最长持有期处理，避免共同MA20/突破低点守卫在LPSY之前先平仓；入场类另有MA20下穿退出及候选低点3根守卫。所有成交在确认后下一合法开盘，沿用T+1/受阻重试；仅卖已有多仓、不做空。1%/20%/3根/10根/实体50%与次日确认均为工程参数；不等于原文全覆盖、真实回测或盈利证据。";
export const wyckoffStrategies = Object.fromEntries(
  wyckoffIds.map((id) => [
    id,
    {
      label: `威科夫 · ${wyckoffProfiles[id][1]}`,
      family: "威科夫结构事件",
      signal: "technical" as const,
      version: `${id}-engineering-1`,
      description:
        wyckoffBoundary +
        (isWyckoffStructure(id) ? wyckoffStructureBoundary : "") +
        (id === "wy-vp-daily-estimate"
          ? "VP为候选前已确认TR最早极值起至少20根、12等宽箱、按日线高低区间重叠长度均匀分量的估算；量和守恒。量最多3箱为HVN、最少3箱为LVN，并列低价优先；JAC只在最高2箱内存在HVN时入场。非真实逐价成交分布；边界容差与箱数为工程参数。"
          : ""),
      sources: [
        "wyckoff-trader/SKILL.md",
        ...(isWyckoffStructure(id)
          ? [
              "wyckoff-trader/references/wyckoff-mtf-guide.md",
              "wyckoff-trader/references/wyckoff-relative-strength.md",
              "wyckoff-trader/references/wyckoff-pf-targets.md",
            ]
          : []),
        ...(id === "wy-vp-daily-estimate"
          ? ["wyckoff-trader/references/wyckoff-volume-profile.md"]
          : []),
        "wyckoff-trader/references/wyckoff-accumulation-schematic.md",
        "wyckoff-trader/references/wyckoff-distribution-schematic.md",
      ],
    },
  ]),
) as Record<
  WyckoffId,
  {
    label: string;
    family: string;
    signal: "technical";
    version: string;
    description: string;
    sources: string[];
  }
>;

export type WyckoffFacts = {
  index: number;
  rangeStart: number;
  low: number;
  high: number;
  close: number;
  volume: number;
  meanVolume: number;
  support: number;
  resistance: number;
  level: number;
  trend: boolean;
  parentAt: string | null;
};
export type WyckoffPoint = {
  date: string;
  candidateAt?: string;
  values: { close: number; ma20: number | null; meanVolume: number };
  entry: boolean;
  exit: boolean;
  reason: string | null;
  decision: string;
  structure: {
    asOf: string | null;
    support: number;
    resistance: number;
    trend: boolean;
  } | null;
  events: StructureEvent<WyckoffFacts>[];
  targetPlan?: ReturnType<typeof researchStructureTargets>;
  profile?: ReturnType<typeof wyckoffDailyProfile>;
  ruleStop?: { price: number; days: number; reason: string };
  reduction?: { fraction: number; reason: string };
};
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.high >= Math.max(b.open, b.close) &&
  b.low <= Math.min(b.open, b.close);

export function researchWyckoffSeries(
  id: WyckoffId,
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((b) => b.date),
): WyckoffPoint[] {
  const machine = structureEventMachine<WyckoffFacts>();
  const mean20 = ma(bars, 20),
    mean60 = ma(bars, 60);
  const days = new Map(calendar.map((date, index) => [date, index]));
  let bullish: StructureEvent<WyckoffFacts> | null = null;
  let bearish: StructureEvent<WyckoffFacts> | null = null;
  let lastLpsParent = "",
    lastLpsyParent = "";
  return bars.map((b, i) => {
    const prior = bars.slice(Math.max(0, i - 60), i),
      day = days.get(b.date);
    const reason =
      prior.length < 60
        ? "需要此前60根日线"
        : !valid(b) || prior.some((p) => !valid(p))
          ? "连续结构窗口量价无效"
          : day == null ||
              prior.some((p, k) => p.date !== calendar[day - 60 + k])
            ? "研究交易日历存在结构窗口缺口"
            : null;
    const extrema = reason ? null : confirmedExtrema(prior);
    const barrier = extrema?.ambiguousIndices.at(-1) ?? -1;
    const points =
      extrema?.extrema.filter((p) => p.index - 3 > barrier).slice(-4) ?? [];
    const highs = points.filter((p) => p.kind === "high"),
      lows = points.filter((p) => p.kind === "low");
    const support =
      lows.length === 2 ? Math.min(...lows.map((p) => p.price)) : 0;
    const resistance =
      highs.length === 2 ? Math.max(...highs.map((p) => p.price)) : 0;
    const range =
      points.length === 4 &&
      points.every((p, k) => !k || p.kind !== points[k - 1]!.kind) &&
      support > 0 &&
      resistance > support &&
      resistance / support <= 1.2 &&
      Math.abs(highs[1]!.price / highs[0]!.price - 1) <= 0.01 &&
      Math.abs(lows[1]!.price / lows[0]!.price - 1) <= 0.01;
    const trend =
      i > 60 &&
      mean20[i - 1]! > mean60[i - 1]! &&
      mean60[i - 1]! > mean60[i - 2]!;
    const structure =
      !reason && range
        ? { asOf: prior.at(-1)!.date, support, resistance, trend }
        : null;
    const average = prior.slice(-20).reduce((s, p) => s + p.volume, 0) / 20;
    const wide =
      b.high > b.low && Math.abs(b.close - b.open) >= (b.high - b.low) * 0.5;
    const expanded = b.volume >= average * 1.5;
    const seeds: { key: string; kind: string; facts: WyckoffFacts }[] = [];
    const seed = (
      kind: string,
      level: number,
      lower = support,
      upper = resistance,
      parentAt: string | null = null,
      priorTrend = trend,
    ) =>
      seeds.push({
        key: `${kind}:${b.date}`,
        kind,
        facts: {
          index: i,
          rangeStart: points[0] ? Math.max(0, i - 60) + points[0].index : i,
          low: b.low,
          high: b.high,
          close: b.close,
          volume: b.volume,
          meanVolume: average,
          support: lower,
          resistance: upper,
          level,
          trend: priorTrend,
          parentAt,
        },
      });
    if (reason) {
      bullish = null;
      bearish = null;
    }
    if (!reason) {
      if (
        bullish &&
        (i - bullish.facts.index > 10 || b.low < bullish.facts.level)
      )
        bullish = null;
      if (
        bearish &&
        (i - bearish.facts.index > 10 || b.high > bearish.facts.level)
      )
        bearish = null;
      if (structure) {
        const middle = (support + resistance) / 2;
        if (b.low < support) seed("spring", support);
        if (b.high > resistance) seed("ut", resistance);
        if (
          expanded &&
          wide &&
          b.close > b.open &&
          prior.at(-1)!.close <= resistance &&
          b.close > resistance
        )
          seed("jac", resistance);
        else if (
          expanded &&
          wide &&
          b.close > b.open &&
          prior.at(-1)!.close <= middle &&
          b.close > middle
        )
          seed("sos", middle);
        if (
          expanded &&
          wide &&
          b.close < b.open &&
          prior.at(-1)!.close >= middle &&
          b.close < middle
        )
          seed("sow", middle);
      }
      if (
        bullish &&
        lastLpsParent !== bullish.key &&
        b.volume < average * 0.5 &&
        b.low >=
          Math.max(
            bullish.facts.level,
            (bullish.facts.low + bullish.facts.close) / 2,
          ) &&
        b.low <= bullish.facts.level * 1.01 &&
        b.close < bars[i - 1]!.close
      ) {
        seed(
          "lps",
          bullish.facts.level,
          bullish.facts.support,
          bullish.facts.resistance,
          bullish.candidateAt,
          bullish.facts.trend,
        );
        lastLpsParent = bullish.key;
      }
      if (
        bearish &&
        lastLpsyParent !== bearish.key &&
        b.volume < average * 0.5 &&
        b.high <=
          Math.min(
            bearish.facts.level,
            (bearish.facts.high + bearish.facts.close) / 2,
          ) &&
        b.high >= bearish.facts.level * 0.99 &&
        b.close > bars[i - 1]!.close
      ) {
        seed(
          "lpsy",
          bearish.facts.level,
          bearish.facts.support,
          bearish.facts.resistance,
          bearish.candidateAt,
        );
        lastLpsyParent = bearish.key;
      }
      if (
        !structure &&
        trend &&
        mean20[i - 1]! > mean20[i - 2]! &&
        b.volume < average * 0.5 &&
        b.low >= mean20[i - 1]! &&
        b.low <= mean20[i - 1]! * 1.01 &&
        b.close < bars[i - 1]!.close
      )
        seed("trend", mean20[i - 1]!, mean20[i - 1]!, b.high);
    }
    const events = machine.observe(
      b.date,
      seeds,
      (e) => {
        const f = e.facts,
          age = i - f.index;
        const bull = ["spring", "jac", "sos", "lps", "trend"].includes(e.kind);
        const invalid = bull ? b.low < f.low : b.high > f.high;
        if (invalid || age > (e.kind === "spring" || e.kind === "ut" ? 3 : 1))
          return { state: "cancelled", reason: "越过候选极值或等待超时" };
        const confirmed =
          e.kind === "spring"
            ? b.close > f.level && b.volume >= f.meanVolume * 1.5
            : e.kind === "ut"
              ? b.close < f.level && b.volume >= f.meanVolume * 1.5
              : ["jac", "sos"].includes(e.kind)
                ? b.low >= f.level
                : e.kind === "sow"
                  ? b.high <= f.level
                  : e.kind === "lpsy"
                    ? b.close < f.low
                    : b.close > f.high &&
                      (e.kind !== "trend" || b.volume >= f.meanVolume * 1.5);
        return {
          state: confirmed ? "confirmed" : "waiting",
          reason: confirmed ? "冻结候选后续确认" : "条件未满足",
        };
      },
      reason,
    );
    for (const e of events.filter((e) => e.state === "confirmed")) {
      if (["jac", "sos"].includes(e.kind)) bullish = e;
      if (e.kind === "sow") bearish = e;
    }
    if (
      !reason &&
      structure &&
      expanded &&
      wide &&
      b.close < b.open &&
      bars[i - 1]!.close >= support &&
      b.close < support
    ) {
      events.push({
        key: `ice:${b.date}`,
        kind: "ice",
        candidateAt: b.date,
        observedAt: b.date,
        confirmedAt: b.date,
        state: "confirmed",
        reason: "收盘放量跌破此前已知冰线",
        facts: {
          index: i,
          rangeStart: points[0] ? Math.max(0, i - 60) + points[0].index : i,
          low: b.low,
          high: b.high,
          close: b.close,
          volume: b.volume,
          meanVolume: average,
          support,
          resistance,
          level: support,
          trend,
          parentAt: null,
        },
      });
    }
    const kind: Kind = wyckoffProfiles[id][2];
    const confirms = events.filter((e) => e.state === "confirmed");
    const baseline = ["ut", "lpsy", "ice", "target", "rs", "score"].includes(
      kind,
    );
    const match = confirms.find((e) =>
      baseline || kind === "vp"
        ? e.kind === "jac"
        : kind === "reaccumulation"
          ? e.kind === "lps" && e.facts.trend
          : e.kind === kind,
    );
    const targetPlan =
      kind === "target" && match
        ? researchStructureTargets({
            model:
              id === "wy-target-pf"
                ? "pf-close-reversal-1box"
                : id === "wy-target-time"
                  ? "source-width-time-columns"
                  : "source-width-123",
            bars: bars.slice(match.facts.rangeStart, match.facts.index),
            low: match.facts.support,
            high: match.facts.resistance,
            boxSize: (match.facts.resistance - match.facts.support) * 0.1,
            direction: 1,
            breakoutPrice: match.facts.close,
            confirmedAt: b.date,
          })
        : undefined;
    const externalMissing = ["mtf", "rs", "score"].includes(kind)
      ? "缺少周线/RS/阶段评分研究输入"
      : null;
    const profile =
      kind === "vp" && match
        ? wyckoffDailyProfile(
            bars.slice(match.facts.rangeStart, match.facts.index),
            match.facts.support,
            match.facts.resistance,
          )
        : undefined;
    const profilePass =
      kind !== "vp" ||
      (profile?.status === "daily-uniform-estimate" &&
        profile.hvn.some((index) => index >= 10));
    const exit =
      !reason &&
      ((!baseline &&
        b.close < mean20[i]! &&
        bars[i - 1]!.close >= mean20[i - 1]!) ||
        (["ut", "target"].includes(kind) &&
          confirms.some((e) => e.kind === "ut")) ||
        (["ice", "target"].includes(kind) &&
          confirms.some((e) => e.kind === "ice")));
    const reduce = kind === "lpsy" && confirms.some((e) => e.kind === "lpsy");
    return {
      date: b.date,
      ...(match ? { candidateAt: match.candidateAt } : {}),
      values: { close: b.close, ma20: mean20[i] ?? null, meanVolume: average },
      entry:
        !!match &&
        !exit &&
        !reduce &&
        profilePass &&
        !externalMissing &&
        targetPlan?.status !== "missing",
      ...(targetPlan ? { targetPlan } : {}),
      ...(profile ? { profile } : {}),
      exit,
      reason:
        reason ??
        externalMissing ??
        (targetPlan?.status === "missing" ? targetPlan.reason : null) ??
        (profile?.status === "missing" ? profile.reason : null),
      decision:
        reason ??
        (exit
          ? "已确认多仓退出"
          : reduce
            ? "LPSY确认减半"
            : match && !profilePass
              ? "日线估算VP无上沿HVN支持，过滤"
              : match
                ? "后续结构确认入场"
                : "等待结构事件"),
      structure,
      events,
      ...(match
        ? {
            ruleStop: {
              price: baseline ? match.facts.support : match.facts.low,
              days: kind === "target" ? 60 : baseline ? 0 : 3,
              reason: "威科夫冻结候选低点",
            },
          }
        : {}),
      ...(reduce
        ? {
            reduction: {
              fraction: 0.5,
              reason: "SOW后LPSY确认，减当时剩余多仓50%",
            },
          }
        : {}),
    };
  });
}

export const structureBarBytes = (bars: readonly Bar[]) =>
  JSON.stringify(
    bars.map((b) => [
      b.date,
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume,
      b.amount,
    ]),
  );
