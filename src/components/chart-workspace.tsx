"use client";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";

import { useCallback, useState } from "react";
import type { Snapshot } from "~/lib/domain";
import { api } from "~/trpc/react";
import {
  structureAvailability,
  chartCost,
  chartViewSchema,
  indicatorParametersSchema,
  type ChartPeriod,
  type ChartView,
  type Drawing,
} from "~/lib/chart-view";
import { CzscMarketChart, MarketChart } from "./chart";
const exclusionLabels = {
  unfinished: "周期未完成",
  "calendar-unknown": "交易日历未知",
  "missing-days": "缺少交易日行情",
  "calendar-conflict": "行情与日历冲突",
};
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
}: {
  snapshot: Snapshot;
  period: ChartPeriod;
}) {
  const view = api.chartView.useQuery(
    { symbol: snapshot.symbol, period },
    { retry: false, refetchOnWindowFocus: false },
  );
  const aggregate = api.chartBars.useQuery(
    { snapshotId: snapshot.id, period: period === "month" ? "month" : "week" },
    {
      enabled: period === "week" || period === "month",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const position = api.chartPosition.useQuery(snapshot.symbol, {
    retry: false,
    refetchOnWindowFocus: true,
  });
  if (view.error)
    return (
      <div role="alert">
        视图读取失败：{view.error.message}{" "}
        <button onClick={() => void view.refetch()}>重试读取</button>
      </div>
    );
  if (!view.data) return <p>正在读取图表视图…</p>;
  const derived = period === "week" || period === "month";
  if (derived && aggregate.error)
    return (
      <div role="alert">
        聚合失败：{aggregate.error.message}{" "}
        <button onClick={() => void aggregate.refetch()}>重试聚合</button>
      </div>
    );
  if (derived && !aggregate.data) return <p>正在聚合已完成周期…</p>;
  return (
    <EditableChart
      key={`${snapshot.symbol}:${period}`}
      snapshot={snapshot}
      period={period}
      initial={view.data}
      bars={derived ? aggregate.data!.bars : snapshot.bars}
      cost={chartCost(position.data ?? undefined)}
      positionMessage={
        position.error
          ? `持仓读取失败：${position.error.message}`
          : position.isPending
            ? "正在读取持仓成本…"
            : position.data &&
                position.data.quantity > 0 &&
                position.data.adjustedCost == null
              ? "持仓成本不可用"
              : undefined
      }
      aggregateMessage={
        derived
          ? `仅已完成周期 · 排除 ${aggregate.data!.excluded.length} 个周期（${[...new Set(aggregate.data!.excluded.map((e) => exclusionLabels[e.reason]))].join("、") || "无"}）`
          : undefined
      }
    />
  );
}
function EditableChart({
  snapshot,
  period,
  initial,
  bars,
  cost,
  positionMessage,
  aggregateMessage,
}: {
  snapshot: Snapshot;
  period: ChartPeriod;
  initial: ChartView;
  bars: Snapshot["bars"];
  cost: number | null;
  positionMessage?: string;
  aggregateMessage?: string;
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
            color: view.dark ? "#60a5fa" : "#2563eb",
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
    bars,
    period,
    view,
    onViewChange: change,
    drawingTool: tool,
    onAnchor,
    cost,
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
      <div className="flex flex-wrap items-center gap-3 py-2">
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
          暗色主题
        </label>
        <button
          disabled={save.isPending}
          onClick={() => save.mutate({ symbol: snapshot.symbol, period, view })}
        >
          保存视图
        </button>
        <span role="status">
          {save.error
            ? `保存失败：${save.error.message}，可重新保存`
            : message || (dirty ? "有未保存更改，请切换前保存" : "")}
        </span>
      </div>
      <details>
        <summary>指标参数</summary>
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
          <button type="submit">应用参数</button>
        </form>
      </details>
      <div
        className="flex flex-wrap gap-2 py-2"
        role="toolbar"
        aria-label="画线工具"
      >
        {Object.entries(tools).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tool === id}
            onClick={() => {
              setTool(id as keyof typeof tools);
              setAnchor(null);
            }}
          >
            {label}
          </button>
        ))}
        <span>
          {tool !== "none"
            ? anchor
              ? "点击第二个端点；Esc 取消"
              : "点击主图 K 线位置定锚；Esc 取消"
            : "左右键平移 · 上下键缩放 · 拖拽价格轴缩放"}
        </span>
      </div>
      {aggregateMessage && <p role="status">{aggregateMessage}</p>}
      {positionMessage && <p role="status">{positionMessage}</p>}
      {cost != null && (
        <p data-testid="position-cost">
          持仓成本 {cost.toFixed(2)} ·{" "}
          {(bars.at(-1)?.close ?? cost) >= cost
            ? "图中收盘价高于或等于成本（红）"
            : "图中收盘价低于成本（绿）"}{" "}
          · P1 移动加权成本 · 不复权
        </p>
      )}
      <fieldset
        disabled={save.isPending}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        {!structureAvailability(period).czsc ? (
          <MarketChart
            {...common}
            czscMessage="缠论结构在周/月线不可用"
            breakoutMessage="双突破仅支持日线，周/月线不可用"
          />
        ) : (
          <CzscMarketChart {...common} snapshotId={snapshot.id} />
        )}
      </fieldset>
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
                },
                b: {
                  date: String(f.get("bDate")),
                  price: Number(f.get("bPrice")),
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
                  step="0.01"
                  defaultValue={d[k].price}
                />
              </span>
            ))}
            <button type="submit">更新图形</button>
            <button
              type="button"
              onClick={() =>
                change({
                  ...view,
                  drawings: view.drawings.filter((v) => v.id !== d.id),
                })
              }
            >
              删除图形
            </button>
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
