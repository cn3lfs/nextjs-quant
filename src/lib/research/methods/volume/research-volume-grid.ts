import type { Bar } from "../../../domain";
import { confirmedExtrema, ma, volumeMa } from "../../../indicators";
import type { VolumePoint, VolumeValues } from "./research-volume";

// Source names are deliberately not multiplied by all possible locations.
// Waiting cells are components of the grid, not permanently silent strategies.
export const volumeGridProfiles = {
  "vp-grid": ["九宫格完整路由", "grid", "all"],
  "vp-grid-up-expanded": ["价涨量增位置路由", "grid", "up-expanded"],
  "vp-grid-up-normal": ["价涨量平后续路由", "grid", "up-normal"],
  "vp-grid-up-contracted": ["价涨量缩位置路由", "grid", "up-contracted"],
  "vp-grid-flat-expanded": ["横盘放量双向选择", "grid", "flat-expanded"],
  "vp-grid-flat-contracted": ["横盘缩量双向选择", "grid", "flat-contracted"],
  "vp-grid-down-expanded": ["放量下跌位置路由", "grid", "down-expanded"],
  "vp-grid-down-contracted": ["缩量回调需求确认", "grid", "down-contracted"],
  "vp-extreme-main": ["天量形态退出 · 主文R2", "huge", "2"],
  "vp-extreme-detail": ["天量形态退出 · 附件R2.5", "huge", "2.5"],
  "vp-extreme-history": ["天量形态退出 · 可得全历史新高量", "huge", "history"],
  "vp-dry-turnover-and": ["地量三阶段 · AND加历史低换手", "dry", "and"],
  "vp-dry-turnover-or": ["地量三阶段 · OR加历史低换手", "dry", "or"],
  "vp-controlled-turnover": ["低换手三根小阳守MA5", "turnover", "controlled"],
  "vp-turnover-bands": ["突破加五档换手过滤", "turnover", "bands"],
  "vp-turnover-location": ["剧烈换手底部高位分流", "turnover", "location"],
  "vp-multiday-grid": ["多日量形与九宫格确认", "multi", "all"],
  "vp-wash-1": ["洗盘价量关键位 · 一根收复", "wash", "1"],
  "vp-wash-2": ["洗盘价量关键位 · 两根收复", "wash", "2"],
  "vp-wash-3": ["洗盘价量关键位 · 三根收复", "wash", "3"],
} as const;
export type VolumeGridId = keyof typeof volumeGridProfiles;
export const volumeGridIds = Object.keys(volumeGridProfiles) as VolumeGridId[];
export function isVolumeGrid(id: string): id is VolumeGridId {
  return Object.hasOwn(volumeGridProfiles, id);
}
export function volumeGridDefinition(id: VolumeGridId) {
  const row = volumeGridProfiles[id];
  return {
    label: `量价 · ${row[0]}`,
    family: "量价",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    description: `工程定义v1：${row[0]}。${row[1]}/${row[2]}；九宫格采用含当日VMA5及主板±2%/±1%阈值。位置用前一日已确认3/3枢轴与20/60均线；底部需20%回落、均线粘合走平及10根缩量，高位需50%涨幅、10%乖离与3根滞涨。底部突破R≥2，其他突破R≥1.5；缩量反弹须1.2≤R<2.5突破。横盘候选10根未选择方向转区间，冻结边界再等10根；恐慌需2根缩量守底再放量收复。高位和下跌受阻退出，未知位置持仓从严；日线价量版本不证明主力意图。天量长上影≥全幅一半、光头阴线或收盘位于全幅下半区直接退出；次根缩量及10根内缩量二顶退出，连续两根放量新高取消天量候选。地量AND/OR各保留，20根内温和量再突破且历史换手<1%；控盘需3根0至2%小阳、守MA5且换手<2%。换手五档为<1/[1,3)/[3,7)/[7,15]/>15，过滤保留[1,15]，>15底部突破与高位退出分流。洗盘跌幅≤5%、非阶段天量并守MA20/60/已知前低；1/2/3根内缩量企稳再收复，否则退出。多日采用3根温和递增、3根递减、三脉冲隔2根、孤量次根确认、3根滞涨与前高缩量背离。所有候选破底/异常取消，下一可成交开盘，确认低点3根守卫及最长持有期。历史流通股本须逐日时点证明，缺失返回待数据；涨跌停、除权、停复牌、ETF申赎分别记录，已知异常不进正常量档，未知不当已排除。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
    ],
  };
}

export type VolumeDayEvidence = {
  date: string;
  availableDate: string;
  /** Optional B6a timestamp; it must describe the event/effective day, not capture time. */
  availableAt?: string;
  source: string;
  // Volume units are explicit; float is valid for this date only, never forward-filled.
  floatShares?: number;
  volumeUnit?: "share" | "lot100";
  limit?: boolean | null;
  corporateAction?: boolean | null;
  suspension?: boolean | null;
  resumption?: boolean | null;
  etfFlow?: boolean | null;
};
export type VolumeEvidence = Readonly<Record<string, VolumeDayEvidence>>;
export type GridLocation =
  "bottom" | "up" | "high" | "down" | "range" | "unknown";
export type PositionFacts = {
  higher: boolean;
  lower: boolean;
  touches: boolean;
  holds: boolean;
  ma20: number | null;
  ma60: number | null;
  ma20Prior5: number | null;
  close: number;
  rise: number | null;
  drop: number | null;
  bias: number | null;
  stall: boolean;
  contracted10: boolean;
};
export function volumeGridPosition(f: PositionFacts): GridLocation {
  if (f.ma20 == null || f.ma60 == null || f.ma20Prior5 == null)
    return "unknown";
  if (
    f.rise != null &&
    f.rise >= 0.5 &&
    f.bias != null &&
    f.bias >= 0.1 &&
    f.stall
  )
    return "high";
  if (
    f.drop != null &&
    f.drop >= 0.2 &&
    f.touches &&
    f.contracted10 &&
    Math.abs(f.ma20 / f.ma60 - 1) <= 0.03 &&
    Math.abs(f.ma20 / f.ma20Prior5 - 1) <= 0.01
  )
    return "bottom";
  if (f.higher && f.holds && f.ma20 > f.ma60 && f.close >= f.ma20) return "up";
  if (f.lower && f.ma20 < f.ma60 && f.close < f.ma20) return "down";
  if (f.touches) return "range";
  return "unknown";
}
export function volumeTurnoverBand(rate: number | null) {
  if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
  return rate < 1
    ? "cold"
    : rate < 3
      ? "normal"
      : rate < 7
        ? "active"
        : rate <= 15
          ? "very-active"
          : "extreme";
}
function evidenceAt(bar: Bar, evidence: VolumeEvidence) {
  const item = evidence[bar.date];
  return item &&
    item.date === bar.date &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.availableDate) &&
    item.availableDate <= bar.date &&
    (item.availableAt === undefined ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(
        item.availableAt,
      )) &&
    (item.availableAt === undefined ||
      item.availableAt.slice(0, 10) >= item.availableDate) &&
    typeof item.source === "string" &&
    item.source.trim()
    ? item
    : undefined;
}
export function volumeDayStatus(bar: Bar, evidence: VolumeEvidence = {}) {
  const e = evidenceAt(bar, evidence);
  const finiteFloat =
    e?.floatShares != null &&
    Number.isFinite(e.floatShares) &&
    e.floatShares > 0;
  const turnover =
    finiteFloat &&
    (e?.volumeUnit === "share" || e?.volumeUnit === "lot100") &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0
      ? ((bar.volume * (e.volumeUnit === "lot100" ? 100 : 1)) /
          e.floatShares!) *
        100
      : null;
  const anomalies = {
    limit: bar.high === bar.low ? true : (e?.limit ?? null),
    corporateAction: e?.corporateAction ?? null,
    suspension: bar.volume === 0 ? true : (e?.suspension ?? null),
    resumption: e?.resumption ?? null,
    etfFlow: e?.etfFlow ?? null,
  };
  return {
    turnover,
    turnoverBand: volumeTurnoverBand(turnover),
    anomalies,
    abnormal: Object.values(anomalies).some((v) => v === true),
    unverified: Object.entries(anomalies)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  } as const;
}

export type GridFacts = {
  location: GridLocation;
  support: number | null;
  resistance: number | null;
  position: PositionFacts;
  ma5: number | null;
  turnover: number | null;
  turnoverBand: ReturnType<typeof volumeTurnoverBand>;
  anomalies: ReturnType<typeof volumeDayStatus>["anomalies"];
  unverified: string[];
  abnormal: boolean;
  highVolume60: number | null;
  lowVolume60: number | null;
  highVolumeHistory: number | null;
  historicalStart: string | null;
  controlled: boolean | null;
  dryTurnover: boolean | null;
  stack: boolean;
  decreasing: boolean;
  pulses: boolean;
  isolated: boolean;
  stall: boolean;
  lowVolumeHigh: boolean;
  shapeRisk: boolean;
};
export type GridPoint = VolumePoint & {
  gridFacts: GridFacts;
  gridState: GridState | null;
};
export type GridState = {
  kind:
    | "break"
    | "contract"
    | "normal"
    | "demand"
    | "panic"
    | "range"
    | "dry"
    | "huge"
    | "wash"
    | "isolated";
  index: number;
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
  location: GridLocation;
  count: number;
  phase: number;
  wait: number;
};

// This builder is shared by all rows; base is calculated once by research-volume.
export function volumeGridFacts(
  bars: readonly Bar[],
  base: readonly VolumePoint[],
  evidence: VolumeEvidence = {},
): GridFacts[] {
  const m5 = ma(bars, 5),
    m20 = ma(bars, 20);
  const clean = bars.map((b) =>
    volumeDayStatus(b, evidence).abnormal ? { ...b, volume: NaN } : b,
  );
  const v20 = volumeMa(clean, 20);
  const statuses = bars.map((b) => volumeDayStatus(b, evidence));
  const extrema = confirmedExtrema(clean);
  return bars.map((b, i) => {
    const v = base[i]!.values;
    const prior = bars.slice(Math.max(0, i - 60), i);
    const barrier = [
      ...extrema.ambiguousIndices
        .filter((index) => index + 3 < i)
        .map((index) => bars[index]!.date),
      ...bars
        .slice(0, i)
        .filter((x, j) => statuses[j]!.abnormal || base[j]!.reason !== null)
        .map((x) => x.date),
    ]
      .sort()
      .at(-1);
    const four = extrema.extrema
      .filter(
        (p) =>
          p.confirmedAt < b.date &&
          p.index >= i - 60 &&
          (!barrier || bars[p.index - 3]!.date > barrier),
      )
      .slice(-4);
    const highs = four.filter((p) => p.kind === "high"),
      lows = four.filter((p) => p.kind === "low");
    const alternating =
      four.length === 4 &&
      four.every((p, k) => k === 0 || p.kind !== four[k - 1]!.kind);
    const resistance = alternating
      ? Math.max(...highs.map((p) => p.price))
      : null;
    const support = alternating ? Math.min(...lows.map((p) => p.price)) : null;
    const touches =
      alternating &&
      highs.length === 2 &&
      lows.length === 2 &&
      Math.abs(highs[1]!.price / highs[0]!.price - 1) <= 0.01 &&
      Math.abs(lows[1]!.price / lows[0]!.price - 1) <= 0.01 &&
      resistance! / support! - 1 <= 0.2;
    const last = base.slice(Math.max(0, i - 2), i + 1);
    const last10 = base.slice(Math.max(0, i - 9), i + 1);
    const valid = (p: VolumePoint) =>
      p.reason === null &&
      !statuses[bars.findIndex((x) => x.date === p.date)]!.abnormal;
    const priorClean =
      prior.length === 60 &&
      prior.every(
        (x) =>
          Number.isFinite(x.volume) &&
          x.volume > 0 &&
          !volumeDayStatus(x, evidence).abnormal,
      );
    const position: PositionFacts = {
      higher:
        alternating &&
        highs[1]!.price > highs[0]!.price &&
        lows[1]!.price > lows[0]!.price,
      lower:
        alternating &&
        highs[1]!.price < highs[0]!.price &&
        lows[1]!.price < lows[0]!.price &&
        b.close < highs[1]!.price,
      touches,
      holds:
        alternating &&
        lows.every((p) => m20[p.index] != null && p.price >= m20[p.index]!),
      ma20: v.ma20,
      ma60: v.ma60,
      ma20Prior5: m20[i - 5] ?? null,
      close: b.close,
      rise: v.riseFromLow60,
      drop: v.dropFromHigh60,
      bias: v.ma20 ? b.close / v.ma20 - 1 : null,
      stall:
        last.length === 3 &&
        last.every(valid) &&
        last.every((p) => Math.abs(p.values.change ?? Infinity) <= 0.01),
      contracted10:
        last10.length === 10 &&
        last10.every(valid) &&
        last10.every(
          (p, k) => v20[i - 9 + k] != null && p.values.volume < v20[i - 9 + k]!,
        ),
    };
    const knownRates = statuses
      .slice(Math.max(0, i - 59), i + 1)
      .map((x) => x.turnover);
    const previousHigh = prior.reduce<Bar | null>(
      (best, x) => (!best || x.high >= best.high ? x : best),
      null,
    );
    const window7 = base.slice(Math.max(0, i - 6), i + 1);
    const rates3 = statuses.slice(Math.max(0, i - 2), i + 1);
    const allHistory = bars.slice(0, i);
    return {
      ...statuses[i]!,
      location: volumeGridPosition(position),
      position,
      support,
      resistance,
      ma5: m5[i] ?? null,
      highVolume60: priorClean ? Math.max(...prior.map((x) => x.volume)) : null,
      lowVolume60: priorClean ? Math.min(...prior.map((x) => x.volume)) : null,
      highVolumeHistory:
        allHistory.length >= 60 &&
        allHistory.every(
          (x) =>
            x.volume > 0 &&
            Number.isFinite(x.volume) &&
            !volumeDayStatus(x, evidence).abnormal,
        )
          ? Math.max(...allHistory.map((x) => x.volume))
          : null,
      historicalStart: bars[0]?.date ?? null,
      controlled:
        rates3.length < 3 || rates3.some((x) => x.turnover == null)
          ? null
          : last.length === 3 &&
            last.every(valid) &&
            last.every(
              (p, k) =>
                p.values.close > p.values.open &&
                p.values.close / p.values.open - 1 <= 0.02 &&
                p.values.low >= (m5[i - 2 + k] ?? Infinity) &&
                rates3[k]!.turnover! < 2,
            ),
      dryTurnover:
        knownRates.length !== 60 || knownRates.some((x) => x == null)
          ? null
          : knownRates.at(-1)! < 1 &&
            knownRates.at(-1)! <=
              Math.min(...(knownRates.slice(0, -1) as number[])),
      stack:
        last.length === 3 &&
        last.every(valid) &&
        last.every(
          (p, k) =>
            p.values.ratio5! >= 1.2 &&
            p.values.ratio5! < 1.5 &&
            (k === 0 ||
              (p.values.volume > last[k - 1]!.values.volume &&
                p.values.close >= last[k - 1]!.values.close)),
        ),
      decreasing:
        last.length === 3 &&
        last.every(valid) &&
        last.every(
          (p, k) => k === 0 || p.values.volume < last[k - 1]!.values.volume,
        ) &&
        Math.max(...last.map((p) => p.values.high)) /
          Math.min(...last.map((p) => p.values.low)) -
          1 <=
          0.05,
      pulses:
        window7.length === 7 &&
        window7.every(valid) &&
        window7.every((p, k) =>
          k % 3 === 0 ? p.values.ratio5! >= 1.5 : p.values.ratio5! < 0.8,
        ),
      isolated:
        i >= 3 &&
        v.ratio5 != null &&
        v.ratio5 >= 2.5 &&
        base.slice(i - 3, i).every((p) => valid(p) && p.values.ratio5! < 0.8),
      stall:
        last.length === 3 &&
        last.every(valid) &&
        last.every(
          (p, k) =>
            p.values.change! > 0 &&
            (k === 0 ||
              (p.values.volume > last[k - 1]!.values.volume &&
                p.values.change! < last[k - 1]!.values.change!)),
        ) &&
        priorClean &&
        b.volume > Math.max(...prior.map((x) => x.volume)),
      lowVolumeHigh:
        priorClean &&
        previousHigh != null &&
        b.high > previousHigh.high &&
        b.volume < previousHigh.volume,
      shapeRisk:
        b.high - Math.max(b.open, b.close) >= (b.high - b.low) / 2 ||
        (b.close < b.open && b.open === b.high) ||
        b.close <= (b.high + b.low) / 2,
    };
  });
}

export const volumeGridCells = {
  "up-expanded": "break",
  "up-normal": "normal",
  "up-contracted": "contract",
  "flat-expanded": "range",
  "flat-normal": "wait",
  "flat-contracted": "range",
  "down-expanded": "panic",
  "down-normal": "wait",
  "down-contracted": "demand",
} as const;

export function evaluateVolumeGrid(
  id: VolumeGridId,
  base: readonly VolumePoint[],
  facts: readonly GridFacts[],
): GridPoint[] {
  const [, mode, selection] = volumeGridProfiles[id];
  let state: GridState | null = null;
  let previousEntry = false;
  return base.map((point, i) => {
    const v = point.values,
      f = facts[i]!,
      p = base[i - 1]?.values;
    let entry = false,
      exit = false,
      reason = point.reason,
      decision = "等待量价确认";
    const r = v.ratio5 ?? 0;
    const eligible = ["up", "bottom", "range"].includes(f.location);
    const make = (
      kind: GridState["kind"],
      wait: number,
      high = f.resistance ?? v.high,
      low = f.support ?? v.low,
    ): GridState => ({
      kind,
      index: i,
      date: point.date,
      high,
      low,
      close: v.close,
      volume: v.volume,
      location: f.location,
      count: 0,
      phase: 0,
      wait,
    });
    const breakthrough =
      eligible &&
      f.resistance != null &&
      v.close > f.resistance &&
      r >= (f.location === "bottom" ? 2 : 1.5);
    if (f.abnormal)
      reason = `异常量能独立处理：${Object.entries(f.anomalies)
        .filter(([, x]) => x)
        .map(([k]) => k)
        .join("、")}`;
    if (
      mode === "turnover" &&
      (f.turnover == null ||
        (selection === "controlled" && f.controlled == null))
    )
      reason = `待数据：${point.date}缺同日可知流通股本、成交量单位${selection === "controlled" ? "及连续3日换手" : ""}`;
    if (mode === "dry" && f.dryTurnover == null)
      reason = `待数据：截至${point.date}连续60根历史流通股本/成交量单位不可用`;
    if (
      mode === "huge" &&
      selection === "history" &&
      f.highVolumeHistory == null
    )
      reason = `待数据：${f.historicalStart ?? "输入起点"}至${point.date}的可得全历史量不足60根或含不可比较记录`;
    if (reason) {
      state = null;
      previousEntry = false;
      return {
        ...point,
        entry: false,
        exit: false,
        reason,
        decision: reason,
        candidate: null,
        ruleStop: undefined,
        gridFacts: f,
        gridState: null,
      };
    }
    if (f.location === "unknown") {
      exit = true;
      decision = "位置不明：不开仓，已有持仓从严退出";
    }
    if (
      p &&
      v.ma20 != null &&
      p.ma20 != null &&
      v.close < v.ma20 &&
      p.close >= p.ma20
    )
      exit = true;
    const cell =
      v.grid && v.grid.price !== "grey"
        ? (`${v.grid.price}-${v.grid.volume}` as keyof typeof volumeGridCells)
        : null;
    const selected = selection === "all" || selection === cell;
    let captured: GridState | null = state ? { ...state } : null;
    if (state && mode !== "huge") {
      const age = i - state.index;
      if (
        state.kind === "break" &&
        ((age <= 3 && v.close < state.high) ||
          (age === 1 &&
            v.volume > state.volume &&
            (v.close < v.open || f.shapeRisk)))
      ) {
        exit = true;
        decision = "突破后1至3根失守/次根更大量阴线或长上影";
      }
      if (age > state.wait || v.low < state.low || exit) {
        if (state.kind === "wash") exit = true;
        decision = "候选过期/破底/位置失效";
        state = null;
      } else if (state.kind === "normal") {
        // Only the next bar chooses the route. It never invents a normal-volume buy.
        if (v.grid?.volume === "contracted") {
          state = {
            ...state,
            kind: "contract",
            index: i,
            high: Math.max(state.high, v.high),
            low: Math.max(state.low, v.low),
            wait: 5,
          };
          decision = "量平转缩量：进入缩量确认路线";
        } else {
          entry =
            v.grid?.price === "up" &&
            r >= 1.5 &&
            v.close > state.high &&
            eligible;
          state = null;
        }
      } else if (state.kind === "huge") {
        /* handled below */
      } else if (state.kind === "panic") {
        if (age <= 2) {
          if (r < 0.8) state.count++;
          else state = null;
        } else entry = state.count === 2 && r >= 1.5 && v.close > state.high;
      } else if (state.kind === "dry") {
        if (state.phase === 0 && r >= 1.2 && r < 1.5) state.phase = 1;
        else if (state.phase === 1)
          entry = r >= 1.5 && v.close > state.high && eligible;
      } else if (state.kind === "wash") {
        if (r < 0.8 && v.close >= state.close) state.phase = 1;
        entry = state.phase === 1 && v.close > state.high;
        if (!entry && age >= state.wait) {
          exit = true;
          decision = "洗盘未按期限收复，或弱反抽不过前高";
          state = null;
        }
      } else if (state.kind === "break") {
        // Retest and >=VMA5 cannot both be R<.8. Shrink relative to breakout volume.
        entry =
          eligible &&
          v.low >= state.high &&
          v.low <= state.high * 1.005 &&
          v.volume < state.volume &&
          r >= 1 &&
          v.close >= state.high;
        if (
          age === 1 &&
          v.volume > state.volume &&
          (v.close < v.open || f.shapeRisk)
        ) {
          exit = true;
          state = null;
        }
      } else if (state.kind === "range") {
        if (r >= 1.5 && v.close < state.low) {
          exit = true;
          state = null;
        } else
          entry =
            eligible &&
            r >= (state.location === "bottom" ? 2 : 1.5) &&
            v.close > state.high;
        if (state && age === 10 && state.phase === 0 && !entry) {
          state = { ...state, kind: "range", index: i, wait: 10, phase: 1 };
          decision = "两周未选方向：转冻结上下沿区间，续等10根";
        }
      } else if (state.kind === "isolated") {
        entry = r >= 1.5 && v.close >= state.close && eligible;
        if (!entry) {
          state = null;
          decision = "孤量缺次根量能延续";
        }
      } else {
        entry =
          eligible &&
          v.close > state.high &&
          v.close > v.open &&
          r >= (state.kind === "contract" ? 1.2 : 1.5) &&
          (state.kind !== "contract" || r < 2.5);
      }
      if (entry && state) {
        captured = { ...state };
        state = null;
        decision = "候选后确认";
      }
    }
    if (mode === "huge") {
      entry = breakthrough;
      const huge =
        selection === "history"
          ? f.highVolumeHistory != null && v.volume > f.highVolumeHistory
          : r >= Number(selection) ||
            (f.highVolume60 != null && v.volume > f.highVolume60);
      if (state) {
        const age = i - state.index;
        if (r >= 1.5 && v.high > state.high) {
          state.count++;
          state.high = v.high;
        } else state.count = 0;
        if (state.count >= 2 || age > 10) {
          state = null;
          decision = "持续放量新高证伪天量顶部，或候选过期";
        } else if (
          r < 0.8 &&
          ((age === 1 && v.high <= state.high) ||
            (v.high > state.high && v.volume < state.volume))
        ) {
          exit = true;
          state = null;
          decision = "天量次根缩量不创新高/缩量二顶";
        }
      }
      if (
        !state &&
        f.location === "high" &&
        huge &&
        v.high >= (v.high20Prior ?? Infinity)
      ) {
        state = make("huge", 10, v.high, v.low);
        captured = { ...state };
        if (f.shapeRisk) {
          exit = true;
          decision = "天量长上影/光头阴线/冲高回落，形态优先";
        }
      }
    } else if (mode === "turnover") {
      entry =
        selection === "controlled"
          ? f.location === "up" && f.controlled === true
          : selection === "bands"
            ? breakthrough && f.turnover! >= 1 && f.turnover! <= 15
            : breakthrough && f.location === "bottom" && f.turnover! > 15;
      if (
        (selection === "location" || selection === "bands") &&
        f.location === "high" &&
        f.turnover! > 15
      )
        exit = true;
      decision = entry
        ? "历史时点换手与价格确认"
        : exit
          ? "高位剧烈换手退出"
          : "换手过滤未确认";
    } else if (mode === "dry") {
      if (
        !state &&
        !entry &&
        f.location === "bottom" &&
        f.dryTurnover === true &&
        f.lowVolume60 != null &&
        (selection === "and"
          ? r < 0.5 && v.volume < f.lowVolume60
          : r < 0.5 || v.volume < f.lowVolume60)
      ) {
        state = make("dry", 20);
        captured = { ...state };
        decision = "地量与历史低换手，等待温和量再突破";
      }
    } else if (mode === "wash") {
      if (
        !state &&
        !entry &&
        ["up", "high"].includes(f.location) &&
        cell === "down-expanded"
      ) {
        const holds =
          f.support != null &&
          v.low >= f.support &&
          v.low >= Math.max(v.ma20 ?? Infinity, v.ma60 ?? Infinity);
        const controlled =
          v.change != null &&
          v.change >= -0.05 &&
          r < 2.5 &&
          f.highVolume60 != null &&
          v.volume < f.highVolume60;
        if (holds && controlled) {
          state = make("wash", Number(selection), p?.high ?? v.high, v.low);
          captured = { ...state };
          decision = "价量/关键位偏洗盘，等待缩量企稳与收复";
        } else {
          exit = true;
          decision = "巨量长阴/关键位破坏，偏出货退出";
        }
      }
    } else {
      if (mode === "multi") {
        if (f.stall || f.lowVolumeHigh) {
          exit = true;
          decision = "滞涨或前高量背离退出";
        }
        entry =
          entry ||
          (f.stack && f.location === "up") ||
          (f.pulses && breakthrough);
        if (!state && !entry && f.decreasing && eligible) {
          state = make("range", 10);
          captured = { ...state };
        }
        if (f.isolated && breakthrough) {
          entry = false;
          state = make("isolated", 1);
          captured = { ...state };
        }
      }
      if (mode === "grid" && cell && selected && !state && !entry && !exit) {
        const action = volumeGridCells[cell];
        if (action === "wait") decision = "无信息/过渡形态：等待下一根量能方向";
        else if (f.location === "high") {
          exit = true;
          decision = "高位背离/加速先按派发风险，退出不追高";
        } else if (f.location === "down" && action !== "panic") {
          exit = v.close <= (f.resistance ?? Infinity);
          decision = "下跌反抽未收复前高：受阻退出";
          if (!exit && r >= 1.5) {
            state = make("break", 5);
            captured = { ...state };
          }
        } else if (action === "panic") {
          if (
            f.location === "bottom" &&
            r >= 2.5 &&
            Math.min(v.open, v.close) - v.low >= (v.high - v.low) / 2 &&
            v.close >= (v.high + v.low) / 2
          ) {
            state = make("panic", 10, v.high, v.low);
            captured = { ...state };
          } else {
            exit = true;
            decision = "放量下跌未满足恐慌回收：加速/派发风险";
          }
        } else if (eligible) {
          if (action === "break" && breakthrough) {
            state = make(
              "break",
              5,
              f.resistance!,
              Math.min(v.low, f.resistance!),
            );
            captured = { ...state };
          } else if (action !== "break") {
            state = make(
              action,
              action === "normal" ? 1 : action === "range" ? 10 : 5,
            );
            captured = { ...state };
          }
        }
      }
    }
    // Explicit lower-bound breakout must exit even if intraday low already cancelled the candidate.
    if (captured?.kind === "range" && v.close < captured.low && r >= 1.5) {
      exit = true;
      decision = "放量跌破冻结区间下沿";
    }
    if (exit) {
      entry = false;
      state = null;
    }
    const triggered = entry && !previousEntry;
    previousEntry = entry;
    return {
      ...point,
      entry: triggered,
      exit,
      reason: null,
      decision,
      candidate: null,
      ruleStop: triggered
        ? {
            price: captured?.low ?? f.support ?? v.low,
            days: 3,
            reason: "量价工程确认低点",
          }
        : undefined,
      gridFacts: f,
      gridState: state ? { ...state } : null,
    };
  });
}
