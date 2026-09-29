"use client";
import { Flask } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cryptoPair } from "~/lib/market/crypto";
import { api, type RouterOutputs } from "~/trpc/react";
import { Panel, Pill } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { usePanelVisible } from "../workbench/keep-alive";

type Preview = RouterOutputs["previewCryptoDemoOrder"];
type Outcome = RouterOutputs["confirmCryptoDemoOrder"];
const networkLabels = { demo: "Demo 模拟盘", testnet: "现货测试网" } as const;

/**
 * Binance simulated trading for the pair on screen. Off by default; orders
 * are previewed, then confirmed once within 60 seconds. Accepted is not the
 * same as filled, and nothing here touches the A-share ledgers.
 */
export function CryptoDemoPanel({ symbol }: { symbol: string }) {
  const utils = api.useUtils();
  const status = api.cryptoDemoStatus.useQuery();
  const enabled = status.data?.enabled === true;
  const credential = status.data?.credential;
  const usable =
    enabled && credential?.configured && credential.network !== "live";
  const visible = usePanelVisible();
  const account = api.cryptoDemoAccount.useQuery(undefined, {
    enabled: !!usable,
    retry: false,
    refetchInterval: visible ? 15000 : false,
  });
  const trades = api.cryptoDemoTrades.useQuery(symbol, {
    enabled: !!usable,
    retry: false,
  });
  const toggle = api.setCryptoDemoEnabled.useMutation({
    onSuccess: () => void utils.cryptoDemoStatus.invalidate(),
  });
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [left, setLeft] = useState(0);
  const refresh = () => {
    void utils.cryptoDemoAccount.invalidate();
    void utils.cryptoDemoTrades.invalidate();
    void utils.cryptoDemoStatus.invalidate();
  };
  const previewOrder = api.previewCryptoDemoOrder.useMutation({
    onSuccess: (result) => {
      setOutcome(null);
      setPreview(result);
      setLeft(result.id ? 60 : 0);
    },
  });
  const confirm = api.confirmCryptoDemoOrder.useMutation({
    onSuccess: (result) => {
      setOutcome(result);
      setPreview(null);
      refresh();
    },
    onSettled: () => setPreview(null),
  });
  const cancel = api.cancelCryptoDemoOrder.useMutation({ onSuccess: refresh });
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  // A new pair invalidates any pending preview.
  useEffect(() => {
    setPreview(null);
    setOutcome(null);
  }, [symbol]);

  return (
    <Panel
      icon={Flask}
      title="币安模拟盘"
      tone="warn"
      actions={
        <label className="flex items-center gap-2 text-[12px]">
          <Switch
            aria-label="启用币安模拟盘"
            checked={enabled}
            disabled={toggle.isPending || !status.data}
            onCheckedChange={(value) => toggle.mutate(value)}
          />
          {enabled ? "已启用" : "未启用"}
        </label>
      }
      note="仅用于币安 Demo 模拟盘或现货测试网，不连接实盘、不自动下单；每笔委托需预览后在 60 秒内人工确认，失败不会自动重试。受理不等于成交，模拟盘行情仅供测试，不代表实盘结果，也不写入 A 股持仓与交易日志。"
    >
      {!credential?.configured ? (
        <p className="text-[12px]">
          尚未保存模拟盘 Key，请到{" "}
          <Link href="/settings" className="underline">
            数据与连接
          </Link>{" "}
          的「币安 API」中保存 Demo 或测试网 Key。
        </p>
      ) : credential.network === "live" ? (
        <p role="alert" className="text-[12px] nc-text-bad">
          已保存的是实盘 Key，模拟盘不会使用它，请改存 Demo 或测试网 Key。
        </p>
      ) : (
        <p className="text-[12px]">
          <Pill tone="accent">{networkLabels[credential.network]}</Pill> Key{" "}
          {credential.keyHint}
        </p>
      )}
      {usable && (
        <div className="space-y-3 text-[12px]">
          {account.error ? (
            <p role="alert" className="nc-text-bad">
              账户读取失败：{account.error.message}
            </p>
          ) : (
            <>
              <div>
                <strong>余额</strong>
                {account.data?.balances.length ? (
                  <ul className="tabular-nums">
                    {account.data.balances.map((b) => (
                      <li key={b.asset}>
                        {b.asset} 可用 {b.free} · 冻结 {b.locked}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{account.isLoading ? "读取中…" : "无余额"}</p>
                )}
              </div>
              <div>
                <strong>挂单</strong>
                {account.data?.openOrders.length ? (
                  <ul className="tabular-nums">
                    {account.data.openOrders.map((o) => (
                      <li key={o.orderId} className="flex items-center gap-2">
                        {o.symbol} {o.side === "BUY" ? "买" : "卖"} {o.origQty}{" "}
                        @ {o.price}（已成交 {o.executedQty}）
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancel.isPending}
                          onClick={() =>
                            cancel.mutate({
                              symbol: `cx${o.symbol}`,
                              orderId: String(o.orderId),
                            })
                          }
                        >
                          撤单
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>无挂单</p>
                )}
                {cancel.error && (
                  <p role="alert" className="nc-text-bad">
                    撤单失败：{cancel.error.message}
                  </p>
                )}
              </div>
            </>
          )}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              previewOrder.mutate({
                symbol,
                side,
                type,
                quantity,
                ...(type === "LIMIT" ? { price } : {}),
              });
            }}
          >
            <strong>下单 {cryptoPair(symbol)}</strong>
            <div className="flex gap-2">
              <Select
                value={side}
                onValueChange={(v) => setSide(v as typeof side)}
              >
                <SelectTrigger aria-label="买卖方向">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BUY">买入</SelectItem>
                  <SelectItem value="SELL">卖出</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={type}
                onValueChange={(v) => setType(v as typeof type)}
              >
                <SelectTrigger aria-label="委托类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LIMIT">限价</SelectItem>
                  <SelectItem value="MARKET">市价</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="数量"
                placeholder="数量"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {type === "LIMIT" && (
                <Input
                  aria-label="限价"
                  placeholder="价格"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!quantity || previewOrder.isPending}
            >
              预览委托
            </Button>
            {previewOrder.error && (
              <p role="alert" className="nc-text-bad">
                {previewOrder.error.message}
              </p>
            )}
          </form>
          {preview && (
            <div className="rounded border p-2" aria-live="polite">
              <p className="tabular-nums">
                参考价 {preview.referencePrice} · 名义金额约{" "}
                {preview.notional.toFixed(4)}
              </p>
              {preview.problems.length ? (
                <ul className="nc-text-bad">
                  {preview.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : left > 0 ? (
                <Button
                  size="sm"
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate(preview.id!)}
                >
                  确认{side === "BUY" ? "买入" : "卖出"}（{left} 秒内有效）
                </Button>
              ) : (
                <p>预览已过期，请重新预览。</p>
              )}
            </div>
          )}
          {confirm.error && (
            <p role="alert" className="nc-text-bad">
              {confirm.error.message}
            </p>
          )}
          {outcome && (
            <p
              role="status"
              className={outcome.outcome === "accepted" ? "" : "nc-text-bad"}
            >
              {outcome.outcome === "accepted"
                ? "委托已受理（受理不等于成交，请看挂单与成交记录）"
                : outcome.outcome === "unknown"
                  ? `结果未知，未自动重试，请先刷新挂单与成交核对：${outcome.message}`
                  : `委托被拒绝：${outcome.message}`}
            </p>
          )}
          <details>
            <summary className="cursor-pointer">
              {cryptoPair(symbol)} 最近成交（{trades.data?.length ?? 0}）
            </summary>
            <ul className="tabular-nums">
              {trades.data?.map((t) => (
                <li key={t.id}>
                  {new Date(t.time).toLocaleString("zh-CN")}{" "}
                  {t.isBuyer ? "买" : "卖"} {t.qty} @ {t.price} · 手续费{" "}
                  {t.commission} {t.commissionAsset}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary className="cursor-pointer">
              最近请求诊断（{status.data?.diagnostics.length ?? 0}，已脱敏）
            </summary>
            <ul className="max-h-48 overflow-auto break-all">
              {status.data?.diagnostics
                .slice()
                .reverse()
                .map((d) => (
                  <li key={`${d.at}-${d.path}`}>
                    {new Date(d.at).toLocaleTimeString("zh-CN")} {d.method}{" "}
                    {d.path} → {d.status ?? "无响应"} {d.error ?? ""}
                  </li>
                ))}
            </ul>
          </details>
        </div>
      )}
    </Panel>
  );
}
