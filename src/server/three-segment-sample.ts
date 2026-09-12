import type Database from "better-sqlite3";
import { z } from "zod";
import { dailyPerformance } from "~/lib/daily-performance";
import type { ResearchEvent } from "~/lib/strategy-research";
import type { ResearchDataset } from "./research-dataset";
import { ResearchStore, type ResearchResult } from "./research-store";
import {
  researchAdmissionSource,
  exportStrategyAdmission,
  pageStrategyAdmission,
  type AdmissionPageInput,
} from "./strategy-admission-service";
import { strategyAdmission } from "~/lib/strategy-admission";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const time = Date.parse(date);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === date
    );
  });
export const trackingUnavailableReason =
  "该策略版本无前向观察记录，系统跟踪段不存在";

/** U6 §2 与事实不符：台账已由 wall clock + 当日行情门禁写入 observedDate，
 * 没有 observedAt；盘中 strategyVersion 在 signals 中。只查这两种前向记录，
 * 不读取 research-result，不将缠论不同命名空间的版本映射为同一版本。 */
export function deriveTrackingStart(
  db: Database.Database,
  strategyVersion: string,
) {
  const ledger = db
    .prepare(
      "SELECT observed_date AS date FROM signal_ledger WHERE json_extract(payload,'$.strategyVersion')=? ORDER BY observed_date LIMIT 1",
    )
    .get(strategyVersion) as { date: string } | undefined;
  const preview = db
    .prepare(
      "SELECT MIN(json_extract(r.payload,'$.observedAt')) AS time FROM records r, json_each(r.payload,'$.signals') s WHERE r.kind='intraday-preview' AND json_extract(s.value,'$.strategyVersion')=?",
    )
    .get(strategyVersion) as { time: number | null };
  const ledgerDate = ledger ? dateSchema.parse(ledger.date) : null;
  const previewDate =
    preview.time === null
      ? null
      : dateSchema.parse(
          new Date(z.number().finite().parse(preview.time) + 8 * 3600000)
            .toISOString()
            .slice(0, 10),
        );
  const dates = [ledgerDate, previewDate]
    .filter((value): value is string => value !== null)
    .sort();
  return {
    strategyVersion,
    trackingStart: dates[0] ?? null,
    reason: dates.length ? null : trackingUnavailableReason,
    sources: { ledgerDate, previewDate },
  };
}

export function threeSegmentSample(
  db: Database.Database,
  result: ResearchResult,
  dataset: ResearchDataset,
) {
  const versions = [
    ...new Set(result.events.map((event) => event.strategyVersion)),
  ];
  // 双突破版本由确定性引擎固定；缠论无事件时不猜 DLL 版本。
  if (!versions.length && result.spec.strategy === "dual-breakout")
    versions.push("dual-breakout-1");
  const evidence =
    versions.length === 1 ? deriveTrackingStart(db, versions[0]!) : null;
  const trackingStart = evidence?.trackingStart ?? null;
  const paramsFrozenAt = new ResearchStore(db).paramsFrozenAt(result.spec);
  const paramsFrozenBeforeTracking =
    paramsFrozenAt === null || trackingStart === null
      ? null
      : paramsFrozenAt < Date.parse(`${trackingStart}T00:00:00+08:00`);
  const overlap =
    trackingStart !== null && trackingStart < result.spec.validationStart;
  const reason = overlap
    ? `系统跟踪起点 ${trackingStart} 早于保留验证起点 ${result.spec.validationStart}，样本重叠，拒绝计算跟踪段指标`
    : (evidence?.reason ??
      (evidence ? null : "研究策略版本不可唯一确定，系统跟踪段不可得"));
  const available = trackingStart !== null && !overlap;
  const sources = (["development", "validation"] as const).map((partition) =>
    researchAdmissionSource(result, dataset, partition),
  );
  const segments = sources.map((source, i) => {
    const indices = source.input.dates.flatMap((date, index) =>
      i === 1 && available && date >= trackingStart! ? [] : [index],
    );
    return segment(i === 0 ? "development" : "validation", source, indices);
  });
  function segment(
    partition: ResearchEvent["partition"],
    source: (typeof sources)[number],
    indices: number[],
  ) {
    const dates = indices.map((i) => source.input.dates[i]!);
    const returns = indices.map((i) => source.input.strategyDaily[i]!);
    const admission = strategyAdmission({
      ...source.input,
      dates,
      strategyDaily: returns,
      benchDaily: indices.map((i) => source.input.benchDaily[i]!),
      mode: "history",
    });
    if (admission.mode !== "history") throw new Error("历史判定模式错误");
    return {
      partition,
      dates,
      returns,
      startDate: dates[0] ?? null,
      endDate: dates.at(-1) ?? null,
      tradingDays: dates.length,
      informationRatio: admission.historyAlphaSharpe,
      ...dailyPerformance({
        returns,
        annualRiskFreeRate: result.spec.annualRiskFreeRate,
      }),
    };
  }
  const tracking = available
    ? segment(
        "tracking",
        sources[1]!,
        sources[1]!.input.dates.flatMap((date, i) =>
          date >= trackingStart! ? [i] : [],
        ),
      )
    : null;
  if (tracking) segments.push(tracking);
  const events = result.events.map((event): ResearchEvent =>
    available &&
    event.partition === "validation" &&
    event.observedDate >= trackingStart!
      ? { ...event, partition: "tracking" }
      : event,
  );
  return {
    trackingStart,
    paramsFrozenAt,
    paramsFrozenBeforeTracking,
    trackingSegmentAvailable: available,
    overlap,
    reason,
    evidence,
    segments,
    tracking,
    events,
  };
}

/** U8 两段本金仍独立；完整验证日收益先生成再切片，跟踪首日不重置本金。
 * recent 沿用 U8 全样本单次缩放，用跟踪实际日数替代尾部天数；其历史比较
 * 只用同一验证净值的前缀，不能跨开发期本金拼接净值。 */
export function threeSegmentAdmission(
  db: Database.Database,
  result: ResearchResult,
  dataset: ResearchDataset,
  partition: "development" | "validation",
  page: AdmissionPageInput,
) {
  const sample = threeSegmentSample(db, result, dataset);
  const original = researchAdmissionSource(result, dataset, partition);
  const historySegment = sample.segments.find(
    (s) => s.partition === partition,
  )!;
  const count = historySegment.dates.length;
  const history = {
    ...original,
    input: {
      ...original.input,
      dates: original.input.dates.slice(0, count),
      strategyDaily: original.input.strategyDaily.slice(0, count),
      benchDaily: original.input.benchDaily.slice(0, count),
    },
  };
  const recentSource = sample.trackingSegmentAvailable
    ? researchAdmissionSource(result, dataset, "validation")
    : original;
  // 起点晚于快照截止日时真实跟踪窗口为空，不回退成尾部或捏造一天。
  const trackingDays = sample.tracking?.tradingDays ?? 0;
  const recentInput = {
    ...recentSource.input,
    mode: "recent" as const,
    params: {
      ...page.params,
      ...(sample.trackingSegmentAvailable
        ? { recentDays: Math.max(1, trackingDays) }
        : {}),
    },
  };
  if (sample.trackingSegmentAvailable && !trackingDays) {
    recentInput.dates = [];
    recentInput.strategyDaily = [];
    recentInput.benchDaily = [];
  }
  const evaluated = strategyAdmission(recentInput);
  if (evaluated.mode !== "recent") throw new Error("近期判定模式错误");
  const recent = {
    ...evaluated,
    trackingSegmentAvailable: sample.trackingSegmentAvailable,
  };
  const note = sample.trackingSegmentAvailable
    ? "history 分别使用开发段、保留验证段；recent 使用同一验证净值的完整跟踪段，并与其前缀比较。日期分段仍是本地模拟日收益，不是前向成交业绩，也不证明实验参数已在上线前冻结。"
    : "近期窗口是按尾部天数截的，不是真实上线跟踪段";
  const metadata = {
    trackingStart: sample.trackingStart,
    trackingSegmentAvailable: sample.trackingSegmentAvailable,
    trackingReason: sample.reason,
    note: `${original.note} ${note}${sample.reason ? `；${sample.reason}` : ""}`,
  };
  const exported = exportStrategyAdmission(history, page.params, false);
  return {
    page: {
      ...pageStrategyAdmission(history, page, false),
      ...metadata,
      recent,
    },
    exported: {
      ...exported,
      ...metadata,
      inputs: [...exported.inputs, recentInput],
      results: [...exported.results, recent],
      evidence: sample.evidence,
    },
  };
}
