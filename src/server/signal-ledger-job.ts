import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import {
  horizons,
  ledgerOutcome,
  type ActionEvidence,
} from "~/lib/signal-ledger";
import { SignalLedgerStore, type LedgerRun } from "./signal-ledger-store";
import { ledgerSignals } from "./signal-ledger-engine";
import { analyzeCzsc } from "./czsc";
import { breakoutBatch } from "./breakout-batch";
import { analyzeBreakout, type BreakoutPoint } from "./breakout";
import { readSnapshot, scan } from "./tdx";
import { readGbbq } from "./tdx-gbbq";
import { localCalendarReference, type CalendarReference } from "./data-health";
import { completedBarFilter } from "./screening";
import { sqlite } from "./db";
import { settings } from "./settings";

export type LedgerDependencies = {
  calendar: () => Promise<CalendarReference>;
  universe: () => Promise<string[]>;
  bars: (symbol: string) => Promise<Bar[]>;
  czsc: (bars: Bar[]) => Promise<CzscResult>;
  breakout: (
    symbols: string[],
    now: number,
  ) => Promise<{
    candidates: { symbol: string; point: BreakoutPoint }[];
    errors: { symbol: string; error: string }[];
  }>;
  actions: () => Promise<(symbol: string) => ActionEvidence>;
};

export function localLedgerDependencies(
  root: string,
  calendar: string[],
): LedgerDependencies {
  return {
    calendar: () => localCalendarReference(root, calendar),
    universe: async () =>
      (await scan(root)).securities
        .filter((s) => s.period === "day")
        .map((s) => s.symbol),
    bars: async (symbol) => (await readSnapshot(root, symbol, "day")).bars,
    czsc: (bars) => analyzeCzsc(bars, true),
    breakout: (symbols, now) => breakoutBatch(root, symbols, now),
    actions: async () => {
      try {
        const data = await readGbbq(root);
        return (symbol) => ({
          // Category 11/12 are share consolidation events: also not comparable.
          dates: (data.events.get(symbol) ?? [])
            .filter((e) => [1, 11, 12].includes(e.category))
            .map((e) => e.date),
          source: `${data.path}；mtime=${data.modified}；既有GBBQ解析；无完整覆盖证明`,
        });
      } catch {
        return () => ({ dates: [], source: "本地GBBQ不可用；除权状态未知" });
      }
    },
  };
}

/** Date comes exclusively from the frozen wall clock. No historical/asOf API. */
export async function runSignalLedger(
  store: SignalLedgerStore,
  deps: LedgerDependencies,
  now: number,
) {
  const local = new Date(now + 8 * 3600000).toISOString();
  const today = local.slice(0, 10);
  if (local.slice(11, 16) < "15:05") return;
  const previousRun = store.run(today);
  if (
    previousRun &&
    ["complete", "partial", "failed"].includes(previousRun.status)
  )
    return previousRun;
  const started = performance.now();
  const run: LedgerRun = {
    date: today,
    status: "running",
    total: 0,
    scanned: 0,
    signals: 0,
    elapsedMs: 0,
    errors: [],
    calendarSource: "未知",
  };
  try {
    const calendar = await deps.calendar();
    if (!calendar.days.includes(today)) return;
    run.calendarSource = calendar.source;
    store.saveRun(run);
    const symbols = [...new Set(await deps.universe())].sort();
    if (!symbols.length) throw new Error("全市场本地A股日线证券池为空");
    run.total = symbols.length;
    const completed = completedBarFilter("day", now);
    const batch = await deps.breakout(symbols, now);
    const candidates = new Map(
      batch.candidates.map((c) => [c.symbol, c.point]),
    );
    const breakoutErrors = new Set(batch.errors.map((e) => e.symbol));
    run.errors.push(
      ...batch.errors.map((e) => ({
        symbol: e.symbol,
        reason: `双突破：${e.error}`,
      })),
    );
    for (const symbol of symbols) {
      try {
        const baseline = store.baseline(symbol);
        if (baseline?.date === today) {
          run.scanned++;
          continue;
        }
        const bars = (await deps.bars(symbol)).filter((b) => completed(b.date));
        if (bars.at(-1)?.date !== today) {
          run.errors.push({
            symbol,
            reason: "当日行情缺失/过旧，未生成历史台账",
          });
          continue;
        }
        if (!bars.at(-1)!.volume) {
          run.errors.push({ symbol, reason: "当日停牌或零成交" });
          continue;
        }
        if (breakoutErrors.has("*") || breakoutErrors.has(symbol)) continue;
        // Single existing CZSC worker serializes all FFI requests, including UI/monitor requests.
        const czsc = await deps.czsc(bars);
        const point = candidates.has(symbol)
          ? analyzeBreakout(bars).latest
          : null;
        const result = ledgerSignals(
          symbol,
          today,
          bars,
          czsc,
          point,
          baseline,
        );
        store.record(symbol, today, result.keys, result.signals);
        run.scanned++;
      } catch {
        run.errors.push({ symbol, reason: "行情读取或策略执行失败" });
      }
    }
    const actions = await deps.actions();
    const rows = store.rows();
    const pending = new Map<string, typeof rows>();
    for (const row of rows)
      if (
        horizons.some(
          (h) => !row.outcomes.find((o) => o.horizon === h)?.settled,
        )
      ) {
        const values = pending.get(row.symbol) ?? [];
        values.push(row);
        pending.set(row.symbol, values);
      }
    for (const [symbol, values] of pending) {
      let bars: Bar[] = [];
      try {
        bars = await deps.bars(symbol);
      } catch {
        /* Blank with missing-data reason. */
      }
      for (const row of values)
        for (const horizon of horizons) {
          if (row.outcomes.find((o) => o.horizon === horizon)?.settled)
            continue;
          store.outcome(
            row.id,
            ledgerOutcome(
              row,
              horizon,
              bars,
              calendar.days,
              calendar.source,
              actions(symbol),
              today,
            ),
          );
        }
    }
    run.signals = store.rows().filter((s) => s.observedDate === today).length;
    run.status = run.errors.length ? "partial" : "complete";
  } catch {
    run.status = "failed";
    run.errors.push({
      symbol: "*",
      reason: "台账任务失败；检查本地行情与交易日历",
    });
  }
  run.elapsedMs = performance.now() - started;
  store.saveRun(run);
  return run;
}

const scope = globalThis as typeof globalThis & {
  signalLedgerTask?: Promise<unknown>;
};
/** Fire independently of subscription monitoring and never enqueue notifications. */
export function scheduleSignalLedger(now: number) {
  if (scope.signalLedgerTask) return;
  const config = settings();
  scope.signalLedgerTask = runSignalLedger(
    new SignalLedgerStore(sqlite()),
    localLedgerDependencies(config.tdxRoot, config.calendar),
    now,
  )
    .catch(() => {})
    .finally(() => {
      scope.signalLedgerTask = undefined;
    });
}
