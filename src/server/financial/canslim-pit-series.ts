import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import { canslimEarnings } from "trading-strategies/research/canslim/canslim-earnings";
import type { Bar } from "trading-strategy-core/bars";
import {
  pitDuplicateIssues,
  strictPitReports,
  type PitDuplicateIssue,
} from "./pit-report-input";

type GateCheck = Pick<
  ReturnType<typeof canslimEarnings>["checks"][number],
  "status" | "value" | "points"
>;
export const CANSLIM_PIT_CHECK_POINTS = Object.freeze({
  C1: 6, // ≥25% EPS growth
  C2: 5, // acceleration with latest growth ≥20%
  C3: 4, // ≥20% revenue tier after the profit penalty
  A1: 6, // ≥25% annual EPS CAGR
  A2: 5, // ≥17% annual ordinary ROE
  A3: 4, // operating cash flow covers EPS
});
type CheckId = keyof typeof CANSLIM_PIT_CHECK_POINTS;
const checkIds = Object.keys(CANSLIM_PIT_CHECK_POINTS) as CheckId[];
type CheckCoverage = Record<GateCheck["status"], number> & {
  passed: number;
  /** Passed / computed, independent of the other C/A checks. */
  marginalPassRate: number | null;
};
export type CanslimPitDay = {
  date: string;
  qualified: boolean;
  latestReportDate: string | null;
  latestAvailableFrom: string | null;
  c1: GateCheck;
  c2: GateCheck;
  c3: GateCheck;
  a1: GateCheck;
  a2: GateCheck;
  a3: GateCheck;
  totalPoints: number;
};

export type CanslimPitEvaluation = {
  days: CanslimPitDay[];
  strictReportCount: number;
  reportDateRange: [string, string] | null;
  qualifiedDays: number;
  missingDays: number;
  conflictDays: number;
  firstVisibleReportDate: string | null;
  latestVisibleReportDate: string | null;
  checkCoverage: Record<CheckId, CheckCoverage>;
  duplicateIssues: PitDuplicateIssue[];
  boundary: string;
};

const boundary =
  "strict PIT 仅按 availableFrom <= date 生效，公告日当天不可见；仅使用本地通达信单快照财务包，不含首次披露与重述版本历史，未与交易所公告原文交叉核对；仅反映存续标的规则自检，不外推全市场。" +
  " 原始输入含同报告期多记录时沿用最后可见记录并披露重复；边际通过率为单项通过日数除以可计算日数，入场仍只取 C1/A1/A2。";

const periodOf = (reportDate: string) => reportDate.replaceAll("-", "");
const priorYear = (date: string) =>
  `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;

function point(report: FinancialReportSnapshot, id: number) {
  const field = `FN${id}`;
  const value = sourceFinancialValue(report, id);
  return {
    period: periodOf(report.reportDate),
    field,
    value,
    reasons: value === null ? [`${field}缺失或来源零未认证`] : [],
  };
}

// canslimEarnings reads three quarters of growth and five annual observations.
// Keep these windows ordered by report period even for late announcements.
function includeRecent(dates: string[], date: string, limit: number) {
  if (dates.includes(date)) return;
  dates.push(date);
  dates.sort((a, b) => b.localeCompare(a));
  if (dates.length > limit) dates.pop();
}

function evaluateVisible(
  visible: ReadonlyMap<string, FinancialReportSnapshot>,
  quarterlyEps: ReadonlyMap<string, ReturnType<typeof point>>,
  quarters: string[],
  years: string[],
): Omit<CanslimPitDay, "date"> {
  const latest = quarters[0];
  const annual = years.map((date) => visible.get(date)!);
  function growth(date: string, id: number, missing: string) {
    const cur = sourceFinancialValue(visible.get(date), id);
    const prev = sourceFinancialValue(visible.get(priorYear(date)), id);
    const value =
      cur !== null && prev !== null && prev > 0 ? (cur / prev - 1) * 100 : null;
    return {
      period: periodOf(date),
      field: `FN${id}`,
      value,
      reasons: value === null ? [missing] : [],
    };
  }

  // Every visible period has an EPS point, including null. C1 consumes only
  // the latest period and its exact prior-year match, never an older substitute.
  const epsPair = latest
    ? [latest, priorYear(latest)].flatMap(
        (date) => quarterlyEps.get(date) ?? [],
      )
    : [];
  const { checks } = canslimEarnings({
    quarterlyEps: epsPair,
    quarterlyEpsGrowth: quarters.map((date) =>
      growth(date, 311, "同期单季EPS非正或缺失"),
    ),
    quarterlyRevenueGrowth: quarters.map((date) =>
      growth(date, 230, "同期单季营业收入非正或缺失"),
    ),
    quarterlyProfitGrowth: quarters.map((date) =>
      growth(date, 232, "同期单季归母净利润非正或缺失"),
    ),
    annualEps: annual.map((r) => point(r, 1)),
    annualRoe: annual.map((r) => point(r, 6)),
    annualCashPerShare: annual.map((r) => point(r, 7)),
  });
  const gate = (id: CheckId): GateCheck => {
    const { status, value, points } = checks.find((check) => check.id === id)!;
    return { status, value, points };
  };
  const c1 = gate("C1"),
    a1 = gate("A1"),
    a2 = gate("A2");
  return {
    latestReportDate: latest ?? null,
    latestAvailableFrom: latest ? visible.get(latest)!.availableFrom! : null,
    c1,
    c2: gate("C2"),
    c3: gate("C3"),
    a1,
    a2,
    a3: gate("A3"),
    qualified:
      c1.status === "computed" &&
      c1.points >= CANSLIM_PIT_CHECK_POINTS.C1 &&
      a1.status === "computed" &&
      a1.points >= CANSLIM_PIT_CHECK_POINTS.A1 &&
      a2.status === "computed" &&
      a2.points >= CANSLIM_PIT_CHECK_POINTS.A2,
    totalPoints: checks.reduce((sum, check) => sum + check.points, 0),
  };
}

export function buildCanslimPitSeries(
  reports: readonly FinancialReportSnapshot[],
  bars: readonly Bar[],
  options?: { issues?: readonly unknown[] },
): CanslimPitEvaluation {
  const strict = strictPitReports(reports);
  const periods = strict.map((r) => r.reportDate).sort();
  const result: CanslimPitEvaluation = {
    days: [],
    strictReportCount: strict.length,
    reportDateRange: periods.length ? [periods[0]!, periods.at(-1)!] : null,
    qualifiedDays: 0,
    missingDays: 0,
    conflictDays: 0,
    firstVisibleReportDate: null,
    latestVisibleReportDate: null,
    checkCoverage: Object.fromEntries(
      checkIds.map((id) => [
        id,
        {
          computed: 0,
          missing: 0,
          conflict: 0,
          passed: 0,
          marginalPassRate: null,
        },
      ]),
    ) as CanslimPitEvaluation["checkCoverage"],
    duplicateIssues: pitDuplicateIssues(reports, options?.issues),
    boundary,
  };
  const visible = new Map<string, FinancialReportSnapshot>();
  const quarterlyEps = new Map<string, ReturnType<typeof point>>();
  const quarters: string[] = [],
    years: string[] = [];
  let next = 0;
  let state = evaluateVisible(visible, quarterlyEps, quarters, years);
  for (const { date } of bars) {
    if (result.days.length && date < result.days.at(-1)!.date)
      throw new Error("strict PIT 行情日期必须按时间升序排列");
    const before = next;
    // availableFrom > announcementDate > reportDate also proves reportDate <= date.
    while (next < strict.length && strict[next]!.availableFrom <= date) {
      const report = strict[next++]!;
      visible.set(report.reportDate, report);
      quarterlyEps.set(report.reportDate, point(report, 311));
      includeRecent(quarters, report.reportDate, 3);
      if (report.reportDate.endsWith("-12-31"))
        includeRecent(years, report.reportDate, 5);
    }
    if (next !== before)
      state = evaluateVisible(visible, quarterlyEps, quarters, years);
    result.days.push({ date, ...state });
    result.firstVisibleReportDate ??= state.latestReportDate;
    result.latestVisibleReportDate = state.latestReportDate;
    if (state.qualified) result.qualifiedDays++;
    const gates = [state.c1, state.a1, state.a2];
    if (gates.some((c) => c.status === "missing")) result.missingDays++;
    if (gates.some((c) => c.status === "conflict")) result.conflictDays++;
    for (const id of checkIds) {
      const check = state[id.toLowerCase() as Lowercase<CheckId>];
      const coverage = result.checkCoverage[id];
      coverage[check.status]++;
      if (
        check.status === "computed" &&
        check.points >= CANSLIM_PIT_CHECK_POINTS[id]
      )
        coverage.passed++;
    }
  }
  for (const coverage of Object.values(result.checkCoverage))
    if (coverage.computed)
      coverage.marginalPassRate = coverage.passed / coverage.computed;
  return result;
}
