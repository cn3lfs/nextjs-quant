"use client";
import { chartColor } from "~/lib/chart/chart-theme";

import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
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
import {
  chartPricePrecision,
  isNonAShareChartSymbol,
} from "~/lib/chart/chart-symbol";
import { api } from "~/trpc/react";
import {
  chartCost,
  chartViewSchema,
  indicatorParametersSchema,
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
import {
  CzscMarketChart,
  MarketChart,
  compareColors,
  type ChartCompare,
} from "../market/chart";
import { SecuritySelect } from "./security-select";
import { drawingPointCount } from "~/lib/chart/chart-drawings";
import { IntradayChart } from "./intraday-chart";
import { tradableSymbol } from "./tdx-side-panel";
import { isTypingTarget } from "./chart-hotkeys";

// TDX keeps 分时 or K 线 across symbol switches; the workspace remounts per
// symbol/period, so the last choice lives at module scope for the session.
let lastIntraday = false;
// The linked second period (TDX 多周期同列) is kept the same way.
let lastSecond: ChartPeriod | null = null;
import { TdxSnapshotContainer } from "./tdx-snapshot-container";
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
}: {
  snapshot: Snapshot;
  period: ChartPeriod;
  adjustment: ChartAdjustment;
}) {
  const [limit, setLimit] = useState(2000);
  const requestMore = useCallback(
    () => setLimit((value) => Math.min(20000, value + 2000)),
    [],
  );
  const view = api.chartView.useQuery(
    { symbol: snapshot.symbol, period },
    { retry: false, refetchOnWindowFocus: false },
  );
  const aggregate = api.chartBars.useQuery(
    { snapshotId: snapshot.id, period, limit, adjustment },
    {
      retry: false,
      refetchOnWindowFocus: false,
      placeholderData: (previous) => previous,
    },
  );
  const rps = api.rpsCurve.useQuery(snapshot.symbol, {
    enabled: period === "day" && !isNonAShareChartSymbol(snapshot.symbol),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const position = api.chartPosition.useQuery(snapshot.symbol, {
    enabled: adjustment === "none" && !isNonAShareChartSymbol(snapshot.symbol),
    retry: false,
    refetchOnWindowFocus: true,
  });
  if (view.error)
    return (
      <div role="alert">
        视图读取失败：{view.error.message}{" "}
        <Button variant="plain" onClick={() => void view.refetch()}>
          重试读取
        </Button>
      </div>
    );
  if (!view.data) return <p>正在读取图表视图…</p>;
  if (aggregate.error)
    return (
      <div role="alert">
        聚合失败：{aggregate.error.message}{" "}
        <Button variant="plain" onClick={() => void aggregate.refetch()}>
          重试聚合
        </Button>
      </div>
    );
  if (!aggregate.data) return <p>正在读取目标周期行情…</p>;
  return (
    <EditableChart
      key={`${snapshot.symbol}:${period}:${adjustment}`}
      sourceId={snapshot.id}
      snapshot={aggregate.data}
      onHistoryRequest={
        !aggregate.isFetching &&
        !aggregate.data.historyExhausted &&
        limit < 20000
          ? requestMore
          : undefined
      }
      period={period}
      adjustment={adjustment}
      initial={view.data}
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
  initial,
  bars,
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
  initial: ChartView;
  onHistoryRequest?: () => void;
  bars: Snapshot["bars"];
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
  const [dirty, setDirty] = useState(false);
  const [second, setSecondState] = useState<ChartPeriod | null>(() =>
    lastSecond === period ? null : lastSecond,
  );
  const setSecond = (value: ChartPeriod | null) => {
    lastSecond = value;
    setSecondState(value);
  };
  const hub = useMemo(createCrosshairLink, []);
  const sharedQuery = api.chartSharedDrawings.useQuery(
    { symbol: snapshot.symbol, period },
    { retry: false, refetchOnWindowFocus: false },
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
  const canIntraday = tradableSymbol(snapshot.symbol);
  // TDX 叠加 / TradingView compare: up to three A-share symbols.
  const [compareSymbols, setCompareSymbols] = useState<string[]>([]);
  const names = api.securityNames.useQuery(undefined, {
    enabled: compareSymbols.length > 0,
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
        { retry: false, refetchOnWindowFocus: false, staleTime: 60000 },
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
                  compareSymbols[i]!.toUpperCase(),
                bars: q.data.bars,
              },
            ]
          : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareKey, compareSymbols.join(), names.data],
  );
  const compareErrors = compareQueries.flatMap((q, i) =>
    q.error ? [`${compareSymbols[i]!.toUpperCase()}：${q.error.message}`] : [],
  );
  const [intraday, setIntradayState] = useState(lastIntraday);
  const showIntraday = canIntraday && intraday;
  const setIntraday = (next: boolean) => {
    lastIntraday = next;
    setIntradayState(next);
  };
  // F5 switches between K 线 and 分时 (TDX).
  useEffect(() => {
    if (!canIntraday) return;
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
      setIntradayState((current) => (lastIntraday = !current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canIntraday]);
  const utils = api.useUtils();
  const save = api.saveChartView.useMutation({
    onSuccess: (saved) => {
      utils.chartView.setData({ symbol: snapshot.symbol, period }, saved);
      // Other periods of this symbol read the shared drawings afresh.
      void utils.chartSharedDrawings.invalidate();
      const current = JSON.stringify(saved) === JSON.stringify(view);
      setDirty(!current);
      setMessage(
        current ? "视图已保存" : "较早的视图已保存，当前仍有未保存更改",
      );
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
            color: view.dark ? chartColor.accentLight : chartColor.accentLight,
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
  return (
    <div
      data-testid="chart-workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setPoints([]);
          setTool("none");
        }
      }}
    >
      <div
        className="relative flex items-center gap-3 py-1 whitespace-nowrap"
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
        <label>
          <Checkbox
            checked={view.dark}
            onCheckedChange={(checked) =>
              change({ ...view, dark: checked === true })
            }
          />{" "}
          加深背景
        </label>
        {canIntraday && !showIntraday && (
          <span
            className="flex items-center gap-2"
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
                onClick={() =>
                  setCompareSymbols((current) =>
                    current.filter((item) => item !== symbol),
                  )
                }
              >
                {names.data?.[symbol] ?? symbol.toUpperCase()} ×
              </Button>
            ))}
          </span>
        )}
        <details className="relative !my-0" name="chart-tools">
          <summary className="cursor-pointer">画线：{tools[tool]}</summary>
          <div
            className="absolute right-0 top-full z-20 flex w-80 flex-wrap gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md whitespace-normal"
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
        </details>
      </div>
      <span role="status" className="block min-h-4 text-xs">
        {save.error
          ? `视图自动保存失败：${save.error.message}，下次修改时重试`
          : message || (dirty ? "正在自动保存视图…" : "")}
      </span>
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
      {snapshot.sourceNote && (
        <p role="status" className="!my-0 text-xs text-nc-text-3">
          数据说明：{snapshot.sourceNote}
        </p>
      )}
      {aggregateErrors?.map((error) => (
        <p key={error} role="alert" className="!my-0 text-xs">
          数据源错误：{error}
        </p>
      ))}
      {positionMessage && (
        <p role="status" className="!my-0 text-xs">
          {positionMessage}
        </p>
      )}
      {cost != null && (
        <p data-testid="position-cost" className="!my-0 text-xs">
          持仓成本 {cost.toFixed(2)} ·{" "}
          {(bars.at(-1)?.close ?? cost) >= cost
            ? "图中收盘价高于或等于成本（红）"
            : "图中收盘价低于成本（绿）"}{" "}
          · P1 移动加权成本 · {chartAdjustmentLabels[adjustment]}
        </p>
      )}
      {showIntraday ? (
        <IntradayChart
          symbol={snapshot.symbol}
          snapshotId={snapshot.id}
          pricePrecision={common.pricePrecision}
          dark={view.dark}
        />
      ) : (
        <CzscMarketChart
          {...common}
          compare={compare}
          hotkeys
          snapshotId={snapshot.id}
          chartSnapshot
          annotations
          rpsAvailable={!isNonAShareChartSymbol(snapshot.symbol)}
          link={mainLink}
          sharedDrawings={shared}
        />
      )}
      {!showIntraday && (
        <div className="space-y-2">
          <div className="flex w-fit items-center gap-2 text-xs whitespace-nowrap">
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
                  .filter((p) => p !== period)
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
      <TdxSnapshotContainer symbol={snapshot.symbol} />
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
  const bars = api.chartBars.useQuery(
    { snapshotId: sourceId, period, limit: 2000, adjustment },
    { retry: false, refetchOnWindowFocus: false },
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
