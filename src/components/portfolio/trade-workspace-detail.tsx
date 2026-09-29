"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { feeLabel } from "~/lib/portfolio/trade-ledger";
import { saveBonusListing } from "~/app/trade-ledger/actions";
import { Button } from "../ui/button";
import {
  TradeError,
  TradeEvidence,
  TradeInputField,
  tradeNumber,
  downloadTradeFile,
} from "./trade-workspace-fields";
export function TradeWorkspaceDetail({
  id,
  kind,
  visible,
  onBack,
  onAdjustments,
  onChanged,
}: {
  id: string;
  kind: "trade" | "adjustment";
  visible: boolean;
  onBack: () => void;
  onAdjustments: (symbol: string) => void;
  onChanged: () => void;
}) {
  const read = {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  };
  const trade = api.tradeWorkspaceDetail.useQuery(id, {
    ...read,
    enabled: visible && kind === "trade",
  });
  const adjustment = api.tradeWorkspaceAdjustment.useQuery(id, {
    ...read,
    enabled: visible && kind === "adjustment",
  });
  const active = kind === "trade" ? trade : adjustment;
  const [date, setDate] = useState(""),
    [source, setSource] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const a = adjustment.data,
    t = trade.data?.trade;
  const saveBonus = async () => {
    if (!a || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveBonusListing(a.symbol, a.event.date, date, source);
      setMessage("送转股可卖依据已记录，原交易保持不变。");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，输入已保留");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="账本记录详情" tabIndex={-1} className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onBack}>
          返回列表
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={active.isFetching}
          onClick={() => void active.refetch()}
        >
          刷新详情
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!active.data}
          onClick={() => {
            try {
              downloadTradeFile(
                `local-${kind}-${id}.json`,
                "application/json",
                JSON.stringify(
                  {
                    schemaVersion: 1,
                    generatedAt: Date.now(),
                    kind,
                    data: active.data,
                  },
                  null,
                  2,
                ),
              );
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "导出失败，请重试");
            }
          }}
        >
          导出完整记录
        </Button>
      </div>
      <TradeError
        error={active.error?.message}
        onRetry={() => void active.refetch()}
      />
      {active.isFetching && <p role="status">正在读取最新记录…</p>}
      {!active.isLoading && !active.error && !active.data && (
        <p>记录不存在或已不可用，可返回列表重新检索。</p>
      )}
      {t && (
        <>
          <h3>
            {t.symbol} · {t.side === "buy" ? "买入" : "卖出"}
          </h3>
          <p>
            交易日期 {t.date} · {t.quantity}股 × {tradeNumber(t.price)}
          </p>
          <p className="text-xs text-nc-text-3">
            录入时间{" "}
            {new Date(t.createdAt).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
            })}{" "}
            · {t.id}
          </p>
          <p>
            佣金 {tradeNumber(t.fees.commission)} / 税 {tradeNumber(t.fees.tax)}{" "}
            / 滑点 {tradeNumber(t.fees.slippage)} / 合计{" "}
            {tradeNumber(t.fees.total)}
          </p>
          <p className="text-xs text-nc-text-3">
            {feeLabel} · {t.costs.version}
          </p>
          <p>
            当日价格范围 {t.lowerLimit}–{t.upperLimit}；依据：{t.limitSource}
          </p>
          <p className="whitespace-pre-wrap break-words">
            备注：{t.note || "无"}
          </p>
          <p>
            关联信号：
            {!t.signalId ? (
              "无（手动交易）"
            ) : trade.data?.linkedSignal ? (
              <Link
                className="underline"
                href={`/signal-ledger?signal=${encodeURIComponent(t.signalId)}`}
              >
                查看 {t.signalId} 的原始信号证据
              </Link>
            ) : (
              <span>原关联 {t.signalId} 已不可用，保留交易原值。</span>
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAdjustments(t.symbol)}
          >
            查看该证券除权依据（{trade.data?.adjustmentCount ?? 0}）
          </Button>
        </>
      )}
      {a && (
        <>
          <h3>
            {a.symbol} · {a.event.date} · {a.event.name}
          </h3>
          <p>
            股数 {a.beforeQuantity} → {a.afterQuantity}；成本{" "}
            {tradeNumber(a.beforeCost)} → {tradeNumber(a.afterCost)}
          </p>
          <p>{a.basis}</p>
          {(a.event.bonusRatio ?? 0) > 0 && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void saveBonus();
              }}
            >
              <TradeInputField
                label="账户确认的送转股可卖日期"
                type="date"
                value={date}
                onChange={setDate}
              />
              <TradeInputField
                label="到账依据"
                value={source}
                onChange={setSource}
                maxLength={200}
              />
              <Button type="submit" disabled={busy}>
                {busy ? "正在保存依据…" : "保存可卖依据（只记录一次）"}
              </Button>
            </form>
          )}
        </>
      )}
      <TradeError error={error} />
      {message && <p role="status">{message}</p>}
      {active.data && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowEvidence(!showEvidence)}
          >
            {showEvidence ? "收起" : "展开"}完整原始证据
          </Button>
          {showEvidence && (
            <TradeEvidence
              key={id}
              text={JSON.stringify(active.data, null, 2)}
            />
          )}
        </>
      )}
    </section>
  );
}
