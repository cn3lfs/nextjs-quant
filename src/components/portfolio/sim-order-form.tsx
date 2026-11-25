"use client";

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react";
import Big from "big.js";
import { researchExecutionCosts } from "trading-strategy-core/costs";
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

export function newSimRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function quickQuantities(
  market: SimMarket,
  side: "buy" | "sell",
  cash: string,
  sellable: string,
  price: string,
) {
  const held = new Big(sellable);
  if (market === "cn-equity" && side === "sell") {
    const half = held.div(200).round(0, Big.roundDown).times(100);
    return [
      ["1/2", half.toFixed()],
      ["全卖", held.toFixed()],
    ] as const;
  }

  const costs = researchExecutionCosts(market, "fixed");
  const otherRate = (costs.slippageBps + (costs.transferBps ?? 0)) / 10_000;
  const funds = new Big(cash);
  function affordable(fraction: number) {
    // Reserve room for each fee's currency rounding and for minimum commission.
    const budget = funds
      .times(fraction)
      .minus(market === "crypto" ? "0.00000003" : "0.03");
    const withMinimum = budget
      .minus(costs.minimumCommission)
      .div(1 + otherRate);
    const withRate = budget.div(1 + otherRate + costs.commissionBps / 10_000);
    const gross = withMinimum.lt(withRate) ? withMinimum : withRate;
    return gross.gt(0) ? gross.div(price) : new Big(0);
  }

  if (market === "crypto") {
    return (
      [
        ["25%", 0.25],
        ["50%", 0.5],
        ["100%", 1],
      ] as const
    ).map(
      ([label, fraction]) =>
        [
          label,
          (side === "buy" ? affordable(fraction) : held.times(fraction))
            .round(8, Big.roundDown)
            .toFixed(),
        ] as const,
    );
  }

  const lots = (fraction: number) =>
    affordable(fraction).div(100).round(0, Big.roundDown).times(100);
  const max = lots(1);
  return [
    ["100股", max.gte(100) ? "100" : "0"],
    ["500股", max.gte(500) ? "500" : "0"],
    ["1/4仓", lots(0.25).toFixed()],
    ["1/2仓", lots(0.5).toFixed()],
    ["全仓", max.toFixed()],
  ] as const;
}

export type SimOrderFormHandle = { refillReferencePrice: () => void };

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

const orderPrice = (value: number | null | undefined) =>
  value && Number.isFinite(value) && value > 0 ? new Big(value).toFixed() : "";

/**
 * Reusable local simulated order form. The account selector is mandatory and
 * filtered by the symbol's market/currency, so an order can never silently land
 * in an incompatible account. Preview then confirm keeps the two-step flow.
 */
export function SimOrderForm({
  defaults,
  marketHint,
  onDone,
  lockSymbol = false,
  quickCreateDefault = false,
  referencePrice,
  ref,
}: {
  defaults?: SimOrderDefaults;
  /** The caller may know the plan market before the symbol is normalised. */
  marketHint?: SimMarket | null;
  onDone?: (trade: SimTradeRow) => void;
  lockSymbol?: boolean;
  quickCreateDefault?: boolean;
  referencePrice?: number | null;
  ref?: Ref<SimOrderFormHandle>;
}) {
  const visible = useScreenVisible();
  const utils = api.useUtils();
  const [accountId, setAccountId] = useState(defaults?.accountId ?? "");
  const [symbol, setSymbol] = useState(defaults?.symbol ?? "");
  const [side, setSide] = useState<"buy" | "sell">(defaults?.side ?? "buy");
  const [quantity, setQuantity] = useState(defaults?.quantity ?? "");
  const [price, setPrice] = useState(
    () => defaults?.price ?? orderPrice(referencePrice),
  );
  const [tradeDate, setTradeDate] = useState(defaults?.tradeDate ?? "");
  const [preview, setPreview] = useState<{
    key: string;
    data: SimOrderPreviewResult;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [clientRequestId, setClientRequestId] = useState(newSimRequestId);
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
  const effectiveTradeDate = tradeDate || (market ? todayOf(market) : "");
  const canCreateDefault =
    quickCreateDefault &&
    market &&
    accountsQuery.isSuccess &&
    !accountsQuery.isFetching &&
    compatible.length === 0;
  const createDefault = api.simAccountCreate.useMutation({
    retry: false,
    networkMode: "always",
    onSuccess: (account) => {
      utils.simAccountsList.setData(undefined, (previous) => [
        account,
        ...(previous ?? []).filter((row) => row.id !== account.id),
      ]);
      setAccountId(account.id);
      setMessage("");
      setPreview(null);
      void utils.simAccountsList.invalidate();
    },
  });

  // Never keep an incompatible selection. Wait for the account list so a
  // prefilled account is not cleared while the query is still loading.
  useEffect(() => {
    if (!accountsQuery.isSuccess) return;
    if (accountId && !compatible.some((account) => account.id === accountId))
      setAccountId("");
    else if (lockSymbol && !accountId && compatible[0])
      setAccountId(compatible[0].id);
  }, [accountId, accountsQuery.isSuccess, compatible, lockSymbol]);

  const detail = api.simAccountDetail.useQuery(
    {
      accountId,
      limit: 1,
      ...(lockSymbol ? { currentTradeDate: effectiveTradeDate } : {}),
    },
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
  const confirmMutation = api.simOrderConfirm.useMutation({
    ...(lockSymbol ? ({ retry: false, networkMode: "always" } as const) : {}),
    onSuccess: () => {
      void utils.simAccountsList.invalidate();
      void utils.simAccountDetail.invalidate();
    },
  });
  const busy = previewMutation.isPending || confirmMutation.isPending;

  function changePrice(value: string) {
    setPrice(value);
    setPreview(null);
    setMessage("");
  }

  useImperativeHandle(ref, () => ({
    refillReferencePrice: () => {
      const latest = orderPrice(referencePrice);
      if (!busy && latest) changePrice(latest);
    },
  }));

  useEffect(() => {
    setClientRequestId(newSimRequestId());
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
          setClientRequestId(newSimRequestId());
          if (key === currentKey) setPreview(null);
          setMessage(
            `已记录${trade.side === "buy" ? "买入" : "卖出"} ${trade.symbol} × ${trade.quantity} 到〈${selectedAccount?.name ?? "模拟账户"}〉`,
          );
          onDone?.(trade);
        },
        onError: (error) => setMessage(error.message),
      },
    );
  }

  const shownPreview = preview?.key === currentKey ? preview.data : null;
  const enteredPrice = price.trim();
  const priceDecimals =
    enteredPrice.split(".")[1]?.replace(/0+$/, "").length ?? 0;
  const quantityPresets =
    selectedAccount &&
    selectedAccount.market === market &&
    detail.data &&
    positiveDecimal(enteredPrice) &&
    enteredPrice.length <= 48 &&
    priceDecimals <= digits
      ? quickQuantities(
          selectedAccount.market,
          side,
          detail.data.cash,
          position?.sellableQuantity ?? "0",
          enteredPrice,
        )
      : [];

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (lockSymbol && busy) return;
        requestPreview();
      }}
    >
      <label className="block">
        选择模拟账户
        <Select
          value={accountId || undefined}
          disabled={lockSymbol && busy}
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
      {canCreateDefault && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={createDefault.isPending}
          onClick={() =>
            createDefault.mutate(
              market === "crypto"
                ? {
                    name: "数字货币模拟账户",
                    market,
                    currency: "USDT",
                    initialCapital: "10000",
                  }
                : {
                    name: "A股默认模拟账户",
                    market,
                    currency: "CNY",
                    initialCapital: "1000000",
                  },
            )
          }
        >
          {createDefault.isPending ? "正在创建…" : "一键创建默认模拟账户"}
        </Button>
      )}
      {createDefault.error && (
        <p role="alert" className="text-sm text-nc-bad">
          {createDefault.error.message}
        </p>
      )}
      {!quickCreateDefault &&
        accountsQuery.isSuccess &&
        accounts.length === 0 && (
          <p role="alert" className="text-sm text-nc-warn">
            尚无模拟账户；请先在「持仓复盘 · 本地模拟盘」新建。
          </p>
        )}
      {!quickCreateDefault &&
        accountsQuery.isSuccess &&
        accounts.length > 0 &&
        compatible.length === 0 && (
          <p role="alert" className="text-sm text-nc-warn">
            {market
              ? `没有与${marketLabel(market)}币种匹配的活跃模拟账户；请先在「本地模拟盘」新建。`
              : "没有可用的活跃模拟账户。"}
          </p>
        )}

      <fieldset disabled={lockSymbol && busy} className="space-y-3">
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
            readOnly={lockSymbol}
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
                : `可用资金 ${formatSimDecimal(detail.data?.cash ?? "0", digits)} ${currency}${lockSymbol ? ` · 持仓 ${formatSimDecimal(position?.quantity ?? "0")}` : ""} · 可卖 ${
                    position?.sellableQuantity ?? "0"
                  }`}
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block">
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
            {quantityPresets.length > 0 && (
              <div
                className="mt-1.5 flex flex-wrap gap-1"
                role="group"
                aria-label="快捷数量"
              >
                {quantityPresets.map(([label, value]) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={value === "0"}
                    onClick={() => {
                      setQuantity(value);
                      setPreview(null);
                      setMessage("");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <label>
            价格
            <Input
              aria-label="价格"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={price}
              onChange={(event) => changePrice(event.target.value)}
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
      </fieldset>

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
            ...(lockSymbol && market === "cn-equity"
              ? [["过户费", shownPreview.transfer]]
              : []),
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
          {previewMutation.isPending
            ? "正在试算…"
            : lockSymbol
              ? "预览模拟成交"
              : "试算预览"}
        </Button>
        <Button
          type="button"
          disabled={busy || !shownPreview}
          onClick={requestConfirm}
        >
          {confirmMutation.isPending
            ? "正在记录…"
            : lockSymbol
              ? "确认模拟成交"
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
