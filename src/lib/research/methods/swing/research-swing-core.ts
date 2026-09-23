import type { Bar } from "../../../domain";
import type {
  BreakoutPoint,
  Level,
  TrendLine,
} from "../../../../server/strategies/breakout/breakout";
import { ma } from "../../../indicators";

export const swingCoreProfiles = {
  "sw-double-prior20": ["SW01", "三要素前20日均量", "direct"],
  "sw-double-current20": ["SW01", "三要素含当日20日均量", "current"],
  "sw-double-strength": [
    "SW01-strength-size",
    "四指标强中分级仓位",
    "strength",
  ],
  "sw-weak-retest5": ["SW01-weak-retest", "弱量突破五日内回踩", "weak"],
  "sw-double-retest-next": ["SW02", "充分放量突破次日回踩首仓", "retest"],
  "sw-line-angle-chart": [
    "SW01-line-angle",
    "显式线性图表尺度30至60度",
    "angle-chart",
  ],
  "sw-line-angle-percent": [
    "SW01-line-angle",
    "每根1%归一尺度30至60度实验",
    "angle-percent",
  ],
  "sw-level-swing": ["SW03-swing-level", "波段高低点独立突破", "swing"],
  "sw-level-platform": ["SW03-platform-level", "缩量平台独立突破", "platform"],
  "sw-level-body": ["SW03-large-close-level", "放量长阴压力长阳支撑", "body"],
  "sw-level-round": ["SW03-round-level", "整数阶梯独立突破", "round"],
  "sw-level-average": [
    "SW03-average-level",
    "压力MA60/120支撑MA20/60",
    "average",
  ],
  "sw-level-gap": ["SW03-gap-level", "未回补缺口上下沿", "gap"],
  "sw-level-priority": ["SW03-level-priority", "六来源优先后距离", "priority"],
  "sw-level-distance": [
    "SW03-level-priority",
    "六来源距离优先对照",
    "distance",
  ],
  "sw-level-role-retest": ["SW03", "冻结来源强度支撑压力互换", "role"],
} as const;
export type SwingCoreId = keyof typeof swingCoreProfiles;
export const swingCoreIds = Object.keys(swingCoreProfiles) as SwingCoreId[];
export function isSwingCore(id: string): id is SwingCoreId {
  return Object.hasOwn(swingCoreProfiles, id);
}
export const swingCoreBoundary =
  "工程v1：复用breakout已确认60根结构；三要素前20根均量与含当根20均量分别具名。四辅助票为MACD DIF>DEA、KDJ K>D、RSI6>50、价>BOLL中轨，与五辅助表分开；全已知且3票以上全额、恰2票半额、否则禁入，账本整手后回显实际量。角度分别用当时线性像素/元与像素/根比例，或固定1%初锚价格/根归一实验，闭区间30至60度；无尺度不可用。六价位方向按原文，候选须在前收压力侧/支撑侧且已确认；来源优先顺序波段、平台、大实体收盘、整数、均线、缺口，同源按距离、最近确认、来源名排序；另留距离优先。MA用前日，缺口只在60根内且截至前日未完全回补；需该窗口无公司行动证据，不能用除权假缺口。充分放量回踩只等下一研究交易日；弱量和角色互换等5研究交易日，冻结原线/价位/来源，收盘失守或缺日/非法量价取消；回踩最低触及且收回冻结价、仍站上延长趋势线，弱量另需确认日达到候选日前20均量1.5倍。压力转支撑允许首仓，支撑转压力只退出不做空。退出优先，收盘确认下一合法开盘，最长持有期有效。不是完整市场账户体系或盈利证据。";
export function swingCoreDefinition(id: SwingCoreId) {
  return {
    label: `波段 · ${swingCoreProfiles[id][1]}`,
    family: "波段",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: ["swing-trader/references/trading-system.md"],
    description: swingCoreBoundary,
  };
}
export type SwingCoreEvidence = {
  date: string;
  availableDate: string;
  source: string;
  chart?: { mode: "linear"; pixelsPerPrice: number; pixelsPerBar: number };
  noActions?: { start: string; end: string; complete: boolean };
};
export type SwingLevel = Omit<Level, "source"> & {
  source: Level["source"] | "ma120" | "gap-upper" | "gap-lower";
};
const valid = (b: Bar | undefined): b is Bar =>
  !!b &&
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.high >= Math.max(b.open, b.close) &&
  b.low <= Math.min(b.open, b.close);
const ranks: Record<SwingLevel["source"], number> = {
  "swing-high": 0,
  "swing-low": 0,
  "platform-high": 1,
  "platform-low": 1,
  "volume-bear-close": 2,
  "volume-bull-close": 2,
  round: 3,
  ma20: 4,
  ma60: 4,
  ma120: 4,
  "gap-upper": 5,
  "gap-lower": 5,
};
export function selectSwingLevel(
  levels: readonly SwingLevel[],
  previous: number,
  date: string,
  side: "long" | "short",
  family: string,
  priority = true,
) {
  const sign = side === "long" ? 1 : -1;
  const sources =
    side === "long"
      ? [
          "swing-high",
          "platform-high",
          "volume-bear-close",
          "round",
          "ma60",
          "ma120",
          "gap-upper",
        ]
      : [
          "swing-low",
          "platform-low",
          "volume-bull-close",
          "round",
          "ma20",
          "ma60",
          "gap-lower",
        ];
  const rank = ["swing", "platform", "body", "round", "average", "gap"].indexOf(
    family,
  );
  return (
    levels
      .filter(
        (l) =>
          Number.isFinite(l.price) &&
          l.price > 0 &&
          l.confirmedAt < date &&
          sources.includes(l.source) &&
          (l.price - previous) * sign >= 0 &&
          (rank < 0 || ranks[l.source] === rank),
      )
      .sort(
        (a, b) =>
          (priority ? ranks[a.source] - ranks[b.source] : 0) ||
          (a.price - b.price) * sign ||
          b.index - a.index ||
          a.source.localeCompare(b.source),
      )[0] ?? null
  );
}
export function swingLineAngle(
  line: TrendLine | null,
  scale?: SwingCoreEvidence["chart"],
) {
  if (
    !line ||
    scale?.mode !== "linear" ||
    ![scale.pixelsPerPrice, scale.pixelsPerBar].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    return null;
  return (
    (Math.atan(
      (Math.abs(line.slope) * scale.pixelsPerPrice) / scale.pixelsPerBar,
    ) *
      180) /
    Math.PI
  );
}
export function swingStrengthFraction(point: BreakoutPoint) {
  const votes = Object.values(point.long.indicatorVotes);
  if (votes.some((v) => v === "未知")) return null;
  const count = votes.filter((v) => v === "是").length;
  return count >= 3 ? 1 : count === 2 ? 0.5 : 0;
}
export function swingGapLevels(
  bars: readonly Bar[],
  index: number,
): SwingLevel[] {
  const result: SwingLevel[] = [];
  for (let j = Math.max(1, index - 60); j < index; j++) {
    const a = bars[j - 1]!,
      b = bars[j]!;
    if (!valid(a) || !valid(b)) continue;
    // Both edges retain their actual prices; partial fills do not invent new edges.
    const up = b.low > a.high,
      down = b.high < a.low;
    if (!up && !down) continue;
    const lower = up ? a.high : b.high,
      upper = up ? b.low : a.low;
    if (
      bars
        .slice(j + 1, index)
        .some((v) => !valid(v) || (up ? v.low <= lower : v.high >= upper))
    )
      continue;
    result.push(
      { price: upper, source: "gap-upper", index: j, confirmedAt: b.date },
      { price: lower, source: "gap-lower", index: j, confirmedAt: b.date },
    );
  }
  return result;
}
type Frozen = {
  at: number;
  date: string;
  level: SwingLevel;
  line: TrendLine | null;
  volume: number;
  side: "long" | "short";
};
export function researchSwingCoreSeries(
  id: SwingCoreId,
  bars: readonly Bar[],
  points: readonly BreakoutPoint[],
  calendar: readonly string[] = bars.map((b) => b.date),
  evidence: readonly SwingCoreEvidence[] = [],
) {
  const mode = swingCoreProfiles[id][2],
    average120 = ma(bars, 120);
  let pending: Frozen | null = null;
  return bars.map((bar, i) => {
    const point = points[i]!,
      previous = bars[i - 1],
      ci = calendar.indexOf(bar.date);
    const rows = evidence.filter((e) => e.date === bar.date);
    const e =
      rows.length === 1 &&
      rows[0]!.source.trim() &&
      /^\d{4}-\d{2}-\d{2}$/.test(rows[0]!.availableDate) &&
      rows[0]!.availableDate <= bar.date
        ? rows[0]
        : undefined;
    let reason: string | null =
      !valid(bar) || !valid(previous) || point.missing.length || ci < 0
        ? "结构/相邻量价不可用"
        : null;
    let entry = false,
      exit = false,
      entryFraction = 1;
    let angle: number | null = null;
    const levelMode = [
      "swing",
      "platform",
      "body",
      "round",
      "average",
      "gap",
      "priority",
      "distance",
      "role",
    ].includes(mode);
    const allSources = ["priority", "distance", "role"].includes(mode);
    const needsGap = mode === "gap" || allSources;
    const proof = e?.noActions;
    if (
      !reason &&
      needsGap &&
      (!proof?.complete ||
        !/^\d{4}-\d{2}-\d{2}$/.test(proof.start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(proof.end) ||
        proof.start > proof.end ||
        proof.start > bars[Math.max(0, i - 61)]!.date ||
        proof.end < bar.date)
    )
      reason = "待数据：缺口窗口无公司行动证明start/end/complete及来源可得日";
    const levels: SwingLevel[] = [...point.levels];
    const m = average120[i - 1];
    if (m != null && previous)
      levels.push({
        price: m,
        source: "ma120",
        index: i - 1,
        confirmedAt: previous.date,
      });
    if (needsGap && !reason) levels.push(...swingGapLevels(bars, i));
    if (!reason && mode === "average" && m == null) reason = "MA120历史不足";
    const longLevel = previous
      ? selectSwingLevel(
          levels,
          previous.close,
          bar.date,
          "long",
          mode,
          mode !== "distance",
        )
      : null;
    const shortLevel = previous
      ? selectSwingLevel(
          levels,
          previous.close,
          bar.date,
          "short",
          mode,
          mode !== "distance",
        )
      : null;
    const trend = point.long.checks.trend === "是";
    const level = point.long.checks.level === "是";
    const volume = point.long.checks.volume === "是";
    if (!reason) {
      exit = levelMode
        ? !!shortLevel && bar.close < bar.open && bar.close < shortLevel.price
        : point.short.checks.trend === "是";
      if (levelMode)
        entry =
          !!longLevel &&
          bar.close > bar.open &&
          bar.close > longLevel.price &&
          volume;
      else entry = trend && level && volume;
      if (mode === "current") {
        const mean = bars
          .slice(i - 19, i + 1)
          .reduce((s, b) => s + b.volume / 20, 0);
        entry =
          trend && level && i >= 19 && mean > 0 && bar.volume >= 1.5 * mean;
      }
      if (mode === "strength") {
        const fraction = swingStrengthFraction(point);
        if (fraction === null) reason = "四辅助指标未全可用";
        entryFraction = fraction ?? 0;
        entry = entry && entryFraction > 0;
      }
      if (mode === "angle-chart" || mode === "angle-percent") {
        const line = point.long.line;
        angle = swingLineAngle(
          line,
          mode === "angle-chart"
            ? e?.chart
            : line
              ? {
                  mode: "linear",
                  pixelsPerBar: 1,
                  pixelsPerPrice: 100 / line.anchors[0].price,
                }
              : undefined,
        );
        if (angle === null)
          reason =
            "待数据：已确认趋势线及当时线性图表pixelsPerPrice/pixelsPerBar";
        entry =
          entry && angle !== null && angle >= 30 - 1e-12 && angle <= 60 + 1e-12;
      }
    }
    let frozen: Frozen | null = pending;
    let state = "none";
    if (mode === "weak" || mode === "retest" || mode === "role") {
      entry = false;
      if (pending) {
        const age = ci - pending.at,
          sign = pending.side === "long" ? 1 : -1;
        const projected = pending.line
          ? pending.line.anchors[0].price +
            pending.line.slope * (i - pending.line.anchors[0].index)
          : pending.level.price;
        const nextExpected = calendar[ci - 1];
        if (
          reason ||
          previous?.date !== nextExpected ||
          age < 1 ||
          age > (mode === "retest" ? 1 : 5) ||
          (bar.close - pending.level.price) * sign < 0 ||
          (bar.close - projected) * sign < 0
        ) {
          pending = null;
          state = "cancelled";
        } else if (
          (pending.side === "long"
            ? bar.low <= pending.level.price
            : bar.high >= pending.level.price) &&
          (bar.close - pending.level.price) * sign >= 0 &&
          (mode !== "weak" || bar.volume >= 1.5 * pending.volume)
        ) {
          entry = pending.side === "long";
          exit = exit || pending.side === "short";
          pending = null;
          state = "confirmed";
        } else state = "waiting";
      }
      if (!pending && state === "none" && !reason) {
        const side = mode === "role" && exit ? "short" : "long";
        const selected =
          mode === "role"
            ? side === "long"
              ? longLevel
              : shortLevel
            : point.long.keyLevel;
        const candidate =
          mode === "role"
            ? !!selected &&
              volume &&
              (side === "long"
                ? bar.close > bar.open && bar.close > selected.price
                : bar.close < bar.open && bar.close < selected.price)
            : trend &&
              level &&
              (mode === "weak" ? point.long.checks.volume === "否" : volume);
        if (
          candidate &&
          selected &&
          point.volume20 !== null &&
          point.volume20 > 0
        ) {
          pending = {
            at: ci,
            date: bar.date,
            level: { ...selected },
            line: mode === "role" ? null : structuredClone(point.long.line),
            volume: point.volume20,
            side,
          };
          frozen = pending;
          state = "candidate";
        }
      }
      if (mode === "role" && state !== "confirmed") exit = false;
    }
    if (reason) entry = false;
    return {
      date: bar.date,
      entry: entry && !exit,
      exit: !reason && exit,
      reason,
      entryFraction,
      values: { close: bar.close },
      historyStart: bars[0]!.date,
      swing: {
        mode,
        angle,
        longLevel,
        shortLevel,
        frozen,
        state,
        sourceRank: frozen ? ranks[frozen.level.source] : null,
      },
    };
  });
}
