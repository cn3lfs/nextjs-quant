"use client";
import { CurrencyBtc, Globe } from "@phosphor-icons/react/ssr";
import { useEffect, useState } from "react";
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
  cryptoSymbol,
  defaultCryptoPairs,
  isCryptoSymbol,
} from "~/lib/market/crypto";
import { api } from "~/trpc/react";
import { ListPanel, PageGrid, Panel, PanelEmpty, Pill } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ChartWorkspace } from "./chart-workspace";

/** Pair from `?pair=BTCUSDT` (or a legacy `?symbol=cxBTCUSDT` deep link). */
function initialPair() {
  if (typeof window === "undefined") return "cxBTCUSDT";
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("pair") ?? params.get("symbol") ?? "").toUpperCase();
  const symbol = cryptoSymbol(raw.replace(/^CX/, ""));
  return isCryptoSymbol(symbol) ? symbol : "cxBTCUSDT";
}

/**
 * 数字货币: a page of its own, apart from the A-share market view. It keeps
 * its own pair and period state and only ever loads Binance spot data.
 */
export function CryptoView() {
  const [symbol, setSymbol] = useState("cxBTCUSDT");
  const [period, setPeriod] = useState<ChartPeriod>("day");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const load = api.snapshot.useMutation({ onSuccess: setLoaded });
  useEffect(() => {
    const first = initialPair();
    setSymbol(first);
    load.mutate({ symbol: first, period: "day" });
  }, []);
  const open = (next: string) => {
    setSymbol(next);
    load.mutate({ symbol: next, period: "day" });
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
        <div className="panel-toolbar">
          <div className="flex items-center gap-2">
            <CurrencyBtc size={18} className="nc-text-warn" />
            <strong className="text-[15px] font-medium">
              {cryptoDisplayName(symbol)}
            </strong>
            <Pill tone="warn">数字货币</Pill>
            <Pill tone="idle">币安现货 · 7×24 · UTC 收线</Pill>
          </div>
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
        </div>
        {load.error && !load.isPending ? (
          <div role="alert" className="p-4 text-[12px] text-nc-bad">
            币安行情读取失败：{load.error.message}
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
          <PanelEmpty>正在读取币安行情…</PanelEmpty>
        )}
        <div className="source-line">
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
          note="输入币安现货交易对，如 PEPEUSDT、ETHBTC。"
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
