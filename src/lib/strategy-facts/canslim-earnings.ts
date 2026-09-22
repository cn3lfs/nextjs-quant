type Point = {
  period: string;
  field: string;
  value: number | null;
  reasons: string[];
};
type Series = Record<string, Point[]>;
type Check = {
  id: string;
  maxPoints: number;
  points: number;
  status: "computed" | "missing" | "conflict";
  fields: string[];
  value: number | null;
  reason: string;
};
export function canslimEarnings(series: Series) {
  const checks: Check[] = [];
  const add = (
    id: string,
    maxPoints: number,
    points: Point[],
    calculate: () => { points: number; value: number | null; reason: string },
  ) => {
    if (
      !points.length ||
      points.some((p) => p.value === null || p.reasons.length)
    ) {
      checks.push({
        id,
        maxPoints,
        points: 0,
        status: "missing",
        fields: points.map((p) => p.field),
        value: null,
        reason: "缺少有效且同口径的输入",
      });
      return;
    }
    const result = calculate();
    if (result.value !== null && !Number.isFinite(result.value)) {
      result.value = null;
      result.points = 0;
      result.reason = "计算结果非有限数值";
    }
    checks.push({
      id,
      maxPoints,
      status: result.value === null ? "conflict" : "computed",
      fields: points.map((p) => p.field),
      ...result,
    });
  };
  const eps = series.quarterlyEps ?? [];
  const latest = eps[0];
  const prior =
    latest &&
    eps.find(
      (p) =>
        p.period ===
        `${Number(latest.period.slice(0, 4)) - 1}${latest.period.slice(4)}`,
    );
  add("C1", 8, latest && prior ? [latest, prior] : [], () => {
    const current = latest!.value!,
      base = prior!.value!;
    if (base <= 0)
      return {
        points: 0,
        value: null,
        reason: "同期EPS非正，常规同比无意义；扭亏单列待核验",
      };
    return {
      points:
        current >= base * 1.5
          ? 8
          : current >= base * 1.25
            ? 6
            : current >= base * 1.2
              ? 3
              : 0,
      value: (current / base - 1) * 100,
      reason: "同季度基本EPS同比，不替代为净利润",
    };
  });
  const annual = (series.annualEps ?? []).slice(0, 5);
  add("A1", 8, annual.length >= 3 ? annual : [], () => {
    if (
      annual.some(
        (p, i) =>
          p.value! <= 0 ||
          (i > 0 &&
            Number(annual[i - 1]!.period.slice(0, 4)) -
              Number(p.period.slice(0, 4)) !==
              1),
      )
    )
      return {
        points: 0,
        value: null,
        reason: "年度EPS非正或年份不连续，不删除年份计算CAGR",
      };
    const years =
      Number(annual[0]!.period.slice(0, 4)) -
      Number(annual.at(-1)!.period.slice(0, 4));
    const ratio = annual[0]!.value! / annual.at(-1)!.value!;
    return {
      points:
        ratio >= 1.35 ** years
          ? 8
          : ratio >= 1.25 ** years
            ? 6
            : ratio >= 1.15 ** years
              ? 3
              : 0,
      value: (ratio ** (1 / years) - 1) * 100,
      reason: `${annual.length}个连续年报、${years}年实际跨度`,
    };
  });
  const roe = series.annualRoe?.[0];
  add("A2", 7, roe ? [roe] : [], () => ({
    points:
      roe!.value! >= 25 ? 7 : roe!.value! >= 17 ? 5 : roe!.value! >= 12 ? 2 : 0,
    value: roe!.value!,
    reason:
      roe!.value! > 50
        ? "普通年报ROE异常高，需核对净资产"
        : "最新普通年报ROE，不与加权ROE混用",
  }));
  const annualLatest = annual[0];
  const cash =
    annualLatest &&
    series.annualCashPerShare?.find((p) => p.period === annualLatest.period);
  add("A3", 5, annualLatest && cash ? [annualLatest, cash] : [], () => {
    const income = annualLatest!.value!,
      flow = cash!.value!;
    if (income <= 0)
      return { points: 0, value: null, reason: "EPS非正，现金流覆盖比不适用" };
    return {
      points:
        flow >= income * 1.2
          ? 5
          : flow >= income
            ? 4
            : flow >= income * 0.7
              ? 2
              : 0,
      value: flow / income,
      reason: flow < 0 ? "经营现金流为负" : "同年每股经营现金流/基本EPS",
    };
  });
  const growth = series.quarterlyEpsGrowth ?? [];
  const quarterIndex = (period: string) =>
    Number(period.slice(0, 4)) * 4 +
    ["0331", "0630", "0930", "1231"].indexOf(period.slice(4));
  const pair = growth.slice(0, 2);
  const consecutive =
    pair.length === 2 &&
    quarterIndex(pair[0]!.period) - quarterIndex(pair[1]!.period) === 1;
  const third = growth[2];
  const three =
    consecutive &&
    third &&
    third.value !== null &&
    !third.reasons.length &&
    quarterIndex(pair[1]!.period) - quarterIndex(third.period) === 1;
  add("C2", 7, consecutive ? (three ? [...pair, third] : pair) : [], () => {
    const current = pair[0]!.value!,
      previous = pair[1]!.value!;
    const increasing = current > previous;
    const points = increasing
      ? current < 20
        ? 3
        : three && previous > third!.value!
          ? 7
          : 5
      : Math.abs(current - previous) < 5 || (current >= 50 && previous >= 50)
        ? 3
        : 0;
    return {
      points,
      value: current - previous,
      reason:
        "连续两季同比比较；连续三季递增7分，两季递增5分，最新增速不足20%时加速项限3分；高增速回落按两季均≥50%定义",
    };
  });
  const revenue = series.quarterlyRevenueGrowth?.[0];
  const profit =
    revenue &&
    series.quarterlyProfitGrowth?.find((p) => p.period === revenue.period);
  add("C3", 5, revenue && profit ? [revenue, profit] : [], () => {
    const value = revenue!.value!;
    const base = value >= 30 ? 5 : value >= 20 ? 4 : value >= 10 ? 2 : 0;
    const penalty = value > 0 && profit!.value! < 0 ? 1 : 0;
    return {
      points: Math.max(0, base - penalty),
      value,
      reason: penalty
        ? "营收增长但同季归母净利润下降，扣1分"
        : "单季度营收同比；不将下降营收的得分抬高到2分",
    };
  });
  return {
    version: "canslim-earnings-2",
    checks,
    warnings: [
      "仅为C/A六项财务条件计算诊断，不是CANSLIM总分或交易结论。",
      "股本可比性、币种和披露时点需额外核验；computed只表示公式可计算。",
    ],
  };
}
