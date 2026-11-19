"use client";

import { tdxQuoteToDisplayModel } from "~/lib/market/quote-book-view";
import type { QuoteSession, QuoteSnapshot } from "~/lib/market/tdx-quote-view";
import { QuoteBook } from "./quote-book";

/**
 * 通达信即时盘口。渲染与同花顺共用 `QuoteBook`，此处只负责把 7709 快照
 * 转成来源无关的可空展示模型；props 与既有调用方保持不变。
 */
export function TdxQuoteBook({
  quote,
  precision,
  session,
  hasOrderBook,
}: {
  quote: QuoteSnapshot;
  precision: number;
  session: QuoteSession;
  /** 指数没有可交易盘口，协议返回空档；此时只展示价格与统计。 */
  hasOrderBook: boolean;
}) {
  const model = tdxQuoteToDisplayModel(quote, precision, {
    hasOrderBook,
    session,
  });
  return <QuoteBook model={model} testId="tdx-quote-book" />;
}
