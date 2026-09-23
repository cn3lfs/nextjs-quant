import type { Bar } from "../../../domain";
import { obv } from "../../../indicators";
import { pivotDivergenceSeries } from "../../technical/research-pivot-divergence";
import type {
  researchVolumeSeries as VolumeSeries,
  VolumePoint,
} from "./research-volume";
import {
  volumeGridFacts,
  volumeDayStatus,
  type VolumeEvidence,
} from "./research-volume-grid";

export const volumeCompletionProfiles = {
  "vp-huge-half":
    "天量形态分批减仓：主文R2，首次形态/次根/二顶确认减剩余一半；持续信号不重卖，独立新信号可再减半，MA20失守及最长持有期清仓",
  "vp-pivot-obv":
    "严格3/3价格枢轴OBV背离，确认日底背离买入、顶背离退出；OBV端点与价格端点一致，不是滚动20根极值",
  "vp-wash-seven":
    "七维洗盘：四维日线加分时、筹码换手、消息；七维全为洗盘才入场，任一出货或不明从严退出；缺数据不可买入",
} as const;
export type VolumeCompletionId = keyof typeof volumeCompletionProfiles;
export const volumeCompletionIds = Object.keys(
  volumeCompletionProfiles,
) as VolumeCompletionId[];
export function isVolumeCompletion(id: string): id is VolumeCompletionId {
  return Object.hasOwn(volumeCompletionProfiles, id);
}
export function volumeCompletionDefinition(id: VolumeCompletionId) {
  return {
    label: `量价 · ${volumeCompletionProfiles[id]}`,
    family: "量价",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    description: `${volumeCompletionProfiles[id]}。工程定义，完成日线确认、下一可成交开盘；缺失不补造。七维仅在上涨/高位放量下跌候选后3根内判别；候选确认低点失守取消。早盘跌幅至少2%、尾盘收复开盘为洗盘，高开低走或尾盘跌2%为出货；换手[1,7)、峰未上移为洗盘，换手≥15且高位筹码≥50%为出货。消息须同日可知的完整检索覆盖。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
    ],
  };
}
export type WashEvidence = {
  date: string;
  availableDate: string;
  source: string;
  morningLow?: number;
  afternoonOpen?: number;
  previousChipPeak?: number;
  chipPeak?: number;
  highChipFraction?: number;
  turnover?: number;
  newsCoverage?: boolean;
  adverseNews?: boolean;
  earningsMiss?: boolean;
};
type Vote = "wash" | "distribution" | "unknown";
export function washExternalVotes(
  bar: Bar,
  previousClose: number,
  evidence?: WashEvidence,
) {
  const empty = {
    intraday: "unknown",
    chips: "unknown",
    news: "unknown",
  } as const;
  if (
    !evidence ||
    evidence.date !== bar.date ||
    evidence.availableDate > bar.date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(evidence.availableDate) ||
    !evidence.source.trim()
  )
    return empty;
  const e = evidence;
  const positive = (...v: (number | undefined)[]) =>
    v.every((x) => x != null && Number.isFinite(x) && x > 0);
  let intraday: Vote = "unknown",
    chips: Vote = "unknown",
    news: Vote = "unknown";
  if (
    bar.date >= "2000-01-04" &&
    bar.date <= "2022-11-30" &&
    positive(e.morningLow, e.afternoonOpen, previousClose) &&
    e.morningLow! >= bar.low &&
    e.morningLow! <= bar.high &&
    e.afternoonOpen! >= bar.low &&
    e.afternoonOpen! <= bar.high
  ) {
    if (
      (bar.open > previousClose && bar.close < bar.open) ||
      bar.close / e.afternoonOpen! <= 0.98
    )
      intraday = "distribution";
    else if (e.morningLow! / bar.open <= 0.98 && bar.close >= bar.open)
      intraday = "wash";
  }
  if (
    positive(e.previousChipPeak, e.chipPeak, e.turnover) &&
    e.highChipFraction != null &&
    Number.isFinite(e.highChipFraction) &&
    e.highChipFraction >= 0 &&
    e.highChipFraction <= 1
  ) {
    if (e.turnover! >= 15 && e.highChipFraction >= 0.5) chips = "distribution";
    else if (
      e.turnover! >= 1 &&
      e.turnover! < 7 &&
      e.chipPeak! <= e.previousChipPeak!
    )
      chips = "wash";
  }
  if (
    e.newsCoverage === true &&
    typeof e.adverseNews === "boolean" &&
    typeof e.earningsMiss === "boolean"
  )
    news = e.adverseNews || e.earningsMiss ? "distribution" : "wash";
  return { intraday, chips, news };
}
export function washComposite(votes: readonly Vote[]) {
  return votes.length === 7 && votes.every((v) => v === "wash")
    ? "wash"
    : "distribution";
}
export function researchVolumeCompletionSeries(
  id: VolumeCompletionId,
  bars: readonly Bar[],
  researchVolumeSeries: typeof VolumeSeries,
  evidence: VolumeEvidence = {},
  washEvidence: Readonly<Record<string, WashEvidence>> = {},
): VolumePoint[] {
  if (id === "vp-huge-half") {
    const base = researchVolumeSeries("vp-extreme-main", bars, evidence);
    let prior = false;
    return base.map((p, i) => {
      const hugeSignal = p.exit && p.decision.startsWith("天量");
      const triggered = hugeSignal && !prior;
      prior = hugeSignal;
      const prev = base[i - 1]?.values;
      const exit =
        p.reason == null &&
        prev?.ma20 != null &&
        p.values.ma20 != null &&
        prev.close >= prev.ma20 &&
        p.values.close < p.values.ma20;
      return {
        ...p,
        exit,
        entry: p.entry && !p.exit,
        reduction: triggered
          ? { fraction: 0.5, reason: "天量形态首次确认减剩余持仓一半" }
          : undefined,
      };
    });
  }
  const input = bars.map((b) =>
    volumeDayStatus(b, evidence).abnormal ? { ...b, volume: NaN } : b,
  );
  const base = researchVolumeSeries("vp-breakout-1-5", input, evidence);
  if (id === "vp-pivot-obv") {
    const pivots = pivotDivergenceSeries(input, obv(input));
    return base.map((p, i) => ({
      ...p,
      entry: !p.reason && pivots[i]!.bottom.single,
      exit: !p.reason && pivots[i]!.top.single,
      decision: "3/3枢轴确认日OBV背离",
      pivotEvidence: pivots[i],
    }));
  }
  const facts = volumeGridFacts(bars, base, evidence);
  let candidate: {
    index: number;
    high: number;
    low: number;
    volume: number;
    amplitude: Vote;
    key: Vote;
  } | null = null;
  let priorEntry = false;
  return base.map((p, i) => {
    const v = p.values,
      f = facts[i]!;
    if (p.reason || f.abnormal) {
      candidate = null;
      priorEntry = false;
      return { ...p, entry: false, exit: false };
    }
    if (candidate && i - candidate.index > 3) candidate = null;
    if (
      !candidate &&
      ["up", "high"].includes(f.location) &&
      v.change! < -0.02 &&
      v.ratio5! >= 1.5
    ) {
      candidate = {
        index: i,
        high: v.high,
        low: v.low,
        volume: v.volume,
        amplitude:
          v.change! >= -0.05 &&
          f.highVolume60 != null &&
          v.volume < f.highVolume60
            ? "wash"
            : "distribution",
        key:
          f.support != null &&
          v.ma20 != null &&
          v.ma60 != null &&
          v.low >= Math.max(f.support, v.ma20, v.ma60)
            ? "wash"
            : "distribution",
      };
    }
    if (!candidate) {
      priorEntry = false;
      return {
        ...p,
        entry: false,
        exit: false,
        decision: "等待上涨/高位放量下跌候选",
      };
    }
    const ext = washExternalVotes(
      bars[i]!,
      bars[i - 1]?.close ?? NaN,
      washEvidence[p.date],
    );
    const recovered =
      i > candidate.index &&
      v.close > candidate.high &&
      v.volume < candidate.volume &&
      v.low >= candidate.low;
    const votes: Vote[] = [
      candidate.amplitude,
      candidate.key,
      recovered ? "wash" : "unknown",
      recovered && i - candidate.index <= 3 ? "wash" : "unknown",
      ext.intraday,
      ext.chips,
      ext.news,
    ];
    const decision = washComposite(votes);
    const entry = decision === "wash" && !priorEntry;
    priorEntry = decision === "wash";
    const missing = Object.entries(ext)
      .filter(([, v]) => v === "unknown")
      .map(([k]) => k);
    const result = {
      ...p,
      entry,
      exit: decision === "distribution",
      reason: missing.length
        ? `待数据：${p.date}七维缺失或未明确 ${missing.join("/")}`
        : null,
      decision: `七维${decision}；不明从严`,
      washVotes: votes,
      ruleStop: entry
        ? { price: candidate.low, days: 3, reason: "七维洗盘候选低点" }
        : undefined,
    };
    if (recovered || v.low < candidate.low || i - candidate.index === 3)
      candidate = null;
    return result;
  });
}
