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
    // U4 §3.3 differs from R12: Shanghai bars are yuan/hand, statement price yuan/bond.
    const expected = fill.price * fill.quantity * factor;
    if (
      classification.instrument === "convertible" &&
      (!(expected > 0) ||
        !Number.isFinite(expected) ||
        Math.abs(fill.amount - expected) > Math.max(0.05, expected * 0.005))
    )
      vwap = metric(null, "可转债数量单位无法确认（沿用 R12 成交金额校验）");
    else if (vwap.value !== null) vwap = metric(vwap.value / factor);
    const price = metric(
      fill.price > 0 ? fill.price : null,
      "成交价格非正或无效",
    );
    const amount = metric(
      fill.amount > 0 ? fill.amount : null,
      "成交金额非正或无效",
    );
    const bp = metric(
      vwap.value !== null && price.value !== null
        ? ((fill.kind === "buy"
            ? price.value - vwap.value
            : vwap.value - price.value) /
            vwap.value) *
            10000
        : null,
      vwap.reason ?? price.reason ?? undefined,
    );
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
  const sum = (read: (row: ExecutionRow) => ReviewValue) => {
    const missing = rows.filter((r) => read(r).value === null);
    return metric(
      rows.length && !missing.length
        ? rows.reduce((s, r) => s + read(r).value!, 0)
        : null,
      missing.length
        ? `${missing.length} 笔数据不可得；合计留空`
        : "无符合条件的成交",
    );
  };
  const amount = sum((r) => r.amount);
  const slippageCost = sum((r) => r.slippageCost);
  const fees = Object.fromEntries(
    (
      ["commission", "stampTax", "transferFee", "otherFee", "total"] as const
    ).map((key) => [key, sum((r) => r.fees[key])]),
  ) as ExecutionRow["fees"];
  const totalCost = metric(
    fees.total.value !== null && slippageCost.value !== null
      ? fees.total.value + slippageCost.value
      : null,
    fees.total.reason ?? slippageCost.reason ?? undefined,
  );
  const ratio = (v: ReviewValue) =>
    metric(
      v.value !== null && amount.value !== null && amount.value > 0
        ? (v.value / amount.value) * 10000
        : null,
      v.reason ?? amount.reason ?? "成交额不可得",
    );
  return {
    count: rows.length,
    amount,
    fees,
    slippageCost,
    totalCost,
    averageSlippageBp: ratio(slippageCost),
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
    summary: summarizeExecution(rows),
    missingVwap,
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
  const boundaries = (nav: typeof actual) =>
    JSON.stringify({
      segments: nav.segments.map((s) => [s.start, s.end, s.returnObservations]),
      days: nav.days.map((d) => [d.date, d.dailyReturn.value !== null]),
    });
  if (boundaries(actual) !== boundaries(counterfactual))
    return {
      ...unavailable("实际与 VWAP 反事实的收益分段边界不一致"),
      counterfactual,
    };
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
