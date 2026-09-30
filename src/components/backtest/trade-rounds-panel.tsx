"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  createSeriesMarkers,
  type Time,
} from "lightweight-charts";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import { periodReturns, type TradeRound } from "~/lib/backtest/trade-rounds";
import type { Bar } from "~/lib/domain";
import { api } from "~/trpc/react";
import { GridTable, Segmented } from "../panels";
import { Button } from "../ui/button";
import { usePanelVisible } from "../workbench/keep-alive";
import { isTypingTarget } from "../market/chart-hotkeys";

const PAGE = 20;
/** Fill prices include slippage; three decimals are enough to read. */
const price = (v: number | null) =>
  v === null ? "—" : String(Number(v.toFixed(3)));
const pct = (v: number | null, digits = 2) =>
  v === null ? "—" : `${(v * 100).toFixed(digits)}%`;
const tone = (v: number | null) =>
  v === null || v === 0 ? undefined : v > 0 ? "text-nc-up" : "text-nc-down";

/** Candles around one round with its buy/sell marks (context, not a new source). */
function RoundChart({ bars, round }: { bars: Bar[]; round: TradeRound }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const at = (date: string | null) =>
      date
        ? bars.findIndex((b) => b.date.slice(0, 10) === date.slice(0, 10))
        : -1;
    const from = at(round.entryDate),
      to = round.exitDate ? at(round.exitDate) : bars.length - 1;
    if (from < 0) return;
    const window = bars.slice(
      Math.max(0, from - 20),
      Math.min(bars.length, to + 21),
    );
    const chart = createNocturneChart(ref.current, {
      autoSize: true,
      localization: chineseChartLocalization,
      timeScale: { tickMarkFormatter: chineseTickMark },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: chartColor.up,
      downColor: chartColor.down,
      borderVisible: false,
      wickUpColor: chartColor.up,
      wickDownColor: chartColor.down,
    });
    candles.setData(
      window.map((b) => ({ ...b, time: b.date.slice(0, 10) as Time })),
    );
    createSeriesMarkers(candles, [
      {
        time: round.entryDate.slice(0, 10) as Time,
        position: "belowBar",
        shape: "arrowUp",
        color: chartColor.up,
        text: `买 ${price(round.entryPrice)}`,
      },
      ...(round.exitDate
        ? [
            {
              time: round.exitDate.slice(0, 10) as Time,
              position: "aboveBar" as const,
              shape: "arrowDown" as const,
              color: chartColor.down,
              text: `卖 ${price(round.exitPrice)}`,
            },
          ]
        : []),
    ]);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, round]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`回合 K 线：${round.entryDate} 买入${round.exitDate ? `，${round.exitDate} 卖出` : "，未平仓"}`}
      // autoSize follows the container: keep its height fixed.
      style={{ height: 300 }}
    />
  );
}

/**
 * Round trips of the backtest (paged), the selected round on a candle chart
 * (PageUp/PageDown step rounds), and month/quarter/year returns against
 * buy-and-hold. Mirrors TradingView's List of Trades and period comparison.
 */
export function TradeRoundsPanel({
  rounds,
  equity,
  benchmark,
  snapshotId,
}: {
  rounds: TradeRound[];
  equity: { date: string; value: number }[];
  benchmark?: { date: string; value: number }[];
  snapshotId?: string;
}) {
  const visible = usePanelVisible();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [unit, setUnit] = useState<"month" | "quarter" | "year">("year");
  const pages = Math.max(1, Math.ceil(rounds.length / PAGE));
  const closed = rounds.filter((r) => r.netReturn !== null);
  const wins = closed.filter((r) => r.netReturn! > 0).length;
  const bars = api.chartBars.useQuery(
    { snapshotId: snapshotId ?? "", period: "day", limit: 20000 },
    { enabled: !!snapshotId && selected !== null, staleTime: Infinity },
  );
  const periods = useMemo(
    () => periodReturns(equity, benchmark, unit).reverse(),
    [equity, benchmark, unit],
  );
  const select = (index: number) => {
    const next = Math.max(0, Math.min(rounds.length - 1, index));
    setSelected(next);
    setPage(Math.floor(next / PAGE));
  };
  const latest = useRef({ selected, select });
  latest.current = { selected, select };
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      const { selected, select } = latest.current;
      if (
        selected === null ||
        (event.key !== "PageUp" && event.key !== "PageDown") ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      select(selected + (event.key === "PageDown" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);
  const round = selected === null ? null : rounds[selected];
  return (
    <div className="space-y-3" aria-label="交易回合">
      <p className="text-sm">
        共 {rounds.length} 个回合（已平仓 {closed.length}，盈利 {wins}，胜率{" "}
        {closed.length ? pct(wins / closed.length, 1) : "—"}）。MFE/MAE
        为持有期间最高价、最低价相对买入价，使用回测所用的同一份日线。
      </p>
      <GridTable
        label="交易回合"
        rows={rounds.slice(page * PAGE, (page + 1) * PAGE)}
        rowKey={(r) => r.entryDate}
        onRowClick={(r) => select(rounds.indexOf(r))}
        rowClassName={(r) => (round === r ? "bg-nc-inset" : undefined)}
        minWidth={760}
        columns={[
          {
            key: "no",
            header: "#",
            width: "48px",
            cell: (r) => rounds.indexOf(r) + 1,
          },
          {
            key: "in",
            header: "买入",
            cell: (r) => `${r.entryDate} @ ${price(r.entryPrice)}`,
          },
          {
            key: "out",
            header: "卖出",
            cell: (r) =>
              r.exitDate ? `${r.exitDate} @ ${price(r.exitPrice)}` : "未平仓",
          },
          {
            key: "bars",
            header: "持有（根）",
            align: "right",
            width: "80px",
            cell: (r) => r.bars,
          },
          {
            key: "ret",
            header: "净收益",
            align: "right",
            cell: (r) => (
              <span className={tone(r.netReturn)}>{pct(r.netReturn)}</span>
            ),
          },
          {
            key: "mfe",
            header: "MFE",
            align: "right",
            cell: (r) => <span className={tone(r.mfe)}>{pct(r.mfe)}</span>,
          },
          {
            key: "mae",
            header: "MAE",
            align: "right",
            cell: (r) => <span className={tone(r.mae)}>{pct(r.mae)}</span>,
          },
        ]}
      />
      {pages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          第 {page + 1} / {pages} 页
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      {round && (
        <div className="space-y-2" aria-label="回合 K 线">
          <p role="status" className="text-xs text-nc-text-3">
            第 {selected! + 1}/{rounds.length} 回合 · PageUp/PageDown 切换
          </p>
          {bars.data ? (
            <RoundChart bars={bars.data.bars} round={round} />
          ) : bars.error ? (
            <p role="alert">{bars.error.message}</p>
          ) : (
            <p role="status">正在读取日线…</p>
          )}
        </div>
      )}
      <div className="space-y-2" aria-label="分期收益对比">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-medium">分期收益：策略与买入持有</h4>
          <Segmented
            label="分期"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "month", label: "月" },
              { value: "quarter", label: "季" },
              { value: "year", label: "年" },
            ]}
          />
        </div>
        <GridTable
          label="分期收益"
          rows={periods.slice(0, 24)}
          rowKey={(p) => p.period}
          columns={[
            { key: "p", header: "期间", width: "90px", cell: (p) => p.period },
            {
              key: "s",
              header: "策略",
              cell: (p) => <PeriodBar value={p.strategy} />,
            },
            {
              key: "b",
              header: "买入持有",
              cell: (p) => <PeriodBar value={p.benchmark} />,
            },
            {
              key: "d",
              header: "差（百分点）",
              align: "right",
              width: "110px",
              cell: (p) =>
                p.strategy === null || p.benchmark === null
                  ? "—"
                  : ((p.strategy - p.benchmark) * 100).toFixed(2),
            },
          ]}
        />
        {periods.length > 24 && (
          <p className="text-xs text-nc-text-3">
            显示最近 24 期，共 {periods.length} 期。
          </p>
        )}
      </div>
    </div>
  );
}

/** Signed bar scaled to ±50% (clipped), with the value as text. */
function PeriodBar({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>;
  const width = Math.min(50, Math.abs(value) * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-24 bg-nc-inset">
        <span
          className={
            value >= 0
              ? "absolute left-1/2 h-2 bg-nc-up"
              : "absolute right-1/2 h-2 bg-nc-down"
          }
          style={{ width: `${width}%` }}
        />
      </span>
      <span className={tone(value)}>{pct(value)}</span>
    </span>
  );
}
