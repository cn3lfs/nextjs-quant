import { tradeReviewRefSchema, type TradeReviewRef } from "./trade-review-ref";
import type { Bar } from "../domain";
import type { DiagnoseScenarioMetrics } from "../research/diagnose-contract";

/**
 * Backtest fills projected onto K 线. This module is deliberately pure: it
 * never fits prices, never snaps a fill to a neighbouring bar and never emits
 * price lines. A fill whose date is absent from the bars is dropped and
 * counted, because drawing it on another bar would fabricate evidence.
 */

/** Chart periods that carry a trade mark. The rest hide the overlay outright. */
const dailyPeriods = new Set(["day", "1d", "daily"]);

export const TRADE_MARKS_DAILY_ONLY = "仅日线显示回测买卖点";

export type TradeTrigger =
  "signal" | "stop" | "target" | "trailing" | "time" | null | undefined;

export type TradeMarkFill = {
  symbol: string;
  date: string;
  side: "buy" | "sell";
  trigger?: TradeTrigger;
  price?: number;
  quantity?: number;
  orderId?: number;
};

/** Structural subset of `DiagnoseScenarioMetrics` (no runtime contract import). */
export type DiagnoseFillSource = Pick<
  DiagnoseScenarioMetrics,
  "sampleFills" | "sampleOrders"
>;

export type TradeMark = {
  /** Daily bar date (YYYY-MM-DD) that already exists in the bars. */
  date: string;
  side: "buy" | "sell";
  trigger: TradeTrigger;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown";
  color: string;
  text: string;
};

export type TradeMarkProjection = {
  marks: TradeMark[];
  matchedCount: number;
  droppedCount: number;
  /** Sell fills for this symbol whose exit trigger cannot be recovered. */
  unknownTriggerCount: number;
  /** Unique fill dates with no matching daily bar. */
  droppedDates: string[];
  hiddenReason: string | null;
  fillCount: number;
};

export const tradeMarkColors = {
  buy: "#cf5562",
  sell: "#28977f",
  stop: "#d97706",
} as const;

export function isTradeMarkPeriod(period: string | undefined): boolean {
  return period !== undefined && dailyPeriods.has(period);
}

/** Fills may carry a timestamp; bars are keyed by the trading date. */
export function normalizeTradeDate(date: string): string {
  return date.slice(0, 10);
}

export function normalizeTradeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

/** Older archives store the trigger only on the sampled order. */
export function tradeFillsFromDiagnose(
  scenario: DiagnoseFillSource | undefined,
): TradeMarkFill[] {
  if (!scenario) return [];
  const orderById = new Map(
    scenario.sampleOrders.map((order) => [order.id, order]),
  );
  return scenario.sampleFills.map((fill) => ({
    symbol: fill.symbol,
    date: fill.date,
    side: fill.side,
    trigger: fill.trigger ?? orderById.get(fill.orderId)?.trigger,
    price: fill.price,
    quantity: fill.quantity,
    orderId: fill.orderId,
  }));
}

function mark(fill: TradeMarkFill): TradeMark {
  const stop = fill.side === "sell" && fill.trigger === "stop";
  return {
    date: normalizeTradeDate(fill.date),
    side: fill.side,
    trigger: fill.trigger,
    position: fill.side === "buy" ? "belowBar" : "aboveBar",
    shape: fill.side === "buy" ? "arrowUp" : "arrowDown",
    color: stop
      ? tradeMarkColors.stop
      : fill.side === "buy"
        ? tradeMarkColors.buy
        : tradeMarkColors.sell,
    text: stop ? "止损" : fill.side === "buy" ? "买" : "卖",
  };
}

export function countUnknownSellTriggers(fills: readonly TradeMarkFill[]) {
  return fills.filter((fill) => fill.side === "sell" && fill.trigger == null)
    .length;
}

export function tradeMarks(input: {
  symbol: string;
  bars: readonly Bar[];
  period: string | undefined;
  fills?: readonly TradeMarkFill[];
  scenario?: DiagnoseFillSource;
}): TradeMarkProjection {
  const symbol = normalizeTradeSymbol(input.symbol);
  const fills = (input.fills ?? tradeFillsFromDiagnose(input.scenario)).filter(
    (fill) => normalizeTradeSymbol(fill.symbol) === symbol,
  );
  const unknownTriggerCount = countUnknownSellTriggers(fills);
  if (!isTradeMarkPeriod(input.period))
    return {
      marks: [],
      matchedCount: 0,
      droppedCount: 0,
      unknownTriggerCount,
      droppedDates: [],
      hiddenReason: TRADE_MARKS_DAILY_ONLY,
      fillCount: fills.length,
    };
  const dates = new Set(input.bars.map((bar) => bar.date));
  const marks: TradeMark[] = [];
  const droppedDates = new Set<string>();
  for (const fill of fills) {
    const date = normalizeTradeDate(fill.date);
    if (!dates.has(date)) {
      droppedDates.add(date);
      continue;
    }
    marks.push(mark({ ...fill, date }));
  }
  marks.sort((a, b) => a.date.localeCompare(b.date));
  return {
    marks,
    matchedCount: marks.length,
    droppedCount: fills.length - marks.length,
    unknownTriggerCount,
    droppedDates: [...droppedDates].sort(),
    hiddenReason: null,
    fillCount: fills.length,
  };
}

/**
 * One-shot viewport window centred on a trade date. Returns the window in
 * logical coordinates for the bars suffix that starts at `start`; the caller
 * must not write this into the persistent `rememberChartRange` store.
 */
export function tradeMarkFocusRange(
  bars: readonly Bar[],
  date: string,
  halfWindow = 60,
  history = 120,
) {
  const target = normalizeTradeDate(date);
  const index = bars.findIndex((bar) => bar.date === target);
  if (index < 0) return null;
  const start = Math.max(0, index - history);
  const from = Math.max(0, index - start - halfWindow);
  const to = Math.min(
    bars.length - 1 - start,
    Math.max(from + 2, index - start + halfWindow),
  );
  return { index, start, range: { from, to } };
}

/** `/scan` deep link used outside the workbench, where no in-place switch exists. */
export function tradeChartHref(input: {
  symbol: string;
  at?: string;
  diagnose?: string;
  cell?: string;
  scenario?: string;
  review?: TradeReviewRef;
}) {
  const params = new URLSearchParams({
    symbol: input.symbol,
    period: "day",
    adjustment: "none",
  });
  if (input.at) params.set("at", normalizeTradeDate(input.at));
  if (input.diagnose) params.set("diagnose", input.diagnose);
  if (input.cell) params.set("cell", input.cell);
  if (input.scenario) params.set("scenario", input.scenario);
  if (input.review) {
    const review = tradeReviewRefSchema.parse(input.review);
    if (review.symbol !== normalizeTradeSymbol(input.symbol))
      throw new Error("复盘证券与主图证券不一致");
    params.set("reviewSource", review.source);
    params.set("reviewId", review.refId);
    params.set("reviewLabel", review.label);
    params.set("reviewBack", review.backHref);
    if (review.accountId) params.set("reviewAccount", review.accountId);
    if (review.unitKey) params.set("reviewUnit", review.unitKey);
  }
  return `/scan?${params}`;
}

export function parseTradeReviewRef(
  search: string | URLSearchParams,
): TradeReviewRef | null {
  const params = new URLSearchParams(search);
  const result = tradeReviewRefSchema.safeParse({
    source: params.get("reviewSource"),
    refId: params.get("reviewId"),
    symbol: params.get("symbol"),
    label: params.get("reviewLabel"),
    backHref: params.get("reviewBack"),
    accountId: params.get("reviewAccount") ?? undefined,
    unitKey: params.get("reviewUnit") ?? undefined,
  });
  return result.success ? result.data : null;
}
