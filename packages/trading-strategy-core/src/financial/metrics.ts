import {
  sourceFinancialValue as value,
  financialVisibleAt,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
export type FinancialMetric = {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  formula: string;
  inputs: { reportDate: string; code: string; sourceSha256: string }[];
  reason: string | null;
};
type Input = [FinancialReportSnapshot | undefined, number];
function calculate(
  id: string,
  label: string,
  unit: string,
  formula: string,
  inputs: Input[],
  fn: (...values: number[]) => number,
): FinancialMetric {
  const values = inputs.map(([report, code]) => value(report, code));
  const result = values.some((v) => v === null)
    ? null
    : fn(...(values as number[]));
  return {
    id,
    label,
    unit,
    formula,
    value: result !== null && Number.isFinite(result) ? result : null,
    inputs: inputs.flatMap(([report, code]) =>
      report
        ? [
            {
              reportDate: report.reportDate,
              code: `FN${code}`,
              sourceSha256: report.sourceSha256,
            },
          ]
        : [],
    ),
    reason:
      result === null
        ? "所需报告期、字段或有效零值证据缺失"
        : Number.isFinite(result)
          ? null
          : "分母非正、输入口径不适用或计算无效",
  };
}
const divide = (a: number, b: number) => (b > 0 ? a / b : NaN);
const growth = (current: number, previous: number) =>
  previous > 0 ? (current / previous - 1) * 100 : NaN;
export function financialMetrics(
  reports: readonly FinancialReportSnapshot[],
  reportDate?: string,
): FinancialMetric[] {
  const report = reportDate
    ? reports.find((r) => r.reportDate === reportDate)
    : reports[0];
  if (!report) return [];
  const date = report.reportDate,
    year = +date.slice(0, 4),
    monthDay = date.slice(4);
  const previousYear = reports.find(
    (r) => r.reportDate === `${year - 1}${monthDay}`,
  );
  const yearEnd = reports.find((r) => r.reportDate === `${year - 1}-12-31`);
  const quarterEnds = ["-03-31", "-06-30", "-09-30", "-12-31"];
  const quarterIndex = quarterEnds.indexOf(monthDay);
  const previousQuarter =
    quarterIndex > 0
      ? reports.find(
          (r) => r.reportDate === `${year}${quarterEnds[quarterIndex - 1]}`,
        )
      : undefined;
  const out: FinancialMetric[] = [];
  const ratio = (
    id: string,
    label: string,
    numerator: number,
    denominator: number,
  ) =>
    out.push(
      calculate(
        id,
        label,
        "比例",
        `FN${numerator}/FN${denominator}`,
        [
          [report, numerator],
          [report, denominator],
        ],
        divide,
      ),
    );
  ratio("debt-ratio", "资产负债率", 63, 40);
  ratio("net-margin", "合并净利率", 95, 74);
  ratio("parent-roe", "归母利润/期末归母权益（累计）", 96, 271);
  ratio("cash-to-profit", "经营现金流/合并净利润", 107, 95);
  ratio("goodwill-ratio", "商誉/总资产", 35, 40);
  ratio("receivables-ratio", "应收账款/累计收入", 11, 74);
  ratio("inventory-ratio", "存货/累计收入", 17, 74);
  ratio("current-ratio", "流动比率", 21, 54);
  out.push(
    calculate(
      "gross-margin",
      "毛利率（非金融）",
      "比例",
      "(营业收入-营业成本)/营业收入",
      [
        [report, 74],
        [report, 75],
      ],
      (income, cost) => (cost >= 0 ? divide(income - cost, income) : NaN),
    ),
  );
  if (report.financialCompany !== false) {
    const metric = out.find((metric) => metric.id === "gross-margin")!;
    metric.value = null;
    metric.reason = "金融企业或行业未核验，不能套用普通企业毛利率";
  }
  out.push(
    calculate(
      "free-cash-flow",
      "经营现金流减购建长期资产现金支出",
      "元",
      "FN107-FN114",
      [
        [report, 107],
        [report, 114],
      ],
      (cash, capex) => (capex >= 0 ? cash - capex : NaN),
    ),
  );
  for (const [id, label] of [
    [74, "营业收入"],
    [96, "归母净利润"],
    [206, "扣非净利润"],
    [107, "经营现金流"],
  ] as const) {
    out.push(
      calculate(
        `${id}-yoy`,
        `${label}累计同比`,
        "%",
        "本期/上年同期-1；上年基数须正",
        [
          [report, id],
          [previousYear, id],
        ],
        growth,
      ),
    );
    out.push(
      quarterIndex === 0
        ? calculate(
            `${id}-quarter`,
            `${label}单季`,
            "元",
            "Q1累计值",
            [[report, id]],
            (a) => a,
          )
        : calculate(
            `${id}-quarter`,
            `${label}单季`,
            "元",
            "本期累计-上季度累计",
            [
              [report, id],
              [previousQuarter, id],
            ],
            (a, b) => (quarterIndex > 0 ? a - b : NaN),
          ),
    );
    out.push(
      monthDay === "-12-31"
        ? calculate(
            `${id}-ttm`,
            `${label}TTM（自算）`,
            "元",
            "年报值",
            [[report, id]],
            (a) => a,
          )
        : calculate(
            `${id}-ttm`,
            `${label}TTM（自算）`,
            "元",
            "上年年报+本期累计-上年同期累计",
            [
              [yearEnd, id],
              [report, id],
              [previousYear, id],
            ],
            (a, b, c) => a + b - c,
          ),
    );
  }
  for (const [id, label] of [
    [308, "归母利润TTM（源值）"],
    [309, "扣非利润TTM（源值）"],
    [319, "营业收入TTM（源值）"],
    [281, "加权ROE（源值）"],
  ] as const)
    out.push(
      calculate(
        `source-${id}`,
        label,
        id === 281 ? "%" : "元",
        `FN${id}（按字段单位归一）`,
        [[report, id]],
        (a) => a,
      ),
    );
  const annual = reports.filter((r) => r.reportDate.endsWith("-12-31"));
  const end = annual.find((r) => r.reportDate <= date),
    start =
      end &&
      annual.find(
        (r) => +r.reportDate.slice(0, 4) === +end.reportDate.slice(0, 4) - 3,
      );
  for (const [id, label] of [
    [74, "收入"],
    [96, "归母利润"],
  ] as const)
    out.push(
      calculate(
        `${id}-cagr3`,
        `${label}三年CAGR`,
        "%",
        "(末年/三年前)^(1/3)-1，需连续4个年度且端点正",
        [
          [end, id],
          [start, id],
        ],
        (last, first) =>
          last > 0 &&
          first > 0 &&
          [0, 1, 2, 3].every((n) =>
            annual.some(
              (r) =>
                r.reportDate === `${+end!.reportDate.slice(0, 4) - n}-12-31`,
            ),
          )
            ? (Math.pow(last / first, 1 / 3) - 1) * 100
            : NaN,
      ),
    );
  return out;
}
export function financialMetricSeries(
  reports: readonly FinancialReportSnapshot[],
  metricId: string,
  dates: readonly string[],
) {
  return dates.map((date) => {
    const visible = reports
      .filter((report) => financialVisibleAt(report, date))
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
    return (
      financialMetrics(visible).find((metric) => metric.id === metricId)
        ?.value ?? null
    );
  });
}
