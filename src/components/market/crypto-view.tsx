"use client";
import { CurrencyBtc, Globe } from "@phosphor-icons/react/ssr";
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
  cryptoAssets,
  cryptoDisplayName,
  cryptoPair,
  cryptoSourceLabels,
  cryptoSourceSchema,
  cryptoSymbol,
  defaultCryptoPairs,
  isCryptoSymbol,
  type CryptoSource,
} from "~/lib/market/crypto";
import { marketSourceLabel } from "~/lib/market/market-source";
import { useSnapshotLoad } from "./use-snapshot-load";
import {
  ListPanel,
  PageGrid,
  Panel,
  PanelEmpty,
  Pill,
  Segmented,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ChartWorkspace } from "./chart-workspace";
import { ChartSimOrderDialog } from "./chart-sim-order-dialog";
import { CryptoBotPanel } from "./crypto-bot-panel";
import { usePanelVisible } from "../workbench/keep-alive";

/** Account facts and simulated strategies live under Accounts & Review. */
export function CryptoView() {
  const [workspace, setWorkspace] = useState<"strategy" | "account">("account");
  return (
    <div className="space-y-4">
      <Segmented
        label="数字货币工作区"
        value={workspace}
        onChange={setWorkspace}
        options={[
          { value: "strategy", label: "策略模拟" },
          { value: "account", label: "平台账户" },
        ]}
      />
      <CryptoBotPanel view={workspace} />
    </div>
  );
}

export function CryptoQuotes() {
  const visible = usePanelVisible();
  const [period, setPeriod] = useState<ChartPeriod>("day");
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<CryptoSource>("auto");
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const [simOrderOpen, setSimOrderOpen] = useState(false);
  const load = useSnapshotLoad({ onSuccess: setLoaded });
  const { symbol, selectSymbol } = useForeignChartSymbol("crypto", (next) =>
    load.mutate({ symbol: next, period: "day", cryptoSource: source }),
  );
  usePeriodHotkey(
    period,
    setPeriod,
    !visible || load.isPending,
    chartPeriodSchema.options,
  );
  const open = (next: string, pick = source) => {
    selectSymbol(next);
    setSource(pick);
    load.mutate({ symbol: next, period: "day", cryptoSource: pick });
  };
  const typed = cryptoSymbol(
    draft
      .trim()
      .toUpperCase()
      .replace(/[/\s-]/g, ""),
  );
  const { base, quote } = cryptoAssets(symbol);
  return (
    <PageGrid>
      <section className="panel chart-panel nc-span-9 nc-crypto-frame">
        <div className="panel-toolbar flex-wrap">
          <div className="flex items-center gap-2">
            <CurrencyBtc size={18} className="nc-text-warn" />
            <strong className="text-[15px] font-medium">
              {cryptoDisplayName(symbol)}
            </strong>
            <Pill tone="warn">数字货币</Pill>
            <Pill tone="idle">现货 · 7×24 · UTC 收线</Pill>
          </div>
          <Select
            value={source}
            disabled={load.isPending}
            onValueChange={(next) => {
              setPeriod("day");
              open(symbol, cryptoSourceSchema.parse(next));
            }}
          >
            <SelectTrigger
              aria-label="数字货币数据源"
              title="自动按 币安 → OKX → Gate → Coinbase → Bybit 顺序读取"
              className="ml-auto w-auto min-w-24"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cryptoSourceSchema.options.map((s) => (
                <SelectItem key={s} value={s}>
                  {cryptoSourceLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="segmented">
            {chartPeriodSchema.options.map((p) => (
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
            market="crypto"
            symbol={symbol}
            displayName={cryptoDisplayName(symbol)}
            referencePrice={
              loaded?.symbol === symbol
                ? (loaded.bars.at(-1)?.close ?? null)
                : null
            }
            trigger={
              <Button type="button" size="sm" variant="outline">
                模拟下单
              </Button>
            }
          />
        </div>
        {load.error && !load.isPending ? (
          <div role="alert" className="p-4 text-[13px] text-nc-bad">
            数字货币行情读取失败：{load.error.message}
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
          <PanelEmpty>正在读取数字货币行情…</PanelEmpty>
        )}
        <div className="source-line">
          {loaded?.symbol === symbol
            ? `数据源 ${marketSourceLabel(loaded.source)} · `
            : ""}
          价格单位 {quote || "计价币"} · 成交量单位 {base} · 不复权 · 与 A
          股数据、自选、RPS、监控和台账完全分开
        </div>
      </section>
      <div className="nc-span-3 flex min-w-0 flex-col gap-[var(--nc-gap)]">
        <ListPanel
          icon={CurrencyBtc}
          title="交易对"
          tone="warn"
          items={defaultCryptoPairs.map((p) => ({
            key: p.symbol,
            title: p.name,
            subtitle: cryptoPair(p.symbol),
            tone: p.symbol === symbol ? "warn" : "neutral",
            action: (
              <Button
                size="sm"
                variant={p.symbol === symbol ? "default" : "outline"}
                disabled={load.isPending}
                onClick={() => open(p.symbol)}
              >
                {p.symbol === symbol ? "当前" : "查看"}
              </Button>
            ),
          }))}
        />
        <Panel
          icon={Globe}
          title="其他交易对"
          note="输入现货交易对，如 PEPEUSDT、ETHBTC。"
        >
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (isCryptoSymbol(typed)) {
                open(typed);
                setDraft("");
              }
            }}
          >
            <Input
              aria-label="交易对"
              placeholder="PEPEUSDT"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!isCryptoSymbol(typed) || load.isPending}
            >
              打开
            </Button>
          </form>
        </Panel>
      </div>
    </PageGrid>
  );
}
