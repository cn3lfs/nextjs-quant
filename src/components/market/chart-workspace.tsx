"use client";
import { chartColor } from "~/lib/chart/chart-theme";

import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";

import { useCallback, useState } from "react";
import type { Snapshot } from "~/lib/domain";
import { isMarketIndex } from "~/lib/market/market-indices";
import { chartPricePrecision, isSectorChartSymbol } from "~/lib/chart/chart-symbol";
import { api } from "~/trpc/react";
import {
  chartCost,
  chartViewSchema,
  indicatorParametersSchema,
  type ChartPeriod,
  type ChartView,
  type Drawing,
} from "~/lib/chart/chart-view";
import { CzscMarketChart } from "../market/chart";
import { TdxSnapshotContainer } from "./tdx-snapshot-container";
const tools = {
  none: "浏览",
  trend: "趋势线",
  horizontal: "水平线",
  rectangle: "矩形",
  fibonacci: "斐波那契",
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
    enabled: period === "day" && !isSectorChartSymbol(snapshot.symbol),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const position = api.chartPosition.useQuery(snapshot.symbol, {
    enabled: adjustment === "none" && !isSectorChartSymbol(snapshot.symbol),
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
    [anchor, setAnchor] = useState<Drawing["a"] | null>(null),
    [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const utils = api.useUtils();
  const save = api.saveChartView.useMutation({
    onSuccess: (saved) => {
      utils.chartView.setData({ symbol: snapshot.symbol, period }, saved);
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
  const onAnchor = useCallback(
    (point: Drawing["a"]) => {
      if (tool === "none") return;
      if (tool !== "horizontal" && !anchor) {
        setAnchor(point);
        return;
      }
      const next = {
        ...view,
        drawings: [
          ...view.drawings,
          {
            id: crypto.randomUUID(),
            kind: tool,
            a: anchor ?? point,
            b: point,
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
      setAnchor(null);
      setTool("none");
    },
    [anchor, tool, view, change],
  );
  const common = {
    pricePrecision: chartPricePrecision(snapshot.symbol),
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
    drawingStart: anchor,
    onAnchor,
    cost,
    adjustment,
  };
  return (
    <div
      data-testid="chart-workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setAnchor(null);
          setTool("none");
        }
      }}
    >
      <div
        className="relative flex items-center gap-3 py-1 whitespace-nowrap"
        data-testid="chart-primary-controls"
      >
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
        <Button
          variant="plain"
          disabled={save.isPending}
          onClick={() => save.mutate({ symbol: snapshot.symbol, period, view })}
        >
          保存视图
        </Button>
        <details className="relative !my-0" name="chart-tools">
          <summary className="cursor-pointer">指标参数</summary>
          <div className="absolute left-0 top-full z-20 max-h-96 w-[min(36rem,70vw)] overflow-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-md whitespace-normal">
            <p>参数仅影响图表；缠论与双突破标注仍按原策略参数计算。</p>
            <form
              key={JSON.stringify(view.parameters)}
              className="flex flex-wrap gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const candidate = Object.fromEntries(
                  Object.entries(view.parameters).map(([name, values]) => [
                    name,
                    values.map((_, i) => Number(data.get(`${name}-${i}`))),
                  ]),
                );
                const parsed = indicatorParametersSchema.safeParse(candidate);
                if (!parsed.success) {
                  setMessage("周期须为 1–500 整数，BOLL 周期至少 2、倍数 0–20");
                  return;
                }
                change({ ...view, parameters: parsed.data });
              }}
            >
              {Object.entries(view.parameters).map(([name, values]) => (
                <fieldset key={name}>
                  <legend>{name.toUpperCase()}</legend>
                  {values.map((value, i) => (
                    <label key={i} className="inline-flex flex-col">
                      {name.toUpperCase()} {i + 1}
                      <Input
                        aria-label={`${name.toUpperCase()} 参数 ${i + 1}`}
                        name={`${name}-${i}`}
                        type="number"
                        className="w-20"
                        min={name === "boll" ? (i === 0 ? 2 : 0) : 1}
                        max={name === "boll" && i === 1 ? 20 : 500}
                        step={name === "boll" && i === 1 ? 0.1 : 1}
                        defaultValue={value}
                      />
                    </label>
                  ))}
                </fieldset>
              ))}
              <Button variant="plain" type="submit">
                应用参数
              </Button>
            </form>
          </div>
        </details>
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
                  setAnchor(null);
                }}
              >
                {label}
              </Button>
            ))}
            <span>
              {tool !== "none"
                ? anchor
                  ? "移动鼠标预览，点击第二点完成；Esc 取消"
                  : "移动鼠标自由定位，点击定锚；Esc 取消"
                : "左右键平移 · 上下键缩放 · 拖拽价格轴缩放"}
            </span>
          </div>
        </details>
      </div>
      <span role="status" className="text-xs">
        {save.error
          ? `保存失败：${save.error.message}，可重新保存`
          : message || (dirty ? "有未保存更改，请切换前保存" : "")}
      </span>
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
      <fieldset
        disabled={save.isPending}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        <CzscMarketChart {...common} snapshotId={snapshot.id} chartSnapshot />
      </fieldset>
      <TdxSnapshotContainer symbol={snapshot.symbol} />
      <details open={view.drawings.length > 0}>
        <summary>已画图形（{view.drawings.length}）· 编辑端点 / 删除</summary>
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
