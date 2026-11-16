import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";
import { AlertEngine } from "~/server/alerts/engine";
import {
  appendShadowSamples,
  assessShadow,
  shadowBarCompletedAt,
  type ShadowRegistration,
  type ShadowSample,
} from "~/server/alerts/shadow";
import { selectShadowCandidates } from "~/server/research/shadow-selection";
import type { ScoreboardRow } from "~/server/research/validation-model";
import type { StrategyObjectInput } from "trading-strategies";
import { ledgerOutcome } from "~/lib/strategy-facts/signal-ledger";
import {
  saveValidationScoreboard,
  validationScoreboardPage,
} from "~/server/db/validation-scoreboard";

const strategy: StrategyObjectInput = {
  id: "shadow-test",
  version: 1,
  market: "crypto",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["BTCUSDT"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
};
const start = Date.parse("2026-11-15T00:00:00Z");
const registration: ShadowRegistration = {
  startedAt: start,
  active: true,
  status: "shadow-candidate",
  sizing: "equal",
  trialSharpes: [
    { value: 0.01, reason: null },
    { value: 0.02, reason: null },
  ],
  neighbors: [
    { id: "n1", excess: 0.1 },
    { id: "n2", excess: 0.2 },
  ],
  completeMarketCycles: 0,
  lowZoneCorroborated: false,
};
function sample(date = "2026-11-15", symbol = "BTCUSDT"): ShadowSample {
  const bar = {
    date,
    open: 10,
    close: 11,
    high: 12,
    low: 9,
    volume: 1000,
    amount: 10000,
  };
  return {
    symbol,
    bar,
    benchmark: bar,
    observedAt: Math.max(start, Date.parse(date)) + 60000,
    completedAt: Date.parse(date),
    source: "fixed-observation",
    entry: true,
    exit: false,
    stop: 8,
    actions: [],
  };
}
describe("shadow prospective observations", () => {
  it("excludes a bar physically closed before registration even when the batch receipt is later", () => {
    const at = Date.parse("2026-11-13T07:06:00Z");
    const completed = shadowBarCompletedAt(
      "cn-equity",
      "day",
      "2026-11-13",
      Date.parse("2026-11-13T07:05:00Z"),
    );
    expect(completed).toBe(Date.parse("2026-11-13T07:00:00Z"));
    const s = {
      ...sample("2026-11-13"),
      completedAt: completed,
      observedAt: at,
    };
    expect(
      appendShadowSamples(
        undefined,
        { ...registration, startedAt: Date.parse("2026-11-13T07:03:00Z") },
        [s],
      ).samples,
    ).toEqual([]);
    expect(
      appendShadowSamples(
        undefined,
        { ...registration, startedAt: Date.parse("2026-11-13T06:59:00Z") },
        [s],
      ).samples,
    ).toHaveLength(1);
    expect(shadowBarCompletedAt("crypto", "day", "2026-11-13", at)).toBe(at);
  });
  it("an ordinary report without the full trial family cannot silently stop an ongoing frozen shadow candidate", () => {
    const repo = new AlertRepository();
    const id = "preserve-shadow-scope";
    repo.strategies.saveStrategy({ ...strategy, id });
    const row: ScoreboardRow = {
      id,
      market: "crypto",
      sleeve: "swing",
      level: "strategy",
      rule: id,
      status: "research",
      return: 0.1,
      excess: 0.05,
      drawdown: 0.2,
      worstDrawdown: 0.2,
      trades: 40,
      oosWindows: 4,
      positiveWindows: 3,
      riskAdjusted: {
        sharpe: 1,
        benchmarkSharpe: 0.5,
        sharpeDifference: 0.5,
        calmar: 1,
        benchmarkCalmar: 0.5,
        calmarDifference: 0.5,
        basis: "fixture",
      },
      bias: {
        universe: "fixture",
        adjustment: "raw",
        financial: "none",
        execution: "fixture",
      },
      reasons: ["multiple-testing-dsr-0.95"],
    };
    const report = {
      market: "crypto" as const,
      inputHash: "fixture",
      resultHash: "fixture",
      buildHash: "fixture",
      rows: [row],
      missing: [],
      createdAt: start,
      runtimeMs: 0,
      universe: "fixture",
      gaps: [],
    };
    repo.saveState(`shadow:${id}:1`, registration);
    saveValidationScoreboard({
      ...report,
      trialSharpes: registration.trialSharpes,
    });
    const original = repo.state(`shadow:${id}:1`);
    saveValidationScoreboard({ ...report, createdAt: start + 1000 });
    expect(repo.state(`shadow:${id}:1`)).toEqual(original);
    expect(
      validationScoreboardPage({ market: "crypto", page: 0 }).rows[0]!.status,
    ).toBe("shadow-candidate");
    saveValidationScoreboard({
      ...report,
      rows: [],
      trialSharpes: registration.trialSharpes,
    });
    expect(repo.state(`shadow:${id}:1`)).toMatchObject({
      active: true,
      startedAt: start,
    });
  });
  it("keeps the first evidence, excludes preregistration bars, and does not backfill missed days", () => {
    const p = appendShadowSamples(undefined, registration, [
      sample("2026-11-14"),
      sample(),
      sample(),
    ]);
    expect(p.samples).toHaveLength(1);
    expect(p.signals).toBe(1);
    expect(p.days).toEqual(["2026-11-15"]);
    const revised = sample();
    revised.bar.close = 999;
    const next = appendShadowSamples(p, registration, [
      revised,
      sample("2026-11-18"),
    ]);
    expect(next.samples[0]!.bar.close).toBe(11);
    expect(next.days).toEqual(["2026-11-15", "2026-11-18"]);
    expect(assessShadow(strategy, registration, next, start)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        "shadow-observations-have-no-portfolio-distribution",
      ]),
      coverage: { observedDays: 2 },
    });
  });
  it("a signal threshold remains coverage only without a portfolio distribution", () => {
    const p = appendShadowSamples(
      undefined,
      registration,
      Array.from({ length: 30 }, (_, i) => sample("2026-11-15", `coin-${i}`)),
    );
    expect(p.signals).toBe(30);
    expect(assessShadow(strategy, registration, p, start)).toMatchObject({
      eligible: false,
      reasons: [
        "shadow-observations-have-no-portfolio-distribution",
        "incomplete-shadow-observation-windows",
      ],
    });
  });
  it("60 observed days never reconstruct portfolio returns or rerun research gates", () => {
    const samples = Array.from({ length: 60 }, (_, i) => {
      const s = sample(
        new Date(start + i * 86400000).toISOString().slice(0, 10),
      );
      s.observedAt = start + (i + 1) * 86400000;
      s.bar = {
        ...s.bar,
        open: 10 + i * 0.1,
        close: 10.05 + i * 0.1,
        high: 10.2 + i * 0.1,
        low: 9.9 + i * 0.1,
      };
      s.benchmark = { ...s.bar };
      return s;
    });
    const p = appendShadowSamples(undefined, registration, samples);
    const result = assessShadow(
      strategy,
      registration,
      p,
      start + 61 * 86400000,
    )!;
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      "shadow-observations-have-no-portfolio-distribution",
    ]);
    expect(result.recommendation).not.toContain("手动开启");
  });
  it("reports unknown rules and capacity without discarding captured coverage", () => {
    const progress = appendShadowSamples(undefined, registration, [
      { ...sample(), entry: null },
    ]);
    progress.paused = true;
    expect(assessShadow(strategy, registration, progress, start)).toMatchObject(
      {
        eligible: false,
        reasons: [
          "shadow-observations-have-no-portfolio-distribution",
          "shadow-observation-capacity-reached",
          "unknown-forward-rule-inputs",
        ],
        coverage: { observedDays: 1, windows: 1 },
      },
    );
    expect(progress.samples[0]!.entry).toBeNull();
  });
  it("a new gap reports the latest short segment instead of recycling an older complete verdict", () => {
    const samples = Array.from({ length: 60 }, (_, i) =>
      sample(new Date(start + i * 86400000).toISOString().slice(0, 10)),
    ).filter((_, i) => i !== 58);
    const progress = appendShadowSamples(undefined, registration, samples);
    const result = assessShadow(
      strategy,
      registration,
      progress,
      start + 61 * 86400000,
    )!;
    expect(result.reasons).toEqual([
      "shadow-observations-have-no-portfolio-distribution",
      "incomplete-shadow-observation-windows",
    ]);
    expect(result.coverage).toMatchObject({
      observedDays: 59,
      assessedDays: 1,
      start: samples.at(-1)!.bar.date,
      end: samples.at(-1)!.bar.date,
      latestObserved: samples.at(-1)!.bar.date,
      windows: 59,
    });
    expect(result.coverage!.gaps).toHaveLength(1);
  });
  it("selects two per market/sleeve in preregistered order and excludes negative return/over50% DD", () => {
    const row = (
      id: string,
      failures: number,
      sharpe: number,
      drawdown = 0.4,
    ): ScoreboardRow => ({
      id,
      market: "crypto",
      sleeve: "swing",
      level: "strategy",
      rule: id,
      status: "research",
      return: 0.1,
      excess: 0,
      drawdown,
      worstDrawdown: drawdown,
      riskAdjusted: {
        sharpe: 1,
        benchmarkSharpe: 0,
        sharpeDifference: sharpe,
        calmar: 1,
        benchmarkCalmar: 0,
        calmarDifference: 1,
        basis: "fixture",
      },
      trades: 31,
      oosWindows: 3,
      positiveWindows: 2,
      bias: {
        universe: "fixture",
        adjustment: "raw",
        financial: "unused",
        execution: "fixture",
      },
      reasons: Array.from({ length: failures }, (_, i) => String(i)),
    });
    const negative = { ...row("negative", 0, 99), return: -0.1 };
    expect(
      selectShadowCandidates([
        row("B", 2, 1),
        row("A", 1, 0.5),
        row("C", 1, 0.6),
        row("bad", 0, 99, 0.50001),
        negative,
      ]).map((r) => r.id),
    ).toEqual(["C", "A"]);
    expect(
      selectShadowCandidates([
        { ...row("passed", 0, 1), status: "live-candidate" },
        row("C", 1, 0.6),
        row("A", 1, 0.5),
      ]).map((r) => r.id),
    ).toEqual(["passed", "C"]);
  });
  it.each([null, 25])(
    "keeps strong shadow signals insufficient without portfolio evidence, with a historical gap at %s",
    (gap) => {
      const samples = Array.from({ length: 240 }, (_, i) => {
        const s = sample(
          new Date(start + i * 86400000).toISOString().slice(0, 10),
        );
        const open = 10 * 1.02 ** i;
        s.bar = {
          ...s.bar,
          open,
          close: open * 1.01,
          high: open * 1.03,
          low: open * 0.99,
        };
        const b = 100 * 0.999 ** i;
        s.benchmark = {
          ...s.bar,
          open: b,
          close: b * 0.999,
          high: b,
          low: b * 0.999,
        };
        s.entry = i % 2 === 0;
        s.exit = i % 2 === 1;
        s.observedAt = start + (i + 1) * 86400000;
        return s;
      });
      const p = appendShadowSamples(
        undefined,
        registration,
        samples.filter((_, i) => i !== gap),
      );
      const result = assessShadow(
        strategy,
        registration,
        p,
        start + 241 * 86400000,
      )!;
      expect(result.reasons).toContain(
        "shadow-observations-have-no-portfolio-distribution",
      );
      expect(result.eligible).toBe(false);
      expect(result.coverage).toMatchObject({
        observedDays: gap === null ? 240 : 239,
        assessedDays: gap === null ? 240 : 214,
      });
      expect(result.coverage!.gaps).toHaveLength(gap === null ? 0 : 1);
      expect(result.coverage!.windows).toBeGreaterThan(0);
      expect(result.recommendation).toBe(
        "证据不足；影子信号计数不代表组合盈亏，资格以同版本纸面前推一致性为准",
      );
      expect(registration.active).toBe(true);
    },
  );
  it("uses the fake clock to force shadow even under live mode, dedupes, settles T+5/10/20, and calls no delivery", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const repo = new AlertRepository(db);
    let now = start + 86400000;
    const deliver = vi.fn();
    const errors = vi.fn();
    const event = {
      strategyId: strategy.id,
      version: 1,
      market: "crypto" as const,
      symbol: "BTCUSDT",
      bar: "2026-11-15",
      type: "entry" as const,
      price: 11,
      sleeve: "swing",
      stop: 8,
      target: null,
      reason: "prospective fixture",
      source: "stub",
    };
    const engine = new AlertEngine({
      clock: { now: () => now },
      repository: repo,
      mode: () => "live",
      leader: () => true,
      calendar: async () => [],
      receipt: async () => false,
      evaluate: async () => ({
        proposals: [
          {
            strategy,
            event,
            completedAt: now,
            windowMs: 300000,
            shadowOnly: true,
          },
        ],
        states: [],
      }),
      deliver,
      outcomes: async () => {},
      error: errors,
    });
    try {
      await engine.tick();
      now += 60000;
      await engine.tick();
      expect(errors).toHaveBeenCalledTimes(0);
      expect(deliver).toHaveBeenCalledTimes(0);
      const history = repo.history({
        market: "crypto",
        page: 0,
        size: 20,
        symbol: "",
        strategyId: "",
      });
      expect(history.total).toBe(1);
      expect(history.items[0]).toMatchObject({
        mode: "shadow",
        status: "shadow",
      });
      const dates = Array.from({ length: 22 }, (_, i) =>
        new Date(start + i * 86400000).toISOString().slice(0, 10),
      );
      const bars = dates.map((date, i) => ({
        date,
        open: 10 + i,
        close: 10.5 + i,
        high: 12 + i,
        low: 9 + i,
        volume: 1,
        amount: 10,
      }));
      const outcomes = ([5, 10, 20] as const).map((h) =>
        ledgerOutcome(
          { observedDate: dates[0]! },
          h,
          bars,
          dates,
          "UTC",
          { dates: [], coverageEnd: dates.at(-1)!, source: "fixture" },
          dates.at(-1)!,
        ),
      );
      repo.outcomes(history.items[0]!.key, outcomes);
      const values = repo.history({
        market: "crypto",
        page: 0,
        size: 20,
        symbol: "",
        strategyId: "",
      }).items[0]!.outcomes;
      expect(values.map((o) => o.horizon)).toEqual([5, 10, 20]);
      expect(values.every((o) => o.settled && o.returnPct !== null)).toBe(true);
      expect(repo.liveStrategies()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
