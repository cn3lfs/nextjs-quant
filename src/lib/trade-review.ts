import type { ParsedCashFlow, ParsedFill } from "./delivery-import";
import type { Bar } from "./domain";
import { researchTradeStatistics } from "./strategy-research";

export const costMethods = ["movingAverage", "fifo"] as const;
export type CostMethod = (typeof costMethods)[number];
export type ReviewValue = { value: number | null; reason: string | null };
const value = (n: number | null, reason = "数据不可得"): ReviewValue =>
  n !== null && Number.isFinite(n)
    ? { value: n, reason: null }
    : { value: null, reason };
const sum = (ns: readonly (number | null)[]) =>
  ns.some((n) => n === null) ? null : ns.reduce<number>((s, n) => s + n!, 0);
const key = (f: ParsedFill) => f.symbol ?? f.code;
const dayCount = (a: string, b: string) =>
  (Date.parse(b) - Date.parse(a)) / 86400000;

export type ReviewFeeSource = {
  fillIndex: number;
  amount: number | null;
  /** Actual cash movement, parsed component total, or unavailable evidence. */
  source: "netAmount" | "components" | "missing";
  warnings: string[];
};
// Cash sign is authoritative for repos; broker operation labels can conflict.
// See docs/invariants.md, W8.
function repoDirection(f: ParsedFill) {
  return f.netAmount === null ||
    !Number.isFinite(f.netAmount) ||
    f.netAmount === 0
    ? null
    : f.netAmount < 0
      ? 1
      : -1;
}
function actualFees(f: ParsedFill, fillIndex: number): ReviewFeeSource {
  const warnings: string[] = [];
  const direction = f.instrument === "reverseRepo" ? repoDirection(f) : null;
  if (f.instrument === "reverseRepo") {
    if (direction === null)
      warnings.push(
        `成交 ${fillIndex}（${f.code}）：逆回购方向不可判，发生金额缺失、非有限或为零`,
      );
    else if ((direction === 1) !== (f.kind === "sell"))
      warnings.push(
        `成交 ${fillIndex}（${f.code}）：操作列与资金方向不一致，以资金方向为准`,
      );
  }
  if (
    f.netAmount !== null &&
    Number.isFinite(f.netAmount) &&
    (f.instrument !== "reverseRepo" || direction !== null)
  ) {
    const outflow =
      f.instrument === "reverseRepo" ? direction === 1 : f.kind === "buy";
    const inferred = outflow
      ? Math.abs(f.netAmount) - f.amount
      : f.amount - f.netAmount;
    if (Number.isFinite(inferred) && inferred >= 0)
      return { fillIndex, amount: inferred, source: "netAmount", warnings };
    warnings.push(
      `成交 ${fillIndex}：发生金额反推费用为负或无效，退回费用分项`,
    );
  }
  const amount = f.fees.total;
  return {
    fillIndex,
    amount,
    source: amount === null ? "missing" : "components",
    warnings,
  };
}

export type TradeReviewInput = {
  /** One account at a time; the storage caller must not merge account ledgers. */
  fills: readonly ParsedFill[];
  cashFlows?: readonly ParsedCashFlow[];
  /** Caller-confirmed issuance mapping; quantity is required when multiple sales exist. */
  subscriptions?: readonly {
    cashFlowIndex: number;
    security: string;
    quantity: number;
    evidence: string;
  }[];
  /** Complete market calendar, not the security's potentially suspended bar dates. */
  tradingDays?: readonly string[];
  bars?: Readonly<Record<string, readonly Bar[]>>;
  exRightsEvents?: readonly { security: string; date: string }[];
};
type Lot = {
  quantity: number;
  amount: number;
  fees: number | null;
  date: string;
};
export type ReviewRealization = {
  fillIndex: number;
  date: string;
  quantity: number;
  buyAmount: number | null;
  buyFees: number | null;
  sellAmount: number;
  sellFees: number | null;
  netProfit: ReviewValue;
  netReturn: ReviewValue;
};
export type ReviewRound = {
  security: string;
  instrument: ParsedFill["instrument"];
  costMethod: CostMethod;
  openingDate: string | null;
  closingDate: string | null;
  holdingCalendarDays: ReviewValue;
  holdingTradingDays: ReviewValue;
  buyAveragePrice: ReviewValue;
  sellAveragePrice: ReviewValue;
  quantity: number;
  remainingQuantity: number;
  remainingCost: ReviewValue;
  totalFees: ReviewValue;
  feeSources: ReviewFeeSource[];
  grossProfit: ReviewValue;
  netProfit: ReviewValue;
  netReturn: ReviewValue;
  costBasis: string;
  openingUnknown: boolean;
  crossesExRights: boolean | null;
  warnings: string[];
  fillIndices: number[];
  realizations: ReviewRealization[];
};

/** Flat-to-flat episodes are the win-rate unit. Per-sale realizations expose
 * the cost-method difference without counting partial exits as extra rounds.
 * Return denominator is all opening purchase amounts plus actual buy fees.
 * No corporate-action adjustments: R3 explicitly reports raw-price returns. */
export function reviewTrades(input: TradeReviewInput) {
  const feeSources = input.fills.map(actualFees);
  const ordered = input.fills
    .map((fill, index) => ({ fill, index }))
    .sort(
      (a, b) =>
        a.fill.tradeDate.localeCompare(b.fill.tradeDate) ||
        (a.fill.tradeTime ?? "").localeCompare(b.fill.tradeTime ?? "") ||
        a.fill.rowIndex - b.fill.rowIndex ||
        a.index - b.index,
    );
  const replayRank = new Map(ordered.map((entry, rank) => [entry.index, rank]));
  const exceptions = ordered
    .filter(
      ({ fill }) =>
        fill.anomalies.length ||
        !Number.isFinite(fill.quantity) ||
        fill.quantity <= 0 ||
        !Number.isFinite(fill.amount) ||
        fill.amount < 0 ||
        !Number.isFinite(fill.price) ||
        fill.price <= 0,
    )
    .map((x) => ({
      ...x,
      reason: x.fill.anomalies.join("；") || "成交数值无效",
    }));
  const invalid = new Set(
    exceptions
      .filter(
        (x) =>
          !Number.isFinite(x.fill.quantity) ||
          x.fill.quantity <= 0 ||
          !Number.isFinite(x.fill.amount) ||
          x.fill.amount < 0 ||
          !Number.isFinite(x.fill.price) ||
          x.fill.price <= 0,
      )
      .map((x) => x.index),
  );
  const repos = ordered.filter((x) => x.fill.instrument === "reverseRepo");
  const repoCash = repos.map((x) => x.fill.netAmount);
  const reverseRepo = {
    unknownDirectionCount: repos.filter((x) => repoDirection(x.fill) === null)
      .length,
    basis:
      "资金占用为累计实际融出现金（含费用），非峰值；利息为全部购回后的净现金收入",
    fills: repos,
    totalFees: value(
      sum(repos.map((x) => feeSources[x.index]!.amount)),
      "实际费用缺失",
    ),
    feeSources: repos.map((x) => feeSources[x.index]!),
    warnings: repos.flatMap((x) => [
      ...x.fill.anomalies,
      ...feeSources[x.index]!.warnings,
    ]),
    capitalCommitted: value(
      sum(
        repoCash
          .filter((n) => n === null || n < 0)
          .map((n) => (n === null ? null : -n)),
      ),
      "逆回购缺实际资金发生额",
    ),
    netCashFlow: value(sum(repoCash), "逆回购缺实际资金发生额"),
    interestIncome: value(
      [...new Set(repos.map((x) => key(x.fill)))].some(
        (security) =>
          repos
            .filter((x) => key(x.fill) === security)
            .some((x) => repoDirection(x.fill) === null) ||
          repos
            .filter((x) => key(x.fill) === security)
            .reduce(
              (s, x) => s + repoDirection(x.fill)! * x.fill.quantity,
              0,
            ) !== 0,
      )
        ? null
        : sum(repoCash),
      "逆回购尚未全部购回或缺实际资金发生额（含方向不可判）",
    ),
  };
  const results = costMethods.map((costMethod) => {
    const closedRounds: ReviewRound[] = [],
      openPositions: ReviewRound[] = [];
    const usedFlows = new Set<number>();
    const securities = [
      ...new Set(
        ordered
          .filter((x) => x.fill.instrument !== "reverseRepo")
          .map((x) => key(x.fill)),
      ),
    ];
    for (const security of securities) {
      const entries = ordered.filter(
        (x) =>
          key(x.fill) === security &&
          x.fill.instrument !== "reverseRepo" &&
          !invalid.has(x.index),
      );
      let lots: Lot[] = [],
        active: {
          fills: typeof entries;
          openingDate: string | null;
          bought: number;
          amount: number;
          fees: (number | null)[];
          sales: ReviewRealization[];
          unknown: boolean;
        } | null = null;
      const finish = (closingDate: string | null) => {
        if (!active) return;
        const a = active,
          end =
            closingDate ??
            [
              entries.at(-1)!.fill.tradeDate,
              input.bars?.[security]?.at(-1)?.date ?? "",
            ]
              .sort()
              .at(-1)!;
        const sold = a.sales.reduce((s, r) => s + r.quantity, 0),
          sellAmount = a.sales.reduce((s, r) => s + r.sellAmount, 0);
        const buyFees = sum(a.fees),
          sellFees = sum(a.sales.map((r) => r.sellFees));
        const fees = a.unknown ? null : sum([buyFees, sellFees]);
        const gross = a.unknown || !closingDate ? null : sellAmount - a.amount;
        const net = gross === null || fees === null ? null : gross - fees;
        const reason = a.unknown
          ? "开仓成本未知"
          : !closingDate
            ? "未平仓"
            : "实际费用缺失";
        const events = input.exRightsEvents;
        const crosses =
          a.openingDate === null || events === undefined
            ? null
            : events.some(
                (e) =>
                  e.security === security &&
                  e.date > a.openingDate! &&
                  e.date <= end,
              );
        const calendar = input.tradingDays
          ? [...new Set(input.tradingDays)].sort()
          : null;
        const holding =
          a.openingDate &&
          calendar?.includes(a.openingDate) &&
          calendar.includes(end)
            ? calendar.filter((d) => d > a.openingDate! && d <= end).length
            : null;
        const round: ReviewRound = {
          security,
          instrument: entries[0]!.fill.instrument,
          costMethod,
          openingDate: a.openingDate,
          closingDate,
          holdingCalendarDays: value(
            a.openingDate ? dayCount(a.openingDate, end) : null,
            "开仓日期未知",
          ),
          holdingTradingDays: value(holding, "完整交易日历或起止交易日不可得"),
          buyAveragePrice: value(
            a.unknown || !a.bought ? null : a.amount / a.bought,
            "开仓成本未知",
          ),
          sellAveragePrice: value(sold ? sellAmount / sold : null, "尚无卖出"),
          quantity: a.bought || sold,
          remainingQuantity: lots.reduce((s, l) => s + l.quantity, 0),
          remainingCost: value(
            sum(lots.map((l) => (l.fees === null ? null : l.amount + l.fees))),
            "剩余买入费用缺失",
          ),
          totalFees: value(fees, a.unknown ? "开仓费用未知" : "实际费用缺失"),
          feeSources: a.fills.map((x) => feeSources[x.index]!),
          grossProfit: value(gross, reason),
          netProfit: value(net, reason),
          netReturn: value(
            net !== null && buyFees !== null && a.amount + buyFees > 0
              ? net / (a.amount + buyFees)
              : null,
            reason,
          ),
          costBasis:
            "买入成交金额 + 实际买入费用；中签按实付扣款，收益率为小数",
          openingUnknown: a.unknown,
          crossesExRights: crosses,
          warnings: [
            ...(crosses
              ? ["未复权，不代表经济收益"]
              : crosses === null
                ? ["除权证据或开仓日期不可得"]
                : []),
            ...a.fills.flatMap((x) => x.fill.anomalies),
            ...a.fills.flatMap((x) => feeSources[x.index]!.warnings),
          ],
          fillIndices: a.fills.map((x) => x.index),
          realizations: a.sales,
        };
        (closingDate ? closedRounds : openPositions).push(round);
        active = null;
      };
      for (const entry of entries) {
        const f = entry.fill;
        const actualFee = feeSources[entry.index]!.amount;
        active ??= {
          fills: [],
          openingDate: f.kind === "buy" ? f.tradeDate : null,
          bought: 0,
          amount: 0,
          fees: [],
          sales: [],
          unknown: false,
        };
        active.fills.push(entry);
        if (f.kind === "buy") {
          lots.push({
            quantity: f.quantity,
            amount: f.amount,
            fees: actualFee,
            date: f.tradeDate,
          });
          active.bought += f.quantity;
          active.amount += f.amount;
          active.fees.push(actualFee);
          continue;
        }
        let available = lots.reduce((s, l) => s + l.quantity, 0);
        if (available < f.quantity) {
          const candidates = (input.cashFlows ?? [])
            .map((flow, index) => ({
              flow,
              index,
              link: input.subscriptions?.find(
                (l) =>
                  l.cashFlowIndex === index &&
                  l.security === security &&
                  l.evidence.trim(),
              ),
            }))
            .filter(
              (x) =>
                !usedFlows.has(x.index) &&
                x.flow.kind === "subscription" &&
                x.flow.amount < 0 &&
                x.flow.flowDate <= f.tradeDate &&
                (x.link || x.flow.code === f.code),
            );
          const candidate = candidates.length === 1 ? candidates[0] : undefined;
          // A code alone proves identity, not allotment size. Infer size only
          // for a lone sell; all more complex allotments need explicit evidence.
          const qty =
            candidate?.link?.quantity ??
            (entries.length === 1 ? f.quantity : 0);
          if (
            candidate &&
            Number.isFinite(qty) &&
            qty >= f.quantity - available &&
            qty > 0
          ) {
            usedFlows.add(candidate.index);
            lots.push({
              quantity: qty,
              amount: -candidate.flow.amount,
              fees: 0,
              date: candidate.flow.flowDate,
            });
            active.bought += qty;
            active.amount -= candidate.flow.amount;
            active.fees.push(0);
            active.openingDate =
              active.openingDate === null ||
              candidate.flow.flowDate < active.openingDate
                ? candidate.flow.flowDate
                : active.openingDate;
            available += qty;
          }
        }
        const unknown = available < f.quantity;
        active.unknown ||= unknown;
        let amount = 0,
          fees: number | null = 0,
          needed = Math.min(available, f.quantity);
        if (costMethod === "movingAverage") {
          const fraction = available ? needed / available : 0;
          const allAmount = lots.reduce((s, l) => s + l.amount, 0);
          amount = allAmount * fraction;
          const allFees = sum(lots.map((l) => l.fees));
          fees = allFees === null ? null : allFees * fraction;
          // Collapse into a single pool. Quantity only uses exact integer
          // additions/subtractions; never scale individual lot quantities.
          lots =
            available === needed
              ? []
              : [
                  {
                    quantity: available - needed,
                    amount: allAmount - amount,
                    fees: allFees === null ? null : allFees - fees!,
                    date: lots[0]!.date,
                  },
                ];
        } else {
          while (needed > 1e-8 && lots.length) {
            const lot = lots[0]!,
              take = Math.min(needed, lot.quantity),
              fraction = take / lot.quantity;
            amount += lot.amount * fraction;
            fees =
              fees === null || lot.fees === null
                ? null
                : fees + lot.fees * fraction;
            lot.amount *= 1 - fraction;
            if (lot.fees !== null) lot.fees *= 1 - fraction;
            lot.quantity -= take;
            needed -= take;
            if (lot.quantity < 1e-8) lots.shift();
          }
        }
        const cost = unknown || fees === null ? null : amount + fees;
        const net =
          cost === null || actualFee === null
            ? null
            : f.amount - actualFee - cost;
        active.sales.push({
          fillIndex: entry.index,
          date: f.tradeDate,
          quantity: f.quantity,
          buyAmount: unknown ? null : amount,
          buyFees: unknown ? null : fees,
          sellAmount: f.amount,
          sellFees: actualFee,
          netProfit: value(net, unknown ? "开仓成本未知" : "实际费用缺失"),
          netReturn: value(
            net !== null && cost !== null && cost > 0 ? net / cost : null,
            unknown ? "开仓成本未知" : "实际费用缺失或成本非正",
          ),
        });
        if (!lots.length) finish(f.tradeDate);
      }
      finish(null);
    }
    closedRounds.sort(
      (a, b) =>
        a.closingDate!.localeCompare(b.closingDate!) ||
        replayRank.get(a.fillIndices.at(-1)!)! -
          replayRank.get(b.fillIndices.at(-1)!)!,
    );
    const group = (getKey: (r: ReviewRound) => string) =>
      Object.fromEntries(
        [...new Set(closedRounds.map(getKey))].map((k) => [
          k,
          reviewStatistics(closedRounds.filter((r) => getKey(r) === k)),
        ]),
      );
    return {
      costMethod,
      closedRounds,
      openPositions,
      statistics: reviewStatistics(closedRounds),
      groups: {
        description: "描述性分组，不声称因果",
        bySecurity: group((r) => r.security),
        byInstrument: group((r) => r.instrument),
        byHoldingPeriod: group((r) =>
          r.holdingTradingDays.value === null
            ? "unknown"
            : r.holdingTradingDays.value <= 5
              ? "0-5"
              : r.holdingTradingDays.value <= 20
                ? "6-20"
                : "21+",
        ),
      },
      unmatchedCashFlows: (input.cashFlows ?? [])
        .map((flow, index) => ({
          flow,
          index,
          reason: "未用于可确认的中签建仓",
        }))
        .filter((x) => !usedFlows.has(x.index)),
    };
  });
  const movingAverage = results[0]!,
    fifo = results[1]!;
  return {
    defaultCostMethod: "movingAverage" as const,
    movingAverage,
    fifo,
    reverseRepo,
    exceptions,
    tradePoints: analyzeTradePoints(
      input,
      movingAverage.closedRounds.concat(movingAverage.openPositions),
    ),
  };
}

export function reviewStatistics(rounds: readonly ReviewRound[]) {
  const valid = rounds.filter(
    (r) =>
      r.closingDate !== null &&
      r.netReturn.value !== null &&
      r.netProfit.value !== null,
  );
  const profits = valid.map((r) => r.netProfit.value!);
  const gain = profits.filter((n) => n > 0).reduce((s, n) => s + n, 0),
    loss = -profits.filter((n) => n < 0).reduce((s, n) => s + n, 0);
  let win = 0,
    lose = 0,
    maxWin = 0,
    maxLose = 0;
  for (const r of rounds) {
    const n = r.closingDate ? r.netProfit.value : null;
    win = n !== null && n > 0 ? win + 1 : 0;
    lose = n !== null && n < 0 ? lose + 1 : 0;
    maxWin = Math.max(maxWin, win);
    maxLose = Math.max(maxLose, lose);
  }
  const gross = valid.reduce((s, r) => s + r.grossProfit.value!, 0),
    fees = valid.reduce((s, r) => s + r.totalFees.value!, 0);
  return {
    ...researchTradeStatistics(valid.map((r) => r.netReturn.value!)),
    excludedCount: rounds.length - valid.length,
    unavailableReason: valid.length ? null : "无可计算的已平仓回合",
    profitFactor: value(loss > 0 ? gain / loss : null, "无亏损样本"),
    maxConsecutiveWins: maxWin,
    maxConsecutiveLosses: maxLose,
    largestWin: value(
      profits.some((n) => n > 0)
        ? Math.max(...profits.filter((n) => n > 0))
        : null,
      "无盈利样本",
    ),
    largestLoss: value(
      profits.some((n) => n < 0)
        ? Math.min(...profits.filter((n) => n < 0))
        : null,
      "无亏损样本",
    ),
    feesToGrossProfit: value(
      valid.length && gross > 0 ? fees / gross : null,
      "已平仓有效样本合计毛利非正或不可得",
    ),
    feesToGrossProfitBasis:
      "有效已平仓回合总费用 / 合计毛利（含毛亏损）；分母非正时不可估",
  };
}

export const positionWindows = [20, 60, 250] as const;
export const afterSaleHorizons = [1, 5, 10, 20] as const;
export function analyzeTradePoints(
  input: TradeReviewInput,
  rounds: readonly ReviewRound[],
) {
  return input.fills.flatMap((fill, fillIndex) => {
    if (fill.instrument === "reverseRepo") return [];
    const bars = input.bars?.[key(fill)];
    const valid = bars?.every(
      (b, i) =>
        (i === 0 || bars[i - 1]!.date < b.date) &&
        [b.high, b.low, b.close].every((n) => Number.isFinite(n) && n > 0) &&
        b.high >= b.low &&
        b.close >= b.low &&
        b.close <= b.high,
    );
    const index = valid
      ? bars!.findIndex((b) => b.date === fill.tradeDate)
      : -1;
    const reason = !bars?.length
      ? "数据不可得：缺日线"
      : !valid
        ? "日线顺序或价格无效"
        : !Number.isFinite(fill.price) || fill.price <= 0
          ? "成交价格无效"
          : "数据不可得：缺成交日日线";
    const usable = index >= 0 && Number.isFinite(fill.price) && fill.price > 0;
    const position = (window: readonly Bar[]) => {
      const high = Math.max(...window.map((b) => b.high)),
        low = Math.min(...window.map((b) => b.low));
      return value(
        high > low ? (fill.price - low) / (high - low) : null,
        "区间高低价相同",
      );
    };
    const round = rounds.find((r) => r.fillIndices.includes(fillIndex));
    const end = round?.closingDate ?? bars?.at(-1)?.date;
    const future =
      usable && end
        ? bars!.filter((b) => b.date > fill.tradeDate && b.date <= end)
        : [];
    const excursionReason =
      fill.kind !== "buy"
        ? "仅买入成交适用"
        : !usable
          ? reason
          : !round
            ? "回合不可得"
            : "买入后至平仓日行情不足";
    const canExcursion =
      fill.kind === "buy" &&
      usable &&
      round &&
      future.length > 0 &&
      (!round.closingDate || bars!.some((b) => b.date === round.closingDate));
    return [
      {
        fillIndex,
        security: key(fill),
        basis:
          "未复权日线；位置与涨跌均为小数；MFE/MAE 为该次买入至所属回合平仓，未平仓至末根",
        warnings: round?.warnings ?? [],
        dataReason: usable ? null : reason,
        intradayPosition: usable
          ? position([bars![index]!])
          : value(null, reason),
        intervalPositions: Object.fromEntries(
          positionWindows.map((n) => [
            n,
            usable && index >= n
              ? position(bars!.slice(index - n, index))
              : value(null, usable ? `历史不足${n}个交易日` : reason),
          ]),
        ),
        mfe: value(
          canExcursion
            ? Math.max(...future.map((b) => b.high)) / fill.price - 1
            : null,
          excursionReason,
        ),
        mae: value(
          canExcursion
            ? Math.min(...future.map((b) => b.low)) / fill.price - 1
            : null,
          excursionReason,
        ),
        afterSale: Object.fromEntries(
          afterSaleHorizons.map((n) => [
            n,
            fill.kind === "sell" && usable && bars![index + n]
              ? value(bars![index + n]!.close / fill.price - 1)
              : value(
                  null,
                  fill.kind !== "sell"
                    ? "仅卖出成交适用"
                    : !usable
                      ? reason
                      : `卖后不足${n}个交易日`,
                ),
          ]),
        ),
      },
    ];
  });
}
