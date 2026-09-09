import type { Snapshot } from "~/lib/domain";
import { canslimEntry } from "./canslim-entry";

export type VolumeContext = {
  symbol: string;
  days: {
    date: string;
    limitUpContraction: boolean;
    marketCrashVolumeDecline: boolean;
    evidenceIds: string[];
  }[];
};
export function canslimVolume(
  snapshot: Snapshot,
  context: VolumeContext | null,
  now = Date.now(),
) {
  const valid =
    snapshot.bars.length >= 25 &&
    canslimEntry(snapshot, null, null, null, now).asOf !== null;
  const recent = valid ? snapshot.bars.slice(-5) : [];
  const mean20 = valid
    ? snapshot.bars.slice(-25, -5).reduce((sum, b) => sum + b.volume / 20, 0)
    : null;
  const contextValid =
    valid &&
    context?.symbol === snapshot.symbol &&
    context.days.length === 5 &&
    recent.every((b) => {
      const matches = context.days.filter((d) => d.date === b.date);
      return (
        matches.length === 1 &&
        typeof matches[0]!.limitUpContraction === "boolean" &&
        typeof matches[0]!.marketCrashVolumeDecline === "boolean" &&
        matches[0]!.evidenceIds.length > 0 &&
        matches[0]!.evidenceIds.every(
          (id) => typeof id === "string" && id.trim().length > 0,
        )
      );
    });
  const excludedDates = contextValid
    ? context!.days.filter((d) => d.marketCrashVolumeDecline).map((d) => d.date)
    : [];
  const eligible = recent.filter((b) => !excludedDates.includes(b.date));
  const rawRatio =
    mean20 !== null ? Math.max(...recent.map((b) => b.volume)) / mean20 : null;
  const peak = eligible.length
    ? Math.max(...eligible.map((b) => b.volume))
    : null;
  const ratio =
    contextValid && peak !== null && mean20 !== null ? peak / mean20 : null;
  const exception =
    contextValid &&
    context!.days.some(
      (d) => d.limitUpContraction && !excludedDates.includes(d.date),
    );
  const points =
    peak === null || mean20 === null
      ? 0
      : peak >= mean20 * 2
        ? 8
        : peak >= mean20 * 1.5
          ? 6
          : peak >= mean20 * 1.2
            ? 3
            : 0;
  const status =
    !contextValid || ratio === null
      ? "missing"
      : exception && points < 8
        ? "conflict"
        : "computed";
  return {
    id: "S1",
    maxPoints: 8,
    version: "canslim-volume-1",
    status,
    points: status === "computed" ? points : 0,
    asOf: valid ? snapshot.bars.at(-1)!.date : null,
    mean20,
    rawRatio,
    ratio,
    excludedDates,
    evidenceIds: contextValid
      ? [...new Set(context!.days.flatMap((d) => d.evidenceIds))]
      : [],
    warnings: [
      "参考均量取近5条之前的20条，近5条取最高量，两个窗口不重叠；该窗口选择为应用适配。",
      "每个近期日期须有证券身份匹配的涨停缩量/大盘暴跌放量下跌状态证据，缺失时原始量比仅展示不评分。",
      "异常大盘放量下跌日排除；涨停缩量且普通评分未满分时规则未定义替代分值，保留conflict，不把它判为量能不足或自动补满分。",
    ],
  };
}
