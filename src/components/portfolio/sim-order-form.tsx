"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { chinaDate } from "~/lib/market/security-trading-status";
import type {
  SimAccountSummary,
  SimOrderPreviewResult,
  SimTradeRow,
} from "~/lib/portfolio/sim-accounts";
import { Segmented } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useScreenVisible } from "../workbench/use-task-visible";

export type SimMarket = SimAccountSummary["market"];
export type SimExecutionMode = "manual" | "plan-manual" | "plan-auto";

export type SimOrderDefaults = {
  accountId?: string;
  symbol?: string;
  side?: "buy" | "sell";
  quantity?: string;
  price?: string;
  tradeDate?: string;
  executionMode?: SimExecutionMode;
  planId?: string;
};

const moneyDigits = (market: SimMarket) => (market === "crypto" ? 8 : 2);
const decimalPattern = /^\d+(?:\.\d+)?$/;
const positiveDecimal = (value: string) =>
  decimalPattern.test(value.trim()) && /[1-9]/.test(value);
const normalizeSymbol = (value: string) =>
  value.trim().replace(/^cx/i, "").toUpperCase();
const sameSymbol = (left: string, right: string) =>
  normalizeSymbol(left) === normalizeSymbol(right) &&
  normalizeSymbol(left) !== "";

/** A symbol alone is enough to separate A-share and crypto accounts. */
export function simSymbolMarket(
  symbol: string,
  hint?: SimMarket | null,
): SimMarket | null {
  const value = symbol.trim();
  if (!value) return hint ?? null;
  if (/^cx[A-Za-z0-9]{5,20}$/.test(value) || /USDT$/i.test(value))
    return "crypto";
  if (/^(sh|sz|bj)\d{6}$/i.test(value)) return "cn-equity";
  return hint ?? null;
}

const marketLabel = (market: SimMarket) =>
  market === "crypto" ? "数字货币" : "A股";

function todayOf(market: SimMarket) {
  return market === "crypto"
    ? new Date().toISOString().slice(0, 10)
    : chinaDate(Date.now());
}

function newRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Format an exact decimal string with thousand separators without converting through IEEE-754 Number. */
export function formatSimDecimal(
  value: string | null | undefined,
  digits?: number,
): string {
  const trimmed = value?.trim() ?? "";
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return "—";
  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  const [rawWhole = "0", rawFraction = ""] = magnitude.split(".");
  const whole = (rawWhole.replace(/^0+(?=\d)/, "") || "0").replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  let fraction = rawFraction;
  if (digits !== undefined) {
    fraction =
      digits > 0 ? rawFraction.padEnd(digits, "0").slice(0, digits) : "";
  }
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

export function isPositiveSimDecimal(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim() ?? "";
  return /^\d+(?:\.\d+)?$/.test(trimmed) && /[1-9]/.test(trimmed);
}

const modeLabel = (mode: SimExecutionMode) =>
  mode === "manual"
    ? "手动成交"
    : mode === "plan-manual"
      ? "按计划手动模拟成交"
      : "按计划自动模拟成交";

/**
 * Reusable local simulated order form. The account selector is mandatory and
 * filtered by the symbol's market/currency, so an order can never silently land
 * in an incompatible account. Preview then confirm keeps the two-step flow.
 */
export function SimOrderForm({
  defaults,
  marketHint,
  onDone,
}: {
  defaults?: SimOrderDefaults;
  /** The caller may know the plan market before the symbol is normalised. */
  marketHint?: SimMarket | null;
  onDone?: (trade: SimTradeRow) => void;
}) {
  const visible = useScreenVisible();
  const utils = api.useUtils();
  const [accountId, setAccountId] = useState(defaults?.accountId ?? "");
  const [symbol, setSymbol] = useState(defaults?.symbol ?? "");
  const [side, setSide] = useState<"buy" | "sell">(defaults?.side ?? "buy");
  const [quantity, setQuantity] = useState(defaults?.quantity ?? "");
  const [price, setPrice] = useState(defaults?.price ?? "");
  const [tradeDate, setTradeDate] = useState(defaults?.tradeDate ?? "");
  const [preview, setPreview] = useState<{
    key: string;
    data: SimOrderPreviewResult;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [clientRequestId, setClientRequestId] = useState(newRequestId);
  const executionMode: SimExecutionMode = defaults?.executionMode ?? "manual";
  const planId = defaults?.planId;

  const accountsQuery = api.simAccountsList.useQuery(undefined, {
    enabled: visible,
    staleTime: 15000,
  });
  const accounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.status === "active"),
    [accountsQuery.data],
  );
  const selectedAccount =
    accounts.find((account) => account.id === accountId) ?? null;
  const symbolMarket = simSymbolMarket(symbol, marketHint);
  const market = symbolMarket ?? selectedAccount?.market ?? null;
  const compatible = useMemo(
    () =>
      accounts.filter(
        (account) =>
          !market ||
          (account.market === market &&
            account.currency === (market === "crypto" ? "USDT" : "CNY")),
      ),
    [accounts, market],
  );
  const compatibleKey = compatible.map((account) => account.id).join("|");
  const effectiveTradeDate = tradeDate || (market ? todayOf(market) : "");

  // Never keep an incompatible selection. Wait for the account list so a
  // prefilled account is not cleared while the query is still loading.
  useEffect(() => {
    if (!accountsQuery.isSuccess || !accountId) return;
    if (!compatible.some((account) => account.id === accountId))
      setAccountId("");
  }, [accountId, accountsQuery.isSuccess, compatibleKey]);

  const detail = api.simAccountDetail.useQuery(
    { accountId, limit: 1 },
    { enabled: visible && !!accountId },
  );
  const position = detail.data?.positions.find((row) =>
    sameSymbol(row.symbol, symbol),
  );
  const currency = selectedAccount?.currency ?? "";
  const digits = selectedAccount ? moneyDigits(selectedAccount.market) : 2;

  const currentKey = JSON.stringify([
    accountId,
    symbol.trim(),
    side,
    quantity.trim(),
    price.trim(),
    effectiveTradeDate,
    executionMode,
    planId ?? "",
    market ?? "",
  ]);

  const previewMutation = api.simOrderPreview.useMutation();
  const confirmMutation = api.simOrderConfirm.useMutation();
  const busy = previewMutation.isPending || confirmMutation.isPending;

  useEffect(() => {
    setClientRequestId(newRequestId());
  }, [
    accountId,
    symbol,
    side,
    quantity,
    price,
    effectiveTradeDate,
    executionMode,
    planId,
  ]);

  function buildOrder() {
    return {
      accountId,
      symbol:
        market === "cn-equity"
          ? symbol.trim().toLowerCase()
          : symbol.trim().toUpperCase(),
      side,
      quantity: quantity.trim(),
      price: price.trim(),
      tradeDate: effectiveTradeDate,
      executionMode,
      ...(executionMode === "manual" ? {} : { planId: planId ?? "" }),
      ...(market ? { market } : {}),
    };
  }

  function validate() {
    if (!accountsQuery.isSuccess) return "正在读取模拟账户";
    if (!accountId) return "请选择模拟账户";
    if (!compatible.some((account) => account.id === accountId))
      return "所选账户与标的市场/币种不匹配";
    if (!symbol.trim()) return "请填写证券代码";
    if (!market) return "无法识别证券代码所属市场";
    if (!positiveDecimal(quantity)) return "数量必须大于零";
    if (!positiveDecimal(price)) return "价格必须大于零";
    if (!effectiveTradeDate) return "请选择交易日期";
    if (executionMode !== "manual" && !planId)
      return "计划成交必须关联交易计划";
    return "";
  }

  function requestPreview() {
    const problem = validate();
    if (problem) {
      setMessage(problem);
      setPreview(null);
      return;
    }
    setMessage("");
    const key = currentKey;
    previewMutation.mutate(buildOrder(), {
      onSuccess: (result) => setPreview({ key, data: result }),
      onError: (error) => {
        setPreview(null);
        setMessage(error.message);
      },
    });
  }

  function requestConfirm() {
    if (!preview || preview.key !== currentKey) {
      setMessage("请先试算预览当前委托");
      return;
    }
    const key = currentKey;
    confirmMutation.mutate(
      { ...buildOrder(), clientRequestId },
      {
        onSuccess: (trade) => {
          setClientRequestId(newRequestId());
          if (key === currentKey) setPreview(null);
          setMessage(
            `已记录${trade.side === "buy" ? "买入" : "卖出"} ${trade.symbol} × ${trade.quantity} 到〈${selectedAccount?.name ?? "模拟账户"}〉`,
          );
          void utils.simAccountsList.invalidate();
          void utils.simAccountDetail.invalidate();
          onDone?.(trade);
        },
        onError: (error) => setMessage(error.message),
      },
    );
  }

  const shownPreview = preview?.key === currentKey ? preview.data : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        requestPreview();
      }}
    >
      <label className="block">
        选择模拟账户
        <Select
          value={accountId || undefined}
          onValueChange={(value) => {
            setAccountId(value);
            setPreview(null);
            setMessage("");
          }}
        >
          <SelectTrigger aria-label="选择模拟账户" className="w-full">
            <SelectValue placeholder="请选择模拟账户" />
          </SelectTrigger>
          <SelectContent>
            {compatible.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name} · {marketLabel(account.market)} ·{" "}
                {account.currency}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {accountsQuery.error && (
        <p role="alert" className="text-sm text-nc-bad">
          模拟账户读取失败：{accountsQuery.error.message}
        </p>
      )}
      {accountsQuery.isSuccess && accounts.length === 0 && (
        <p role="alert" className="text-sm text-nc-warn">
          尚无模拟账户；请先在「持仓复盘 · 本地模拟盘」新建。
        </p>
      )}
      {accountsQuery.isSuccess &&
        accounts.length > 0 &&
        compatible.length === 0 && (
          <p role="alert" className="text-sm text-nc-warn">
            {market
              ? `没有与${marketLabel(market)}币种匹配的活跃模拟账户；请先在「本地模拟盘」新建。`
              : "没有可用的活跃模拟账户。"}
          </p>
        )}

      <Segmented
        label="买卖方向"
        value={side}
        onChange={(value) => {
          setSide(value);
          setPreview(null);
          setMessage("");
        }}
        options={[
          { value: "buy", label: "买入" },
          { value: "sell", label: "卖出" },
        ]}
      />

      <label className="block">
        证券代码
        <Input
          aria-label="证券代码"
          value={symbol}
          placeholder={market === "crypto" ? "BTCUSDT" : "sh600000"}
          onChange={(event) => {
            setSymbol(event.target.value);
            setPreview(null);
            setMessage("");
          }}
        />
      </label>

      {selectedAccount && (
        <p className="text-sm text-nc-text-3">
          {detail.isLoading
            ? "正在读取账户可用资金与可卖数量…"
            : detail.error
              ? `账户读取失败：${detail.error.message}`
              : `可用资金 ${formatSimDecimal(detail.data?.cash ?? "0", digits)} ${currency} · 可卖 ${
                  position?.sellableQuantity ?? "0"
                }`}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          数量
          <Input
            aria-label="数量"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value);
              setPreview(null);
              setMessage("");
            }}
          />
        </label>
        <label>
          价格
          <Input
            aria-label="价格"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
              setPreview(null);
              setMessage("");
            }}
          />
        </label>
        <label>
          交易日期
          <Input
            aria-label="交易日期"
            type="date"
            value={effectiveTradeDate}
            onChange={(event) => {
              setTradeDate(event.target.value);
              setPreview(null);
              setMessage("");
            }}
          />
        </label>
      </div>

      {executionMode !== "manual" && (
        <p className="text-sm text-nc-warn" role="note">
          记录为{modeLabel(executionMode)} ·
          仅写入本地模拟账户，绝不触发真实下单。
        </p>
      )}

      {shownPreview && (
        <dl
          aria-label="委托试算预览"
          className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-nc-border-soft bg-nc-inset p-3 text-sm"
        >
          {[
            ["成交额", shownPreview.gross],
            ["佣金", shownPreview.commission],
            ["印花税", shownPreview.tax],
            ["滑点", shownPreview.slippage],
            ["可用资金变动", shownPreview.netCashDelta],
            ["成交后可用资金", shownPreview.cashAfter],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-2"
            >
              <dt className="text-nc-text-4">{label}</dt>
              <dd className="tabular-nums">
                {formatSimDecimal(value, digits)} {currency}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={busy}>
          {previewMutation.isPending ? "正在试算…" : "试算预览"}
        </Button>
        <Button
          type="button"
          disabled={busy || !shownPreview}
          onClick={requestConfirm}
        >
          {confirmMutation.isPending
            ? "正在记录…"
            : `确认${side === "buy" ? "买入" : "卖出"}到〈${selectedAccount?.name ?? "模拟账户"}〉`}
        </Button>
      </div>
      {message && (
        <p
          role={
            confirmMutation.isError || previewMutation.isError
              ? "alert"
              : "status"
          }
          className="text-sm"
        >
          {message}
        </p>
      )}
    </form>
  );
}
