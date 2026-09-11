import type { ClsReportArchive } from "./cls-review-store";
import type { ClsDirection } from "./cls-report-parser";

export type ClsSampleCandidate = {
  symbol: string;
  sectionId: string;
  direction: ClsDirection;
  priority: number;
  basis: "explicit-recommendation" | "sector-rps";
  rps: number | null;
  evidence: string;
};
export type ClsSample = {
  version: "cls-sample-1";
  date: string;
  fixedAt: number;
  reportId: string;
  reportHash: string;
  previousTradingDay: string;
  calendarSource: string;
  poolHash: string;
  candidates: ClsSampleCandidate[];
  selected: ClsSampleCandidate | null;
  reason: string | null;
};
export function buildClsSample(input: {
  report: ClsReportArchive;
  now: number;
  date: string;
  previousTradingDay: string;
  calendarSource: string;
  isTradingDay: boolean;
  poolHash: string;
  candidates: ClsSampleCandidate[];
}): ClsSample {
  const { report, now, date } = input;
  const opening = Date.parse(`${date}T09:30:00+08:00`);
  if (
    !Number.isFinite(opening) ||
    new Date(now + 8 * 3600000).toISOString().slice(0, 10) !== date
  )
    throw new Error("只能固定当前日期的盘前样本");
  if (
    !input.isTradingDay ||
    !input.calendarSource ||
    input.previousTradingDay >= date
  )
    throw new Error("缺少有效交易日历依据");
  if (now >= opening) throw new Error("已开盘，不能补选盘前样本");
  if (
    report.importedAt > now ||
    report.observedAt > now ||
    report.modifiedAt > now
  )
    throw new Error("报告时间晚于选样时点");
  if (report.report.reportDate !== date)
    throw new Error("报告日期不是当日，不能作为当日盘前预测");
  const sections = new Map(
    report.report.sections.map((section) => [section.id, section]),
  );
  const candidates = input.candidates
    .filter((candidate) => {
      const section = sections.get(candidate.sectionId);
      return (
        /^(sh|sz)\d{6}$/.test(candidate.symbol) &&
        !!section &&
        section.direction === candidate.direction &&
        ["bullish", "bearish"].includes(candidate.direction) &&
        Number.isFinite(candidate.priority) &&
        candidate.priority >= 0 &&
        !!candidate.evidence.trim() &&
        (candidate.basis === "explicit-recommendation" ||
          (candidate.rps !== null &&
            Number.isFinite(candidate.rps) &&
            candidate.rps >= 0 &&
            candidate.rps <= 100))
      );
    })
    .sort(
      (a, b) =>
        (a.basis === "explicit-recommendation" ? 0 : 1) -
          (b.basis === "explicit-recommendation" ? 0 : 1) ||
        a.priority - b.priority ||
        (b.rps ?? -1) - (a.rps ?? -1) ||
        a.symbol.localeCompare(b.symbol) ||
        a.sectionId.localeCompare(b.sectionId),
    );
  return {
    version: "cls-sample-1",
    date,
    fixedAt: now,
    reportId: report.id,
    reportHash: report.report.hash,
    previousTradingDay: input.previousTradingDay,
    calendarSource: input.calendarSource,
    poolHash: input.poolHash,
    candidates,
    selected: candidates[0] ?? null,
    reason: candidates.length ? null : "未找到方向明确且可唯一匹配的沪深候选",
  };
}
