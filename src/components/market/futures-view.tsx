"use client";
import { formatNumber } from "trading-strategy-core/format-number";
import { Mountains, Wallet } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { usePeriodHotkey } from "./chart-hotkeys";
import { useState } from "react";
import { useForeignChartSymbol } from "./use-foreign-chart-symbol";
import type { Snapshot } from "~/lib/domain";
import {
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import {
  futuresContract,
  futuresContracts,
  futuresGroups,
  futuresSourceLabels,
  futuresSourceSchema,
  futuresSourceSupports,
  type FuturesSource,
} from "~/lib/market/futures";
import { api, type RouterInputs } from "~/trpc/react";
import { useSnapshotLoad } from "./use-snapshot-load";
import { ListPanel, PageGrid, PanelEmpty, Pill } from "../panels";
import { MacroRatesPanel } from "./macro-rates-panel";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ChartWorkspace } from "./chart-workspace";
import { ChartSimOrderDialog } from "./chart-sim-order-dialog";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

/**
 * 资源期货: a fixed list of major commodity contracts (Eastmoney continuous /
 * main contracts), with a separate local futures simulation ledger.
 */
export function FuturesView() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [simOrderOpen, setSimOrderOpen] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  const [period, setPeriod] = useState<ChartPeriod>("day");
  const [source, setSource] = useState<FuturesSource>("auto");
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const load = useSnapshotLoad({ onSuccess: setLoaded });
  const { symbol, selectSymbol } = useForeignChartSymbol("futures", loadSymbol);
  const visible = usePanelVisible();
  usePeriodHotkey(
    period,
    setPeriod,
    !visible || load.isPending,
    chartPeriodSchema.options.filter(
      (p) => p !== "4h" && p !== "1h" && (source !== "sina" || p === "day"),
    ),
  );
  const quotes = api.futuresQuotes.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 60_000 : false,
    refetchOnWindowFocus: false,
  });
  function loadSymbol(next: string, pick = source) {
    // A contract without the picked source falls back to the automatic chain.
    const usable = futuresSourceSupports(futuresContract(next)!, pick)
      ? pick
      : "auto";
    setSourceNotice(
      usable !== pick ? "所选来源不支持当前品种，已切换为自动来源。" : "",
    );
    setSource(usable);
    load.mutate({ symbol: next, period: "day", futuresSource: usable });
  }
  const open = (next: string, pick = source) => {
    setPickerOpen(false);
    selectSymbol(next);
    loadSymbol(next, pick);
  };
  const contract = futuresContract(symbol)!;
  const chartContract =
    loaded && load.isPending
      ? (futuresContract(loaded.symbol) ?? contract)
      : contract;
  const quoteOf = (s: string) => quotes.data?.find((q) => q.symbol === s);
  return (
    <PageGrid className="nc-futures-workspace">
      <div className="nc-futures-mobile-picker">
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">选择品种 · {contract.name}</Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85%]">
            <DialogHeader>
              <DialogTitle>资源期货 · 15个固定品种</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {futuresGroups.map((group) => (
                <ListPanel
                  key={group}
                  icon={Mountains}
                  title={group}
                  tone="warn"
                  items={futuresContracts
                    .filter((c) => c.group === group)
                    .map((c) => {
                      const q = quoteOf(c.symbol);
                      const close = q?.close ?? null;
                      const change = q?.changePct ?? null;
                      return {
                        key: c.symbol,
                        title: c.name,
                        subtitle:
                          close !== null
                            ? `${formatNumber(close, c.precision)} ${c.unit}${
                                change === null
                                  ? ""
                                  : ` · ${change >= 0 ? "+" : ""}${formatNumber(change, 2)}%`
                              }`
                            : q?.error || quotes.error
                              ? "报价读取失败"
                              : `${c.exchange} · ${c.unit}`,
                        tone:
                          c.symbol === symbol
                            ? "warn"
                            : change === null
                              ? "neutral"
                              : change >= 0
                                ? "bad"
                                : "ok",
                        action: (
                          <Button
                            size="sm"
                            variant={
                              c.symbol === symbol ? "default" : "outline"
                            }
                            disabled={load.isPending}
                            onClick={() => open(c.symbol)}
                          >
                            {c.symbol === symbol ? "当前" : "查看"}
                          </Button>
                        ),
                      };
                    })}
                />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="nc-futures-instruments">
        {futuresGroups.map((group) => (
          <ListPanel
            key={group}
            icon={Mountains}
            title={group}
            tone="warn"
            items={futuresContracts
              .filter((c) => c.group === group)
              .map((c) => {
                const q = quoteOf(c.symbol);
                const close = q?.close ?? null;
                const change = q?.changePct ?? null;
                return {
                  key: c.symbol,
                  title: c.name,
                  subtitle:
                    close !== null
                      ? `${formatNumber(close, c.precision)} ${c.unit}${
                          change === null
                            ? ""
                            : ` · ${change >= 0 ? "+" : ""}${formatNumber(change, 2)}%`
                        }`
                      : q?.error || quotes.error
                        ? "报价读取失败"
                        : `${c.exchange} · ${c.unit}`,
                  tone:
                    c.symbol === symbol
                      ? "warn"
                      : change === null
                        ? "neutral"
                        : change >= 0
                          ? "bad"
                          : "ok",
                  action: (
                    <Button
                      size="sm"
                      variant={c.symbol === symbol ? "default" : "outline"}
                      disabled={load.isPending}
                      onClick={() => open(c.symbol)}
                    >
                      {c.symbol === symbol ? "当前" : "查看"}
                    </Button>
                  ),
                };
              })}
          />
        ))}
      </div>
      <section className="panel chart-panel nc-futures-chart">
        <div className="panel-toolbar flex-wrap">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Mountains size={18} className="nc-text-warn" />
            <strong className="text-[15px] font-medium">{contract.name}</strong>
            <Pill tone="warn">资源期货</Pill>
            <Pill tone="idle">{contract.exchange} · 连续合约 · 北京时间</Pill>
          </div>
          <Select
            value={source}
            disabled={load.isPending}
            onValueChange={(next) => {
              setPeriod("day");
              open(symbol, futuresSourceSchema.parse(next));
            }}
          >
            <SelectTrigger
              aria-label="期货数据源"
              title="自动按 Yahoo → 东方财富 → 新浪 顺序读取；新浪仅支持日线"
              className="ml-auto w-auto min-w-24"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {futuresSourceSchema.options.map((s) => (
                <SelectItem
                  key={s}
                  value={s}
                  disabled={!futuresSourceSupports(contract, s)}
                >
                  {futuresSourceLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="segmented">
            {chartPeriodSchema.options
              .filter(
                (p) =>
                  p !== "4h" &&
                  p !== "1h" &&
                  (source !== "sina" || p === "day"),
              )
              .map((p) => (
                <Button
                  variant="plain"
                  key={p}
                  className={period === p ? "selected" : ""}
                  disabled={load.isPending}
                  onClick={() => setPeriod(p)}
                >
                  {p === "day" ? "日 K" : periodLabels[p]}
                </Button>
              ))}
          </div>
          <ChartSimOrderDialog
            open={simOrderOpen}
            onOpenChange={setSimOrderOpen}
            market="futures"
            symbol={symbol}
            displayName={contract.name}
            referencePrice={
              (loaded?.symbol === symbol
                ? loaded.bars.at(-1)?.close
                : undefined) ??
              quoteOf(symbol)?.close ??
              null
            }
            pricePrecision={contract.precision}
            trigger={
              <Button type="button" size="sm" variant="outline">
                模拟下单
              </Button>
            }
          />
        </div>
        <FuturesSimPositionStrip visible={visible} onSelect={open} />
        {sourceNotice && (
          <p role="status" className="px-4 py-2 text-[13px] text-nc-warn">
            {sourceNotice}
          </p>
        )}
        {load.isPending && loaded && (
          <p
            role="status"
            className="px-4 py-2 text-[13px] text-muted-foreground"
          >
            正在读取当前选择；下方暂保留上次图表：
            {futuresContract(loaded.symbol)?.name ?? loaded.symbol}。
          </p>
        )}
        {load.error && !load.isPending ? (
          <div role="alert" className="p-4 text-[13px] text-nc-bad">
            期货行情读取失败：{load.error.message}
            <Button
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={() => open(symbol)}
            >
              重试
            </Button>
          </div>
        ) : loaded?.symbol === symbol && !load.isPending ? (
          <ChartWorkspace
            key={`${loaded.id}:${period}`}
            snapshot={loaded}
            period={period}
            adjustment="none"
          />
        ) : (
          <PanelEmpty>正在读取期货行情…</PanelEmpty>
        )}
        <div className="source-line">
          价格单位 {chartContract.unit} · 连续/主连未做换月调整 ·
          自动按适用来源依次读取；手动选源失败不切换。新浪境外日线不提供成交量，国内主连可能滞后一日。支持本地期货模拟下单（T+0
          双向保证金模拟，非实盘委托）。
        </div>
      </section>
      <div className="nc-futures-macro">
        <MacroRatesPanel />
      </div>
    </PageGrid>
  );
}

const futuresPositionScope = {
  kind: "futures-sim",
  market: "futures",
  page: 0,
} satisfies RouterInputs["accountPositions"];

function FuturesSimPositionStrip({
  visible,
  onSelect,
}: {
  visible: boolean;
  onSelect: (symbol: string) => void;
}) {
  const options = { enabled: visible, retry: false };
  const first = api.accountPositions.useQuery(futuresPositionScope, options);
  const remaining = api.useQueries((query) =>
    Array.from(
      { length: Math.max(0, Math.ceil((first.data?.total ?? 0) / 20) - 1) },
      (_, index) =>
        query.accountPositions(
          { ...futuresPositionScope, page: index + 1 },
          options,
        ),
    ),
  );
  const positions = [
    ...(first.data?.items ?? []),
    ...remaining.flatMap((page) => page.data?.items ?? []),
  ];
  const fetching = first.isPending || remaining.some((page) => page.isPending);
  const error = first.error ?? remaining.find((page) => page.error)?.error;
  const totals = (["CNY", "USD"] as const).flatMap((currency) => {
    const rows = positions.filter((row) => row.currency === currency);
    if (!rows.length) return [];
    return [
      {
        currency,
        margin: rows.reduce((sum, row) => sum + (row.marginUsed ?? 0), 0),
        pnl: rows.every((row) => row.unrealizedPnl != null)
          ? rows.reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0)
          : null,
      },
    ];
  });

  return (
    <section
      aria-label="期货模拟持仓"
      className="space-y-1 border-b border-nc-border-soft px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sub">
        <Wallet size={15} className="text-nc-accent" aria-hidden="true" />
        <strong>期货模拟持仓</strong>
        {error ? (
          <span role="alert" className="text-nc-bad">
            {error.message}
          </span>
        ) : fetching ? (
          <span role="status">正在读取持仓…</span>
        ) : positions.length === 0 ? (
          <span className="text-nc-text-3">暂无持仓</span>
        ) : (
          totals.map(({ currency, margin, pnl }) => (
            <span key={currency} className="tabular-nums text-nc-text-3">
              {currency} 保证金 {formatNumber(margin)} · 浮动盈亏{" "}
              {formatNumber(pnl)}
            </span>
          ))
        )}
        <Link
          href="/accounts?tab=paper&channel=futures-sim"
          className="ml-auto text-nc-accent underline underline-offset-2"
        >
          管理模拟账户 →
        </Link>
      </div>
      {positions.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {positions.map((position) => {
            const contract = futuresContract(position.symbol);
            const caption = `${contract?.name ?? position.symbol} · ${position.direction === "short" ? "空" : "多"} ${position.quantity} 手`;
            return (
              <li key={position.id}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!contract}
                  onClick={() => onSelect(position.symbol)}
                  title={`${position.accountName ?? position.account} · ${position.at ? `估值日 ${position.at}` : "暂无估值行情"}`}
                >
                  {caption}
                  <span className="tabular-nums text-nc-text-3">
                    浮动盈亏 {formatNumber(position.unrealizedPnl)}{" "}
                    {position.currency}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
