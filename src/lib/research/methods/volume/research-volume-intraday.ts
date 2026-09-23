import type { Bar } from "../../../domain";
import { technicalIntradayRatio } from "../../technical/research-technical-methods";
import { evaluateFormula } from "../../../formula/tdx-formula";

export const volumeIntradayProfiles = {
  "vp-intraday-rate": ["VP-intraday-ratio", "14:30每分钟量比确认"],
  "vp-intraday-projection": [
    "VP-intraday-projection",
    "14:30线性全天量近似确认",
  ],
} as const;
export type VolumeIntradayId = keyof typeof volumeIntradayProfiles;
export const volumeIntradayIds = Object.keys(
  volumeIntradayProfiles,
) as VolumeIntradayId[];
export function isVolumeIntraday(id: string): id is VolumeIntradayId {
  return Object.hasOwn(volumeIntradayProfiles, id);
}
export const volumeIntradayBoundary =
  "工程v1：只在2000-01-04至2022-11-30读取已完成14:30分钟快照（已过210/全天240交易分钟），盘中价突破前20根日高且量比≥1.5并≤5，或预计全天量≥过去5日均量1.5倍且≤5倍确认。量比=累计量/已过分钟/(前5日总量/1200)，预计量=累计量×240/已过分钟；两种量纲分别展示，数学上此固定分母条件相同，保留两种原文用途，不宣称独立收益。分档<0.8/[0.8,1.5)/[1.5,2.5)/[2.5,5]/>5，原文重叠边界按左闭版本固定；开盘前30分钟极端值警告，不直接外推。需要同单位五个紧邻已完成交易日量、分钟快照source/observedAt/availableAt、精确日历关联；不使用当日最终成交量倒填。日线收盘回放保存该快照判断，次日可成交开盘执行（不是14:30成交）；日线MA5/10死叉或持有上限退出。快照价不高于前高则无信号；真实分钟证据缺失为待数据。全部输入公司行动覆盖。";
export function volumeIntradayDefinition(id: VolumeIntradayId) {
  return {
    label: volumeIntradayProfiles[id][1],
    family: "量价盘中快照",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: [
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/SKILL.md",
    ],
    description: volumeIntradayBoundary,
  };
}
export type VolumeIntradayEvidence = NonNullable<
  Parameters<typeof technicalIntradayRatio>[0]
> & {
  observedAt: string;
  availableAt: string;
  price: number;
  priorDates: readonly string[];
};
export function volumeIntradayFacts(
  input: VolumeIntradayEvidence | undefined,
  date: string,
) {
  const result = technicalIntradayRatio(input, date);
  if (
    !input ||
    !result ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.priorDates.length !== 5 ||
    new Set(input.priorDates).size !== 5 ||
    input.priorDates.some(
      (d, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        d >= date ||
        (i > 0 && d <= input.priorDates[i - 1]!),
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(input.observedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(input.availableAt) ||
    input.observedAt.slice(0, 10) !== date ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !Number.isFinite(Date.parse(input.availableAt)) ||
    input.availableAt < input.observedAt
  )
    return null;
  const average = input.prior5DailyVolumes.reduce((s, v) => s + v, 0) / 5;
  return {
    ...result,
    average,
    band:
      result.ratio < 0.8
        ? "contracted"
        : result.ratio < 1.5
          ? "normal"
          : result.ratio < 2.5
            ? "active"
            : result.ratio <= 5
              ? "unusual"
              : "extreme",
    openingWarning: input.elapsedMinutes <= 30,
  };
}
export function researchVolumeIntradaySeries(
  id: VolumeIntradayId,
  bars: readonly Bar[],
  evidence: readonly VolumeIntradayEvidence[] = [],
) {
  const valid = (b: Bar) =>
    Number.isFinite(b.volume) &&
    b.volume > 0 &&
    [b.open, b.high, b.low, b.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close);
  const exitSeries = evaluateFormula(
    "CROSS(MA(C,10),MA(C,5));",
    bars.map((b) =>
      valid(b)
        ? b
        : { ...b, open: NaN, close: NaN, high: NaN, low: NaN, volume: NaN },
    ),
  ).outputs[0]!.values;
  let previous = false;
  return bars.map((bar, i) => {
    const rows = evidence.filter((e) => e.date === bar.date),
      row = rows.length === 1 ? rows[0] : undefined,
      facts = volumeIntradayFacts(row, bar.date);
    const prior = bars.slice(Math.max(0, i - 20), i),
      prior5 = prior.slice(-5),
      cutoff = `${bar.date}T14:30:00+08:00`;
    const ready =
      valid(bar) &&
      prior.length === 20 &&
      prior.every(valid) &&
      !!facts &&
      !!row &&
      row.observedAt === cutoff &&
      row.availableAt <= cutoff &&
      row.elapsedMinutes === 210 &&
      row.sessionMinutes === 240 &&
      prior5.every(
        (b, j) =>
          row.priorDates[j] === b.date &&
          row.prior5DailyVolumes[j] === b.volume,
      );
    const trigger =
      ready &&
      row!.price > Math.max(...prior.map((b) => b.high)) &&
      (id === "vp-intraday-rate"
        ? facts!.ratio >= 1.5 && facts!.ratio <= 5
        : facts!.projectedVolume >= 1.5 * facts!.average &&
          facts!.projectedVolume <= 5 * facts!.average);
    const exit = valid(bar) && exitSeries[i] === 1,
      entry = !!trigger && !previous && !exit;
    previous = !!trigger;
    const values: Record<string, number | null> = {
      close: Number.isFinite(bar.close) ? bar.close : null,
      intradayPrice: ready ? row!.price : null,
      ratio: ready ? facts!.ratio : null,
      projectedVolume: ready ? facts!.projectedVolume : null,
    };
    return {
      date: bar.date,
      entry,
      exit,
      reason: ready
        ? null
        : "待数据：14:30已知分钟快照、前五交易日同单位量或20日日线不足",
      values,
      intraday: {
        id,
        cutoff,
        facts: ready ? facts : null,
        source: ready ? row!.source : null,
        snapshot: ready ? row! : null,
      },
    };
  });
}
