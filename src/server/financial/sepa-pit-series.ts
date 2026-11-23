import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import {
  evaluateSepaFinance,
  type SepaFinancePoint,
} from "trading-strategies/research/canslim/sepa-finance-gate";
import type { Bar } from "trading-strategy-core/bars";
import {
  pitDuplicateIssues,
  strictPitReports,
  type PitDuplicateIssue,
} from "./pit-report-input";

type Finance = ReturnType<typeof evaluateSepaFinance>;
export type SepaPitDay = {
  date: string;
  gate: Finance["gate"];
  qualifiedStrict: boolean;
  qualifiedTolerant: boolean;
  strictCount: number;
  latestReportDate: string | null;
  latestAvailableFrom: string | null;
  strictChecks: Finance["strictChecks"];
};

export type SepaPitEvaluation = {
  days: SepaPitDay[];
  strictReportCount: number;
  reportDateRange: [string, string] | null;
  strictPassDays: number;
  tolerantPassDays: number;
  incompleteDays: number;
  failedDays: number;
  duplicateRecordIssues: PitDuplicateIssue[];
  boundary: string;
};

const boundary =
  "仅使用公告日之后且 availableFrom <= date 的本地通达信财报单快照。" +
  "FN230/FN232 为单季金额，按精确去年同期的正基数计算同比百分比；净利率按两项金额计算。" +
  "ROE 只用最新可见年报的 FN281 加权净资产收益率（%），普通 ROE FN6/FN197 不混用。" +
  "同一报告期有多条已可见原始记录时该期字段视为缺失。首次披露与重述版本历史未认证。" +
  "strict-pass 与 tolerant-pass 为互斥档；宽松档要求四项容差均满足且至少两项达到严格阈值。";

const priorYear = (date: string) =>
  `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
const point = (
  date: string,
  id: number,
  value: number | null,
): SepaFinancePoint => ({
  period: date.replaceAll("-", ""),
  field: `FN${id}`,
  value,
});

function evaluateVisible(
  visible: ReadonlyMap<string, FinancialReportSnapshot | null>,
  latest: string | null,
  annual: string | null,
): Omit<SepaPitDay, "date"> {
  const dates = [...visible.keys()].sort().reverse();
  const valueAt = (date: string, id: number) => {
    const value = sourceFinancialValue(visible.get(date) ?? undefined, id);
    return value !== null && Number.isFinite(value) ? value : null;
  };
  const amounts = (id: number) =>
    dates.map((date) => point(date, id, valueAt(date, id)));
  const growth = (id: number) =>
    dates.map((date) => {
      const current = valueAt(date, id);
      const prior = valueAt(priorYear(date), id);
      const change =
        current !== null && prior !== null && prior > 0
          ? ((current - prior) / prior) * 100
          : null;
      return point(
        date,
        id,
        change !== null && Number.isFinite(change) ? change : null,
      );
    });
  const { gate, strictCount, strictChecks } = evaluateSepaFinance({
    revenue: growth(230),
    profit: growth(232),
    revenueAmounts: amounts(230),
    profitAmounts: amounts(232),
    roe: annual ? [point(annual, 281, valueAt(annual, 281))] : [],
  });
  return {
    gate,
    qualifiedStrict: gate === "strict-pass",
    qualifiedTolerant: gate === "strict-pass" || gate === "tolerant-pass",
    strictCount,
    latestReportDate: latest,
    latestAvailableFrom: latest
      ? (visible.get(latest)?.availableFrom ?? null)
      : null,
    strictChecks,
  };
}

export function buildSepaPitSeries(
  reports: readonly FinancialReportSnapshot[],
  bars: readonly Bar[],
  options?: { issues?: readonly unknown[] },
): SepaPitEvaluation {
  const strict = strictPitReports(reports);
  const periods = strict.map((report) => report.reportDate).sort();
  const result: SepaPitEvaluation = {
    days: [],
    strictReportCount: strict.length,
    reportDateRange: periods.length ? [periods[0]!, periods.at(-1)!] : null,
    strictPassDays: 0,
    tolerantPassDays: 0,
    incompleteDays: 0,
    failedDays: 0,
    duplicateRecordIssues: pitDuplicateIssues(reports, options?.issues),
    boundary,
  };
  const visible = new Map<string, FinancialReportSnapshot | null>();
  let next = 0;
  let latest: string | null = null;
  let annual: string | null = null;
  let state = evaluateVisible(visible, latest, annual);
  for (const { date } of bars) {
    if (result.days.length && date < result.days.at(-1)!.date)
      throw new Error("strict PIT 行情日期必须按时间升序排列");
    const before = next;
    while (next < strict.length && strict[next]!.availableFrom <= date) {
      const report = strict[next++]!;
      const period = report.reportDate;
      visible.set(period, visible.has(period) ? null : report);
      if (latest === null || period > latest) latest = period;
      if (period.endsWith("-12-31") && (annual === null || period > annual))
        annual = period;
    }
    if (before !== next) state = evaluateVisible(visible, latest, annual);
    result.days.push({ date, ...state });
    if (state.gate === "strict-pass") result.strictPassDays++;
    else if (state.gate === "tolerant-pass") result.tolerantPassDays++;
    else if (state.gate === "incomplete") result.incompleteDays++;
    else result.failedDays++;
  }
  return result;
}
