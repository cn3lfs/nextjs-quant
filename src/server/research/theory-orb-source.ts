import { createHash } from "node:crypto";
import type { PortfolioInstrument } from "quant-backtest";
import type { Bar } from "~/lib/domain";
import {
  buildUtcOrbSessions,
  utcOrbBarEpoch,
  utcOrbSessionBars,
  utcOrbSessionDay,
  utcOrbShiftDay,
  utcOrbSlotIndex,
  utcOrbSlotLabel,
  utcOrbSymbols,
  utcOrbWarmupDays,
  type StrategyObjectInput,
  type UtcOrbInput,
} from "trading-strategies";
import {
  evaluateResearchReadiness,
  type ResearchReadinessInput,
} from "~/lib/research/research-readiness";
import { readBars } from "../market/bar-store/read-bars";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Adapter warmup is deliberately wider than the rule's 10 complete days. */
export const theoryOrbAdapterWarmupDays = 14;

export type TheoryOrbLoadOptions = {
  strategy: StrategyObjectInput;
  /** First decision UTC day (YYYY-MM-DD). */
  start: string;
  /** Last decision UTC day (YYYY-MM-DD). */
  end: string;
  config: { tdxRoot: string; binancePublicDataRoot: string };
  read?: typeof readBars;
  now?: number;
  progress?: (n: number, phase: string) => void;
};

function expectedLabels(fromDay: string, lastLabel: string) {
  const last = Date.parse(lastLabel);
  const labels: string[] = [];
  for (let day = fromDay; ; day = utcOrbShiftDay(day, 1)) {
    for (let slot = 0; slot < utcOrbSessionBars; slot++) {
      const label = utcOrbSlotLabel(day, slot);
      labels.push(label);
      if (label === lastLabel) return labels;
      if (Date.parse(label) > last)
        throw new Error("UTC ORB expected range overshot the last slot");
    }
  }
}

function readinessInput(options: {
  symbol: string;
  warmupStart: string;
  decisionStart: string;
  lastLabel: string;
  /** Keyed by canonical UTC epoch so `Z` and `+00:00` labels compare equal. */
  bars: ReadonlyMap<number, Bar>;
  sourceHash: string;
  adjustmentId: string;
  calendarHash: string;
  evaluatedAt: string;
}): ResearchReadinessInput {
  const slots = expectedLabels(options.warmupStart, options.lastLabel);
  const warmup: ResearchReadinessInput["warmup"] = {
    decisionStart: options.decisionStart,
    // First completed slot of the decision day is the strict availability instant.
    decisionAvailableAt: utcOrbSlotLabel(options.decisionStart, 0),
  };
  return {
    asOf: options.lastLabel.slice(0, 10),
    evaluatedAt: options.evaluatedAt,
    instrument: options.symbol,
    market: "crypto",
    engineering: {
      runnable: true,
      reason: "UTC ORB adapter and runnable strategy object implemented",
    },
    ruleCheck: {
      evaluated: false,
      reason: "适配器只导出数据资格；规则自检由冻结组合回放执行",
    },
    window: {
      start: options.warmupStart,
      end: options.lastLabel.slice(0, 10),
    },
    series: [
      {
        instrument: options.symbol,
        period: "5m",
        sourceHash: options.sourceHash,
        adjustmentId: options.adjustmentId,
        calendarHash: options.calendarHash,
        expectedSlots: slots.length,
        expectedFirstAvailableAt: slots[0]!,
        expectedLastAvailableAt: slots.at(-1)!,
        requiredBars: utcOrbSessionBars * utcOrbWarmupDays,
        slots: slots.map((label) => {
          const epoch = utcOrbBarEpoch(label);
          const bar = epoch === null ? undefined : options.bars.get(epoch);
          return bar && epoch !== null
            ? {
                availableAt: label,
                bar: {
                  date: bar.date,
                  open: bar.open,
                  high: bar.high,
                  low: bar.low,
                  close: bar.close,
                  volume: bar.volume,
                  amount: bar.amount,
                },
              }
            : {
                availableAt: label,
                bar: null,
                reason: "missing-completed-5m-bar",
              };
        }),
      },
    ],
    warmup,
    financial: { requiredFacts: [], missingFacts: [] },
    pointInTime: {
      status: "limited",
      reason:
        "原始 Binance 归档；历史场所过滤、当时证券池和费用未认证，不是可信业绩",
    },
  };
}

/** Raw unadjusted completed 5-minute crypto source for F04.05. Gaps stay
 * missing; no earlier signal uses future current-day completeness. Caller must
 * establish an isolated QUANT_DATA_DIR before invocation. */
export async function loadTheoryOrbSource(options: TheoryOrbLoadOptions) {
  const { strategy, start, end, config } = options;
  if (strategy.entry.kind !== "utc-orb" || strategy.universe.kind !== "symbols")
    throw new Error("Explicit UTC ORB symbols required");
  if (strategy.market !== "crypto" || strategy.period !== "5m")
    throw new Error("UTC ORB adapter is crypto 5m only");
  const symbols = strategy.universe.symbols;
  if (symbols.some((symbol) => !utcOrbSymbols.includes(symbol as never)))
    throw new Error("UTC ORB universe is BTC/ETH spot only");
  let warmupStart: string,
    readinessStart: string,
    firstLabel: string,
    lastLabel: string;
  try {
    // Shared strict day labels reject 2026-02-30 and other impossible dates.
    warmupStart = utcOrbShiftDay(start, -theoryOrbAdapterWarmupDays);
    // Readiness needs only the rule's 10 prior days, not the adapter buffer.
    readinessStart = utcOrbShiftDay(start, -utcOrbWarmupDays);
    firstLabel = utcOrbSlotLabel(warmupStart, 0);
    lastLabel = `${utcOrbShiftDay(end, 1)}T00:00:00+00:00`;
  } catch {
    throw new Error("Invalid UTC ORB research dates");
  }
  if (Date.parse(start) > Date.parse(end))
    throw new Error("Invalid UTC ORB research dates");
  const now = options.now ?? Date.now();
  if (Date.parse(lastLabel) > now)
    throw new Error("UTC ORB end day is not completed");
  const calendarHash = "continuous-UTC-v1";
  const evaluatedAt = new Date().toISOString();
  const read = options.read ?? readBars;
  const instruments: PortfolioInstrument[] = [],
    sources: Record<string, unknown>[] = [];
  let total = 0;
  for (const symbol of symbols) {
    const archive = await binanceArchiveSource({
      symbol,
      period: "5m",
      configuredRoot: config.binancePublicDataRoot,
      from: firstLabel,
      to: lastLabel,
      now,
    });
    if (!archive) throw new Error(`${symbol} 缺少本地原生5分钟官方归档`);
    const snapshot = await read(
      {
        instrument: { market: "crypto", symbol },
        period: "5m",
        adjustment: "none",
        freezeRaw: true,
        root: config.tdxRoot,
        source: "local",
        from: firstLabel,
        to: lastLabel,
        live: false,
        now,
      },
      archive,
    );
    if (
      snapshot.barStore.formingDates.length ||
      snapshot.barStore.priceRepaired
    )
      throw new Error(`${symbol} 包含未完成或修复行情`);
    const raw = snapshot.rawBars ?? snapshot.bars;
    const sameBar = (left: Bar, right: Bar) =>
      left.date === right.date &&
      left.open === right.open &&
      left.high === right.high &&
      left.low === right.low &&
      left.close === right.close &&
      left.volume === right.volume &&
      left.amount === right.amount;
    if (
      raw.length !== snapshot.bars.length ||
      raw.some((bar, index) => !sameBar(bar, snapshot.bars[index]!))
    )
      throw new Error(`${symbol} 原价与信号周期未对齐（含OHLCV）`);
    const from = Date.parse(firstLabel),
      to = Date.parse(lastLabel);
    const seenLabels = new Set<string>();
    const bars = raw
      .filter((bar) => {
        const time = utcOrbBarEpoch(bar.date);
        if (time === null)
          throw new Error(`${symbol} 含非法UTC 5分钟bar标签: ${bar.date}`);
        return time >= from && time <= to;
      })
      .map((bar) => {
        // The engine aligns by exact date string. Normalize equivalent UTC
        // labels (Z / +00:00) to the frozen +00:00 slot text only; prices and
        // source identity stay untouched.
        const day = utcOrbSessionDay(bar.date);
        const slot = utcOrbSlotIndex(bar.date);
        if (day === null || slot === null)
          throw new Error(`${symbol} 含非法UTC 5分钟bar标签: ${bar.date}`);
        const date = utcOrbSlotLabel(day, slot);
        if (seenLabels.has(date))
          throw new Error(`${symbol} 含重复UTC 5分钟槽: ${date}`);
        seenLabels.add(date);
        return date === bar.date ? bar : { ...bar, date };
      });
    if (!bars.length) throw new Error(`${symbol} UTC ORB区间行情为空`);
    total += bars.length;
    if (total > 2_000_000) throw new Error("冻结行情超过200万根资源边界");
    const sessions = buildUtcOrbSessions(bars);
    const slotsByDay = new Map<string, Set<number>>();
    for (const bar of bars) {
      const day = utcOrbSessionDay(bar.date);
      const slot = utcOrbSlotIndex(bar.date);
      if (day === null || slot === null) continue;
      const slots = slotsByDay.get(day) ?? new Set<number>();
      slots.add(slot);
      slotsByDay.set(day, slots);
    }
    const completeSessions = sessions.filter(
      (session) => slotsByDay.get(session.day)?.size === utcOrbSessionBars,
    ).length;
    const observed = sessions.find((session) => session.day === start) ?? null;
    const decisionExpected = expectedLabels(start, lastLabel);
    const decisionEpochs = new Set(
      decisionExpected.map((label) => utcOrbBarEpoch(label)!),
    );
    const observedDecision = bars.filter((bar) =>
      decisionEpochs.has(utcOrbBarEpoch(bar.date)!),
    ).length;
    const adjustmentId = hash({
      kind: "raw-unadjusted",
      sourceHash: snapshot.hash,
    });
    const orb: UtcOrbInput = {
      market: "crypto",
      period: "5m",
      barMinutes: 5,
      sessionBars: utcOrbSessionBars,
      warmupDays: utcOrbWarmupDays,
      sourceHash: snapshot.hash,
      adjustmentId,
      calendarHash,
      coverage: {
        from: bars[0]?.date ?? null,
        to: bars.at(-1)?.date ?? null,
        bars: bars.length,
        sessions: sessions.length,
        completeSessions,
      },
      sessions,
    };
    const barMap = new Map(bars.map((bar) => [utcOrbBarEpoch(bar.date)!, bar]));
    const readiness = evaluateResearchReadiness(
      readinessInput({
        symbol,
        warmupStart: readinessStart,
        decisionStart: start,
        lastLabel,
        bars: barMap,
        sourceHash: snapshot.hash,
        adjustmentId,
        calendarHash,
        evaluatedAt,
      }),
    );
    instruments.push({
      symbol,
      market: "crypto",
      bars,
      signalBars: bars,
      actions: [],
      external: { orb },
      execution: {
        evidence:
          "Verified Binance archive; raw completed 5m; fixed research quantity/tick scenario, venue filters unverified",
        minimum: 0.000001,
        step: 0.000001,
        limitUp: null,
        limitDown: null,
        tradable: true,
      },
    });
    sources.push({
      symbol,
      period: "5m",
      sourceHash: snapshot.hash,
      rawHash: hash(bars),
      rawHashBasis: "normalized-UTC-slot-labels",
      sourceFingerprint: snapshot.barStore.sourceFingerprint,
      sourceVersions: snapshot.barStore.sourceVersions,
      adjustment: "none",
      adjustmentId,
      calendarHash,
      expected5mSlots: decisionExpected.length,
      observed5mSlots: observedDecision,
      missing5mSlots: Math.max(0, decisionExpected.length - observedDecision),
      prior10CompleteBeforeStart: observed?.priorCompleteDays.length ?? 0,
      requestedCoverage: { from: firstLabel, to: lastLabel },
      observedCoverage: orb.coverage,
      readiness,
    });
    options.progress?.(
      Math.floor((instruments.length / symbols.length) * 70),
      `冻结 ${symbol} UTC ORB 5分钟输入`,
    );
  }
  const calendar = expectedLabels(start, lastLabel);
  if (!calendar.length) throw new Error("UTC ORB window contains no slots");
  return {
    instruments,
    sources,
    calendar,
    start: utcOrbSlotLabel(start, 0),
    end: lastLabel,
    boundary:
      "UTC 5分钟收盘代理；规则自检，非严格日内执行或盘中硬止损；历史窗口不是独立留出或前向观察",
  };
}
