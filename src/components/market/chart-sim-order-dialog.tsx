"use client";

import Big from "big.js";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { futuresContract, type FuturesContract } from "~/lib/market/futures";
import { chinaDate } from "~/lib/market/security-trading-status";
import {
  futuresContractCurrency,
  futuresSimActionLabels,
  futuresSimOrderPreviewSchema,
  type FuturesSimAction,
  type FuturesSimCurrency,
  type FuturesSimOrderConfirm,
  type FuturesSimOrderPreview,
} from "~/lib/portfolio/futures-sim";
import { tradeInputSchema } from "~/lib/portfolio/trade-ledger";
import { useMarketSession } from "~/lib/stores/market-session";
import { api, type RouterOutputs } from "~/trpc/react";
import { Pill, Segmented } from "../panels";
import {
  formatSimDecimal,
  newSimRequestId,
  SimOrderForm,
  type SimOrderFormHandle,
} from "../portfolio/sim-order-form";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type ReferencePriceSource = "snapshot" | "adjusted" | "unadjusted" | "missing";
type ChartOrderInstrument = {
  symbol: string;
  displayName: string;
  referencePrice: number | null;
  referenceDate?: string;
  referenceLabel?: string;
  pricePrecision?: number;
} & (
  | { market: "cn-equity"; referencePriceSource: ReferencePriceSource }
  | {
      market: "crypto" | "futures";
      referencePriceSource?: ReferencePriceSource;
    }
);
type ChartSimOrderDialogProps = ChartOrderInstrument & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  /** Optional prefill from a rebalance ticket or other planning surface. */
  initialSide?: "buy" | "sell";
  initialQuantity?: string;
  /** Chart entries also show the newly confirmed fill in the chart. */
  syncChartReview?: boolean;
};

const mockAccountsHref = "/accounts?tab=paper&channel=ths-mock";
const futuresAccountsHref = "/accounts?tab=paper&channel=futures-sim";
const manualRequest = { retry: false, networkMode: "always" } as const;

export function ChartSimOrderDialog({
  open,
  onOpenChange,
  trigger,
  initialSide,
  initialQuantity,
  syncChartReview = Boolean(trigger),
  ...instrument
}: ChartSimOrderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="lg:max-w-2xl">
        {open && (
          <ChartOrderContent
            key={[
              instrument.market,
              instrument.symbol,
              instrument.referencePriceSource,
              instrument.referencePriceSource === "snapshot" &&
                instrument.referenceDate,
            ].join(":")}
            {...instrument}
            initialSide={initialSide}
            initialQuantity={initialQuantity}
            syncChartReview={syncChartReview}
            onNavigate={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChartOrderContent({
  market,
  symbol,
  displayName,
  referencePrice,
  referencePriceSource,
  referenceDate,
  referenceLabel = "最新参考价",
  pricePrecision,
  initialSide,
  initialQuantity,
  syncChartReview,
  onNavigate,
}: ChartOrderInstrument & {
  initialSide?: "buy" | "sell";
  initialQuantity?: string;
  syncChartReview: boolean;
  onNavigate: () => void;
}) {
  const utils = api.useUtils();
  const contract = market === "futures" ? futuresContract(symbol) : undefined;
  const digits =
    pricePrecision ?? (market === "cn-equity" ? 2 : contract?.precision);
  const validReference =
    (referencePriceSource === undefined ||
      referencePriceSource === "unadjusted") &&
    referencePrice !== null &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0;
  const reference = validReference
    ? new Big(referencePrice).toFixed(digits ?? 8)
    : "";
  const latestPrice =
    reference && new Big(reference).gt(0)
      ? digits === undefined
        ? new Big(reference).toFixed()
        : reference
      : "";
  const date = referenceDate ? `（${referenceDate}）` : "";
  const priceWarning =
    referencePriceSource === "snapshot"
      ? `当前为历史快照${referenceDate ? `（快照日期 ${referenceDate}）` : ""}。为避免按历史旧价误成交，请核对并手动输入当前未复权价格。`
      : referencePriceSource === "adjusted"
        ? `当前图表${date}仅有复权价，请核对并手动输入未复权价格。`
        : referencePriceSource === "missing"
          ? `暂无未复权参考价${date}，请手动输入价格。`
          : null;
  const [channel, setChannel] = useState<"local" | "ths-mock">("local");
  const [futuresAccountId, setFuturesAccountId] = useState("");
  const [price, setPrice] = useState({ value: latestPrice, revision: 0 });
  const localForm = useRef<SimOrderFormHandle>(null);
  const supportedCrypto = /^(?:cx)?(?:BTCUSDT|ETHUSDT)$/i.test(symbol);
  const local = market !== "futures" && channel === "local";
  const canRefill =
    market === "futures" ? !!contract : market !== "crypto" || supportedCrypto;

  function changePrice(value: string) {
    setPrice((previous) => ({ value, revision: previous.revision + 1 }));
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <div>
          <Pill tone="warn">模拟盘 · 非真实券商委托</Pill>
        </div>
        <DialogTitle>模拟下单 · {displayName}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 tabular-nums lg:justify-start">
          <span>
            {symbol.toUpperCase()}
            {contract && " · " + contract.unit}
          </span>
          <span>
            {referenceLabel} {latestPrice || "—"}
            {latestPrice && date}
          </span>
          {contract && (
            <span>
              合约乘数 {formatSimDecimal(String(contract.contractMultiplier))}{" "}
              {contract.unit.split("/")[1]}/手
            </span>
          )}
        </DialogDescription>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-center lg:self-start"
          disabled={!latestPrice || !canRefill}
          onClick={() => {
            if (local) localForm.current?.refillReferencePrice();
            else changePrice(latestPrice);
          }}
        >
          {referenceLabel === "最新参考价" ? "回填最新价" : "回填参考价"}
        </Button>
      </DialogHeader>
      {priceWarning && (
        <p role="note" className="text-sm text-nc-warn">
          {priceWarning}
        </p>
      )}
      {market === "cn-equity" && (
        <Segmented
          label="模拟下单通道"
          value={channel}
          onChange={(next) => {
            if (next === channel) return;
            changePrice(latestPrice);
            setChannel(next);
          }}
          options={[
            { value: "local", label: "本地模拟账户" },
            { value: "ths-mock", label: "同花顺模拟账户" },
          ]}
        />
      )}
      {market === "futures" ? (
        contract ? (
          <FuturesOrderForm
            contract={contract}
            price={price}
            onPriceChange={changePrice}
            accountId={futuresAccountId}
            onAccountIdChange={setFuturesAccountId}
          />
        ) : (
          <p role="alert" className="text-sm text-nc-bad">
            无法识别当前期货合约。
          </p>
        )
      ) : market === "crypto" && !supportedCrypto ? (
        <p role="status" className="text-sm text-nc-warn">
          本地数字货币模拟账户目前支持 BTCUSDT 和 ETHUSDT 现货。
        </p>
      ) : channel === "ths-mock" ? (
        <ThsMockOrderForm
          symbol={symbol}
          price={price}
          onPriceChange={changePrice}
          onNavigate={onNavigate}
          initialSide={initialSide}
          initialQuantity={initialQuantity}
        />
      ) : (
        <SimOrderForm
          ref={localForm}
          lockSymbol
          quickCreateDefault
          marketHint={market}
          defaults={{
            symbol,
            price: latestPrice,
            ...(initialSide ? { side: initialSide } : {}),
            ...(initialQuantity ? { quantity: initialQuantity } : {}),
          }}
          referencePrice={latestPrice ? Number(latestPrice) : null}
          onDone={(trade) => {
            if (market !== "cn-equity") return;
            void utils.chartPosition.invalidate(trade.symbol);
            void utils.chartTradeReview.invalidate();
            void utils.accountPositions.invalidate();
            void utils.accountTrades.invalidate();
            if (!syncChartReview) return;
            const chart = useMarketSession.getState();
            if (chart.chartPeriod === "day" && chart.loaded)
              void utils.chartBars.invalidate({
                snapshotId: chart.loaded.id,
                period: "day",
              });
            if (
              chart.chartPeriod === "day" &&
              chart.chartMode === "k" &&
              chart.adjustment !== "none"
            )
              chart.setAdjustment("none");
            chart.setTradeContext({
              symbol: trade.symbol,
              at: trade.tradeDate,
              review: {
                source: "paper-account",
                refId: `local-sim:${trade.accountId}`,
                accountId: trade.accountId,
                symbol: trade.symbol,
                label: "本地模拟",
                backHref: `/accounts?${new URLSearchParams({
                  tab: "trades",
                  kind: "local-sim",
                  symbol: trade.symbol,
                  trade: `local-sim:${trade.accountId}:${trade.fillId}`,
                })}`,
              },
            });
          }}
        />
      )}
      <DialogFooter className="border-t border-nc-border-soft pt-3">
        <Link
          className="text-sm text-nc-accent-light hover:underline"
          href={
            market === "futures"
              ? futuresAccountId
                ? `${futuresAccountsHref}&accountId=${encodeURIComponent(futuresAccountId)}`
                : futuresAccountsHref
              : "/accounts?tab=paper"
          }
          onClick={onNavigate}
        >
          前往模拟账户查看持仓与成交 →
        </Link>
      </DialogFooter>
    </>
  );
}

type OrderPriceProps = {
  price: { value: string; revision: number };
  onPriceChange: (value: string) => void;
};
type ThsPreview = RouterOutputs["thsMockPreviewOrder"] & {
  priceRevision: number;
  expiresAt: number;
};

function ThsMockOrderForm({
  symbol,
  price,
  onPriceChange,
  onNavigate,
  initialSide = "buy",
  initialQuantity,
}: OrderPriceProps & {
  symbol: string;
  onNavigate: () => void;
  initialSide?: "buy" | "sell";
  initialQuantity?: string;
}) {
  const meta = api.thsMockMeta.useQuery();
  const prepare = api.thsMockPreviewOrder.useMutation(manualRequest);
  const confirm = api.thsMockConfirmOrder.useMutation(manualRequest);
  const status = api.thsMockOrderStatus.useMutation(manualRequest);
  const [side, setSide] = useState(initialSide);
  const [preview, setPreview] = useState<ThsPreview | null>(null);
  const [expired, setExpired] = useState(false);
  const [validation, setValidation] = useState("");
  const [lastOrderId, setLastOrderId] = useState("");
  const current = preview?.priceRevision === price.revision ? preview : null;
  const busy = prepare.isPending || confirm.isPending || status.isPending;

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, current.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [current]);

  function changeInputs() {
    setPreview(null);
    setExpired(false);
    setValidation("");
    prepare.reset();
  }

  function requestPreview(fields: FormData) {
    if (busy || confirm.isError || (current && !expired)) return;
    changeInputs();
    const startedAt = Date.now();
    const result = tradeInputSchema.safeParse({
      id: crypto.randomUUID(),
      symbol: symbol.toLowerCase(),
      date: chinaDate(startedAt),
      side,
      price: Number(price.value),
      quantity: Number(fields.get("quantity")),
      lowerLimit: Number(fields.get("lowerLimit")),
      upperLimit: Number(fields.get("upperLimit")),
      limitSource: fields.get("limitSource"),
    });
    if (!result.success) {
      setValidation(
        result.error.issues[0]?.message === "价格超出当日涨跌停范围"
          ? "价格超出当日涨跌停范围"
          : "请核对委托价格、股数和当日涨跌停依据。",
      );
      return;
    }
    prepare.mutate(result.data, {
      onSuccess: (data) =>
        setPreview({
          ...data,
          priceRevision: price.revision,
          expiresAt: startedAt + 60_000,
        }),
    });
  }

  function requestConfirm() {
    if (busy || !current || !meta.data?.enabled || !meta.data.hasAccount)
      return;
    if (Date.now() >= current.expiresAt) {
      setExpired(true);
      return;
    }
    setLastOrderId(current.id);
    setPreview(null);
    status.reset();
    confirm.mutate({ id: current.id });
  }

  if (meta.isPending)
    return (
      <p role="status" className="text-sm">
        正在读取同花顺模拟账户状态…
      </p>
    );

  const unavailable = meta.error
    ? "同花顺模拟账户读取失败：" + meta.error.message
    : !meta.data?.enabled
      ? "同花顺模拟盘尚未开启。"
      : !meta.data.hasAccount
        ? "请先开通或恢复同花顺模拟账户。"
        : !/^(sh(60|68)|sz(00|30))\d{4}$/i.test(symbol)
          ? "同花顺模拟盘仅支持沪深股票，请使用本地模拟账户。"
          : null;
  if (unavailable)
    return (
      <div className="space-y-2 text-sm">
        <p role="status">{unavailable}</p>
        <Link
          href={mockAccountsHref}
          className="text-nc-accent-light hover:underline"
          onClick={onNavigate}
        >
          前往同花顺模拟账户 →
        </Link>
      </div>
    );

  return (
    <form
      className="space-y-3"
      onChange={changeInputs}
      onSubmit={(event) => {
        event.preventDefault();
        requestPreview(new FormData(event.currentTarget));
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <Segmented
          label="买卖方向"
          value={side}
          onChange={(value) => {
            setSide(value);
            changeInputs();
          }}
          options={[
            { value: "buy", label: "买入" },
            { value: "sell", label: "卖出" },
          ]}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <label>
            委托股数
            <Input
              name="quantity"
              type="number"
              min="100"
              max="100000000"
              step="100"
              defaultValue={initialQuantity}
              required
            />
          </label>
          <label>
            委托价格（元）
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={price.value}
              onChange={(event) => onPriceChange(event.target.value)}
              required
            />
          </label>
          <label>
            当日跌停价（元）
            <Input
              name="lowerLimit"
              type="number"
              min="0.01"
              step="0.01"
              required
            />
          </label>
          <label>
            当日涨停价（元）
            <Input
              name="upperLimit"
              type="number"
              min="0.01"
              step="0.01"
              required
            />
          </label>
          <label className="sm:col-span-2">
            涨跌停依据
            <Input
              name="limitSource"
              placeholder="例如当日行情终端"
              maxLength={200}
              required
            />
          </label>
        </div>
      </fieldset>
      {current && (
        <div
          className="rounded border border-nc-border-soft bg-nc-inset p-3 text-sm tabular-nums"
          role="status"
        >
          {expired ? (
            "预览已过期，请重新预览。"
          ) : (
            <>
              <p>
                {current.input.date} ·{" "}
                {current.input.side === "buy" ? "买入" : "卖出"}{" "}
                {current.input.quantity} 股 · {current.input.price} 元/股
              </p>
              <p className="text-nc-text-3">
                预览有效期 60 秒，确认后发送至同花顺模拟账户。
              </p>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || confirm.isError || (!!current && !expired)}
        >
          {prepare.isPending ? "正在预览…" : "预览模拟委托"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !current || expired}
          onClick={requestConfirm}
        >
          {confirm.isPending ? "正在提交…" : "确认模拟委托"}
        </Button>
      </div>
      {(validation || prepare.error) && (
        <p role="alert" className="text-sm text-nc-bad">
          {validation || prepare.error?.message}
        </p>
      )}
      {confirm.data && (
        <p role="status" className="text-sm">
          {confirm.data.entrustNos.length
            ? "已收到模拟委托回执 · 委托号 " +
              confirm.data.entrustNos.join("、")
            : "已收到模拟委托回执 · 暂无可核验委托号"}
        </p>
      )}
      {confirm.error && (
        <p role="alert" className="text-sm text-nc-bad">
          {confirm.error.message}
          。请查询委托状态或到同花顺模拟账户核对后再发起新委托。
        </p>
      )}
      {lastOrderId && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => status.mutate({ id: lastOrderId })}
        >
          {status.isPending ? "正在查询…" : "查询委托状态"}
        </Button>
      )}
      {status.error && (
        <p role="alert" className="text-sm text-nc-bad">
          {status.error.message}
        </p>
      )}
      {status.data && (
        <p role="status" className="text-sm">
          {
            {
              matched: "已查到关联成交",
              unfilled: "当日未查到关联成交",
              unknown: "委托成交状态未知",
            }[status.data.fillStatus]
          }
          {status.data.reason && " · " + status.data.reason}
        </p>
      )}
    </form>
  );
}

export const futuresOpeningCapital = { CNY: "1000000", USD: "200000" } as const;

export function FuturesSimAccountCreateButton({
  currency,
  label,
  onCreated,
}: {
  currency: FuturesSimCurrency;
  label: string;
  onCreated: (id: string) => void;
}) {
  const utils = api.useUtils();
  const create = api.futuresSimAccountCreate.useMutation({
    ...manualRequest,
    onSuccess: (account) => {
      utils.futuresSimAccountsList.setData(undefined, (previous) => [
        account,
        ...(previous ?? []).filter((row) => row.id !== account.id),
      ]);
      onCreated(account.id);
      void utils.futuresSimAccountsList.invalidate();
    },
  });
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={create.isPending}
        onClick={() =>
          create.mutate({
            currency,
            name: (currency === "CNY" ? "人民币" : "美元") + "期货模拟账户",
            initialCapital: futuresOpeningCapital[currency],
          })
        }
      >
        {create.isPending ? "正在创建…" : label}
      </Button>
      {create.error && (
        <p role="alert" className="text-sm text-nc-bad">
          {create.error.message}
        </p>
      )}
    </div>
  );
}

const futuresActions = Object.entries(futuresSimActionLabels).map(
  ([value, label]) => ({ value: value as FuturesSimAction, label }),
);

export function parseFuturesOrderPreview(
  order: Omit<FuturesSimOrderPreview, "marginRate">,
  marginPercent: FormDataEntryValue | null,
) {
  const marginRate =
    typeof marginPercent === "string" &&
    marginPercent.length <= 48 &&
    /^\d+(?:\.\d+)?$/.test(marginPercent)
      ? new Big(marginPercent).times("0.01").toFixed()
      : "";
  return futuresSimOrderPreviewSchema.safeParse({ ...order, marginRate });
}

function FuturesOrderForm({
  contract,
  price,
  onPriceChange,
  accountId,
  onAccountIdChange,
}: OrderPriceProps & {
  contract: FuturesContract;
  accountId: string;
  onAccountIdChange: (id: string) => void;
}) {
  const { symbol } = contract;
  const currency = futuresContractCurrency(contract);
  const utils = api.useUtils();
  const accounts = api.futuresSimAccountsList.useQuery();
  const compatible =
    accounts.data?.filter((account) => account.currency === currency) ?? [];
  const account =
    compatible.find((row) => row.id === accountId) ?? compatible[0];
  useEffect(() => {
    if (account && account.id !== accountId) onAccountIdChange(account.id);
  }, [account, accountId, onAccountIdChange]);
  const [action, setAction] = useState<FuturesSimAction>("buy_open");
  const [quantity, setQuantity] = useState("");
  const [preview, setPreview] = useState<{
    key: string;
    order: FuturesSimOrderConfirm;
    data: RouterOutputs["futuresSimOrderPreview"];
  } | null>(null);
  const [validation, setValidation] = useState("");
  const prepare = api.futuresSimOrderPreview.useMutation(manualRequest);
  const confirm = api.futuresSimOrderConfirm.useMutation({
    ...manualRequest,
    onSuccess: () =>
      Promise.all([
        utils.futuresSimAccountsList.invalidate(),
        utils.accountPositions.invalidate(),
      ]),
  });
  const key = JSON.stringify([account?.id, symbol, action, price.revision]);
  const current = preview?.key === key ? preview : null;
  const busy = prepare.isPending || confirm.isPending;

  function changeInputs() {
    setPreview(null);
    setValidation("");
    prepare.reset();
    confirm.reset();
  }

  function requestPreview(fields: FormData) {
    if (busy || current || !account) return;
    changeInputs();
    const result = parseFuturesOrderPreview(
      {
        accountId: account.id,
        symbol,
        action,
        quantity: Number(quantity),
        price: price.value,
      },
      fields.get("marginRate"),
    );
    if (!result.success) {
      setValidation("请填写正整数手数、有效价格及 5% 至 100% 的保证金比例。");
      return;
    }
    const order = { ...result.data, clientRequestId: newSimRequestId() };
    prepare.mutate(result.data, {
      onSuccess: (data) => setPreview({ key, order, data }),
    });
  }

  if (accounts.isPending)
    return (
      <p role="status" className="text-sm">
        正在读取期货模拟账户…
      </p>
    );
  if (accounts.error)
    return (
      <p role="alert" className="text-sm text-nc-bad">
        期货模拟账户读取失败：{accounts.error.message}
      </p>
    );
  if (!account)
    return (
      <div className="space-y-2">
        <p className="text-sm text-nc-text-3">
          当前合约使用 {currency}，默认初始资金{" "}
          {formatSimDecimal(futuresOpeningCapital[currency])} {currency}。
        </p>
        {!accounts.isFetching && (
          <FuturesSimAccountCreateButton
            currency={currency}
            label="一键创建期货模拟账户"
            onCreated={onAccountIdChange}
          />
        )}
      </div>
    );

  const position = (side: "long" | "short") =>
    account.positions.find((row) => row.symbol === symbol && row.side === side);
  return (
    <form
      className="space-y-3"
      onChange={changeInputs}
      onSubmit={(event) => {
        event.preventDefault();
        requestPreview(new FormData(event.currentTarget));
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <label className="block">
          期货模拟账户（{currency}）
          <Select
            value={account.id}
            disabled={busy}
            onValueChange={(id) => {
              onAccountIdChange(id);
              changeInputs();
            }}
          >
            <SelectTrigger aria-label="选择期货模拟账户" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {compatible.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
          <div>
            <dt className="text-nc-text-3">可用资金</dt>
            <dd>
              {formatSimDecimal(account.cash, 2)} {currency}
            </dd>
          </div>
          <div>
            <dt className="text-nc-text-3">冻结保证金</dt>
            <dd>
              {formatSimDecimal(account.frozenMargin, 2)} {currency}
            </dd>
          </div>
          <div>
            <dt className="text-nc-text-3">当前合约多仓 / 可平</dt>
            <dd>{position("long")?.quantity ?? 0} 手</dd>
          </div>
          <div>
            <dt className="text-nc-text-3">当前合约空仓 / 可平</dt>
            <dd>{position("short")?.quantity ?? 0} 手</dd>
          </div>
        </dl>
        <Segmented
          label="期货开平仓方向"
          value={action}
          options={futuresActions}
          onChange={(value) => {
            setAction(value);
            changeInputs();
          }}
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <label className="block">
              手数
              <Input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </label>
            <div
              className="mt-1.5 flex flex-wrap gap-1"
              role="group"
              aria-label="快捷手数"
            >
              {[1, 5, 10].map((lots) => (
                <Button
                  key={lots}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuantity(String(lots));
                    changeInputs();
                  }}
                >
                  {lots}手
                </Button>
              ))}
            </div>
          </div>
          <label>
            价格
            <Input
              type="number"
              min="0"
              step="any"
              value={price.value}
              onChange={(event) => onPriceChange(event.target.value)}
              required
            />
          </label>
          <label>
            保证金比例（%）
            <Input
              name="marginRate"
              type="number"
              min="5"
              max="100"
              step="any"
              defaultValue="10"
              required
            />
          </label>
        </div>
      </fieldset>
      {current && (
        <div
          className="rounded border border-nc-border-soft bg-nc-inset p-3 text-sm tabular-nums"
          role="status"
        >
          <p className="mb-2 font-medium">
            {futuresSimActionLabels[current.data.action]}{" "}
            {current.data.quantity} 手 · {current.data.price} {contract.unit}
          </p>
          <dl
            aria-label="期货模拟委托预览"
            className="grid gap-x-5 gap-y-1 sm:grid-cols-2"
          >
            {[
              ["名义价值", current.data.notional],
              ["占用保证金", current.data.requiredMargin],
              ["释放保证金", current.data.releasedMargin],
              ["手续费", current.data.fee],
              ["预估实现盈亏（扣平仓手续费）", current.data.estimatedPnl],
              ["成交后可用资金", current.data.cashAfter],
            ].map(([label, value]) => (
              <div className="flex justify-between gap-2" key={label}>
                <dt className="text-nc-text-3">{label}</dt>
                <dd>
                  {formatSimDecimal(value, 2)} {currency}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || !!current}
        >
          {prepare.isPending ? "正在预览…" : "预览模拟委托"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !current}
          onClick={() => {
            if (busy || !current) return;
            confirm.mutate(current.order, {
              onSuccess: () => setPreview(null),
            });
          }}
        >
          {confirm.isPending ? "正在成交…" : "确认模拟成交"}
        </Button>
      </div>
      {(validation || prepare.error || confirm.error) && (
        <p role="alert" className="text-sm text-nc-bad">
          {validation || prepare.error?.message || confirm.error?.message}
        </p>
      )}
      {confirm.data && (
        <p role="status" className="text-sm">
          已记录 {confirm.data.name} ·{" "}
          {futuresSimActionLabels[confirm.data.action]} {confirm.data.quantity}{" "}
          手 · {confirm.data.price} {contract.unit}
        </p>
      )}
    </form>
  );
}
