import { macd } from "./indicators";
import { chanStructureCriterion } from "./research-chan-criteria";
import type { Bar } from "./domain";
import type { CzscFamily, CzscResult } from "./czsc";

export const chanNativeProfiles = {
  "chan-consolidation-weekly-native": [
    "CH05",
    "周线盘整背驰类一买 · 原生A/C",
    5,
  ],
  "chan-wolf-daily-native": ["CH15", "防狼术 · 个股日线MACD零轴/风险仓位", 15],
  "chan-overlap-native": ["CH04", "二三买重合 · 原生关联齐全", 4],
  "chan-hold-cash-native": ["CH14", "持股持币 · 原生买卖点", 14],
  "chan-ma-kiss-native": ["CH16-ma-kiss", "均线首次有效吻 · 日线原生差值", 16],
  "chan-ma-area-native": ["CH17-ma-area", "均线已完成同向面积背驰", 17],
  "chan-ma-average-native": [
    "CH17-ma-average-force",
    "均线即时平均力度衰减",
    18,
  ],
  "chan-first-native": ["CH01", "原生一买 · 趋势背驰证据", 1],
  "chan-second-native": ["CH02", "原生二买 · DLL次级别回调", 2],
  "chan-third-native": ["CH03", "原生三买 · 中枢上首次回试", 3],
} as const;
export type ChanNativeId = keyof typeof chanNativeProfiles;
export const chanNativeIds = Object.keys(chanNativeProfiles) as ChanNativeId[];
export const isChanNative = (id: string): id is ChanNativeId =>
  Object.hasOwn(chanNativeProfiles, id);
export const chanNativeBoundary =
  "复用b67f3c6 DLL原生具名子集，保持配置0/1100、单队列逐完整前缀调用。每根只消费当时新出现的quality=1/2信号，端点日与首次可知确认日分离；预热已有信号不回填。原生kind=1另需semantic=1及flags含新极值(1)/背驰确认(16)、所属中枢存在且端点低于ZD；kind=2仅选原生二买，原生规则为一买后的第二段回调不低于一买低点；kind=3另验所属中枢ZG之上，严格大于，首次回试由原生算法负责。中枢归属来自output25，禁止最近中枢推测。缺少元数据或归属无效报结构缺口，不补造信号。固定持有期及既有可选风控，确认后下一合法开盘，T+1及成交限制保持；不实现裸卖空。这三个预设是锁定DLL的具体规则变体，不宣称原文递归级别、二三买重合、区间套或完整体系覆盖；固定输入不是盈利证据。";
export const chanMethodBoundary =
  "CH05：只消费连续完整周线全前缀DLL semantic=2、A/C端点与中枢关联；最多104周固定起点，超过窗口明确不可用，不把日线信号改名周线。缺输入中断后重新建立观察基线，旧信号不回填。CH15：个股日线最低周期工程版MACD12/26/9，双线均>0才买、均<0收盘确认退出，等于0观望；非30/60分钟或全市场过滤，风险1%/单股20%、5%止损复用资金执行器。CH04要求原生二/三类上下文位同时成立、两套端点齐全及中枢归属，不以kind推断重合。CH14只在已有多仓消费镜像核验的一二三卖点，首次确认后次合法开盘卖出，受阻意图保留；无信号保持，最长持有期作为工程尾部保护。CH16使用原生MA差与吻（10/11/13）：正差趋势首次非零有效吻结束且差仍正入场，volumeKiss=4否决；差转负退出。CH17面积版比较已结束两段负差非吻区间的绝对面积，后段面积严格更小且价格新低，结束吻时入场；平均力度版比较当前负差非吻段与上次完整负差段的面积/根数，严格更弱且差绝对值缩短、价格新低入场。面积求和按日线矩形法，吻节点不计面积，非MACD面积或原生output12；均线背驰版负差吻后再现负差缠绕退出。固定周期、收盘确认与持有期均是工程变体，不将首次缠绕称为可预知最后缠绕，不宣称完整原文或实测盈利。";
export const isChanMa = (id: string) => id.startsWith("chan-ma-");
export const chanNativeStrategies = Object.fromEntries(
  chanNativeIds.map((id) => [
    id,
    {
      label: `缠论 · ${chanNativeProfiles[id][1]}`,
      family: "缠论原生结构",
      signal: "czsc" as const,
      version: `${id}-engineering-1`,
      description:
        chanNativeBoundary +
        (chanNativeProfiles[id][2] > 3 ? chanMethodBoundary : ""),
      sources: [
        "chan-theory/SKILL.md",
        ...(chanNativeProfiles[id][2] > 3
          ? [
              "chan-theory/references/01-moving-average.md",
              "chan-theory/references/06-strategy.md",
            ]
          : []),
        "chan-theory/references/05-trading-points.md",
        "chan-theory/references/04-dynamics.md",
      ],
    },
  ]),
) as Record<
  ChanNativeId,
  {
    label: string;
    family: string;
    signal: "czsc";
    version: string;
    description: string;
    sources: string[];
  }
>;

export function chanNativeCandidates(
  id: ChanNativeId,
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
) {
  const family = result.families.find((f) => f.config === config);
  const gaps: string[] = [];
  const signals: CzscFamily["signals"] = [];
  if (result.status !== "structure") return { signals, gaps };
  if (!family) return { signals, gaps: ["结构缺口：缺少指定原生配置输出"] };
  if (id === "chan-consolidation-weekly-native") {
    for (const p of family.signals.filter((s) => s.kind === 1)) {
      const c = chanStructureCriterion(
        "consolidation-divergence",
        result,
        bars,
        config,
        p,
      );
      if (c.status === "matched") {
        const m = p.structure!,
          a = family.points[m.previousStartPointId - 1],
          b = family.points[m.previousEndPointId - 1],
          cStart = family.points[m.currentStartPointId - 1],
          cEnd = family.points[m.currentEndPointId - 1];
        if (
          a?.direction === 1 &&
          b?.direction === -1 &&
          cStart?.direction === 1 &&
          cEnd?.direction === -1
        )
          signals.push(p);
      }
      gaps.push(...c.gaps);
    }
    return { signals, gaps };
  }
  if (id === "chan-overlap-native") {
    for (const p of family.signals.filter((s) => [2, 3].includes(s.kind))) {
      const c = chanStructureCriterion("overlap", result, bars, config, p);
      if (c.status === "matched") signals.push(p);
      gaps.push(...c.gaps);
    }
    return { signals, gaps };
  }
  for (const p of family.signals.filter(
    (s) =>
      (["chan-hold-cash-native", "chan-wolf-daily-native"].includes(id)
        ? [1, 2, 3].includes(Math.abs(s.kind))
        : s.kind === chanNativeProfiles[id][2]) && [1, 2].includes(s.quality),
  )) {
    const bar = bars[p.index];
    const center =
      p.centerId != null && Number.isInteger(p.centerId)
        ? family.centers[p.centerId - 1]
        : undefined;
    if (
      !bar ||
      bar.date !== p.date ||
      !center ||
      !Number.isFinite(center.ZD) ||
      !Number.isFinite(center.ZG) ||
      center.ZD <= 0 ||
      center.ZD > center.ZG ||
      center.end > p.index ||
      center.end < center.start ||
      bars[center.start]?.date !== center.startDate ||
      bars[center.end]?.date !== center.endDate ||
      center.start < 0 ||
      center.end >= bars.length
    ) {
      gaps.push(`${p.date}：结构缺口，缺少有效原生中枢归属或端点`);
      continue;
    }
    if (Math.abs(p.kind) === 1) {
      const d = p.divergence;
      if (!d || !Number.isInteger(d.flags) || !Number.isFinite(d.semantic)) {
        gaps.push(`${p.date}：结构缺口，缺少原生背驰语义/标志`);
        continue;
      }
      if (
        d.semantic !== 1 ||
        (d.flags & 17) !== 17 ||
        (p.kind > 0
          ? Math.fround(bar.low) >= Math.fround(center.ZD)
          : Math.fround(bar.high) <= Math.fround(center.ZG))
      )
        continue;
    }
    if (
      Math.abs(p.kind) === 3 &&
      (p.kind > 0
        ? Math.fround(bar.low) <= Math.fround(center.ZG)
        : Math.fround(bar.high) >= Math.fround(center.ZD))
    )
      continue;
    if (
      id === "chan-wolf-daily-native" &&
      p.kind > 0 &&
      !chanWolfPoint(bars).entryAllowed
    )
      continue;
    signals.push(p);
  }
  return { signals, gaps };
}

export function chanMaMethodPoint(
  id: ChanNativeId,
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
) {
  const rows = result.families.find((f) => f.config === config)?.diagnostics
    ?.ma;
  const missing = (reason: string) => ({
    entry: false,
    exit: false,
    reason,
    evidence: null as unknown,
  });
  if (
    result.status !== "structure" ||
    result.sourceCommit !== "b67f3c6" ||
    !rows ||
    rows.length !== bars.length ||
    rows.some(
      (r, i) =>
        r.index !== i ||
        !Number.isFinite(r.difference) ||
        ![0, 1, 2, 3].includes(r.kiss) ||
        ![0, 1, 2, 3, 4].includes(r.volumeKiss),
    )
  )
    return missing("结构缺口：原生均线差/吻投影不完整");
  if (
    bars.some(
      (b) =>
        ![b.open, b.high, b.low, b.close, b.volume].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close),
    )
  )
    return missing("均线力度日线无效");
  const n = rows.length,
    last = rows[n - 1],
    prev = rows[n - 2];
  if (!last || !prev) return missing("均线力度历史不足");
  const chunks: {
    start: number;
    end: number;
    sign: number;
    area: number;
    low: number;
    closed: boolean;
  }[] = [];
  let chunk: (typeof chunks)[number] | null = null;
  let positiveKisses = 0,
    kissStarted = false;
  for (const r of rows) {
    if (r.difference <= 0) positiveKisses = 0;
    if (r.kiss && !kissStarted && r.difference > 0) positiveKisses++;
    kissStarted = r.kiss !== 0;
    const sign = Math.sign(r.difference);
    if (r.kiss || !sign || (chunk && chunk.sign !== sign)) {
      if (chunk) {
        chunk.closed = true;
        chunks.push(chunk);
        chunk = null;
      }
    }
    if (!r.kiss && sign) {
      if (!chunk)
        chunk = {
          start: r.index,
          end: r.index,
          sign,
          area: 0,
          low: bars[r.index]!.low,
          closed: false,
        };
      chunk.end = r.index;
      chunk.area += Math.abs(r.difference);
      chunk.low = Math.min(chunk.low, bars[r.index]!.low);
    }
  }
  if (chunk) chunks.push(chunk);
  const negative = chunks.filter((c) => c.sign < 0),
    a = negative.at(-2),
    b = negative.at(-1);
  const areaMatch = !!(
    a &&
    b &&
    a.closed &&
    b.closed &&
    b.end === n - 2 &&
    b.area < a.area &&
    b.low < a.low
  );
  const averageMatch = !!(
    a &&
    b &&
    a.closed &&
    !b.closed &&
    b.end === n - 1 &&
    b.end > b.start &&
    b.area / (b.end - b.start + 1) < a.area / (a.end - a.start + 1) &&
    b.low < a.low &&
    Math.abs(last.difference) < Math.abs(prev.difference)
  );
  const effective = prev.volumeKiss !== 4 && last.volumeKiss !== 4;
  const entry =
    effective &&
    (id === "chan-ma-kiss-native"
      ? last.difference > 0 &&
        prev.kiss > 0 &&
        last.kiss === 0 &&
        positiveKisses === 1
      : id === "chan-ma-area-native"
        ? areaMatch
        : averageMatch);
  const exit =
    !entry &&
    (id === "chan-ma-kiss-native"
      ? last.difference < 0 && prev.difference >= 0
      : last.difference < 0 && last.kiss > 0 && prev.kiss === 0);
  return {
    entry,
    exit,
    reason: null,
    evidence: {
      rows,
      chunks,
      positiveKisses,
      areaMatch,
      averageMatch,
      source: "DLL MA10/11/13; rectangle sum",
      boundary: chanMethodBoundary,
    },
  };
}

export function chanWolfPoint(bars: readonly Bar[]) {
  const last = bars.at(-1);
  const valid =
    last &&
    [last.open, last.high, last.low, last.close, last.volume].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    last.high >= Math.max(last.open, last.close) &&
    last.low <= Math.min(last.open, last.close);
  const p = valid ? macd(bars).at(-1) : undefined;
  return {
    entryAllowed: p?.dif != null && p.dea != null && p.dif > 0 && p.dea > 0,
    exit: p?.dif != null && p.dea != null && p.dif < 0 && p.dea < 0,
    values: p ?? null,
    boundary:
      "个股日线最低周期工程版，MACD12/26/9；黄白线均严格>0才准入，均<0收盘确认退出，等于0观望。未冒充30/60分钟或全市场防狼术。固定风险1%/单股20%复用资金执行器。",
  };
}
