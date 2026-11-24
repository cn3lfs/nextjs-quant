"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { skipToken } from "@tanstack/react-query";
import { Pause, Play, SkipForward } from "@phosphor-icons/react/ssr";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import {
  czscSourceCommit,
  type CzscFamily,
  type CzscResult,
} from "trading-strategies/research/chan/czsc";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import {
  barReplaySymbolSchema,
  type BarReplayAdjustment,
  type BarReplayOrder,
} from "~/lib/chart/bar-replay";
import { chartAdjustmentLabels } from "~/lib/chart/chart-adjustment";
import { chartPricePrecision } from "~/lib/chart/chart-symbol";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/ui/dialog";
import { MarketChart } from "./market-chart";

type Frame = RouterOutputs["barReplayFrame"];
type Evaluation = RouterOutputs["barReplayReveal"];
type Session = NonNullable<RouterInputs["barReplayFrame"]["session"]>;
type Training = {
  frame: Frame;
  session: Session;
  endDate: string | null;
  includeCzsc: boolean;
};

const initialCash = 100_000;
const rejectionLabels = {
  "lot-size": "数量须为整手",
  "no-quote": "执行日无可成交行情",
  cash: "现金不足",
  holdings: "持仓不足",
  "t-plus-one": "T+1 限制",
} as const;
const selectClass = "h-9 rounded-md border border-nc-border bg-nc-card px-2";
const sideLabel = (side: BarReplayOrder["side"]) =>
  side === "buy" ? "买入" : "卖出";
const ratioPercent = (value: number | null, digits = 2) =>
  formatPercent(value === null ? null : value * 100, digits);

function nextDate(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function czscStructure(frame: Frame | undefined): CzscResult | undefined {
  if (!frame?.czsc) return;
  const { bars, czsc } = frame;
  const families: CzscFamily[] = ([0, 1100] as const).flatMap((config) => {
    const level = czsc.families[config];
    if (!level || level.pivots.length < 2) return [];
    return [
      {
        config,
        points: level.pivots.flatMap((pivot) => {
          const bar = bars[pivot.index];
          return bar
            ? [
                {
                  index: pivot.index,
                  date: bar.date,
                  direction: pivot.kind,
                  price: pivot.price,
                  confirmedAt: pivot.confirmedAt,
                },
              ]
            : [];
        }),
        centers: level.centers.flatMap((center) => {
          const start = bars[center.start],
            end = bars[center.end];
          return start && end
            ? [
                {
                  start: center.start,
                  end: center.end,
                  startDate: start.date,
                  endDate: end.date,
                  direction: center.direction,
                  ZG: center.zg,
                  ZD: center.zd,
                  GG: center.gg,
                  DD: center.dd,
                },
              ]
            : [];
        }),
        signals: [],
        movements: [],
        qualities: [],
        divergences: [],
      },
    ];
  });
  return {
    status: families.some((level) => level.points.length > 1)
      ? "structure"
      : "no-structure",
    hash: czsc.hash,
    configId: czsc.configId,
    sourceCommit: czscSourceCommit,
    families,
  };
}

function floatingPnl(simulation: Frame["simulation"]) {
  if (simulation?.blockedReason) return null;
  if (!simulation?.quantity) return 0;
  let shares = 0;
  let cost = 0;
  for (const fill of simulation.fills) {
    if (fill.side === "buy") {
      shares += fill.quantity;
      cost += fill.price * fill.quantity + fill.fee;
    } else {
      cost *= (shares - fill.quantity) / shares;
      shares -= fill.quantity;
    }
  }
  const equity = simulation.equity.at(-1)?.value;
  return equity === undefined ? null : equity - simulation.cash - cost;
}

export function BarReplayPanel({
  symbol,
  onClose,
}: {
  symbol: string;
  onClose: () => void;
}) {
  const [draftSymbol, setSymbol] = useState(symbol);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [adjustment, setAdjustment] = useState<BarReplayAdjustment>("none");
  const [includeCzsc, setIncludeCzsc] = useState(false);
  const [strategyKey, setStrategyKey] =
    useState<NonNullable<RouterInputs["barReplayReveal"]["strategyKey"]>>(
      "ma-cross",
    );
  const [training, setTraining] = useState<Training | null>(null);
  const [quantity, setQuantity] = useState("100");
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const operation = useRef<AbortController | null>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const { client } = api.useUtils();
  const parsedSymbol = barReplaySymbolSchema.safeParse(draftSymbol);
  const candidates = api.barReplayCandidates.useQuery(
    !training && parsedSymbol.success
      ? { symbol: parsedSymbol.data }
      : skipToken,
    { retry: false, refetchOnWindowFocus: false },
  );
  const firstDate = candidates.data?.firstDate;
  const sessionReady =
    parsedSymbol.success &&
    candidates.data?.available &&
    !!firstDate &&
    startDate >= firstDate &&
    (!endDate || startDate <= endDate);
  const frame = training?.frame;
  const visibleDate = frame?.bars.at(-1)?.date;
  const czsc = useMemo(() => czscStructure(frame), [frame]);
  const simulation = frame?.simulation;
  const shares = Number(quantity);
  const holdings = simulation?.quantity ?? 0;
  const pendingShares =
    simulation?.pending.reduce(
      (total, { order }) =>
        total + (order.side === "sell" ? order.quantity : 0),
      0,
    ) ?? 0;
  const validLot =
    Number.isInteger(shares) &&
    shares >= 100 &&
    shares <= 1e9 &&
    shares % 100 === 0;
  const canAdvance =
    !!training &&
    training.frame.hasMore &&
    (!training.endDate || training.frame.cutoffDate < training.endDate) &&
    !evaluation;
  const canOrder =
    canAdvance &&
    validLot &&
    !busy &&
    !simulation?.blockedReason &&
    (training?.session.orders?.length ?? 0) < 2000;

  useEffect(() => () => operation.current?.abort(), []);
  const trainingStarted = training !== null;
  useEffect(() => {
    if (trainingStarted) controls.current?.focus();
  }, [trainingStarted]);
  const run = useCallback(
    async (task: (signal: AbortSignal) => Promise<void>) => {
      if (operation.current) return;
      const controller = new AbortController();
      operation.current = controller;
      setBusy(true);
      setError(null);
      try {
        await task(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setPlaying(false);
          setError(cause instanceof Error ? cause.message : "训练请求失败");
        }
      } finally {
        operation.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [],
  );

  const requestFrame = useCallback(
    (input: RouterInputs["barReplayFrame"], signal: AbortSignal) =>
      client.barReplayFrame.query(input, { signal }),
    [client],
  );
  const start = () => {
    if (!sessionReady) return;
    void run(async (signal) => {
      const frame = await requestFrame(
        {
          symbol: parsedSymbol.data,
          cutoffDate: startDate,
          adjustment,
          includeCzsc,
        },
        signal,
      );
      const start = frame.bars.at(-1)?.date;
      if (!start) throw new Error("截断日之前没有完整日线");
      if (!signal.aborted)
        setTraining({
          frame,
          endDate: endDate || null,
          includeCzsc,
          session: {
            startDate: start,
            initialCash,
            executionRule: "next-open",
            orders: [],
          },
        });
    });
  };

  const advance = useCallback(() => {
    if (!training || !canAdvance) return;
    void run(async (signal) => {
      const { frame, session, endDate, includeCzsc } = training;
      const current = frame.bars.at(-1)?.date;
      const input = {
        symbol: frame.symbol,
        adjustment: frame.adjustment,
        session,
      };
      let next: Frame;
      if (!endDate) {
        next = await requestFrame(
          { ...input, cutoffDate: frame.cutoffDate, step: true, includeCzsc },
          signal,
        );
      } else {
        // Probe calendar cutoffs within the chosen training end, even on holidays.
        next = frame;
        while (!signal.aborted && next.hasMore && next.cutoffDate < endDate) {
          const cutoffDate = nextDate(next.cutoffDate);
          next = await requestFrame({ ...input, cutoffDate }, signal);
          if (next.bars.at(-1)?.date !== current) break;
        }
        if (!signal.aborted && includeCzsc)
          next = await requestFrame(
            { ...input, cutoffDate: next.cutoffDate, includeCzsc: true },
            signal,
          );
      }
      if (signal.aborted) return;
      setTraining({ ...training, frame: next });
      if (!next.hasMore || (endDate && next.cutoffDate >= endDate))
        setPlaying(false);
    });
  }, [training, canAdvance, run, requestFrame]);

  useEffect(() => {
    if (!playing || busy || !canAdvance) return;
    const timer = window.setTimeout(advance, 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, busy, canAdvance, speed, advance]);

  const setStructure = (enabled: boolean) => {
    if (!training) return setIncludeCzsc(enabled);
    const { frame, session } = training;
    setPlaying(false);
    if (!enabled) {
      setTraining({
        ...training,
        includeCzsc: false,
        frame: { ...frame, czsc: null },
      });
      return;
    }
    void run(async (signal) => {
      const next = await requestFrame(
        {
          symbol: frame.symbol,
          cutoffDate: frame.cutoffDate,
          adjustment: frame.adjustment,
          session,
          includeCzsc: true,
        },
        signal,
      );
      if (!signal.aborted)
        setTraining({ ...training, frame: next, includeCzsc: true });
    });
  };
  const placeOrder = (side: BarReplayOrder["side"]) => {
    if (
      !training ||
      !visibleDate ||
      !canOrder ||
      (side === "sell" && shares > holdings - pendingShares)
    )
      return;
    setPlaying(false);
    const { frame } = training;
    const session: Session = {
      ...training.session,
      orders: [
        ...(training.session.orders ?? []),
        { date: visibleDate, side, quantity: shares },
      ],
    };
    void run(async (signal) => {
      const next = await requestFrame(
        {
          symbol: frame.symbol,
          cutoffDate: frame.cutoffDate,
          adjustment: frame.adjustment,
          session,
        },
        signal,
      );
      if (!signal.aborted)
        setTraining({
          ...training,
          session,
          frame: { ...next, czsc: frame.czsc },
        });
    });
  };
  const reveal = () => {
    if (!training || !visibleDate) return;
    setPlaying(false);
    void run(async (signal) => {
      const result = await client.barReplayReveal.mutate(
        {
          symbol: training.frame.symbol,
          cutoffDate: visibleDate,
          session: training.session,
          strategyKey,
        },
        { signal },
      );
      if (!signal.aborted) setEvaluation(result);
    });
  };
  const togglePlay = () => {
    if (playing || (canAdvance && !busy)) setPlaying((value) => !value);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="border-nc-border bg-nc-card lg:max-w-6xl"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          if (document.activeElement instanceof HTMLElement)
            returnFocus.current = document.activeElement;
          event.preventDefault();
          startInput.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
        onKeyDown={(event) => {
          if (
            event.key !== " " ||
            !training ||
            event.repeat ||
            (event.target instanceof Element &&
              event.target.closest(
                "input, textarea, select, button, [contenteditable=true]",
              ))
          )
            return;
          event.preventDefault();
          togglePlay();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DialogTitle>Bar Replay 盲测训练</DialogTitle>
          <Button variant="outline" size="sm" onClick={onClose}>
            退出训练
          </Button>
        </div>
        <DialogDescription>
          收盘后作决定，下一交易日开盘模拟成交。结束后才显示理论信号。
        </DialogDescription>
        {!training ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              start();
            }}
          >
            <fieldset
              disabled={busy}
              className="flex flex-wrap items-end gap-3"
            >
              <label className="grid gap-1">
                标的代码
                <Input
                  value={draftSymbol}
                  onChange={(event) => {
                    setSymbol(event.target.value);
                    setStartDate("");
                    setEndDate("");
                  }}
                  placeholder="sh600000"
                  required
                />
              </label>
              <label className="grid gap-1">
                起始截断日
                <Input
                  ref={startInput}
                  type="date"
                  value={startDate}
                  min={firstDate ?? undefined}
                  max={endDate || undefined}
                  onChange={(event) => setStartDate(event.target.value)}
                  required
                />
              </label>
              <label className="grid gap-1">
                训练结束日（可选）
                <Input
                  type="date"
                  value={endDate}
                  min={startDate || firstDate || undefined}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                复权口径
                <select
                  className={selectClass}
                  value={adjustment}
                  onChange={(event) =>
                    setAdjustment(event.target.value as BarReplayAdjustment)
                  }
                >
                  {(["none", "forward", "backward"] as const).map((value) => (
                    <option key={value} value={value}>
                      {chartAdjustmentLabels[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                理论对照
                <select
                  className={selectClass}
                  value={strategyKey}
                  onChange={(event) =>
                    setStrategyKey(
                      event.target.value === "double-breakout"
                        ? "double-breakout"
                        : "ma-cross",
                    )
                  }
                >
                  <option value="ma-cross">双均线 MA5/MA20</option>
                  <option value="double-breakout">双突破</option>
                </select>
              </label>
              <Button type="submit" disabled={!sessionReady || busy}>
                开始训练
              </Button>
            </fieldset>
            <p className="text-sm text-nc-text-3">
              {candidates.isFetching
                ? "正在检查本地完整日线…"
                : firstDate
                  ? `最早起始截断日 ${firstDate}。`
                  : candidates.data
                    ? "此标的暂无可用于训练的完整日线。"
                    : "输入沪、深、北交易所代码，使用本地 A 股或场内基金日线。"}
            </p>
            {candidates.error && <p role="alert">{candidates.error.message}</p>}
          </form>
        ) : (
          <div
            ref={controls}
            tabIndex={-1}
            className="flex flex-wrap items-center gap-2"
            aria-label="盲测训练控制"
          >
            <strong
              data-testid="bar-replay-cutoff"
              data-date={training.frame.cutoffDate}
            >
              当前截断日 {training.frame.cutoffDate}
            </strong>
            <Button
              variant="outline"
              size="sm"
              disabled={!playing && (!canAdvance || busy)}
              onClick={togglePlay}
              aria-keyshortcuts="Space"
            >
              {playing ? <Pause /> : <Play />} {playing ? "暂停" : "播放"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdvance || busy}
              onClick={() => {
                setPlaying(false);
                advance();
              }}
            >
              <SkipForward /> 前进一根
            </Button>
            <label className="flex items-center gap-1">
              倍速
              <select
                className={selectClass}
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                {[1, 2, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              模拟数量
              <Input
                className="w-24"
                type="number"
                min={100}
                step={100}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!canOrder}
              onClick={() => placeOrder("buy")}
            >
              模拟买入
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canOrder || shares > holdings - pendingShares}
              onClick={() => placeOrder("sell")}
            >
              模拟卖出
            </Button>
            <Button size="sm" disabled={busy || !!evaluation} onClick={reveal}>
              结束并揭晓
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-nc-accent"
            checked={training?.includeCzsc ?? includeCzsc}
            disabled={busy}
            onChange={(event) => setStructure(event.target.checked)}
          />
          按需显示原生缠论（串行）
        </label>
        {busy && <p role="status">正在处理训练请求…</p>}
        {error && <p role="alert">{error}</p>}
        {frame && training && (
          <>
            <div className="space-y-1 text-sm text-nc-text-3">
              <p className="tabular" data-testid="bar-replay-position">
                模拟持仓 {formatNumber(holdings, 0)} 股 · 今日可卖{" "}
                {formatNumber(simulation?.sellableQuantity ?? 0, 0)} 股{" · "}
                浮动盈亏 {formatNumber(floatingPnl(frame.simulation))} · 现金{" "}
                {formatNumber(simulation?.cash ?? initialCash)}
              </p>
              <p>
                模拟采用原价成交，T+1，每手 100 股。
                {evaluation
                  ? "训练已结束。"
                  : canAdvance
                    ? "可前进一根。"
                    : "已到训练末端。"}
              </p>
              {!validLot && <p role="status">请输入 100 股的整数倍。</p>}
              {!!simulation?.pending.length && (
                <p role="status">
                  待下一交易日开盘 {simulation.pending.length} 笔
                </p>
              )}
              {simulation?.blockedReason && (
                <p role="alert">{simulation.blockedReason}</p>
              )}
              {simulation?.fills.slice(-3).map((fill) => (
                <p key={fill.orderIndex}>
                  {fill.executionDate} 模拟{sideLabel(fill.side)}成交{" "}
                  {formatNumber(fill.quantity, 0)} 股 ·{" "}
                  {formatNumber(fill.price, 3)}
                </p>
              ))}
              {simulation?.rejections.slice(-3).map((row) => (
                <p key={row.orderIndex} role="status">
                  {row.executionDate} 模拟{sideLabel(row.order.side)}未成交 ·{" "}
                  {rejectionLabels[row.reason]}
                </p>
              ))}
              {frame.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              {training.includeCzsc && (
                <p>
                  {czsc?.status === "structure"
                    ? "已显示当前截断日的原生笔、线段和中枢"
                    : "当前可见日线尚无缠论结构"}
                </p>
              )}
            </div>
            <MarketChart
              bars={frame.bars}
              period="day"
              adjustment={frame.adjustment}
              czsc={czsc}
              viewportPolicy="ephemeral"
              viewportKey={`${frame.symbol}:day`}
              annotations={false}
              rpsAvailable={false}
              pricePrecision={chartPricePrecision(frame.symbol)}
              height={420}
            />
          </>
        )}
        {evaluation && <ReplayEvaluation evaluation={evaluation} />}
      </DialogContent>
    </Dialog>
  );
}

function ReplayEvaluation({ evaluation }: { evaluation: Evaluation }) {
  const { user, theory, timing } = evaluation;
  return (
    <section
      aria-label="揭晓评分"
      className="space-y-3 rounded-md border border-nc-border bg-nc-inset p-3 text-sm"
    >
      <h3 className="font-semibold">揭晓评分 · 截至 {evaluation.cutoffDate}</h3>
      <dl className="grid gap-2 tabular sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt>时机 F1</dt>
          <dd>
            {formatNumber(timing.f1, 3)} · 容差 ±{timing.toleranceSessions}{" "}
            交易日
          </dd>
        </div>
        <div>
          <dt>规则纪律分</dt>
          <dd>{formatNumber(user.discipline.score, 0)} / 100</dd>
        </div>
        <div>
          <dt>收益差（实训 − 理论）</dt>
          <dd>
            {ratioPercent(evaluation.returnDifference)} ·{" "}
            {ratioPercent(user.totalReturn)} /{" "}
            {ratioPercent(theory.totalReturn)}
          </dd>
        </div>
        <div>
          <dt>回撤差（实训 − 理论）</dt>
          <dd>
            {ratioPercent(evaluation.maxDrawdownDifference)} ·{" "}
            {ratioPercent(user.maxDrawdown)} /{" "}
            {ratioPercent(theory.maxDrawdown)}
          </dd>
        </div>
      </dl>
      <p>
        命中 {timing.matches} 笔 · 实训 {timing.userSignals} 笔 · 理论{" "}
        {timing.theorySignals} 笔
      </p>
      <details className="max-h-52 overflow-auto">
        <summary>理论信号对照</summary>
        <ul>
          {evaluation.theorySignals.map((row) => (
            <li key={`${row.date}:${row.side}`}>
              {row.date} 理论{sideLabel(row.side)}
            </li>
          ))}
        </ul>
        {!evaluation.theorySignals.length && <p>区间内无理论信号。</p>}
      </details>
      <div className="max-h-52 overflow-auto">
        <table className="w-full text-left tabular">
          <caption className="text-left font-semibold">漏做明细</caption>
          <thead>
            <tr>
              <th>信号日</th>
              <th>方向</th>
              <th>观察日</th>
              <th>后续收益</th>
            </tr>
          </thead>
          <tbody>
            {evaluation.missed.map((row) => (
              <tr key={`${row.date}:${row.side}`}>
                <td>{row.date}</td>
                <td>{sideLabel(row.side)}</td>
                <td>{row.followUpDate ?? "—"}</td>
                <td>{ratioPercent(row.forwardReturn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!evaluation.missed.length && <p>无漏做信号。</p>}
      </div>
      {evaluation.warnings.map((warning) => (
        <p className="text-nc-text-3" key={warning}>
          {warning}
        </p>
      ))}
    </section>
  );
}
