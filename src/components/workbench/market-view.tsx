import { MarketSourceSelect } from "../market/market-source-select";
import { ChartAdjustmentSelect } from "../market/chart-adjustment-select";
import {
  ArrowClockwise,
  ArrowUpRight,
  Broadcast,
  CaretLeft,
  CaretRight,
  Flask,
  ListDashes,
  SidebarSimple,
  Sparkle,
  Star,
  X,
} from "@phosphor-icons/react/ssr";
import { useEffect, useState, type ReactNode } from "react";
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
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
import { PopoverTrigger, PopoverContent, PopoverClose } from "../ui/popover";
import { PanelPopover as Popover } from "./panel-popover";
import Link from "next/link";
import { GridTable, SecurityCell } from "../panels";
import { MethodologyPopover } from "../panels/methodology-popover";
import { termLabel } from "~/lib/common/ui-glossary";
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
      <span
        role="group"
        aria-label="常用图表周期"
        className="segmented shrink-0 flex-nowrap! whitespace-nowrap"
      >
        {choices.map((choice) => (
          <Button
            key={choice.value}
            variant="plain"
            type="button"
            className={`px-2! text-xs! ${choice.value === selected ? "selected" : ""}`}
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
          className="w-auto min-w-20 max-w-28 px-2 text-xs"
        >
          <span className="truncate">
            更多 ·{" "}
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

/** 紧凑签组：复用 .segmented 的视觉，不引入大号分段控件。 */
function RailTabs<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <span role="tablist" aria-label={label} className="segmented min-w-0">
      {options.map((option) => (
        <Button
          key={option.value}
          variant="plain"
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "selected" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </span>
  );
}

const methodologyItems = [
  {
    label: "数据源与单位",
    detail:
      "行情来自所选本地或通达信数据源，读取失败不会静默换源。指数价格单位为点；板块与数字货币不计算个股 RPS。",
  },
  {
    label: "复权与双价",
    detail:
      "复权仅用于连续比较；入场、止损与目标始终使用原价，缺失时显示不可用，不由复权价推算。复权快照同时带原价时，图表可双价对照。",
  },
  {
    label: "通知边界",
    detail: "历史导入与回测不会发送通知；只有启用订阅的正式提醒才会推送。",
  },
] as const;

export function MarketView({
  state,
  notify,
  embedded = false,
  frozen = false,
  leftCandidatesSlot,
}: {
  notify: (text: string) => void;
  embedded?: boolean;
  /** A saved formula candidate owns the chart; the old list must not step it. */
  frozen?: boolean;
  /** 扫描候选筛选与列表，显示在左轨「扫描候选」签内。 */
  leftCandidatesSlot?: ReactNode;
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
  // 专注看盘 hides both rails and gives the chart full width.
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
  // Older hosts and isolated tests may render this view without the
  // watchlist-group procedures; fall back to the legacy status watchlist.
  const groupsQuery = api.watchlistGroups?.useQuery?.(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const groups = groupsQuery?.data?.groups ?? [];
  const [activeGroupId, setActiveGroupId] = useState("");
  const activeGroup =
    groups.find((g) => g.id === activeGroupId) ??
    groups.find((g) => g.id === groupsQuery?.data?.defaultGroupId) ??
    groups[0] ??
    null;
  const watchlist = activeGroup
    ? activeGroup.symbols
    : (savedWatchlist.data ?? []);
  const utils = api.useUtils();
  const invalidateWatchlist = () => {
    void utils.status.invalidate();
    void utils.watchlistGroups?.invalidate?.();
  };
  const watch = api.watchlist.useMutation({
    onSuccess: invalidateWatchlist,
    onError: (error) => notify(error.message),
  });
  const addToGroup = api.watchlistGroupAddSymbols?.useMutation?.({
    onSuccess: (result) => {
      invalidateWatchlist();
      notify(`已加入「${result.group.name}」`);
    },
    onError: (error) => notify(error.message),
  });
  const removeFromGroup = api.watchlistGroupRemoveSymbol?.useMutation?.({
    onSuccess: invalidateWatchlist,
    onError: (error) => notify(error.message),
  });
  const usesGroups = !!api.watchlistGroups?.useQuery;
  const watchReady = usesGroups ? !!activeGroup : !!savedWatchlist.data;
  const watchError = groupsQuery?.error ?? savedWatchlist.error;
  const watchPending =
    watch.isPending || !!addToGroup?.isPending || !!removeFromGroup?.isPending;
  const watchUnavailable = !watchReady || !!watchError || watchPending;
  let watchActionLabel = "加入自选";
  if (!loaded) watchActionLabel = "请先加载证券";
  else if (watchError) watchActionLabel = "自选列表读取失败";
  else if (!watchReady) watchActionLabel = "正在读取自选";
  else if (watchPending) watchActionLabel = "正在加入自选";
  else if (load.isPending) watchActionLabel = "正在加载行情";
  else if (isSectorChartSymbol(loaded.symbol))
    watchActionLabel = "板块暂不支持自选";
  else if (watchlist.includes(loaded.symbol)) watchActionLabel = "已在自选";
  const addSymbolToActive = (targetSymbol: string) => {
    if (activeGroup && addToGroup) {
      addToGroup.mutate({ groupId: activeGroup.id, symbols: [targetSymbol] });
    } else {
      watch.mutate([...watchlist, targetSymbol]);
    }
  };
  const removeSymbolFromActive = (targetSymbol: string) => {
    if (activeGroup && removeFromGroup) {
      removeFromGroup.mutate({ groupId: activeGroup.id, symbol: targetSymbol });
    } else {
      watch.mutate(watchlist.filter((v) => v !== targetSymbol));
    }
  };
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
  const hasScanSlot = leftCandidatesSlot !== undefined;
  const [leftTab, setLeftTab] = useState<"watch" | "scan">(
    hasScanSlot ? "scan" : "watch",
  );
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [watchQuery, setWatchQuery] = useState("");
  useEffect(() => {
    if (hasScanSlot) setLeftTab("scan");
  }, [hasScanSlot]);
  // A frozen candidate is stepped by the screening result controls. Keeping the
  // stale browse list out of both the UI and the hotkey prevents PageUp/PageDown
  // from replacing the frozen chart with a live load.
  const activeBrowse = holdFrozen ? null : browse;
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
  const showLeftRail = !embedded && !zenMode;
  const showRightRail = !embedded && !zenMode;
  const leftIsCollapsed = !showLeftRail || leftCollapsed;
  const rightIsCollapsed = !showRightRail || rightCollapsed;
  const watchFilter = watchQuery.trim().toLowerCase();
  const watchRows = watchFilter
    ? watchlist.filter(
        (value) =>
          value.toLowerCase().includes(watchFilter) ||
          (names[value] ?? "").toLowerCase().includes(watchFilter),
      )
    : watchlist;
  // 复权快照同时带原价时，图表可双价对照；冻结证据用「选股当时快照」标识。
  const dualPrice =
    !frozenEvidence &&
    loaded?.adjustment !== "none" &&
    (loaded?.rawBars?.length ?? 0) > 0;
  return (
    <div
      className="nc-market-terminal"
      data-left-collapsed={leftIsCollapsed}
      data-right-collapsed={rightIsCollapsed}
    >
      {showLeftRail && (
        <aside className="nc-market-rail" aria-label="自选与扫描候选">
          <div className="flex items-center gap-1 border-b border-nc-border px-2 py-1.5">
            {hasScanSlot ? (
              <RailTabs
                label="列表来源"
                value={leftTab}
                onChange={setLeftTab}
                options={[
                  {
                    value: "watch",
                    label: `我的自选 (${watchReady ? watchlist.length : "—"})`,
                  },
                  { value: "scan", label: "扫描候选" },
                ]}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-nc-text-2">
                {activeGroup ? activeGroup.name : "我的自选"} (
                {watchReady ? watchlist.length : "—"})
              </span>
            )}
            <Button
              variant="plain"
              type="button"
              className="icon-button shrink-0"
              aria-label="收起列表"
              aria-expanded="true"
              title="收起列表"
              onClick={() => setLeftCollapsed(true)}
            >
              <CaretLeft size={13} />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {hasScanSlot && (
              <div hidden={leftTab !== "scan"}>{leftCandidatesSlot}</div>
            )}
            <div
              className="space-y-2"
              hidden={hasScanSlot && leftTab === "scan"}
            >
              {watchError && (
                <p role="alert" className="text-xs text-nc-bad">
                  自选列表未刷新：{watchError.message}{" "}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void savedWatchlist.refetch();
                      void groupsQuery?.refetch?.();
                    }}
                  >
                    重试
                  </Button>
                </p>
              )}
              {groups.length > 1 && activeGroup && (
                <Select value={activeGroup.id} onValueChange={setActiveGroupId}>
                  <SelectTrigger
                    aria-label="切换自选列表"
                    className="h-8 w-full text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g.symbols.length})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label="搜索我的自选"
                  placeholder="代码 / 名称"
                  className="h-8 flex-1"
                  value={watchQuery}
                  onChange={(event) => setWatchQuery(event.target.value)}
                />
                <Button
                  asChild
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                >
                  <Link href="/scan?tab=watchlist" scroll={false}>
                    管理
                  </Link>
                </Button>
              </div>
              <GridTable
                label="我的自选"
                rows={watchRows}
                rowKey={(value) => value}
                empty={
                  watchError
                    ? "暂时无法读取自选列表"
                    : !watchReady
                      ? "正在读取自选列表…"
                      : watchFilter
                        ? "没有匹配的自选标的"
                        : "加载证券后加入自选"
                }
                columns={[
                  {
                    key: "security",
                    header: "证券",
                    width: "3fr",
                    cell: (value) => (
                      <Button
                        variant="plain"
                        className="flex w-full min-w-0 items-center gap-2 text-left"
                        disabled={holdFrozen}
                        onClick={() => {
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
                        <ArrowUpRight
                          size={13}
                          className="shrink-0 text-nc-text-4"
                        />
                      </Button>
                    ),
                  },
                  {
                    key: "actions",
                    header: "",
                    width: "28px",
                    align: "right",
                    cell: (value) => (
                      <Button
                        variant="plain"
                        className="icon-button"
                        aria-label={`移除 ${value}`}
                        disabled={watchUnavailable}
                        onClick={() => removeSymbolFromActive(value)}
                      >
                        <X size={13} />
                      </Button>
                    ),
                  },
                ]}
              />
            </div>
          </div>
        </aside>
      )}
      <div className="min-w-0 space-y-3">
        <section className="panel chart-panel nc-span-12">
          <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-nc-border-soft px-3 py-1.5">
            {showLeftRail && leftCollapsed && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                className="shrink-0 gap-1 px-1.5"
                aria-expanded="false"
                title="展开列表（自选/候选）"
                onClick={() => setLeftCollapsed(false)}
              >
                <ListDashes size={16} />
                <span className="text-xs">展开列表</span>
              </Button>
            )}
            <div className="w-[210px] min-w-[150px] max-w-[280px] shrink-0">
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
            </div>
            {activeBrowse && (
              <span
                role="status"
                className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-nc-text-3"
                title="PageUp/PageDown 切换上一只/下一只"
              >
                {activeBrowse.label} {activeBrowse.index + 1}/
                {activeBrowse.symbols.length} · PgUp/PgDn 换股
                {browseEdge && ` · ${browseEdge}`}
                <Button
                  size="sm"
                  variant="plain"
                  type="button"
                  aria-label="退出列表翻股"
                  onClick={() => {
                    setBrowse(null);
                    setBrowseEdge("");
                  }}
                >
                  ×
                </Button>
              </span>
            )}
            {frozenEvidence && (
              <span className="tag shrink-0">
                {termLabel("frozenSnapshot")}
              </span>
            )}
            {dualPrice && (
              <span
                className="tag shrink-0"
                title="复权与原价同时在快照内，图表可切换对照"
              >
                {termLabel("dualPriceSync")}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {activeBrowse?.origin === "stock-rps" &&
                activeBrowse.symbols.includes(symbol) && (
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/scan?tab=rps" scroll={false}>
                      返回个股 RPS 排名
                    </Link>
                  </Button>
                )}
              <Button
                size="sm"
                variant={
                  loaded && watchlist.includes(loaded.symbol)
                    ? "ghost"
                    : "outline"
                }
                type="button"
                onClick={() => loaded && addSymbolToActive(loaded.symbol)}
                disabled={
                  !loaded ||
                  watchUnavailable ||
                  load.isPending ||
                  isSectorChartSymbol(loaded.symbol) ||
                  watchlist.includes(loaded.symbol)
                }
                title={watchActionLabel}
              >
                <Star
                  size={13}
                  weight={
                    loaded && watchlist.includes(loaded.symbol)
                      ? "fill"
                      : "regular"
                  }
                />
                {watchActionLabel}
              </Button>
              {groups.length > 1 &&
                loaded &&
                !isSectorChartSymbol(loaded.symbol) &&
                addToGroup && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        disabled={watchUnavailable || load.isPending}
                      >
                        加入列表
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent aria-label="添加到自选列表">
                      <div className="flex min-w-40 flex-col gap-1">
                        {groups.map((g) => {
                          const exists = g.symbols.includes(loaded.symbol);
                          return (
                            <PopoverClose key={g.id} asChild>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="justify-between"
                                disabled={exists || watchUnavailable}
                                onClick={() =>
                                  addToGroup.mutate({
                                    groupId: g.id,
                                    symbols: [loaded.symbol],
                                  })
                                }
                              >
                                <span>{g.name}</span>
                                <span className="text-xs text-nc-text-4">
                                  {exists ? "已在" : `+ (${g.symbols.length})`}
                                </span>
                              </Button>
                            </PopoverClose>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              {loaded && watchlist.includes(loaded.symbol) && (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={watchUnavailable || load.isPending}
                  onClick={() => removeSymbolFromActive(loaded.symbol)}
                  title="从我的自选移出"
                >
                  移出
                </Button>
              )}
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" type="button">
                    继续研究
                  </Button>
                </PopoverTrigger>
                <PopoverContent aria-label="继续研究">
                  <nav aria-label="继续研究" className="flex flex-col gap-2">
                    {(
                      [
                        ["/lab/analysis?tab=evidence", Sparkle, "证据分析"],
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
              {showRightRail && (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  aria-label={rightCollapsed ? "展开盘口" : "收起盘口"}
                  aria-expanded={!rightCollapsed}
                  onClick={() => setRightCollapsed((collapsed) => !collapsed)}
                >
                  <SidebarSimple size={14} />
                  {rightCollapsed ? "展开盘口" : "收起盘口"}
                </Button>
              )}
              <MethodologyPopover items={methodologyItems} />
            </div>
          </div>
          <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-nc-border-soft px-3 py-1.5">
            <ChartPeriodControl
              period={displayedPeriod}
              intraday={showIntraday}
              canIntraday={canIntraday}
              disabled={holdFrozen || load.isPending}
              periods={availableChartPeriods}
              onSelect={selectChart}
            />
            <span
              className="h-4 w-px shrink-0 bg-nc-border"
              aria-hidden="true"
            />
            <span className="min-w-0 shrink-0 [&>button]:min-w-0 [&>button]:max-w-24 [&>button]:px-2 [&>button]:text-xs">
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
            </span>
            <span className="min-w-0 shrink-0 [&>button]:min-w-0 [&>button]:max-w-28 [&>button]:px-2 [&>button]:text-xs">
              <MarketSourceSelect
                value={marketSource}
                disabled={holdFrozen || load.isPending}
                onChange={(source) => {
                  setMarketSource(source);
                  load.mutate({ symbol, period, source });
                }}
              />
            </span>
            <Button
              size="sm"
              variant="outline"
              type="button"
              className="shrink-0 px-2"
              aria-label="刷新行情"
              title="刷新行情"
              disabled={holdFrozen || load.isPending}
              onClick={() =>
                load.mutate(
                  { symbol, period, source: marketSource },
                  { fresh: true },
                )
              }
            >
              <ArrowClockwise size={13} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
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
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-[15px] font-medium">
                    {securityDisplayName(loaded.symbol, names, loaded.name)}
                  </h2>
                  <span className="eyebrow">{loaded.symbol.toUpperCase()}</span>
                  {loaded.historicalAsOf && (
                    <span className="tag">
                      历史快照 · 截至 {loaded.historicalAsOf}
                    </span>
                  )}
                  <span className="text-[11px] text-nc-text-4 tabular">
                    {marketSourceLabel(loaded.source)} ·{" "}
                    {new Date(loaded.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </span>
                </div>
              }
            />
          ) : (
            <Empty>
              {load.isPending
                ? "正在读取行情…"
                : "输入 sh600519 等证券代码加载本地行情"}
            </Empty>
          )}
        </section>
      </div>
      {showRightRail && (
        <aside className="nc-market-rail" aria-label="盘口指标">
          <div className="flex items-center gap-1 border-b border-nc-border px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-nc-text-2">
              盘口指标
            </span>
            <Button
              variant="plain"
              type="button"
              className="icon-button shrink-0"
              aria-label="收起盘口"
              title="收起盘口"
              onClick={() => setRightCollapsed(true)}
            >
              <CaretRight size={13} />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="space-y-2">
              {loaded ? (
                <>
                  <TdxSidePanel symbol={loaded.symbol} />
                  <SymbolRpsBars symbol={loaded.symbol} />
                </>
              ) : (
                <Empty>先加载一只证券</Empty>
              )}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
