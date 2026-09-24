"use client";
import { Mountains } from "@phosphor-icons/react/ssr";
import { useEffect, useState } from "react";
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
  isFuturesSymbol,
  type FuturesSource,
} from "~/lib/market/futures";
import { api } from "~/trpc/react";
import { ListPanel, PageGrid, PanelEmpty, Pill } from "../panels";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ChartWorkspace } from "./chart-workspace";

const DEFAULT = "fuGC00Y";

/** Contract from `?code=GC00Y`. */
function initialSymbol() {
  if (typeof window === "undefined") return DEFAULT;
  const code = new URLSearchParams(window.location.search).get("code") ?? "";
  const symbol = `fu${code.toUpperCase()}`;
  return isFuturesSymbol(symbol) ? symbol : DEFAULT;
}

/**
 * 资源期货: a fixed list of major commodity contracts (Eastmoney continuous /
 * main contracts), browse-only and separate from the A-share view.
 */
export function FuturesView() {
  const [symbol, setSymbol] = useState(DEFAULT);
  const [period, setPeriod] = useState<ChartPeriod>("day");
  const [source, setSource] = useState<FuturesSource>("auto");
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const load = api.snapshot.useMutation({ onSuccess: setLoaded });
  const quotes = api.futuresQuotes.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const first = initialSymbol();
    setSymbol(first);
    load.mutate({ symbol: first, period: "day" });
  }, []);
  const open = (next: string, pick = source) => {
    // A contract without the picked source falls back to the automatic chain.
    const usable = futuresSourceSupports(futuresContract(next)!, pick)
      ? pick
      : "auto";
    setSymbol(next);
    setSource(usable);
    load.mutate({ symbol: next, period: "day", futuresSource: usable });
  };
  const contract = futuresContract(symbol)!;
  const quoteOf = (s: string) => quotes.data?.find((q) => q.symbol === s);
  return (
    <PageGrid>
      <section className="panel chart-panel nc-span-9">
        <div className="panel-toolbar">
          <div className="flex items-center gap-2">
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
              className="ml-auto w-auto min-w-44"
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
          价格单位 {contract.unit} · 成交量单位 手 · 连续/主连合约未做换月调整 ·
          境外合约 Yahoo
          优先、国内合约东方财富优先，失败依次换源（以图表来源为准），仅供浏览，与
          A 股数据完全分开
        </div>
      </section>
      <div className="nc-span-3 flex min-w-0 flex-col gap-[var(--nc-gap)]">
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
                      ? `${close.toFixed(c.precision)} ${c.unit}${
                          change === null
                            ? ""
                            : ` · ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
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
    </PageGrid>
  );
}
