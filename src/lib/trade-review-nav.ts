import type { ParsedCashFlow, ParsedFill } from "./delivery-import";
import type { ReviewValue } from "./trade-review";
import { researchNavStatistics } from "./strategy-research";
import { dailyPerformance } from "./daily-performance";

export type NavDiagnostic = { date: string; reason: string };

type Close = { date: string; close: number };
export type TradeReviewNavInput = {
  /** One account. Statement balances use date + original row order; otherwise
   * time wins and input array order breaks ties (fills, then flows). */
  fills: readonly ParsedFill[];
  cashFlows: readonly ParsedCashFlow[];
  tradingDays: readonly string[];
  openingCash?: number;
  bars: Readonly<Record<string, readonly Close[]>>;
  annualRiskFreeRate?: number;
  benchmark?: readonly Close[];
  /** Exact whole-account NAV immediately BEFORE each external flow, by input index.
   * Required with holdings: a daily close cannot establish an intraday valuation. */
  flowValuations?: Readonly<Record<number, number>>;
};
const metric = (value: number | null, reason: string): ReviewValue =>
  value !== null && Number.isFinite(value)
    ? { value, reason: null }
    : { value: null, reason };
export type NavDay = {
  date: string;
  cash: ReviewValue;
  positions: Record<string, number>;
  marketValue: ReviewValue;
  reverseRepoPrincipal: ReviewValue;
  nav: ReviewValue;
  dailyReturn: ReviewValue;
};
type Point = { date: string; value: number };

function drawdowns(points: Point[]) {
  const result: {
    peakDate: string;
    troughDate: string;
    recoveryDate: string | null;
    recovered: boolean;
    underwaterTradingDays: number;
    drawdownTradingDays: number;
    recoveryTradingDays: number | null;
    drawdown: number;
  }[] = [];
  let peak = points[0]!;
  let peakIndex = 0;
  let troughIndex = 0;
  let active: (typeof result)[number] | null = null;
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!;
    // Chained floating-point returns can put an exact recovery a few ulps below its peak.
    if (
      point.value >= peak.value ||
      Math.abs(point.value - peak.value) <= Number.EPSILON * 8 * peak.value
    ) {
      if (active) {
        active.recoveryDate = point.date;
        active.recovered = true;
        active.recoveryTradingDays = index - troughIndex;
        result.push(active);
        active = null;
      }
      peak = point;
      peakIndex = index;
    } else {
      active ??= {
        peakDate: peak.date,
        troughDate: point.date,
        recoveryDate: null,
        recovered: false,
        underwaterTradingDays: 0,
        drawdownTradingDays: 0,
        recoveryTradingDays: null,
        drawdown: 0,
      };
      active.underwaterTradingDays++;
      const depth = 1 - point.value / peak.value;
      if (depth > active.drawdown) {
        active.drawdown = depth;
        active.troughDate = point.date;
        troughIndex = index;
        active.drawdownTradingDays = index - peakIndex;
      }
    }
  }
  if (active) result.push(active);
  return result.sort(
    (a, b) =>
      Number(a.recovered) - Number(b.recovered) ||
      b.drawdown - a.drawdown ||
      a.peakDate.localeCompare(b.peakDate),
  );
}

function statistics(
  points: Point[],
  rate: number,
  benchmark?: readonly Close[],
  includesOpening = false,
  unavailableReason?: string,
) {
  const values = points.slice(1).map((p) => p.value);
  const base = points[0]!;
  const stats = researchNavStatistics(base.value, values, rate);
  const returns = values.map((v, i) => v / points[i]!.value - 1);
  const rf = (1 + rate) ** (1 / 252) - 1;
  const mean = returns.length
    ? returns.reduce((s, r) => s + r - rf, 0) / returns.length
    : null;
  // Lower partial second moment: denominator is ALL daily returns, not only losses.
  const downside = returns.length
    ? Math.sqrt(
        returns.reduce((s, r) => s + Math.min(0, r - rf) ** 2, 0) /
          returns.length,
      )
    : 0;
  const annual = returns.length
    ? (points.at(-1)!.value / base.value) ** (252 / returns.length) - 1
    : null;
  // Benchmark comparisons retain matched close-to-close dates; the opening leg
  // has no benchmark observation and must not be compared against a daily close.
  const benchmarkPoints = includesOpening ? points.slice(1) : points;
  const benchmarkBase = benchmarkPoints[0]!;
  const benchmarkValues = benchmarkPoints.map((p) => {
    const matches = benchmark?.filter((b) => b.date === p.date);
    return matches?.length === 1 &&
      Number.isFinite(matches[0]!.close) &&
      matches[0]!.close > 0
      ? matches[0]!.close
      : null;
  });
  const missing = benchmarkPoints
    .filter((_, i) => benchmarkValues[i] === null)
    .map((p) => p.date);
  const benchmarkReturn =
    !missing.length && benchmarkPoints.length > 1
      ? benchmarkValues.at(-1)! / benchmarkValues[0]! - 1
      : null;
  const relative = !missing.length
    ? benchmarkPoints.map(
        (p, i) =>
          p.value /
          benchmarkBase.value /
          (benchmarkValues[i]! / benchmarkValues[0]!),
      )
    : null;
  const reason = benchmark
    ? `基准缺少有效唯一收盘价：${missing.join("、")}`
    : "未提供基准";
  return {
    start: base.date,
    end: points.at(-1)!.date,
    tradingDays: points.length - Number(includesOpening),
    returnObservations: returns.length,
    wbtStats: dailyPerformance({ returns, annualRiskFreeRate: rate }),
    totalReturn: metric(
      stats.totalReturn,
      unavailableReason ?? "无每日收益观察",
    ),
    maxDrawdown: metric(
      returns.length ? stats.maxDrawdown : null,
      unavailableReason ?? "无可得日度收益",
    ),
    sharpe: metric(
      stats.sharpe,
      unavailableReason ?? "不足两个每日收益或收益标准差为零",
    ),
    sortino: metric(
      mean !== null && downside > 0 ? (mean / downside) * Math.sqrt(252) : null,
      unavailableReason ?? "无每日收益或下行标准差为零",
    ),
    annualReturn: metric(annual, unavailableReason ?? "无每日收益或年化溢出"),
    calmar: metric(
      annual !== null && stats.maxDrawdown > 0
        ? annual / stats.maxDrawdown
        : null,
      unavailableReason ?? "无每日收益或最大回撤为零",
    ),
    // U3 §2.3 mentions two U1 baselines; the current core exposes only maxDrawdown.
    // Keep these same points and opening baseline; do not rebase to the first close.
    drawdowns: drawdowns(points),
    benchmark: {
      totalReturn: metric(
        benchmarkReturn,
        missing.length ? reason : "无每日收益观察",
      ),
      excessReturn: metric(
        benchmarkReturn !== null
          ? benchmarkPoints.at(-1)!.value / benchmarkBase.value -
              1 -
              benchmarkReturn
          : null,
        reason,
      ),
      relativeDrawdown: metric(
        relative && benchmarkPoints.length > 1
          ? researchNavStatistics(relative[0]!, relative.slice(1), rate)
              .maxDrawdown
          : null,
        missing.length ? reason : "无每日收益观察",
      ),
    },
  };
}

/** R4: raw closing prices, no inferred suspension/corporate action adjustment.
 * TWR links each pre-flow NAV / preceding post-flow NAV, then the closing leg.
 * Risk is computed on this flow-neutral wealth index, never on cash deposits.
 * Missing NAV or an unobservable flow valuation breaks continuity (invariants §2).
 */
export function reviewTradeNav(input: TradeReviewNavInput) {
  const rate = input.annualRiskFreeRate ?? 0.02;
  if (!Number.isFinite(rate) || rate <= -1) throw new Error("无风险利率无效");
  const calendar = [...new Set(input.tradingDays)].sort();
  if (
    calendar.some(
      (d) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) ||
        new Date(d).toISOString().slice(0, 10) !== d,
    )
  )
    throw new Error("交易日历日期无效");
  let cash: number | null = input.openingCash ?? 0;
  if (!Number.isFinite(cash)) throw new Error("期初现金无效");
  const warnings: string[] = [];
  const skippedFlows = new Map<string, number>();
  const statementOrder = input.fills.some(
    (f) => f.balanceCash !== null && Number.isFinite(f.balanceCash),
  );
  const events = [
    ...input.fills.map((fill, index) => ({
      date: fill.tradeDate,
      time: fill.tradeTime,
      row: fill.rowIndex,
      order: index,
      fill,
      flow: null,
      flowIndex: -1,
    })),
    ...input.cashFlows.map((flow, index) => ({
      date: flow.flowDate,
      time: flow.flowTime ?? null,
      row: flow.rowIndex,
      order: input.fills.length + index,
      fill: null,
      flow,
      flowIndex: index,
    })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (statementOrder ? a.row - b.row : 0) ||
      (a.time === null ? 1 : 0) - (b.time === null ? 1 : 0) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      a.order - b.order,
  );
  const missingTimeCount = events.filter((e) => !e.time).length;
  if (missingTimeCount)
    warnings.push(
      statementOrder
        ? `${missingTimeCount} 个事件缺少时间；交割单按日期升序、原始行序升序重放`
        : `${missingTimeCount} 个事件缺少时间，排在当日已知时间之后，同时间按输入原始顺序`,
    );
  // A caller-supplied calendar must cover all ledger events, including transfers.
  const outside = events.filter((e) => !calendar.includes(e.date));
  if (outside.length)
    throw new Error(
      `交易日历未覆盖事件日期：${[...new Set(outside.map((e) => e.date))].join("、")}`,
    );
  // Infer only from the first chronological event: later balances cannot establish
  // opening cash without reconstructing the intervening ledger.
  const first = events[0]?.fill;
  const inferredOpeningCash =
    first &&
    first.balanceCash !== null &&
    first.netAmount !== null &&
    Number.isFinite(first.balanceCash) &&
    Number.isFinite(first.netAmount)
      ? first.balanceCash - first.netAmount
      : null;
  if (inferredOpeningCash !== null) {
    if (input.openingCash === undefined) cash = inferredOpeningCash;
    else if (Math.abs(input.openingCash - inferredOpeningCash) > 0.005)
      warnings.push(
        `期初现金冲突：调用方 ${input.openingCash}，首笔余额反推 ${inferredOpeningCash}；保留调用方期初现金`,
      );
  }
  const openingCash = cash;
  const positions: Record<string, number> = {};
  const repoPrincipals = new Map<string, number>();
  const repoReasons = new Map<string, string>();
  const repoPrincipal = () =>
    repoReasons.size
      ? null
      : [...repoPrincipals.values()].reduce((sum, value) => sum + value, 0);
  let minimumCash = cash;
  let minimumDate: string | null = calendar[0] ?? null;
  let cashUnknown = false;
  const positionReasons = new Map<string, string>();
  // Cash-flow codes and fill symbols can name the same security. Match only
  // exact codes; subscription codes must never be mapped to listed securities.
  const flowSecurity = (code: string | null) => {
    if (!code) return "未识别证券";
    const keys = new Set(
      input.fills.filter((f) => f.code === code).map((f) => f.symbol ?? f.code),
    );
    return keys.size === 1 ? [...keys][0]! : code;
  };
  let minimumFromStatement = false;
  let previousNav: number | null = cash;
  const days: NavDay[] = [];
  let cursor = 0;
  const replay: {
    date: string;
    time: string | null;
    originalOrder: number;
    cash: number | null;
  }[] = [];
  for (const date of calendar) {
    let denominator = previousNav;
    let factor = 1;
    let returnReason: string | null =
      previousNav === null
        ? "上一交易日净值不可得，连续段中断"
        : previousNav <= 0
          ? `${date} 期初净值非正（${previousNav}），收益率无定义`
          : null;
    while (events[cursor]?.date === date) {
      const e = events[cursor++]!;
      const f = e.fill;
      if (f) {
        // Repo legs are not reliably labelled: the real statement records both
        // the lend and the repayment as 卖出. The signed cash movement is the
        // only trustworthy direction — negative means cash left the account
        // (lending out), positive means it came back (repayment).
        const out =
          f.instrument === "reverseRepo"
            ? Number.isFinite(f.netAmount ?? NaN)
              ? f.netAmount! < 0
              : f.kind === "sell"
            : f.kind === "buy";
        let delta = f.netAmount;
        if (delta === null || !Number.isFinite(delta)) {
          delta =
            Number.isFinite(f.amount) &&
            f.amount >= 0 &&
            f.fees.total !== null &&
            Number.isFinite(f.fees.total) &&
            f.fees.total >= 0
              ? (out ? -f.amount : f.amount) - f.fees.total
              : null;
          warnings.push(
            `成交 ${e.order}：实际资金发生额缺失，${delta === null ? "费用分项亦不可得" : "退回成交金额±实际费用分项合计"}`,
          );
        }
        const projected: number | null =
          cash !== null && delta !== null ? cash + delta : null;
        if (f.balanceCash !== null && Number.isFinite(f.balanceCash)) {
          if (
            projected === null ||
            Math.abs(f.balanceCash - projected) > 0.005
          ) {
            const reason = `${date} 原始行 ${f.rowIndex} 资金余额 ${f.balanceCash} 与推算现金 ${projected ?? "未知"} 差异 ${projected === null ? "无法计算" : (f.balanceCash - projected).toFixed(2)}；采用柜台资金余额，待核对`;
            warnings.push(reason);
            returnReason = reason;
          }
          cash = f.balanceCash;
        } else cash = projected;
        const key = f.symbol ?? f.code;
        if (f.instrument === "reverseRepo") {
          // docs/tasks/r11-repo-principal.md: repayment amounts include interest.
          const faceValue = f.code.startsWith("204")
            ? 1000
            : f.code.startsWith("131")
              ? 100
              : null;
          const principalDelta = f.quantity * (faceValue ?? NaN);
          const principal =
            (repoPrincipals.get(f.code) ?? 0) +
            (out ? principalDelta : -principalDelta);
          const reason =
            faceValue === null
              ? `${date} ${f.code} 原始行 ${f.rowIndex} 逆回购无法确定面值，本金未知`
              : !Number.isFinite(f.quantity) ||
                  f.quantity <= 0 ||
                  !Number.isFinite(principal)
                ? `${date} ${f.code} 原始行 ${f.rowIndex} 逆回购数量无效或本金溢出，本金未知`
                : principal < 0
                  ? `${date} ${f.code} 原始行 ${f.rowIndex} 未到期逆回购本金为负（${principal}），回款多于融出或记录不全`
                  : null;
          if (reason) {
            repoReasons.set(f.code, reason);
            warnings.push(reason);
          }
          // Later lending cannot prove that missing opening principal was repaired.
          repoPrincipals.set(f.code, principal);
        } else if (!Number.isFinite(f.quantity) || f.quantity <= 0)
          positionReasons.set(
            key,
            `${date} ${key} 成交 ${e.order} 数量无效，持仓未知`,
          );
        else {
          positions[key] =
            (positions[key] ?? 0) + (out ? f.quantity : -f.quantity);
          if (positions[key] < 0)
            positionReasons.set(
              key,
              `${date} ${key} 超卖，期初持仓或股份流水缺失`,
            );
          if (positions[key] === 0) delete positions[key];
        }
        // A statement share balance is evidence at this event, never a license
        // to reconstruct earlier holdings. Arithmetic zero after an unknown
        // movement alone is not proof of liquidation.
        if (
          f.instrument !== "reverseRepo" &&
          f.balanceShares !== null &&
          Number.isFinite(f.balanceShares) &&
          f.balanceShares >= 0
        ) {
          const wasUnknown = positionReasons.has(key);
          const differs = (positions[key] ?? 0) !== f.balanceShares;
          if (f.balanceShares === 0) delete positions[key];
          else positions[key] = f.balanceShares;
          positionReasons.delete(key);
          if (wasUnknown || differs) {
            const reason = `${date} ${key} 原始行 ${f.rowIndex} 柜台股份余额 ${f.balanceShares}，持仓恢复确定；此前未知期间不回填`;
            warnings.push(reason);
            returnReason = reason;
          }
        }
      } else {
        const flow = e.flow!;
        // Subscription payments never establish a share movement. Other kinds
        // retain quantity/summary evidence even when their cash amount is zero.
        const shareEvidence =
          (flow.quantity != null && flow.quantity !== 0) ||
          /送股|转增|送转|红股|股份|证券转入|证券转出|证券划入|证券划出|中签|入库|出库|配股到账/.test(
            flow.summary,
          );
        const ignored = flow.amount === 0 && !shareEvidence;
        if (ignored)
          skippedFlows.set(flow.kind, (skippedFlows.get(flow.kind) ?? 0) + 1);
        if (
          !ignored &&
          (flow.kind === "transferIn" || flow.kind === "transferOut")
        ) {
          const before = repoReasons.size
            ? null
            : Object.keys(positions).length === 0 && !positionReasons.size
              ? cash === null
                ? null
                : cash + repoPrincipal()!
              : (input.flowValuations?.[e.flowIndex] ?? null);
          if (before === null || !Number.isFinite(before))
            returnReason = `${date} 资金流水 ${e.flowIndex} 缺少出入金前账户估值`;
          else if (denominator !== null && denominator > 0 && before > 0)
            factor *= before / denominator;
          else returnReason ??= `${date} TWR 分母非正或不可得`;
          denominator = before === null ? null : before + flow.amount;
        }
        if (
          !ignored &&
          flow.kind !== "subscription" &&
          (shareEvidence || flow.kind === "neutral")
        )
          positionReasons.set(
            flowSecurity(flow.code),
            `${date} ${flowSecurity(flow.code)} ${flow.kind} 流水缺少可确认的股份变动，持仓未知`,
          );
        cash =
          cash !== null && Number.isFinite(flow.amount)
            ? cash + flow.amount
            : null;
      }
      if (cash !== null && !Number.isFinite(cash)) cash = null;
      if (cash === null) cashUnknown = true;
      if (cash !== null && cash < minimumCash) {
        minimumCash = cash;
        minimumDate = date;
        minimumFromStatement = e.fill?.balanceCash === cash;
      }
      replay.push({ date, time: e.time, originalOrder: e.order, cash });
    }
    let marketValue: number | null = positionReasons.size ? null : 0;
    const reasons = [...positionReasons.values()];
    for (const [key, quantity] of Object.entries(positions)) {
      const matches = input.bars[key]?.filter((b) => b.date === date);
      if (
        matches?.length !== 1 ||
        !Number.isFinite(matches[0]!.close) ||
        matches[0]!.close <= 0
      ) {
        marketValue = null;
        reasons.push(`${date} ${key} 缺少有效唯一收盘价`);
      } else if (marketValue !== null)
        marketValue += quantity * matches[0]!.close;
    }
    const principal = repoPrincipal();
    const nav =
      cash !== null && marketValue !== null && principal !== null
        ? cash + marketValue + principal
        : null;
    const navMetric = metric(
      nav,
      cash === null
        ? "现金流水不完整"
        : [...reasons, ...repoReasons.values()].join("；"),
    );
    const daily =
      !returnReason &&
      navMetric.value !== null &&
      navMetric.value > 0 &&
      denominator !== null &&
      denominator > 0
        ? (factor * navMetric.value) / denominator - 1
        : null;
    days.push({
      date,
      cash: metric(cash, "实际资金变动不可得，后续现金未知"),
      positions: { ...positions },
      marketValue: metric(marketValue, reasons.join("；") || "市值溢出"),
      reverseRepoPrincipal: metric(
        principal,
        [...repoReasons.values()].join("；") || "逆回购本金溢出",
      ),
      nav: navMetric,
      dailyReturn: metric(
        daily,
        returnReason ?? navMetric.reason ?? "净值或TWR分母非正",
      ),
    });
    previousNav = navMetric.value;
  }
  if (skippedFlows.size)
    warnings.push(
      `跳过 ${[...skippedFlows.values()].reduce((a, b) => a + b, 0)} 笔零金额且无股份变动证据的流水（${[...skippedFlows].map(([kind, count]) => `${kind}：${count} 笔`).join("、")}）；现金与持仓不变`,
    );
  if (minimumCash < 0)
    warnings.push(
      `最低已知现金 ${minimumCash}（${minimumDate}）为负：${minimumFromStatement ? "该负值来自柜台余额序列，通常意味着当日有交割单之外的资金流入未被记录，不是账户透支" : "期初资金假设或流水不完整"}；未自动调整期初现金`,
    );
  const segments: ReturnType<typeof statistics>[] = [];
  let points: Point[] = [];
  let includesOpening = false;
  let unavailableReason: string | undefined;
  const finish = () => {
    if (points.length)
      segments.push(
        statistics(
          points,
          rate,
          input.benchmark,
          includesOpening,
          unavailableReason,
        ),
      );
    points = [];
    includesOpening = false;
    unavailableReason = undefined;
  };
  for (const day of days) {
    if (day.nav.value === null || day.nav.value <= 0) {
      finish();
      if (day.nav.value !== null)
        segments.push(
          statistics(
            [{ date: day.date, value: 1 }],
            rate,
            input.benchmark,
            false,
            day.dailyReturn.reason ?? "净值非正，收益率无定义",
          ),
        );
      continue;
    }
    if (day.dailyReturn.value === null) {
      finish();
      unavailableReason = day.dailyReturn.reason ?? undefined;
    } else if (!points.length) {
      // Include the known opening-to-close return, including on a one-day calendar.
      points.push({ date: day.date, value: 1 });
      includesOpening = true;
    }
    if (day.dailyReturn.value !== null) unavailableReason = undefined;
    points.push({
      date: day.date,
      value: points.length
        ? points.at(-1)!.value * (1 + day.dailyReturn.value!)
        : 1,
    });
  }
  finish();
  const skippedIntervals: { start: string; end: string; reason: string }[] = [];
  for (const day of days) {
    const reason =
      day.nav.reason ??
      (day.nav.value !== null && day.nav.value <= 0
        ? "净值非正"
        : day.dailyReturn.reason);
    if (!reason) continue;
    const last = skippedIntervals.at(-1);
    if (
      last &&
      last.reason === reason &&
      calendar.indexOf(last.end) + 1 === calendar.indexOf(day.date)
    )
      last.end = day.date;
    else skippedIntervals.push({ start: day.date, end: day.date, reason });
  }
  const compound = (
    rows: NavDay[],
  ): ReviewValue & { reasons: NavDiagnostic[] } => {
    const reasons = rows
      .filter((d) => d.dailyReturn.value === null)
      .map((d) => ({
        date: d.date,
        reason: d.dailyReturn.reason ?? "收益不可得",
      }));
    return {
      ...metric(
        rows.length && rows.every((d) => d.dailyReturn.value !== null)
          ? rows.reduce((v, d) => v * (1 + d.dailyReturn.value!), 1) - 1
          : null,
        reasons.length ? `共 ${reasons.length} 条收益中断原因` : "无每日收益",
      ),
      reasons,
    };
  };
  return {
    days,
    openingCash,
    inferredOpeningCash,
    replay,
    warnings,
    missingTimeCount,
    minimumCash: metric(
      cashUnknown ? null : minimumCash,
      "部分现金不可得，无法确定全程最低值",
    ),
    minimumDate: cashUnknown ? null : minimumDate,
    lowestKnownCash: { value: minimumCash, date: minimumDate },
    twr: compound(days),
    segments,
    skippedIntervals,
    usedTradingDays: segments
      .filter((s) => s.returnObservations > 0)
      .reduce((s, p) => s + p.tradingDays, 0),
    usedReturnObservations: segments.reduce(
      (s, p) => s + p.returnObservations,
      0,
    ),
    monthlyReturns: [...new Set(calendar.map((d) => d.slice(0, 7)))].map(
      (month) => {
        const rows = days.filter((d) => d.date.startsWith(month));
        return { month, tradingDays: rows.length, return: compound(rows) };
      },
    ),
    basis: {
      reverseRepo:
        "逆回购本金按面值计价：数量 × 面值（204 前缀为 1000 元，131 前缀为 100 元，未知前缀无法确定面值并留空），不使用成交金额计算本金；未到期本金计入资产，不计持仓市值、不使用行情报价；不计应计利息，利息在回款日确认为收益（回款净额减数量 × 面值），融出费用为当期成本；本金异常后留空，不以后续融出抵消缺失记录",
      annualization: 252,
      annualRiskFreeRate: rate,
      returns:
        "日度TWR = Π(每次流前净值/上一流后净值) × 收盘净值/最后流后净值 - 1；首个分母为上一日收盘（首日期初现金）；无外部流水时为收盘/期初-1。无证券持仓时用重放现金加已知逆回购本金估值，证券持仓必须提供逐笔流前账户估值，缺失按日期和流水编号留空；期初或流后分母非正留空；分红、利息、费用为内部收益",
      risk: "全部分段指标使用同一日度TWR连乘曲线，起点归一为1；包含可得的首日收益，缺失日仅作后续段收盘基点，不跨缺口；非正净值日指标留空；收益为小数",
      monthly:
        "月度与全期TWR均连乘对应日度收益；任一天不可得则整月留空并列出日期及原因；收盘净值可得不等于盘中流前估值可得",
      sortino:
        "日超额收益均值 / sqrt(sum(min(日收益-日无风险利率,0)^2)/全部日收益数) × sqrt(252)",
      calmar:
        "(Π(1+日度TWR)^(252/日收益数)-1) / 剔除资金流累计收益曲线的最大回撤",
      underwater: "严格低于前峰的收盘交易日数，不含恢复日",
      benchmark:
        "基准比较使用匹配日期的首日收盘至末日收盘，不含账户首日期初至收盘收益；超额=该区间账户TWR-基准收益；相对回撤来自(账户财富指数/基准财富指数)",
    },
  };
}
