"use client";
import { formatNumber } from "trading-strategy-core/format-number";
import { chartColor } from "~/lib/chart/chart-theme";

import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { PanelPopover as Popover } from "../workbench/panel-popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CzscSettingsDialog } from "./czsc-settings-dialog";
import type { Snapshot } from "~/lib/domain";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isCryptoSymbol } from "~/lib/market/crypto";
import type { IntelEvent } from "~/lib/news/intel-events";
import {
  chartPricePrecision,
  isNonAShareChartSymbol,
} from "~/lib/chart/chart-symbol";
import { api } from "~/trpc/react";
import {
  chartCost,
  chartViewSchema,
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
  type ChartView,
  type Drawing,
} from "~/lib/chart/chart-view";
import {
  createCrosshairLink,
  remapDrawing,
  type CrosshairLink,
} from "~/lib/chart/crosshair-link";
import { CzscMarketChart, MarketChart } from "./chart";
import { IntelAnnotations } from "../news/intel-annotations";
import {
  ChartTradeMarksContext,
  type ChartCompare,
  type ChartTradeMarksValue,
} from "./market-chart-state";
import {
  normalizeTradeSymbol,
  tradeFillsFromDiagnose,
} from "~/lib/chart/chart-trade-marks";
import { compareColors } from "./market-chart-palette";
import { SecuritySelect } from "./security-select";
import { ChartCompareSectors } from "./chart-compare-sectors";
import { drawingPointCount } from "~/lib/chart/chart-drawings";
import { IntradayChart } from "./intraday-chart";
import { tradableSymbol } from "./tdx-side-panel";
import { isTypingTarget } from "./chart-hotkeys";
import {
  useMarketSession,
  type ChartMode,
  type MarketSnapshot,
} from "~/lib/stores/market-session";
import { useWorkbenchUiStore } from "~/lib/stores/workbench-ui-store";
import { StateBanner } from "../panels";

// TDX keeps 分时 or K 线 across symbol switches; the workspace remounts per
// symbol/period. Ordinary A-share charts let the market session own the mode,
// while standalone charts (crypto/futures) keep the last choice here.
let lastIntraday = false;
// The linked second period (TDX 多周期同列) is kept the same way.
let lastSecond: ChartPeriod | null = null;
import { useScreenVisible } from "../workbench/use-task-visible";
const tools = {
  none: "浏览",
  trend: "趋势线",
  horizontal: "水平线",
  rectangle: "矩形",
  fibonacci: "斐波那契",
  ray: "射线",
  channel: "平行通道",
  text: "文字",
  measure: "测量",
} as const;
export function ChartWorkspace({
  snapshot,
  period,
  adjustment,
  frozenEvidence = false,
  showIntelAnnotations = !isCryptoSymbol(snapshot.symbol),
  chartMode,
  onChartModeChange,
}: {
  snapshot: Snapshot;
  period: ChartPeriod;
  adjustment: ChartAdjustment;
  /** The chart must stay on the archived snapshot; no linked live period. */
  frozenEvidence?: boolean;
  /**
   * News markers on the chart and the 图表新闻事件 box below it. Off for crypto
   * by default: Binance pair news is sparse, noisy and floods the candles.
   */
  showIntelAnnotations?: boolean;
  /** Controlled by the market session on ordinary A-share charts. */
  chartMode?: ChartMode;
  onChartModeChange?: (mode: ChartMode) => void;
}) {
  const [limit, setLimit] = useState(2000);
  const visible = useScreenVisible();
  const requestMore = useCallback(
    () => setLimit((value) => Math.min(20000, value + 2000)),
    [],
  );
  const view = api.chartView.useQuery(
    { symbol: snapshot.symbol, period },
    { enabled: visible, retry: false, refetchOnWindowFocus: false },
  );
  const aggregate = api.chartBars.useQuery(
    { snapshotId: snapshot.id, period, limit, adjustment },
    {
      retry: false,
      refetchOnWindowFocus: false,
      placeholderData: (previous) => previous,
      enabled: visible,
    },
  );
  const rps = api.rpsCurve.useQuery(snapshot.symbol, {
    enabled:
      visible && period === "day" && !isNonAShareChartSymbol(snapshot.symbol),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const position = api.chartPosition.useQuery(snapshot.symbol, {
    enabled:
      visible &&
      adjustment === "none" &&
      !isNonAShareChartSymbol(snapshot.symbol),
    retry: false,
    refetchOnWindowFocus: true,
  });
  if (view.error)
    return (
      <div role="alert">
        图表设置读取失败：{view.error.message}{" "}
        <Button variant="plain" onClick={() => void view.refetch()}>
          重试读取
        </Button>
      </div>
    );
  if (!view.data) return <p>正在读取图表设置…</p>;
  if (aggregate.error)
    return (
      <div role="alert">
        行情数据合成失败：{aggregate.error.message}{" "}
        <Button variant="plain" onClick={() => void aggregate.refetch()}>
          重试合成
        </Button>
      </div>
    );
  if (!aggregate.data) return <p>正在读取目标周期行情…</p>;
  // A formula archive is the recorded selection evidence, not ordinary market
  // data; its adjusted close and plan raw price must be explained together.
  const frozenCandidate =
    snapshot.id.startsWith("snapshot-formula-") ||
    (snapshot as MarketSnapshot).frozenCandidate === true;
  return (
    <EditableChart
      key={`${snapshot.symbol}:${period}:${adjustment}`}
      sourceId={snapshot.id}
      snapshot={aggregate.data}
      frozenCandidate={frozenCandidate}
      onHistoryRequest={
        !aggregate.isFetching &&
        !aggregate.data.historyExhausted &&
        limit < 20000
          ? requestMore
          : undefined
      }
      period={period}
      adjustment={adjustment}
      frozenEvidence={frozenEvidence}
      showIntelAnnotations={showIntelAnnotations}
      initial={view.data}
      chartMode={chartMode}
      onChartModeChange={onChartModeChange}
      rps={period === "day" ? rps.data : undefined}
      rpsMessage={
        period !== "day"
          ? undefined
          : rps.error
            ? `RPS读取失败：${rps.error.message}`
            : rps.isLoading
              ? "RPS读取中…"
              : undefined
      }
      onRpsRetry={() => void rps.refetch()}
      bars={aggregate.data.bars}
      barsConfirmed={!aggregate.isPlaceholderData}
      historyLimit={limit}
      cost={
        adjustment === "none" ? chartCost(position.data ?? undefined) : null
      }
      positionMessage={
        adjustment === "none"
          ? position.error
            ? `持仓读取失败：${position.error.message}`
            : position.isLoading
              ? "正在读取持仓成本…"
              : position.data &&
                  position.data.quantity > 0 &&
                  position.data.adjustedCost == null
                ? "持仓成本不可用"
                : undefined
          : undefined
      }
      aggregateErrors={aggregate.data.sourceErrors}
    />
  );
}
function EditableChart({
  sourceId,
  onHistoryRequest,
  snapshot,
  period,
  adjustment,
  frozenEvidence = false,
  frozenCandidate = false,
  showIntelAnnotations = !isCryptoSymbol(snapshot.symbol),
  chartMode,
  onChartModeChange,
  initial,
  bars,
  barsConfirmed,
  historyLimit,
  cost,
  positionMessage,
  aggregateErrors,
  rps,
  rpsMessage,
  onRpsRetry,
}: {
  /** The stored snapshot the aggregate came from (for the second period). */
  sourceId: string;
  snapshot: import("~/lib/chart/chart-snapshot").ChartSnapshot;
  period: ChartPeriod;
  adjustment: ChartAdjustment;
  /** Frozen evidence: ignore the remembered live period next to the archive. */
  frozenEvidence?: boolean;
  /** The loaded snapshot is a saved formula candidate (选股当时快照). */
  frozenCandidate?: boolean;
  /** Mount IntelAnnotations (chart markers + 图表新闻事件 box); crypto is off. */
  showIntelAnnotations?: boolean;
  chartMode?: ChartMode;
  onChartModeChange?: (mode: ChartMode) => void;
  initial: ChartView;
  onHistoryRequest?: () => void;
  bars: Snapshot["bars"];
  barsConfirmed: boolean;
  historyLimit: number;
  cost: number | null;
  positionMessage?: string;
  aggregateErrors?: string[];
  rps?: import("~/lib/chart/chart-data").RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
}) {
  const [view, setView] = useState(initial),
    [tool, setTool] = useState<keyof typeof tools>("none"),
    [points, setPoints] = useState<Drawing["a"][]>([]),
    [label, setLabel] = useState("标注"),
    [message, setMessage] = useState("");
  const visible = useScreenVisible();
  // Backtest trade marks: only the symbol the fills belong to may paint them.
  const [sessionTradeContext, setSessionTradeContext] = useState(
    () => useMarketSession.getState().tradeContext,
  );
  useEffect(() => {
    const unsubscribe = useMarketSession.subscribe((state, previous) => {
      if (state.tradeContext !== previous.tradeContext)
        setSessionTradeContext(state.tradeContext);
    });
    setSessionTradeContext(useMarketSession.getState().tradeContext);
    return unsubscribe;
  }, []);
  const tradeContext =
    sessionTradeContext &&
    normalizeTradeSymbol(sessionTradeContext.symbol) ===
      normalizeTradeSymbol(snapshot.symbol)
      ? sessionTradeContext
      : null;
  const focusDate = tradeContext?.focusPending ? tradeContext.at : undefined;
  const firstDate = bars[0]?.date;
  useEffect(() => {
    if (
      visible &&
      barsConfirmed &&
      period === "day" &&
      focusDate &&
      firstDate &&
      focusDate < firstDate
    )
      onHistoryRequest?.();
  }, [
    visible,
    barsConfirmed,
    period,
    focusDate,
    firstDate,
    onHistoryRequest,
    historyLimit,
  ]);
  const cellIndex = Number(tradeContext?.cell);
  const hasCellIndex =
    /^\d+$/.test(tradeContext?.cell ?? "") && Number.isSafeInteger(cellIndex);
  // Archive fills are sampled server-side; ask for the page holding the cell.
  const archive = api.strategyLabDiagnoseArchiveDetail.useQuery(
    {
      id: tradeContext?.diagnose ?? "",
      page: hasCellIndex ? Math.floor(cellIndex / 50) + 1 : 1,
      pageSize: 50,
    },
    {
      enabled:
        visible &&
        Boolean(tradeContext?.diagnose) &&
        !tradeContext?.portfolioFills,
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  );
  const hasSymbol = (row: { symbols: string[] }) =>
    row.symbols.some(
      (symbol) =>
        normalizeTradeSymbol(symbol) === normalizeTradeSymbol(snapshot.symbol),
    );
  const cell = tradeContext?.cell
    ? hasCellIndex
      ? archive.data?.cells[cellIndex % 50]
      : undefined
    : tradeContext?.diagnose
      ? archive.data?.cells.find(hasSymbol)
      : undefined;
  const scenario =
    cell && hasSymbol(cell)
      ? tradeContext?.scenario
        ? cell.scenarios.find((row) => row.scenarioId === tradeContext.scenario)
        : cell.scenarios[0]
      : undefined;
  const tradeFills = useMemo(
    () => tradeContext?.portfolioFills ?? tradeFillsFromDiagnose(scenario),
    [tradeContext?.portfolioFills, scenario],
  );
  const archiveMessage =
    tradeContext?.diagnose && !tradeContext.portfolioFills
      ? archive.isError
        ? `诊断归档读取失败：${archive.error.message}`
        : !archive.data
          ? "正在读取诊断归档成交样本…"
          : !scenario
            ? "诊断归档中没有对应的证券和执行情景"
            : undefined
      : undefined;
  const tradeMarksValue = useMemo<ChartTradeMarksValue | null>(
    () =>
      tradeContext
        ? {
            symbol: snapshot.symbol,
            fills: tradeFills,
            sourceLabel: tradeContext.portfolioFills
              ? "组合回放成交（当前页）"
              : tradeContext.diagnose
                ? "诊断归档成交样本"
                : null,
            archiveMessage,
            barsConfirmed,
            visible: tradeContext.visible,
            focusAt:
              visible &&
              barsConfirmed &&
              tradeContext.focusPending &&
              tradeContext.at
                ? {
                    date: tradeContext.at,
                    consume: () =>
                      useMarketSession
                        .getState()
                        .consumeTradeFocus(tradeContext.focusToken),
                  }
                : null,
            onVisibilityChange:
              useMarketSession.getState().setTradeMarksVisible,
          }
        : null,
    [
      tradeContext,
      tradeFills,
      snapshot.symbol,
      archiveMessage,
      visible,
      barsConfirmed,
    ],
  );
  const zenMode = useWorkbenchUiStore((state) => state.zenMode);
  const toggleZen = useWorkbenchUiStore((state) => state.toggleZen);
  const [dirty, setDirty] = useState(false);
  const [second, setSecondState] = useState<ChartPeriod | null>(() =>
    frozenEvidence || lastSecond === period ? null : lastSecond,
  );
  const setSecond = (value: ChartPeriod | null) => {
    if (frozenEvidence) return;
    lastSecond = value;
    setSecondState(value);
  };
  const hub = useMemo(createCrosshairLink, []);
  const sharedQuery = api.chartSharedDrawings.useQuery(
    { symbol: snapshot.symbol, period },
    { enabled: visible, retry: false, refetchOnWindowFocus: false },
  );
  const shared = useMemo(
    () =>
      (sharedQuery.data ?? []).flatMap(({ origin, drawings }) =>
        drawings.flatMap((d) => {
          const moved = remapDrawing(d, origin, bars, period);
          return moved ? [moved] : [];
        }),
      ),
    [sharedQuery.data, bars, period],
  );
  const mainLink = useMemo(
    () => (second ? { hub, id: "main" } : undefined),
    [second, hub],
  );
  // Frozen evidence must stay on the archived snapshot's K 线; a 分时 view would
  // read the current market and break the archived contract.
  const canIntraday = !frozenEvidence && tradableSymbol(snapshot.symbol);
  // TDX 叠加 / TradingView compare: up to three A-share symbols.
  const [compareSymbols, setCompareSymbols] = useState<string[]>([]);
  // TDX board codes have no security name, so remember the label chosen here.
  const [compareLabels, setCompareLabels] = useState<Record<string, string>>(
    {},
  );
  const addCompare = useCallback(
    (symbol: string, label: string) => {
      setCompareSymbols((current) =>
        symbol === snapshot.symbol ||
        current.includes(symbol) ||
        current.length >= 3
          ? current
          : [...current, symbol],
      );
      setCompareLabels((current) =>
        current[symbol] ? current : { ...current, [symbol]: label },
      );
    },
    [snapshot.symbol],
  );
  const removeCompare = useCallback((symbol: string) => {
    setCompareSymbols((current) => current.filter((item) => item !== symbol));
    setCompareLabels((current) => {
      if (!(symbol in current)) return current;
      const next = { ...current };
      delete next[symbol];
      return next;
    });
  }, []);
  const names = api.securityNames.useQuery(undefined, {
    enabled: visible && compareSymbols.length > 0,
    staleTime: Infinity,
    retry: false,
  });
  const compareQueries = api.useQueries((t) =>
    compareSymbols.map((symbol) =>
      t.compareBars(
        {
          symbol,
          period,
          limit: Math.min(20000, Math.max(100, bars.length)),
        },
        {
          enabled: visible,
          retry: false,
          refetchOnWindowFocus: false,
          staleTime: 60000,
        },
      ),
    ),
  );
  const compareKey = compareQueries.map((q) => q.dataUpdatedAt).join();
  const compare = useMemo<ChartCompare[]>(
    () =>
      compareQueries.flatMap((q, i) =>
        q.data
          ? [
              {
                symbol: compareSymbols[i]!,
                label:
                  names.data?.[compareSymbols[i]!] ??
                  compareLabels[compareSymbols[i]!] ??
                  compareSymbols[i]!.toUpperCase(),
                bars: q.data.bars,
              },
            ]
          : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareKey, compareSymbols.join(), names.data, compareLabels],
  );
  const compareErrors = compareQueries.flatMap((q, i) =>
    q.error ? [`${compareSymbols[i]!.toUpperCase()}：${q.error.message}`] : [],
  );
  const [localIntraday, setLocalIntradayState] = useState(lastIntraday);
  const intraday =
    chartMode === undefined ? localIntraday : chartMode === "intraday";
  const showIntraday = canIntraday && intraday;
  const setIntraday = (next: boolean) => {
    lastIntraday = next;
    if (chartMode === undefined) setLocalIntradayState(next);
    else onChartModeChange?.(next ? "intraday" : "k");
  };
  // F5 switches between K 线 and 分时 (TDX).
  useEffect(() => {
    if (!canIntraday || !visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "F5" ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      if (chartMode === undefined)
        setLocalIntradayState((current) => (lastIntraday = !current));
      else {
        const next = chartMode !== "intraday";
        lastIntraday = next;
        onChartModeChange?.(next ? "intraday" : "k");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canIntraday, visible, chartMode, onChartModeChange]);
  const utils = api.useUtils();
  const save = api.saveChartView.useMutation({
    onSuccess: (saved) => {
      utils.chartView.setData({ symbol: snapshot.symbol, period }, saved);
      // Other periods of this symbol read the shared drawings afresh.
      void utils.chartSharedDrawings.invalidate();
      const current = JSON.stringify(saved) === JSON.stringify(view);
      setDirty(!current);
      // Saving is automatic; only an out-of-date save is worth a line.
      setMessage(current ? "" : "较早的图表设置已保存，当前仍有未保存更改");
    },
  });
  const change = useCallback((next: ChartView) => {
    setView(next);
    setDirty(true);
    setMessage("");
  }, []);
  // Views persist automatically, like broker terminals; the debounce keeps
  // rapid parameter typing and indicator toggling to one request.
  const { mutate: saveView } = save;
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(
      () => saveView({ symbol: snapshot.symbol, period, view }),
      800,
    );
    return () => clearTimeout(timer);
  }, [dirty, view, snapshot.symbol, period, saveView]);
  const onAnchor = useCallback(
    (point: Drawing["a"]) => {
      if (tool === "none") return;
      const placed = [...points, point];
      // Channels take three clicks, horizontal lines and text one, the rest two.
      if (placed.length < drawingPointCount(tool)) {
        setPoints(placed);
        return;
      }
      const next = {
        ...view,
        drawings: [
          ...view.drawings,
          {
            id: crypto.randomUUID(),
            kind: tool,
            a: placed[0]!,
            b: placed[1] ?? placed[0]!,
            ...(tool === "channel" ? { c: placed[2]! } : {}),
            ...(tool === "text" ? { text: label.trim() || "标注" } : {}),
            color: chartColor.accentLight,
          },
        ],
      };
      const checked = chartViewSchema.safeParse(next);
      if (!checked.success) {
        setMessage("最多保存 200 个图形，坐标必须有效");
        return;
      }
      change(checked.data);
      setPoints([]);
      setTool("none");
    },
    [points, tool, label, view, change],
  );
  const common = {
    pricePrecision: chartPricePrecision(
      snapshot.symbol,
      snapshot.bars.at(-1)?.close,
    ),
    viewportKey: `${snapshot.symbol}:${period}`,
    onHistoryRequest,
    volumeUnit:
      snapshot.volumeUnit ?? (isMarketIndex(snapshot.symbol) ? "源单位" : "股"),
    rps,
    rpsMessage,
    onRpsRetry,
    bars,
    period,
    view,
    onViewChange: change,
    drawingTool: tool,
    drawingPoints: points,
    drawingText: label,
    onAnchor,
    cost,
    adjustment,
  };
  // The frozen candidate's last bar is the selection bar; the plan price comes
  // from the archived raw bars of the same date, never from the adjusted close.
  const lastBar = frozenCandidate ? snapshot.bars.at(-1) : undefined;
  const rawBar = lastBar
    ? snapshot.rawBars?.find((bar) => bar.date === lastBar.date)
    : undefined;
  const snapshotClose = lastBar?.close;
  const executionRawPrice = rawBar?.close;
  const rpsLatest =
    frozenCandidate && rps?.length
      ? rps.reduce(
          (latest, row) => (row.date > latest ? row.date : latest),
          rps[0]!.date,
        )
      : null;
  const rpsLaterThanSnapshot = Boolean(
    lastBar && rpsLatest && rpsLatest > lastBar.date,
  );
  const renderPane = (
    events?: IntelEvent[],
    onSelect?: (id: string) => void,
  ) => {
    if (showIntraday)
      return (
        <IntradayChart
          symbol={snapshot.symbol}
          snapshotId={snapshot.id}
          pricePrecision={common.pricePrecision}
        />
      );
    const mainChart = (
      <CzscMarketChart
        {...common}
        // Crypto has no news layer here: never pass markers or a select
        // handler, so no annotation query or event markers are mounted.
        {...(events ? { newsEvents: events, onNewsEvent: onSelect } : {})}
        compare={compare}
        hotkeys={visible}
        snapshotId={snapshot.id}
        chartSnapshot
        annotations
        rpsAvailable={!isNonAShareChartSymbol(snapshot.symbol)}
        link={mainLink}
        sharedDrawings={shared}
      />
    );
    return tradeMarksValue ? (
      <ChartTradeMarksContext.Provider value={tradeMarksValue}>
        {mainChart}
      </ChartTradeMarksContext.Provider>
    ) : (
      mainChart
    );
  };
  return (
    <div
      data-testid="chart-workspace"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !(
            event.target instanceof Element &&
            event.target.closest('[role="dialog"]')
          )
        ) {
          setPoints([]);
          setTool("none");
        }
      }}
    >
      {frozenCandidate && (
        <div className="mb-2 space-y-2" data-testid="frozen-dual-price-lock">
          <StateBanner
            state="info"
            title="选股当时快照"
            asOf={`基准日 ${lastBar?.date ?? "不可用"} · ${periodLabels[period]} · ${chartAdjustmentLabels[adjustment]}`}
          >
            <span className="flex flex-wrap gap-x-5 gap-y-1">
              <span>
                选股快照末根价（{chartAdjustmentLabels[adjustment]}）：
                <strong className="tabular text-nc-text">
                  {snapshotClose === undefined
                    ? "不可用"
                    : formatNumber(snapshotClose, common.pricePrecision)}
                </strong>
              </span>
              <span>
                计划参考原价（不复权）：
                <strong
                  className={
                    executionRawPrice === undefined
                      ? "text-nc-warn"
                      : "tabular text-nc-text"
                  }
                >
                  {executionRawPrice === undefined
                    ? "不可用"
                    : formatNumber(executionRawPrice, common.pricePrecision)}
                </strong>
              </span>
            </span>
            {executionRawPrice === undefined && (
              <span className="mt-1 block text-nc-warn">
                快照未记录原价：不推算、不以复权价代替；建计划前请用原始行情核对。
              </span>
            )}
          </StateBanner>
          {rpsLaterThanSnapshot && (
            <StateBanner
              state="warn"
              title="右侧 RPS 曲线为最新日期数据，晚于本次选股快照日"
              asOf={`RPS ${rpsLatest} · 快照 ${lastBar?.date}`}
            >
              复核选股信号请以快照日为准。
            </StateBanner>
          )}
        </div>
      )}
      <div
        className="relative flex flex-wrap items-center gap-x-3 gap-y-2 py-1 text-sm"
        data-testid="chart-primary-controls"
      >
        {canIntraday && (
          <span role="group" aria-label="图表类型" className="segmented">
            <Button
              variant="plain"
              className={showIntraday ? "" : "selected"}
              aria-pressed={!showIntraday}
              title="F5 切换"
              onClick={() => setIntraday(false)}
            >
              K 线
            </Button>
            <Button
              variant="plain"
              className={showIntraday ? "selected" : ""}
              aria-pressed={showIntraday}
              title="F5 切换"
              onClick={() => setIntraday(true)}
            >
              分时
            </Button>
          </span>
        )}
        <label>
          <Checkbox
            checked={view.logarithmic}
            onCheckedChange={(checked) =>
              change({ ...view, logarithmic: checked === true })
            }
          />{" "}
          对数坐标
        </label>
        {canIntraday && !showIntraday && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                叠加对比（{compareSymbols.length}/3）
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="叠加对比">
              <span
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label="叠加对比"
              >
                {compareSymbols.length < 3 && (
                  <span className="w-44">
                    <SecuritySelect
                      symbol=""
                      period="day"
                      disabled={false}
                      captureKeys={false}
                      label="叠加对比品种"
                      placeholder="叠加对比…"
                      onSelect={(symbol) =>
                        setCompareSymbols((current) =>
                          symbol === snapshot.symbol ||
                          current.includes(symbol) ||
                          !tradableSymbol(symbol)
                            ? current
                            : [...current, symbol],
                        )
                      }
                    />
                  </span>
                )}
                {compareSymbols.map((symbol, i) => (
                  <Button
                    key={symbol}
                    variant="plain"
                    title="移除叠加"
                    style={{ color: compareColors[i % compareColors.length] }}
                    onClick={() => removeCompare(symbol)}
                  >
                    {names.data?.[symbol] ??
                      compareLabels[symbol] ??
                      symbol.toUpperCase()}{" "}
                    ×
                  </Button>
                ))}
              </span>
              <ChartCompareSectors
                key={snapshot.symbol}
                symbol={snapshot.symbol}
                compareSymbols={compareSymbols}
                onAdd={addCompare}
              />
            </PopoverContent>
          </Popover>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              画线：{tools[tool]}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="画线工具设置"
            onEscapeKeyDown={() => {
              // The workspace skips dialog keys; cancel here before Radix
              // closes this tool popover and returns focus to its trigger.
              setPoints([]);
              setTool("none");
            }}
          >
            <div
              className="flex flex-wrap gap-2 text-sm"
              role="toolbar"
              aria-label="画线工具"
            >
              {Object.entries(tools).map(([id, label]) => (
                <Button
                  variant="plain"
                  key={id}
                  aria-pressed={tool === id}
                  onClick={() => {
                    setTool(id as keyof typeof tools);
                    setPoints([]);
                  }}
                >
                  {label}
                </Button>
              ))}
              {tool === "text" && (
                <Input
                  aria-label="标注文字"
                  className="w-full"
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              )}
              <span>
                {tool !== "none"
                  ? points.length
                    ? `移动鼠标预览，再点击 ${drawingPointCount(tool) - points.length} 次完成${tool === "channel" && points.length === 2 ? "（第三点定通道宽度）" : ""}；Esc 取消`
                    : "移动鼠标自由定位，点击定锚；Esc 取消"
                  : "浏览时点中图形可选中：拖端点改形状、拖线身移动、Delete 删除 · ←→ 光标 · ↑↓ 缩放 · PageUp/PageDown 翻页（从列表进入时换股） · Home/End · F5 分时 · F8 周期"}
              </span>
            </div>
          </PopoverContent>
        </Popover>
        {snapshot.sourceNote && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                数据说明
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="数据说明">
              {snapshot.sourceNote}
            </PopoverContent>
          </Popover>
        )}
        <Button
          variant={zenMode ? "default" : "outline"}
          size="sm"
          className="ml-auto"
          aria-pressed={zenMode}
          title="Shift+F 隐藏侧栏，释放全宽看图空间"
          onClick={toggleZen}
        >
          {zenMode ? "退出专注" : "专注看盘（Shift+F）"}
        </Button>
      </div>
      {(save.error || message) && (
        <span role="status" className="block text-xs">
          {save.error
            ? `图表设置自动保存失败：${save.error.message}，下次修改时重试`
            : message}
        </span>
      )}
      {compareErrors.map((error) => (
        <p key={error} role="alert" className="!my-0 text-xs">
          叠加品种读取失败（仅支持本地通达信 A 股）：{error}
        </p>
      ))}
      {compare.length > 0 && (
        <p role="status" className="!my-0 text-xs">
          叠加对比：纵轴为自可见区首根起的涨跌幅，叠加品种为不复权本地数据，按主图日期对齐
        </p>
      )}
      {aggregateErrors?.map((error) => (
        <p key={error} role="alert" className="!my-0 text-xs">
          数据源提示：{error}
        </p>
      ))}
      {positionMessage && (
        <p role="status" className="!my-0 text-xs">
          {positionMessage}
        </p>
      )}
      {cost != null && (
        <p data-testid="position-cost" className="!my-0 text-xs">
          持仓成本 {formatNumber(cost, 2)} ·{" "}
          {(bars.at(-1)?.close ?? cost) >= cost
            ? "图中收盘价高于或等于成本（红）"
            : "图中收盘价低于成本（绿）"}{" "}
          · P1 移动加权成本 · {chartAdjustmentLabels[adjustment]}
        </p>
      )}
      {showIntelAnnotations ? (
        <IntelAnnotations
          symbol={snapshot.symbol}
          bars={bars}
          render={renderPane}
        />
      ) : (
        renderPane()
      )}
      {!showIntraday && !frozenEvidence && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            联动周期
            <Select
              value={second ?? "off"}
              onValueChange={(next) =>
                setSecond(next === "off" ? null : chartPeriodSchema.parse(next))
              }
            >
              <SelectTrigger aria-label="联动周期" className="w-auto min-w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">关闭</SelectItem>
                {chartPeriodSchema.options
                  .filter(
                    (p) =>
                      p !== period &&
                      (snapshot.requestedSource !== "local" ||
                        !snapshot.barStore?.availablePeriods ||
                        snapshot.barStore.availablePeriods.includes(p)) &&
                      (snapshot.symbol.startsWith("cx") ||
                        (p !== "4h" && p !== "1h")),
                  )
                  .map((p) => (
                    <SelectItem key={p} value={p}>
                      {periodLabels[p]}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="text-nc-text-3">十字光标在两图之间按时间对齐</span>
            <CzscSettingsDialog />
          </div>
          {second && (
            <LinkedPeriodChart
              key={second}
              sourceId={sourceId}
              period={second}
              adjustment={adjustment}
              pricePrecision={common.pricePrecision}
              hub={hub}
            />
          )}
        </div>
      )}
      <details open={view.drawings.length > 0}>
        <summary>已画图形（{view.drawings.length}）· 编辑端点 / 删除</summary>
        {shared.length > 0 && (
          <p className="text-xs text-nc-text-3">
            另有 {shared.length}{" "}
            个图形由其他周期共享而来，以虚线显示；请到原周期编辑。
          </p>
        )}
        {view.drawings.map((d) => (
          <form
            key={`${d.id}:${JSON.stringify(d)}`}
            className="flex flex-wrap items-center gap-2 py-1"
            onSubmit={(event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              const next = {
                ...d,
                a: {
                  date: String(f.get("aDate")),
                  price: Number(f.get("aPrice")),
                  offset:
                    String(f.get("aDate")) === d.a.date
                      ? d.a.offset
                      : undefined,
                },
                b: {
                  date: String(f.get("bDate")),
                  price: Number(f.get("bPrice")),
                  offset:
                    String(f.get("bDate")) === d.b.date
                      ? d.b.offset
                      : undefined,
                },
              };
              if (
                !bars.some((b) => b.date === next.a.date) ||
                !bars.some((b) => b.date === next.b.date)
              ) {
                setMessage("端点日期须为当前周期已有 K 线日期");
                return;
              }
              const candidate = chartViewSchema.safeParse({
                ...view,
                drawings: view.drawings.map((v) => (v.id === d.id ? next : v)),
              });
              if (!candidate.success) {
                setMessage("端点时间或价格无效");
                return;
              }
              change(candidate.data);
            }}
          >
            <span>{tools[d.kind]}</span>
            {(["a", "b"] as const).map((k) => (
              <span key={k}>
                <Input
                  aria-label={`${tools[d.kind]} ${k} 日期`}
                  name={`${k}Date`}
                  defaultValue={d[k].date}
                  list="chart-anchor-dates"
                />
                <Input
                  className="w-24"
                  aria-label={`${tools[d.kind]} ${k} 价格`}
                  name={`${k}Price`}
                  type="number"
                  min="0.01"
                  step="any"
                  defaultValue={d[k].price}
                />
              </span>
            ))}
            <Button variant="plain" type="submit">
              更新图形
            </Button>
            <Button
              variant="plain"
              type="button"
              onClick={() =>
                change({
                  ...view,
                  drawings: view.drawings.filter((v) => v.id !== d.id),
                })
              }
            >
              删除图形
            </Button>
            <Button
              variant="plain"
              type="button"
              aria-pressed={!!d.shared}
              onClick={() =>
                change({
                  ...view,
                  drawings: view.drawings.map((v) =>
                    v.id === d.id ? { ...v, shared: !d.shared } : v,
                  ),
                })
              }
            >
              {d.shared ? "取消共享到其他周期" : "共享到其他周期"}
            </Button>
          </form>
        ))}
        <datalist id="chart-anchor-dates">
          {bars.map((b) => (
            <option key={b.date} value={b.date} />
          ))}
        </datalist>
      </details>
    </div>
  );
}

/** The second period of the same snapshot, crosshair linked to the main chart. */
function LinkedPeriodChart({
  sourceId,
  period,
  adjustment,
  pricePrecision,
  hub,
}: {
  sourceId: string;
  period: ChartPeriod;
  adjustment: ChartAdjustment;
  pricePrecision: number;
  hub: CrosshairLink;
}) {
  const visible = useScreenVisible();
  const bars = api.chartBars.useQuery(
    { snapshotId: sourceId, period, limit: 2000, adjustment },
    { enabled: visible, retry: false, refetchOnWindowFocus: false },
  );
  const link = useMemo(() => ({ hub, id: "second" }), [hub]);
  if (bars.error)
    return (
      <p role="alert">
        {periodLabels[period]}读取失败：{bars.error.message}{" "}
        <Button variant="plain" onClick={() => void bars.refetch()}>
          重试
        </Button>
      </p>
    );
  if (!bars.data) return <p role="status">正在读取{periodLabels[period]}…</p>;
  return (
    <section aria-label={`联动图：${periodLabels[period]}`}>
      <MarketChart
        bars={bars.data.bars}
        period={period}
        adjustment={adjustment}
        pricePrecision={pricePrecision}
        annotations={false}
        rpsAvailable={false}
        height={320}
        link={link}
      />
    </section>
  );
}
