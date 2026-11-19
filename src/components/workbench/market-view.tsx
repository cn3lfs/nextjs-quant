import { MarketSourceSelect } from "../market/market-source-select";
import { ChartAdjustmentSelect } from "../market/chart-adjustment-select";
import { ArrowUpRight, Plus, X } from "@phosphor-icons/react/ssr";
import { useEffect, useState } from "react";
import {
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import { chartAdjustmentLabels } from "~/lib/chart/chart-adjustment";
import { marketSourceLabel } from "~/lib/market/market-source";
import { securityDisplayName } from "~/lib/market/security-display";
import { MarketSecurityViews } from "../market/market-security-views";
import { SecuritySelect } from "../market/security-select";
import { usePeriodHotkey } from "../market/chart-hotkeys";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isSectorChartSymbol } from "~/lib/chart/chart-symbol";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectContent, SelectItem } from "../ui/select";
import { PopoverTrigger, PopoverContent, PopoverClose } from "../ui/popover";
import { PanelPopover as Popover } from "./panel-popover";
import Link from "next/link";
import {
  ArrowClockwise,
  Broadcast,
  Flask,
  Sparkle,
  Star,
} from "@phosphor-icons/react/ssr";
import { GridTable, PageGrid, Panel, SecurityCell, Segmented } from "../panels";
import { TdxSidePanel, tradableSymbol } from "../market/tdx-side-panel";
import { SymbolRpsBars } from "../market/symbol-rps-bars";

import { Empty } from "./shared";
import { type MarketState } from "../market/use-market-state";
import { useBrowseHotkey } from "../market/use-browse-hotkey";
import { useSecurityNames } from "../market/use-security-names";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";
import { useRouter } from "next/navigation";
import { marketSelectionHref } from "~/lib/stores/market-session";
import { useWorkbenchUiStore } from "~/lib/stores/workbench-ui-store";

/** Direct 分时/日K/周K/月K choices; every other supported period stays in the
 *  行情周期 dropdown next to it. */
export function ChartPeriodControl({
  period,
  intraday,
  canIntraday,
  disabled,
  periods,
  onSelect,
}: {
  period: ChartPeriod;
  intraday: boolean;
  canIntraday: boolean;
  disabled: boolean;
  periods: readonly ChartPeriod[];
  onSelect: (next: "intraday" | ChartPeriod) => void;
}) {
  const common = periods.filter(
    (p) => p === "day" || p === "week" || p === "month",
  );
  const choices: { value: "intraday" | ChartPeriod; label: string }[] = [
    ...(canIntraday ? [{ value: "intraday" as const, label: "分时" }] : []),
    ...common.map((p) => ({
      value: p,
      label: p === "day" ? "日 K" : p === "week" ? "周 K" : "月 K",
    })),
  ];
  const selected = intraday ? "intraday" : period;
  // 分时 keeps the previous K period, but the dropdown must not present that
  // period as already selected: choosing it has to fire onValueChange and
  // return to K 线. A value outside the item list keeps it unselected.
  const moreValue = intraday ? "__intraday__" : period;
  return (
    <>
      <span role="group" aria-label="常用图表周期" className="segmented">
        {choices.map((choice) => (
          <Button
            key={choice.value}
            variant="plain"
            type="button"
            className={choice.value === selected ? "selected" : ""}
            aria-pressed={choice.value === selected}
            disabled={disabled}
            onClick={() => onSelect(choice.value)}
          >
            {choice.label}
          </Button>
        ))}
      </span>
      <Select
        value={moreValue}
        disabled={disabled}
        onValueChange={(value) => onSelect(chartPeriodSchema.parse(value))}
      >
        <SelectTrigger
          aria-label="行情周期"
          title="更多周期 · F8 切换周期"
          className="w-auto min-w-28"
        >
          <span className="truncate">
            更多周期 ·{" "}
            {intraday
              ? "分时"
              : period === "day"
                ? "日 K"
                : periodLabels[period]}
          </span>
        </SelectTrigger>
        {/* popper placement does not depend on a selected item, so 分时 can
            leave the dropdown unselected without breaking focus/position. */}
        <SelectContent position="popper">
          {periods.map((p) => (
            <SelectItem key={p} value={p}>
              {p === "day" ? "日 K" : periodLabels[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

export function MarketView({
  state,
  notify,
  embedded = false,
  frozen = false,
}: {
  notify: (text: string) => void;
  embedded?: boolean;
  /** A saved formula candidate owns the chart; the old list must not step it. */
  frozen?: boolean;
  state: Pick<
    MarketState,
    | "marketSource"
    | "marketView"
    | "setMarketView"
    | "setMarketSource"
    | "symbol"
    | "setSymbol"
    | "period"
    | "loaded"
    | "load"
    | "browse"
    | "setBrowse"
    | "chartPeriod"
    | "setChartPeriod"
    | "chartMode"
    | "setChartMode"
    | "adjustment"
    | "setAdjustment"
  >;
}) {
  const {
    marketSource,
    marketView,
    setMarketView,
    setMarketSource,
    symbol,
    setSymbol,
    period,
    loaded,
    load,
    browse,
    setBrowse,
    chartPeriod,
    setChartPeriod,
    chartMode,
    setChartMode,
    adjustment: chartAdjustment,
    setAdjustment: setChartAdjustment,
  } = state;
  const visible = useTaskVisible();
  const router = useRouter();
  // 专注看盘 hides the candidate/watchlist rail and gives the chart full width.
  const zenMode = useWorkbenchUiStore((state) => state.zenMode);
  // Frozen candidate evidence owns the chart until an ordinary read succeeds,
  // including while the ordinary route is pending or failed.
  const frozenEvidence = loaded?.frozenCandidate === true;
  const holdFrozen = frozen || frozenEvidence;
  const savedWatchlist = api.status.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    select: (value) => value.watchlist,
  });
  const watchlist = savedWatchlist.data ?? [];
  const utils = api.useUtils();
  const watch = api.watchlist.useMutation({
    onSuccess: () => void utils.status.invalidate(),
    onError: (error) => notify(error.message),
  });
  const watchUnavailable =
    !savedWatchlist.data || !!savedWatchlist.error || watch.isPending;
  let watchActionLabel = "加入自选";
  if (!loaded) watchActionLabel = "请先加载证券";
  else if (savedWatchlist.error) watchActionLabel = "自选列表读取失败";
  else if (!savedWatchlist.data) watchActionLabel = "正在读取自选";
  else if (watch.isPending) watchActionLabel = "正在加入自选";
  else if (load.isPending) watchActionLabel = "正在加载行情";
  else if (isSectorChartSymbol(loaded.symbol))
    watchActionLabel = "板块暂不支持自选";
  else if (watchlist.includes(loaded.symbol)) watchActionLabel = "已在自选";
  const names = useSecurityNames().data ?? {};
  const chartSymbol = loaded?.symbol ?? symbol;
  const effectiveAdjustment =
    isMarketIndex(chartSymbol) || isSectorChartSymbol(chartSymbol)
      ? "none"
      : chartAdjustment;
  const displayedPeriod = chartPeriod;
  // While frozen evidence is held, the main chart follows the recorded period
  // and adjustment even if an ordinary URL left the toolbar on another choice.
  const snapshotPeriod =
    frozenEvidence && loaded ? loaded.period : displayedPeriod;
  const snapshotAdjustment =
    frozenEvidence && loaded ? loaded.adjustment : effectiveAdjustment;
  const availableChartPeriods = chartPeriodSchema.options.filter(
    (p) =>
      p !== "4h" &&
      p !== "1h" &&
      (marketSource !== "local" ||
        !loaded?.barStore?.availablePeriods ||
        loaded.barStore.availablePeriods.includes(p)),
  );
  // 分时 reuses the chart's existing availability rule (ordinary, tradable
  // A-share symbols, indices included); frozen evidence always stays on K 线.
  const canIntraday = !holdFrozen && tradableSymbol(chartSymbol);
  const showIntraday = canIntraday && chartMode === "intraday";
  const selectChart = (next: "intraday" | ChartPeriod) => {
    if (next === "intraday") {
      if (canIntraday) setChartMode("intraday");
      return;
    }
    // Any explicit K period choice leaves 分时 and keeps that period.
    setChartMode("k");
    if (availableChartPeriods.includes(next)) setChartPeriod(next);
  };
  usePeriodHotkey(
    chartPeriod,
    (next) => {
      setChartMode("k");
      // Leaving 分时 enters the last K period; K 线 keeps cycling as before.
      if (!showIntraday) setChartPeriod(next);
    },
    !visible || load.isPending || holdFrozen || marketView === "financial",
    availableChartPeriods,
  );
  const [browseEdge, setBrowseEdge] = useState("");
  const [listSource, setListSource] = useState<"candidates" | "watch">(
    "candidates",
  );
  const [candidatePage, setCandidatePage] = useState(1);
  const [listsOpen, setListsOpen] = useState(false);
  // A frozen candidate is stepped by the screening result controls. Keeping the
  // stale browse list out of both the UI and the hotkey prevents PageUp/PageDown
  // from replacing the frozen chart with a live load.
  const activeBrowse = holdFrozen ? null : browse;
  useEffect(() => {
    setCandidatePage(Math.floor((activeBrowse?.index ?? 0) / 50) + 1);
  }, [activeBrowse?.index, activeBrowse?.label]);
  const candidatePages = Math.max(
    1,
    Math.ceil((activeBrowse?.symbols.length ?? 0) / 50),
  );
  const displayedCandidatePage = Math.min(candidatePage, candidatePages);
  useBrowseHotkey(
    activeBrowse,
    (next) => {
      setBrowseEdge("");
      setBrowse(next);
      const target = next.symbols[next.index]!;
      setSymbol(target);
      load.mutate({ symbol: target, period, source: marketSource });
    },
    // Not blocked while a load is in flight: rapid PageDown is how TDX users
    // skim a list, and only the last mutate call's callbacks apply.
    (first) => setBrowseEdge(first ? "已是第一只" : "已是最后一只"),
  );
  return (
    <div
      className="nc-market-workspace"
      style={
        embedded || zenMode
          ? { gridTemplateColumns: "minmax(0,1fr)" }
          : undefined
      }
    >
      {!zenMode && (
        <aside
          className={
            embedded
              ? "nc-market-candidates static! max-h-none!"
              : "nc-market-candidates"
          }
        >
          <Button
            variant="outline"
            className={
              embedded
                ? "nc-market-list-toggle inline-flex!"
                : "nc-market-list-toggle"
            }
            aria-expanded={listsOpen}
            aria-controls="market-candidate-lists"
            onClick={() => setListsOpen((open) => !open)}
          >
            自选与候选
          </Button>
          <div
            id="market-candidate-lists"
            className="nc-market-list-content space-y-3"
            data-expanded={listsOpen}
            style={embedded && !listsOpen ? { display: "none" } : undefined}
          >
            {activeBrowse && (
              <Segmented
                label="行情候选来源"
                value={listSource}
                onChange={setListSource}
                options={[
                  { value: "candidates", label: "来源列表" },
                  { value: "watch", label: "我的自选" },
                ]}
              />
            )}
            <div hidden={!activeBrowse || listSource !== "candidates"}>
              {activeBrowse && (
                <Panel
                  title={activeBrowse.label}
                  meta={`${activeBrowse.index + 1} / ${activeBrowse.symbols.length} · PgUp/PgDn连续翻股`}
                >
                  <GridTable
                    label="来源候选"
                    rows={activeBrowse.symbols.slice(
                      (displayedCandidatePage - 1) * 50,
                      displayedCandidatePage * 50,
                    )}
                    rowKey={(value) => value}
                    columns={[
                      {
                        key: "security",
                        header: "证券",
                        cell: (value) => (
                          <Button
                            variant="plain"
                            className="w-full text-left"
                            aria-current={symbol === value ? "true" : undefined}
                            onClick={() => {
                              const index = activeBrowse.symbols.indexOf(value);
                              setBrowse({ ...activeBrowse, index });
                              setBrowseEdge("");
                              setSymbol(value);
                              load.mutate({
                                symbol: value,
                                period,
                                source: marketSource,
                              });
                            }}
                          >
                            <SecurityCell
                              name={securityDisplayName(value, names)}
                              code={value.toUpperCase()}
                            />
                          </Button>
                        ),
                      },
                    ]}
                    rowClassName={(value) =>
                      symbol === value ? "bg-nc-accent-900" : undefined
                    }
                  />
                  <nav
                    aria-label="候选列表分页"
                    className="mt-3 flex items-center justify-between gap-2"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={displayedCandidatePage === 1}
                      onClick={() =>
                        setCandidatePage(displayedCandidatePage - 1)
                      }
                    >
                      上一页
                    </Button>
                    <span className="text-[13px]">
                      {displayedCandidatePage}/{candidatePages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={displayedCandidatePage === candidatePages}
                      onClick={() =>
                        setCandidatePage(displayedCandidatePage + 1)
                      }
                    >
                      下一页
                    </Button>
                  </nav>
                </Panel>
              )}
            </div>
            <div hidden={!!activeBrowse && listSource === "candidates"}>
              <Panel
                span={8}
                icon={Star}
                title="我的自选"
                actions={
                  <span className="muted">
                    {savedWatchlist.data
                      ? `${watchlist.length} 个标的`
                      : "尚未读取"}
                  </span>
                }
              >
                {savedWatchlist.error && (
                  <p role="alert">
                    自选列表未刷新：{savedWatchlist.error.message}{" "}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void savedWatchlist.refetch()}
                    >
                      重试自选列表
                    </Button>
                  </p>
                )}
                <GridTable
                  label="我的自选"
                  rows={watchlist}
                  rowKey={(s) => s}
                  empty={
                    savedWatchlist.error
                      ? "暂时无法读取自选列表"
                      : !savedWatchlist.data
                        ? "正在读取自选列表…"
                        : "在上方加载证券后加入自选"
                  }
                  columns={[
                    {
                      key: "security",
                      header: "证券",
                      width: "3fr",
                      cell: (s) => (
                        <Button
                          variant="plain"
                          className="flex items-center gap-[9px] text-left"
                          disabled={holdFrozen}
                          onClick={() => {
                            setSymbol(s);
                            load.mutate({
                              symbol: s,
                              period,
                              source: marketSource,
                            });
                          }}
                        >
                          <span className="stock-avatar">
                            {s.slice(0, 2).toUpperCase()}
                          </span>
                          <SecurityCell
                            name={securityDisplayName(s, names)}
                            code={s.toUpperCase()}
                          />
                          <ArrowUpRight size={14} className="text-nc-text-4" />
                        </Button>
                      ),
                    },
                    {
                      key: "actions",
                      header: "",
                      width: "1fr",
                      align: "right",
                      cell: (s) => (
                        <Button
                          variant="plain"
                          className="icon-button"
                          aria-label={`移除 ${s}`}
                          disabled={watchUnavailable}
                          onClick={() =>
                            watch.mutate(watchlist.filter((v) => v !== s))
                          }
                        >
                          <X size={13} />
                        </Button>
                      ),
                    },
                  ]}
                />
              </Panel>
            </div>
          </div>
        </aside>
      )}
      <div className="min-w-0 space-y-4">
        <section className="panel chart-panel nc-span-12">
          <div className="panel-toolbar">
            <SecuritySelect
              symbol={symbol}
              name={
                loaded?.symbol === symbol
                  ? securityDisplayName(symbol, names, loaded.name)
                  : names[symbol]
              }
              period={period}
              disabled={holdFrozen || load.isPending}
              onPeriod={selectChart}
              onSelect={(next) => {
                setSymbol(next);
                load.mutate({
                  symbol: next,
                  period,
                  source: marketSource,
                });
              }}
            />
            {activeBrowse && (
              <>
                <span
                  role="status"
                  className="flex items-center gap-1 text-xs text-nc-text-3"
                  title="PageUp/PageDown 切换上一只/下一只"
                >
                  {activeBrowse.label} {activeBrowse.index + 1}/
                  {activeBrowse.symbols.length} · PgUp/PgDn 换股
                  {browseEdge && ` · ${browseEdge}`}
                  <Button
                    size="sm"
                    variant="plain"
                    aria-label="退出列表翻股"
                    onClick={() => {
                      setBrowse(null);
                      setBrowseEdge("");
                    }}
                  >
                    ×
                  </Button>
                </span>
                {/* The ranking panel keeps its search/period/page in the
                    existing panel cache, so returning continues that list. */}
                {activeBrowse.origin === "stock-rps" &&
                  activeBrowse.symbols.includes(symbol) && (
                    <Button asChild size="sm" variant="ghost">
                      <Link href="/scan?tab=rps" scroll={false}>
                        返回个股 RPS 排名
                      </Link>
                    </Button>
                  )}
              </>
            )}
            <MarketSourceSelect
              value={marketSource}
              disabled={holdFrozen || load.isPending}
              onChange={(source) => {
                setMarketSource(source);
                load.mutate({ symbol, period, source });
              }}
            />
            <ChartAdjustmentSelect
              value={effectiveAdjustment}
              disabled={
                holdFrozen ||
                load.isPending ||
                isMarketIndex(symbol) ||
                isSectorChartSymbol(symbol)
              }
              onChange={setChartAdjustment}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={holdFrozen || load.isPending}
              onClick={() =>
                load.mutate(
                  { symbol, period, source: marketSource },
                  { fresh: true },
                )
              }
            >
              <ArrowClockwise size={13} />
              刷新行情
            </Button>
            <ChartPeriodControl
              period={displayedPeriod}
              intraday={showIntraday}
              canIntraday={canIntraday}
              disabled={holdFrozen || load.isPending}
              periods={availableChartPeriods}
              onSelect={selectChart}
            />
          </div>
          {frozenEvidence && loaded && (
            <div
              role="status"
              aria-label="冻结候选证据"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-nc-border px-4 py-2 text-xs text-nc-text-3"
            >
              <span className="text-nc-text-2">冻结候选证据</span>
              <span className="text-nc-text-4">
                选股当时快照 · 按快照口径显示，不随普通行情更新
              </span>
              <span>
                {securityDisplayName(loaded.symbol, names, loaded.name)} ·{" "}
                {loaded.symbol.toUpperCase()}
              </span>
              <span>快照周期 {periodLabels[loaded.period]}</span>
              <span>最后K线 {loaded.bars.at(-1)?.date ?? "无"}</span>
              <span>数据源 {marketSourceLabel(loaded.source)}</span>
              <span>快照复权 {chartAdjustmentLabels[loaded.adjustment]}</span>
              {frozen && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    router.push(
                      marketSelectionHref({
                        symbol,
                        chartPeriod,
                        marketSource,
                        adjustment: chartAdjustment,
                        marketView: "chart",
                        period,
                      }),
                      { scroll: false },
                    )
                  }
                >
                  在普通行情中查看
                </Button>
              )}
            </div>
          )}
          {load.error && !load.isPending ? (
            <div role="alert" className="p-4 text-[13px] text-nc-bad">
              所选数据源读取失败：{load.error.message}
              {frozenEvidence
                ? "；下方仍为冻结候选快照，并非本次普通行情读取结果。"
                : loaded
                  ? "；下方仍为已加载快照，并非本次读取结果。"
                  : ""}
              <Button
                variant="outline"
                onClick={() =>
                  load.mutate(
                    { symbol, period, source: marketSource },
                    frozenEvidence ? { fresh: true } : undefined,
                  )
                }
              >
                重试
              </Button>
            </div>
          ) : null}
          {load.isPending && (
            <p role="status" className="px-4 py-2 text-sm text-nc-text-3">
              {frozenEvidence ? (
                "正在读取普通行情；下方仍为冻结候选快照。"
              ) : (
                <>
                  正在读取所选行情；下方若有图表，仍为{" "}
                  {loaded?.symbol.toUpperCase() ?? "原快照"}。
                </>
              )}
            </p>
          )}
          {loaded ? (
            <MarketSecurityViews
              snapshot={loaded}
              period={snapshotPeriod}
              adjustment={snapshotAdjustment}
              frozenEvidence={holdFrozen}
              chartMode={chartMode}
              onChartModeChange={setChartMode}
              view={marketView}
              onViewChange={setMarketView}
              heading={
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-[15px] font-medium">
                    {securityDisplayName(loaded.symbol, names, loaded.name)}
                  </h2>
                  <span className="eyebrow">{loaded.symbol.toUpperCase()}</span>
                  {loaded.historicalAsOf && (
                    <span className="tag">
                      历史快照 · 截至 {loaded.historicalAsOf}
                    </span>
                  )}
                </div>
              }
              actions={
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" className="ml-auto">
                      继续研究
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent aria-label="继续研究">
                    <nav aria-label="继续研究" className="flex flex-col gap-2">
                      {(
                        [
                          ["/lab/analysis", Sparkle, "证据分析"],
                          ["/lab/backtest", Flask, "策略回测"],
                          ["/system/notifications", Broadcast, "监控配置"],
                        ] as const
                      ).map(([href, Glyph, label]) => (
                        <PopoverClose key={href} asChild>
                          <Button asChild size="sm" variant="ghost">
                            <Link href={href} scroll={false}>
                              <Glyph size={12} />
                              {label}
                            </Link>
                          </Button>
                        </PopoverClose>
                      ))}
                    </nav>
                  </PopoverContent>
                </Popover>
              }
            />
          ) : (
            <Empty>
              {load.isPending
                ? "正在读取行情…"
                : "输入 sh600519 等证券代码加载本地行情"}
            </Empty>
          )}
          <div className="source-line">
            {loaded
              ? `数据源 ${marketSourceLabel(loaded.source)} · 快照于 ${new Date(loaded.createdAt).toLocaleString("zh-CN", { hour12: false })} · 历史导入与回测不会发送通知`
              : "历史导入与回测不会发送通知"}
            {(isMarketIndex(chartSymbol) || isSectorChartSymbol(chartSymbol)) &&
              " · 指数行情 · 价格单位：点"}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                loaded && watch.mutate([...watchlist, loaded.symbol])
              }
              disabled={
                !loaded ||
                watchUnavailable ||
                load.isPending ||
                isSectorChartSymbol(loaded.symbol) ||
                watchlist.includes(loaded.symbol)
              }
              title={watchActionLabel}
            >
              <Plus size={13} />
              {watchActionLabel}
            </Button>
          </div>
        </section>
        <details className="rounded-lg border border-nc-border bg-nc-card p-4">
          <summary className="cursor-pointer text-sm font-medium">
            盘口、基本面与RPS · 展开查看
          </summary>
          <PageGrid>
            <Panel
              span={12}
              icon={Broadcast}
              title={
                loaded
                  ? securityDisplayName(loaded.symbol, names, loaded.name)
                  : "盘口"
              }
              meta={loaded?.symbol.toUpperCase()}
              className="self-start"
            >
              {loaded ? (
                <TdxSidePanel symbol={loaded.symbol} />
              ) : (
                <Empty>先加载一只证券</Empty>
              )}
            </Panel>
            <SymbolRpsBars symbol={loaded?.symbol ?? symbol} />
          </PageGrid>
        </details>
      </div>
    </div>
  );
}
