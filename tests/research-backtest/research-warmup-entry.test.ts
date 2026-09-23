import { expect, it, vi } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchSignals } from "../../src/server/strategies/shared/research-signals";

/**
 * Manager ruling 2026-09-19 (S4): "研究起点之前至少需要 61 根预热日线" no longer
 * rejects a late-listed symbol outright. The event loop now starts at
 * `max(first, warmup)` — the first bar that itself has `warmup` bars of history
 * — so a symbol listed after 1999-08-31 keeps contributing instead of dropping
 * ~80% of the A500 membership out of every backtest.
 *
 * These tests pin the four properties the ruling asked for:
 *   1. early-listed symbols are bit-for-bit unchanged (`start === first`);
 *   2. late-listed symbols enter at exactly the `warmup`-th bar;
 *   3. no event may be observed before `spec.start`;
 *   4. a symbol with no bar at/after `spec.start` still fails loudly rather
 *      than silently producing an empty signal set.
 */

const native = vi.fn(async (): Promise<never> => {
  throw new Error("native must not run");
});

const day = (i: number) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

/** Oscillating series so `rsi-recovery` (RSI6 crossing 30 upward) fires repeatedly. */
const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const close = 100 + 8 * Math.sin(i / 3);
  return {
    date: day(i),
    open: close - 0.2,
    close,
    high: close + 1,
    low: close - 1,
    volume: 10000,
    amount: close * 10000,
  };
});

const specFor = (start: string, end = bars[119]!.date, at = day(80)) =>
  researchSpecSchema.parse({
    strategy: "rsi-recovery",
    symbols: ["sh600000"],
    pool: null,
    start,
    end,
    validationStart: at,
    holdingDays: 5,
    initialCapital: 100000,
    maxPositions: 5,
    entryMaxWait: 3,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });

// The ruling's warmup value for non-ma-cross technical strategies
// (src/server/strategies/shared/research-signals.ts:255-260); rsi-recovery is `signal: "technical"`.
const warmup = 61;

it("窗口内历史不足 warmup 根时从第 warmup 根进入研究，而不是整只拒绝", async () => {
  const spec = specFor(bars[10]!.date);
  expect(bars.filter((bar) => bar.date < spec.start).length).toBe(10);
  const events = await researchSignals("sh600000", bars, spec, native);
  const dates = events.map((event) => event.observedDate);
  expect(dates.every((date) => date >= bars[warmup]!.date)).toBe(true);
  expect(dates.every((date) => date >= spec.start)).toBe(true);
  // 起点前恰好 warmup 根，第 warmup 根（索引 warmup）就是第一根可进入研究的 bar。
  expect(bars.slice(0, warmup).length).toBe(warmup);
  expect(bars[warmup]!.date >= spec.start).toBe(true);
  expect(events.length).toBeGreaterThan(0);
  // 起点由 warmup 决定，不被 `spec.start` 落在哪一根影响：first = 10 与 first = 20
  // 都必须从第 61 根进入，事件逐字节相同（max(first, warmup) 语义）。
  const otherStart = await researchSignals(
    "sh600000",
    bars,
    specFor(bars[20]!.date),
    native,
  );
  expect(otherStart).toEqual(events);
});

it("上市早的证券行为不变：从更早的根进入不会改变同一根之后的事件", async () => {
  // 晚进入（first = 20 < 61 → 起点 61）与早进入（first = 70 → 起点 70）两次运行，
  // 在 `first >= warmup` 的那一段必须逐字节相同 —— 这就是「上市早的证券不变」。
  const lateStart = await researchSignals(
    "sh600000",
    bars,
    specFor(bars[20]!.date),
    native,
  );
  const earlyStart = await researchSignals(
    "sh600000",
    bars,
    specFor(bars[70]!.date),
    native,
  );
  const from = bars[70]!.date;
  expect(earlyStart.every((event) => event.observedDate >= from)).toBe(true);
  expect(lateStart.filter((event) => event.observedDate >= from)).toEqual(
    earlyStart,
  );
  expect(earlyStart.length).toBeGreaterThan(0);
});

it("总历史不足 warmup 根时不产出事件（不是报错，也不是伪造历史）", async () => {
  const short = bars.slice(70);
  const spec = specFor(short[0]!.date, short.at(-1)!.date);
  const events = await researchSignals("sh600000", short, spec, native);
  expect(events).toEqual([]);
});

it("研究窗口内没有任何日线时仍报错，不静默产出空信号", async () => {
  const spec = specFor("2030-01-01", "2030-12-31", "2030-06-03");
  await expect(researchSignals("sh600000", bars, spec, native)).rejects.toThrow(
    "研究窗口内没有可用日线",
  );
});
