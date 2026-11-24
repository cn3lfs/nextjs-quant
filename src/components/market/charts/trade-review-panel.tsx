import Link from "next/link";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/ssr";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { Button } from "~/components/ui/button";
import type {
  ChartTradeReview,
  TradeReviewRef,
} from "~/lib/chart/trade-review-ref";
import { reviewExtremes } from "./trade-review-overlay";

export function TradeReviewPanel({
  reviewRef,
  review,
  error,
  hiddenReason,
  activeBox,
  onStep,
  onRetry,
  bars,
}: {
  reviewRef: TradeReviewRef;
  review?: ChartTradeReview;
  error?: string;
  hiddenReason?: string;
  activeBox: number;
  onStep: (direction: -1 | 1) => void;
  onRetry: () => void;
  bars: readonly { date: string }[];
}) {
  const boxes = review?.boxes ?? [];
  const box = boxes[activeBox];
  const dates = new Set(bars.map(({ date }) => date));
  const loadedBoxes = hiddenReason
    ? []
    : boxes.filter(
        (round) => dates.has(round.entryDate) && dates.has(round.exitDate),
      );
  const extremes = loadedBoxes
    .flatMap(reviewExtremes)
    .filter(({ date, price }) => date && dates.has(date) && price !== null);
  const pnl = box?.pnlAmount ?? box?.pnlPct;
  return (
    <section
      aria-label="交易复盘"
      className="space-y-2 rounded-md border border-nc-border bg-nc-card p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <strong>{reviewRef.label}</strong>
        {boxes.length > 0 && (
          <div
            role="group"
            aria-label="复盘步进"
            className="flex items-center gap-1"
          >
            <Button
              variant="outline"
              size="sm"
              aria-label="上一笔 ["
              disabled={!!hiddenReason || activeBox <= 0}
              onClick={() => onStep(-1)}
            >
              <CaretLeft /> [
            </Button>
            <span className="tabular">
              {activeBox + 1} / {boxes.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label="下一笔 ]"
              disabled={!!hiddenReason || activeBox >= boxes.length - 1}
              onClick={() => onStep(1)}
            >
              ] <CaretRight />
            </Button>
          </div>
        )}
        <Link
          prefetch={false}
          href={box?.backHref ?? reviewRef.backHref}
          className="text-nc-accent underline"
        >
          返回原证据 / 原批次
        </Link>
      </div>
      {error && (
        <p role="alert">
          交易复盘读取失败：{error}{" "}
          <Button variant="plain" size="sm" onClick={onRetry}>
            重试
          </Button>
        </p>
      )}
      {!review && !error && <p role="status">正在读取成交与持仓回合…</p>}
      {hiddenReason && <p role="status">{hiddenReason}</p>}
      {review && !hiddenReason && (
        <p
          data-testid="chart-trade-review-overlay"
          role="status"
          data-box-count={loadedBoxes.length}
          data-extreme-count={extremes.length}
          className="text-nc-text-3"
        >
          {boxes.length
            ? `已载入 ${loadedBoxes.length} / ${boxes.length} 个持仓盈亏区间 · MAE / MFE 极值 ${extremes.length} 处`
            : "暂无可配对的闭合持仓回合"}
        </p>
      )}
      {box && (
        <div
          data-testid="trade-review-round"
          className="flex flex-wrap gap-x-4 gap-y-1 tabular"
        >
          <span>
            {box.entryDate} → {box.exitDate}
          </span>
          <span
            className={
              pnl != null && pnl !== 0
                ? pnl > 0
                  ? "text-nc-up"
                  : "text-nc-down"
                : undefined
            }
          >
            盈亏 {formatNumber(box.pnlAmount)} / {formatPercent(box.pnlPct, 2)}
          </span>
          <span title={box.maeDate ?? undefined}>
            MAE {formatPercent(box.maePct, 2)}
          </span>
          <span title={box.mfeDate ?? undefined}>
            MFE {formatPercent(box.mfePct, 2)}
          </span>
          <span>持有 {formatNumber(box.holdingDays, 0)} 日</span>
          {box.pnlReason && (
            <span className="text-nc-text-3">{box.pnlReason}</span>
          )}
          {box.excursionReason && (
            <span className="text-nc-text-3">{box.excursionReason}</span>
          )}
        </div>
      )}
      {!!review?.warnings.length && (
        <ul className="text-nc-text-3">
          {review.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
