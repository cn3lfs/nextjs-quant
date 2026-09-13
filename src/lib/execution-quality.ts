import { classifyCode, type ParsedFill } from "./delivery-import";
import type { Bar } from "./domain";
import type { ReviewValue } from "./trade-review";
import { reviewTradeNav, type TradeReviewNavInput } from "./trade-review-nav";
import { tradeReviewDayVwap } from "./trade-review-vwap";

export type ExecutionBenchmark = { kind: "dayVwap" };
export type ExecutionRow = {
  id: string;
  fillIndex: number;
  tradeDate: string;
  code: string;
  name: string | null;
  kind: ParsedFill["kind"];
  price: ReviewValue;
  vwap: ReviewValue;
  unitCheck: {
    rawVwap: number | null;
    ratio: number | null;
    factor: number | null;
    convertedVwap: number | null;
    convertedBp: number | null;
    reason: string | null;
  };
  /** Positive = adverse: buying dearer or selling cheaper than day VWAP. */
  slippageBp: ReviewValue;
  slippageCost: ReviewValue;
  amount: ReviewValue;
  fees: { [K in keyof ParsedFill["fees"]]: ReviewValue };
};
const metric = (value: number | null, reason = "数据不可得"): ReviewValue =>
  value !== null && Number.isFinite(value)
    ? { value, reason: null }
    : { value: null, reason };
const repo = (fill: ParsedFill) =>
  fill.instrument === "reverseRepo" ||
  classifyCode(fill.code).instrument === "reverseRepo";

export function executionRows(
  fills: readonly ParsedFill[],
  bars: Readonly<Record<string, readonly Bar[]>>,
): ExecutionRow[] {
  return fills.flatMap((fill, fillIndex) => {
    if (repo(fill)) return [];
    const matches =
      bars[fill.symbol ?? fill.code]?.filter(
        (b) => b.date === fill.tradeDate,
      ) ?? [];
    let vwap =
      matches.length === 1
        ? tradeReviewDayVwap(matches[0]!)
        : metric(null, "缺少当日唯一日线");
    const classification = classifyCode(fill.code);
    const factor =
      classification.instrument === "convertible" &&
      classification.market === "sh"
        ? 10
        : 1;
    const ratio =
      vwap.value !== null && Number.isFinite(fill.price) && fill.price > 0
        ? vwap.value / fill.price
        : null;
    // W12 §9: statement price is the reference; close units are irrelevant.
    // Multiplicative tolerance 1.25 is below sqrt(10); intervals cannot overlap.
    const identifiedFactor =
      ratio !== null && Number.isFinite(ratio)
        ? ([1, 10, 100].find(
            (candidate) =>
              ratio >= candidate / 1.25 && ratio <= candidate * 1.25,
          ) ?? null)
        : null;
    const unitCheck: ExecutionRow["unitCheck"] = {
      rawVwap: vwap.value,
      ratio: ratio !== null && Number.isFinite(ratio) ? ratio : null,
      factor: identifiedFactor,
      convertedVwap: null,
      convertedBp: null,
      reason: null,
    };
    // U4 §3.3 differs from R12: Shanghai bars are yuan/hand, statement price yuan/bond.
    const expected = fill.price * fill.quantity * factor;
    if (
      classification.instrument === "convertible" &&
      (!(expected > 0) ||
        !Number.isFinite(expected) ||
        Math.abs(fill.amount - expected) > Math.max(0.05, expected * 0.005))
    )
      vwap = metric(null, "可转债数量单位无法确认（沿用 R12 成交金额校验）");
    else if (vwap.value !== null) {
      if (identifiedFactor === null) {
        unitCheck.reason =
          "日线 VWAP 单位无法识别（成交价比例不在候选倍率容差内）";
        vwap = metric(null, unitCheck.reason);
      } else {
        vwap = metric(vwap.value / identifiedFactor);
        unitCheck.convertedVwap = vwap.value;
      }
    }
    const price = metric(
      fill.price > 0 ? fill.price : null,
      "成交价格非正或无效",
    );
    const amount = metric(
      fill.amount > 0 ? fill.amount : null,
      "成交金额非正或无效",
    );
    let bp = metric(
      vwap.value !== null && price.value !== null
        ? ((fill.kind === "buy"
            ? price.value - vwap.value
            : vwap.value - price.value) /
            vwap.value) *
            10000
        : null,
      vwap.reason ?? price.reason ?? undefined,
    );
    unitCheck.convertedBp = bp.value;
    if (bp.value !== null && Math.abs(bp.value) > 500) {
      unitCheck.reason = "换算后滑点绝对值超过 500 BP，排除滑点汇总";
      bp = metric(null, unitCheck.reason);
    }
    return [
      {
        id: String(fillIndex),
        fillIndex,
        tradeDate: fill.tradeDate,
        code: fill.code,
        name: fill.name,
        kind: fill.kind,
        price,
        vwap,
        unitCheck,
        slippageBp: bp,
        amount,
        slippageCost: metric(
          bp.value !== null && amount.value !== null
            ? (bp.value / 10000) * amount.value
            : null,
          bp.reason ?? amount.reason ?? undefined,
        ),
        fees: Object.fromEntries(
          Object.entries(fill.fees).map(([key, value]) => [
            key,
            metric(value, `${key} 费用缺失`),
          ]),
        ) as ExecutionRow["fees"],
      },
    ];
  });
}

export function summarizeExecution(rows: readonly ExecutionRow[]) {
  const eligible = rows.filter((r) => r.unitCheck.reason === null);
  const sum = (read: (row: ExecutionRow) => ReviewValue, selected = rows) => {
    const missing = selected.filter((r) => read(r).value === null);
    return metric(
      selected.length && !missing.length
        ? selected.reduce((s, r) => s + read(r).value!, 0)
        : null,
      missing.length
        ? `${missing.length} 笔数据不可得；合计留空`
        : "无符合条件的成交",
    );
  };
  const amount = sum((r) => r.amount);
  const slippageAmount = sum((r) => r.amount, eligible);
  const slippageCost = sum((r) => r.slippageCost, eligible);
  const fees = Object.fromEntries(
    (
      ["commission", "stampTax", "transferFee", "otherFee", "total"] as const
    ).map((key) => [key, sum((r) => r.fees[key])]),
  ) as ExecutionRow["fees"];
  const totalCost = metric(
    eligible.length === rows.length &&
      fees.total.value !== null &&
      slippageCost.value !== null
      ? fees.total.value + slippageCost.value
      : null,
    eligible.length !== rows.length
      ? "存在单位异常成交，全体总执行成本留空"
      : (fees.total.reason ?? slippageCost.reason ?? undefined),
  );
  const ratio = (v: ReviewValue, denominator = amount) =>
    metric(
      v.value !== null && denominator.value !== null && denominator.value > 0
        ? (v.value / denominator.value) * 10000
        : null,
      v.reason ?? denominator.reason ?? "成交额不可得",
    );
  return {
    count: rows.length,
    amount,
    fees,
    slippageCost,
    totalCost,
    slippageCount: eligible.length,
    slippageAmount,
    unitMismatchCount: rows.length - eligible.length,
    averageSlippageBp: ratio(slippageCost, slippageAmount),
    costBp: ratio(totalCost),
  };
}

export function reviewExecutionQuality(
  input: TradeReviewNavInput & {
    bars: Readonly<Record<string, readonly Bar[]>>;
  },
  actual = reviewTradeNav(input),
) {
  const rows = executionRows(input.fills, input.bars);
  const missingVwap = rows
    .filter((r) => r.vwap.value === null)
    .map((r) => ({
      tradeDate: r.tradeDate,
      code: r.code,
      fillIndex: r.fillIndex,
      reason: r.vwap.reason,
    }));
  const base = {
    benchmark: { kind: "dayVwap" } as ExecutionBenchmark,
    rows,
    unitMismatchCount: rows.filter((r) => r.unitCheck.reason !== null).length,
    unitMismatches: rows
      .filter((r) => r.unitCheck.reason !== null)
      .map((r) => ({
        fillIndex: r.fillIndex,
        tradeDate: r.tradeDate,
        code: r.code,
        price: r.price.value,
        ...r.unitCheck,
      })),
    summary: summarizeExecution(rows),
    missingVwap,
    terminalDifference: metric(null, "未启用期末总资产差口径"),
    fallbackNote: null as string | null,
    counterfactualNonPositiveDays: null as number | null,
    counterfactualWorstNav: null as { value: number; date: string } | null,
  };
  const unavailable = (reason: string) => ({
    ...base,
    counterfactual: null,
    loss: metric(null, reason),
    segments: [] as {
      start: string;
      end: string;
      actualTwr: ReviewValue;
      counterfactualTwr: ReviewValue;
      loss: ReviewValue;
    }[],
  });
  if (missingVwap.length)
    return unavailable(
      `${missingVwap.length} 笔成交缺少可得 VWAP：${missingVwap.map((r) => `${r.tradeDate} ${r.code}（${r.reason}）`).join("、")}`,
    );
  if (!rows.length) return unavailable("无非逆回购成交");
  const fills = input.fills.map((f) => ({ ...f }));
  const byIndex = new Map(rows.map((r) => [r.fillIndex, r]));
  const flowValuations = { ...input.flowValuations };
  let cashDifference = 0;
  // U4 §3.3: price/amount alone are ignored by R4's netAmount/balance anchors.
  // Translate only the known price difference in the ORIGINAL replay order;
  // preserve residuals, missing evidence, fees, positions and all NAV rules.
  for (const event of actual.replay) {
    const fill = fills[event.originalOrder];
    if (fill) {
      const row = byIndex.get(event.originalOrder);
      if (row) {
        const kind = classifyCode(fill.code);
        const factor =
          kind.instrument === "convertible" && kind.market === "sh" ? 10 : 1;
        const amount = row.vwap.value! * factor * fill.quantity;
        if (!Number.isFinite(amount) || amount <= 0)
          return unavailable(
            `${fill.tradeDate} ${fill.code} 反事实成交金额无效`,
          );
        const delta = (fill.kind === "buy" ? -1 : 1) * (amount - fill.amount);
        cashDifference += delta;
        fill.price = row.vwap.value!;
        fill.amount = amount;
        if (fill.netAmount !== null) fill.netAmount += delta;
      }
      if (fill.balanceCash !== null) fill.balanceCash += cashDifference;
    } else {
      const index = event.originalOrder - fills.length;
      if (flowValuations[index] !== undefined)
        flowValuations[index] += cashDifference;
    }
  }
  const counterfactual = reviewTradeNav({
    ...input,
    fills,
    openingCash: actual.openingCash,
    flowValuations,
  });
  // W11: diagnose known closing NAVs, never treat missing NAV as zero.
  const knownDays = counterfactual.days.filter((d) => d.nav.value !== null);
  const worst = knownDays.reduce<(typeof knownDays)[number] | null>(
    (lowest, day) =>
      lowest === null || day.nav.value! < lowest.nav.value! ? day : lowest,
    null,
  );
  const diagnostics = {
    counterfactualNonPositiveDays: knownDays.length
      ? knownDays.filter((d) => d.nav.value! <= 0).length
      : null,
    counterfactualWorstNav: worst
      ? { value: worst.nav.value!, date: worst.date }
      : null,
  };
  if (
    diagnostics.counterfactualNonPositiveDays &&
    diagnostics.counterfactualWorstNav
  ) {
    const { value, date } = diagnostics.counterfactualWorstNav;
    const reason = `反事实净值出现大幅非正值（最低 ${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元，日期 ${date}），期末差不可信，执行损耗在本账户上无法用当前反事实方法计算`;
    return {
      ...unavailable(reason),
      counterfactual,
      ...diagnostics,
      fallbackNote: reason,
      terminalDifference: metric(null, reason),
    };
  }
  const boundaries = (nav: typeof actual) =>
    JSON.stringify({
      segments: nav.segments.map((s) => [s.start, s.end, s.returnObservations]),
      days: nav.days.map((d) => [d.date, d.dailyReturn.value !== null]),
    });
  if (boundaries(actual) !== boundaries(counterfactual)) {
    const actualEnd = actual.days.at(-1);
    const otherEnd = counterfactual.days.at(-1);
    const fallbackNote = `分段 TWR 不可用（实际与 VWAP 反事实的收益分段边界不一致），改用期末总资产差；该口径含复利与路径影响，不是纯执行差异`;
    return {
      ...unavailable("实际与 VWAP 反事实的收益分段边界不一致"),
      counterfactual,
      ...diagnostics,
      fallbackNote,
      terminalDifference: metric(
        actualEnd &&
          otherEnd &&
          actualEnd.date === otherEnd.date &&
          actualEnd.nav.value !== null &&
          otherEnd.nav.value !== null
          ? actualEnd.nav.value - otherEnd.nav.value
          : null,
        "共同期末总资产不可得，不能计算期末总资产差",
      ),
    };
  }
  const segments = actual.segments.map((s, i) => {
    const other = counterfactual.segments[i]!;
    return {
      start: s.start,
      end: s.end,
      actualTwr: s.totalReturn,
      counterfactualTwr: other.totalReturn,
      loss: metric(
        s.totalReturn.value !== null && other.totalReturn.value !== null
          ? s.totalReturn.value - other.totalReturn.value
          : null,
        s.totalReturn.reason ?? other.totalReturn.reason ?? undefined,
      ),
    };
  });
  return {
    ...base,
    ...diagnostics,
    counterfactual,
    segments,
    loss: metric(
      actual.twr.value !== null && counterfactual.twr.value !== null
        ? actual.twr.value - counterfactual.twr.value
        : null,
      "全期 TWR 中断，参见同边界分段执行损耗与净值中断原因",
    ),
  };
}
