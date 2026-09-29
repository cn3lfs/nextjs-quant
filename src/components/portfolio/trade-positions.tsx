"use client";
import { useRef, useState } from "react";
import type { RouterOutputs } from "~/trpc/react";
import { updateStop } from "~/app/trade-ledger/actions";
import { feeLabel } from "~/lib/portfolio/trade-ledger";
import { Button } from "../ui/button";
import {
  TradeError,
  TradeInputField,
  tradeNumber,
} from "./trade-workspace-fields";

export function TradePositions({
  data,
  fetching,
  error,
  page,
  onPage,
  onRetry,
  onRelated,
  onChanged,
}: {
  data?: RouterOutputs["tradeWorkspacePositions"];
  fetching: boolean;
  error?: string;
  page: number;
  onPage: (page: number) => void;
  onRetry: () => void;
  onRelated: (symbol: string) => void;
  onChanged: () => void;
}) {
  const [stops, setStops] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  async function save(symbol: string, value: string) {
    if (inFlight.current.has(symbol)) return;
    inFlight.current.add(symbol);
    setPending((p) => ({ ...p, [symbol]: true }));
    setMessages((p) => ({ ...p, [symbol]: "" }));
    try {
      const stop = Number(value);
      if (!Number.isFinite(stop) || stop <= 0)
        throw new Error("止损价必须大于0");
      await updateStop(symbol, stop);
      setMessages((p) => ({
        ...p,
        [symbol]: `已保存止损价 ${value}；不自动卖出。`,
      }));
      setStops((p) => {
        if (p[symbol] !== value) return p;
        const next = { ...p };
        delete next[symbol];
        return next;
      });
      onChanged();
    } catch (e) {
      setMessages((p) => ({
        ...p,
        [symbol]: e instanceof Error ? e.message : "保存失败，输入已保留",
      }));
    } finally {
      inFlight.current.delete(symbol);
      setPending((p) => ({ ...p, [symbol]: false }));
    }
  }
  return (
    <section aria-label="持仓列表" className="space-y-4">
      <p className="text-xs text-nc-text-3">{feeLabel}</p>
      <p className="text-xs text-nc-text-3">
        持仓按完整本地账本计算。GBBQ不可用时成本未按除权调整，浮盈留空；参考成本不可当作已核对成本。
      </p>
      <TradeError error={error} onRetry={onRetry} />
      {fetching && <p role="status">正在核对完整持仓与本地行情…</p>}
      {data && (
        <p className="text-xs text-nc-text-3">
          日历：{data.calendarSource} · 核对日期 {data.today} · 匹配{data.count}
          只证券
        </p>
      )}
      {!fetching && !error && data?.items.length === 0 && (
        <p>暂无持仓或没有匹配的证券。</p>
      )}
      {data?.items.map((p) => (
        <article
          key={p.symbol}
          className="space-y-3 rounded border border-nc-border-soft p-3"
        >
          <div className="flex flex-wrap justify-between gap-2">
            <h3>
              {p.symbol} · {p.quantity > 0 ? "持有" : "已清仓"}
            </h3>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRelated(p.symbol)}
            >
              查看除权依据（{p.adjustmentCount}）
            </Button>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-sm max-sm:grid-cols-2">
            <div>
              <dt>持股 / T+1可卖</dt>
              <dd>
                {p.quantity} / {p.sellable}
              </dd>
            </div>
            <div>
              <dt>核对后 / 参考成本</dt>
              <dd>
                {tradeNumber(p.adjustedCost)} / {tradeNumber(p.averageCost)}
              </dd>
            </div>
            <div>
              <dt>本地收盘 / 日期</dt>
              <dd>
                {tradeNumber(p.quote?.price)} / {p.quote?.date ?? "缺少行情"}
              </dd>
            </div>
            <div>
              <dt>浮动盈亏</dt>
              <dd>{tradeNumber(p.floating)}</dd>
            </div>
            <div>
              <dt>已实现盈亏（实验费用）</dt>
              <dd>{tradeNumber(p.realized)}</dd>
            </div>
            <div>
              <dt>止损距离</dt>
              <dd>
                {p.stopDistancePct == null
                  ? "—"
                  : `${tradeNumber(p.stopDistancePct)}%`}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-nc-text-3">{p.adjustmentStatus}</p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save(p.symbol, stops[p.symbol] ?? String(p.stop ?? ""));
            }}
          >
            <TradeInputField
              label={`${p.symbol} 止损价`}
              value={stops[p.symbol] ?? String(p.stop ?? "")}
              onChange={(value) =>
                setStops((previous) => ({ ...previous, [p.symbol]: value }))
              }
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={pending[p.symbol]}
            >
              {pending[p.symbol] ? "保存中…" : "保存止损"}
            </Button>
          </form>
          {messages[p.symbol] && (
            <p role="status" className="text-sm">
              {messages[p.symbol]}
            </p>
          )}
        </article>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page === 1 || fetching}
          onClick={() => onPage(page - 1)}
        >
          上一页持仓
        </Button>
        <span>第{page}页</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!data?.hasMore || fetching}
          onClick={() => onPage(page + 1)}
        >
          下一页持仓
        </Button>
      </div>
    </section>
  );
}
