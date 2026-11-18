import { createHash } from "node:crypto";
import type { PortfolioInstrument } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import { adjustmentFactors, applyAdjustmentAtAnchor } from "tstdx/local";
import { readBars } from "../market/bar-store/read-bars";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { corporateActions } from "../market/bar-store/corporate-actions";
import { localBars } from "../market/bar-store/local-source";
import type { CalendarReference } from "../market/data-health";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "./corporate-actions";
import { theoryMultiperiodInputs } from "./theory-multiperiod-inputs";
import { loadTheoryPriceTicks } from "./theory-price-ticks";
import { loadTheoryCalendar } from "./theory-calendar";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type TheoryMultiperiodLoadOptions = {
  strategy: StrategyObjectInput;
  start: string;
  end: string;
  config: { tdxRoot: string; binancePublicDataRoot: string };
  calendar?: CalendarReference;
  loadCalendar?: typeof loadTheoryCalendar;
  priceTicks?: Readonly<
    Record<string, { tick: number; source: string; observedAt: string }>
  >;
  /** Freeze once in a batch; the app defaults to one public metadata read. */
  loadPriceTicks?: typeof loadTheoryPriceTicks;
  read?: typeof readBars;
  progress?: (n: number, phase: string) => void;
};
/** Local/frozen readers only. Caller must establish isolated QUANT_DATA_DIR before invocation. */
export async function loadTheoryMultiperiodSource(
  options: TheoryMultiperiodLoadOptions,
) {
  const { strategy, start, end, config } = options;
  if (
    strategy.entry.kind !== "triple-screen" ||
    strategy.universe.kind !== "symbols"
  )
    throw new Error("Explicit triple-screen symbols required");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start >= end
  )
    throw new Error("Invalid research dates");
  const cn = strategy.market === "cn-equity",
    variant = strategy.entry.variant;
  const intraday = variant === "day-hour-five";
  const now = cn
    ? Date.parse(`${end}T23:59:59+08:00`)
    : Date.parse(end) + 86400000;
  const warmupStart = new Date(
    Date.parse(start) - (intraday ? 120 : 730) * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const minuteStart = new Date(Date.parse(start) - 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  const calendar = cn
    ? (options.calendar ??
      (await (options.loadCalendar ?? loadTheoryCalendar)(warmupStart, end)))
    : { days: [], closedDays: [], hash: "continuous-UTC-v1", source: "UTC" };
  const actionsSource = cn ? await corporateActions(config.tdxRoot) : null;
  const priceTicks = cn
    ? undefined
    : (options.priceTicks ??
      (await (options.loadPriceTicks ?? loadTheoryPriceTicks)()));
  const read = options.read ?? readBars;
  const instruments: PortfolioInstrument[] = [],
    sources: Record<string, unknown>[] = [];
  const expectedCalendar = new Set<string>();
  let total = 0;
  for (const symbol of strategy.universe.symbols) {
    if (!cn && !["cxBTCUSDT", "cxETHUSDT"].includes(symbol))
      throw new Error("Only BTC/ETH spot supported");
    const load = async (period: "day" | "5m", from: string) => {
      const to = !cn && period === "5m" ? new Date(now).toISOString() : end;
      let archive = cn
        ? undefined
        : await binanceArchiveSource({
            symbol,
            period,
            configuredRoot: config.binancePublicDataRoot,
            from,
            to,
            now,
          });
      if (!cn && !archive)
        throw new Error(`${symbol} ${period} local archive missing`);
      if (cn && period === "5m") {
        const full = await localBars(config.tdxRoot, symbol, "5m");
        const bars = full.bars.filter(
          (b) => b.date.slice(0, 10) >= from && b.date.slice(0, 10) <= end,
        );
        archive = {
          ...full,
          bars,
          hash: hash({ full: full.hash, from, to: end, bars }),
          sourceVersions: [...(full.sourceVersions ?? []), full.hash],
        };
      }
      let snapshot = await read(
        {
          instrument: { market: strategy.market, symbol },
          period,
          adjustment: "none",
          freezeRaw: true,
          root: config.tdxRoot,
          source: "local",
          from,
          to,
          live: false,
          now,
        },
        archive ?? undefined,
      );
      if (!cn && period === "5m") {
        // End-labelled midnight belongs to the preceding UTC day, outside (from, end].
        const bars = snapshot.bars.filter(
          (bar) => Date.parse(bar.date) > Date.parse(from),
        );
        const sourceHash = snapshot.hash;
        snapshot = {
          ...snapshot,
          bars,
          hash: hash({ sourceHash, exclusiveStart: from, bars }),
          barStore: {
            ...snapshot.barStore,
            sourceVersions: [...snapshot.barStore.sourceVersions, sourceHash],
            coverage: {
              ...snapshot.barStore.coverage,
              from: bars[0]?.date ?? null,
              to: bars.at(-1)?.date ?? null,
              count: bars.length,
            },
          },
        };
      }
      if (
        snapshot.barStore.priceRepaired ||
        snapshot.barStore.formingDates.length
      )
        throw new Error(
          `${symbol} ${period} contains repaired or forming bars`,
        );
      total += snapshot.bars.length;
      if (total > 2000000)
        throw new Error("Frozen sources exceed 2 million bars");
      if (!snapshot.bars.length)
        throw new Error(`${symbol} ${period} source empty`);
      return snapshot;
    };
    const daily = await load("day", warmupStart),
      five = intraday ? await load("5m", minuteStart) : undefined;
    const events = actionsSource?.events.get(symbol) ?? [];
    const factors = cn ? adjustmentFactors(daily.bars, events) : [];
    const anchor = cn
      ? { date: factors[0]!.date, factor: factors[0]!.factor }
      : null;
    const signalDaily = anchor
      ? applyAdjustmentAtAnchor(daily.bars, factors, anchor)
      : daily.bars;
    const signalFive = five
      ? anchor
        ? applyAdjustmentAtAnchor(five.bars, factors, anchor)
        : five.bars
      : undefined;
    const adjustmentId = hash({
      kind: cn ? "fixed-first-daily-anchor" : "raw",
      anchor,
      actions: actionsSource?.fingerprint ?? null,
      daily: daily.hash,
    });
    const multi = theoryMultiperiodInputs({
      variant,
      market: strategy.market,
      tick: cn ? 0.01 : (priceTicks?.[symbol]?.tick ?? null),
      now,
      dailyFrom: warmupStart,
      executionFrom: intraday ? minuteStart : warmupStart,
      calendar: {
        days: calendar.days,
        closedDays: (calendar as CalendarReference).closedDays ?? [],
        hash: calendar.hash ?? "",
      },
      daily: {
        bars: signalDaily,
        sourceHash: daily.hash,
        adjustmentId,
        priceScales: Object.fromEntries(
          signalDaily.map((b, i) => [b.date, b.close / daily.bars[i]!.close]),
        ),
      },
      ...(five && signalFive
        ? {
            fiveMinute: {
              bars: signalFive,
              sourceHash: five.hash,
              adjustmentId,
              priceScales: Object.fromEntries(
                signalFive.map((b, i) => [
                  b.date,
                  b.close / five.bars[i]!.close,
                ]),
              ),
            },
          }
        : {}),
    });
    const raw = five?.bars ?? daily.bars,
      signal = signalFive ?? signalDaily;
    for (const slot of multi.execution.slots) {
      if (slot.bar) {
        expectedCalendar.add(slot.bar.date);
        continue;
      }
      const time = Date.parse(slot.availableAt);
      expectedCalendar.add(
        intraday
          ? cn
            ? new Date(time + 8 * 3600000)
                .toISOString()
                .replace(".000Z", "+08:00")
            : new Date(time).toISOString().replace(".000Z", "+00:00")
          : new Date(time + (cn ? 8 * 3600000 : -86400000))
              .toISOString()
              .slice(0, 10),
      );
    }
    const dailyActions = actionsSource
      ? researchCorporateActions(
          events,
          actionsSource.fingerprint,
          daily.bars[0]!.date,
          end,
        )
      : [];
    const dailyExecution = new Map(
      daily.bars.map((b, i) => [
        b.date,
        researchExecutionAt(symbol, b, daily.bars[i - 1], dailyActions),
      ]),
    );
    const actions = intraday
      ? dailyActions.map((a) => ({
          ...a,
          date: `${a.date}T09:35:00+08:00`,
          availableAt: `${a.availableAt}T09:35:00+08:00`,
          ...(a.sharesSellableAt
            ? { sharesSellableAt: `${a.sharesSellableAt}T09:35:00+08:00` }
            : {}),
        }))
      : dailyActions;
    instruments.push({
      symbol,
      market: strategy.market,
      bars: raw,
      signalBars: signal,
      actions,
      external: { tripleScreen: multi },
      execution: cn
        ? (bar) => {
            if (!bar) return undefined;
            const evidence = dailyExecution.get(bar.date.slice(0, 10));
            return evidence
              ? { ...evidence, tradable: evidence.tradable && bar.volume > 0 }
              : undefined;
          }
        : {
            evidence:
              "Verified Binance archive; fixed research quantity/tick scenario, historical venue filters unverified",
            minimum: 0.000001,
            step: 0.000001,
            limitUp: null,
            limitDown: null,
            tradable: true,
          },
    });
    sources.push({
      symbol,
      daily: daily.hash,
      five: five?.hash ?? null,
      dailySourceVersions: daily.barStore.sourceVersions,
      fiveSourceVersions: five?.barStore.sourceVersions ?? [],
      requestedCoverage: {
        dailyFrom: warmupStart,
        executionFrom: intraday ? minuteStart : warmupStart,
        end,
      },
      adjustmentId,
      anchor,
      tickEvidence: cn
        ? "A-share CNY 0.01 price increment"
        : (priceTicks?.[symbol] ?? null),
      calendarHash: calendar.hash,
      calendarSource: calendar.source,
      signalHash: hash(signal),
      actionsHash: hash(actions),
      missing: {
        execution: multi.execution.slots.filter((s) => !s.bar).length,
        setup: multi.setup.slots.filter((s) => !s.bar).length,
        background: multi.background.slots.filter((s) => !s.bar).length,
      },
    });
    options.progress?.(
      Math.floor((instruments.length / strategy.universe.symbols.length) * 70),
      `冻结 ${symbol} 多周期输入`,
    );
  }
  const calendarBars = [...expectedCalendar].sort();
  const selected = calendarBars.filter((date) =>
    intraday && !cn
      ? Date.parse(date) > Date.parse(start) && Date.parse(date) <= now
      : date.slice(0, 10) >= start && date.slice(0, 10) <= end,
  );
  if (!selected.length)
    throw new Error("Research window contains no execution bars");
  return {
    instruments,
    sources,
    calendar: calendarBars,
    start: selected[0]!,
    end: selected.at(-1)!,
    boundary:
      "Rule-check only; current universe, revised sources and research ST/IPO/venue assumptions; no certified strategy performance",
  };
}
