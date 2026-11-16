import { afterEach, expect, it, vi } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import { AlertRepository } from "~/server/db/alert-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import { ForwardReferenceRepository } from "~/server/db/forward-reference-repository";
import {
  saveValidationScoreboard,
  validationScoreboardPage,
} from "~/server/db/validation-scoreboard";
import type { ScoreboardRow } from "~/server/research/validation-model";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";

vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "d".repeat(64),
}));
afterEach(() => vi.useRealTimers());

function fixture(id: string, version = 1) {
  const repo = new AlertRepository();
  const strategy = strategyObjectSchema.parse({
    id,
    version,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  });
  const row: ScoreboardRow = {
    ...(frozen.candidates[0]!.row as ScoreboardRow),
    id,
    strategyVersion: version,
    market: "crypto",
    level: "strategy",
    status: "live-candidate",
    reasons: [],
  };
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`shadow:${id}:${version}`, {
    ...frozen.candidates[0]!.registration,
    startedAt: 1,
    active: true,
  });
  const historical = {
    signals: 500,
    days: 240,
    paused: false,
    assessment: {
      at: 1,
      eligible: true,
      reasons: [],
      recommendation: "OLD SHADOW CAN ENABLE LIVE",
    },
  };
  repo.saveState(`shadow-summary:${id}:${version}`, historical);
  saveValidationScoreboard({
    market: "crypto",
    inputHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    buildHash: "d".repeat(64),
    rows: [row],
    missing: [],
    createdAt: 1,
    runtimeMs: 0,
    universe: "fixture",
    gaps: [],
  });
  return {
    repo,
    strategy,
    historical,
    page: () => validationScoreboardPage({ market: "crypto" }).rows[0]!,
  };
}

it("does not expose a historical shadow pass or backtest pass as current conformance, and preserves its record", () => {
  const f = fixture("shadow-only-scoreboard");
  expect(f.page().forward).toMatchObject({
    verdict: "insufficient",
    eligible: false,
    promoted: false,
  });
  expect(f.page().forward?.reasons).toContain(
    "missing-same-version-forward-conformance",
  );
  expect(f.page().shadow).toMatchObject({ signals: 500, days: 240 });
  expect(f.page().shadow).not.toHaveProperty("assessment");
  expect(JSON.stringify(f.page())).not.toContain("OLD SHADOW");
  expect(f.repo.state(`shadow-summary:${f.strategy.id}:1`)).toEqual(
    f.historical,
  );
});

it.each([true, false])(
  "uses the same-version current paper assessment with backtest AND=%s, and rejects a changed reference",
  (eligible) => {
    vi.useFakeTimers();
    vi.setSystemTime("2025-12-31T00:00:00Z");
    const f = fixture(`current-paper-scoreboard-${eligible}`, 2);
    const references = new ForwardReferenceRepository(f.repo.db);
    const reference = references.freeze({
      strategy: f.strategy,
      distribution: {
        days: [{ date: "2025-01-01", return: 0.01, signals: 1 }],
        tradeReturns: [],
        slippageBps: [],
      },
      inputHash: "a".repeat(64),
      resultHash: "b".repeat(64),
      buildHash: "d".repeat(64),
      initial: 100000,
      sizingPolicyHash: "e".repeat(64),
      backtestPassed: eligible,
      method: "lifecycle-2",
      purpose: "preregistered",
      slippageBasis: "paper-model",
      source: "projector fixture only",
    });
    const account: PaperAccount = {
      id: `paper:${f.strategy.id}`,
      market: "crypto",
      currency: "USDT",
      sleeve: "swing",
      startedAt: Date.parse("2026-01-01T00:00:00Z"),
      initial: 100000,
      candidates: [
        {
          ...frozen.candidates[0],
          strategy: f.strategy,
        } as unknown as FrozenCandidate,
      ],
      mirror: { venue: "off" },
      mirrorRevision: "fixture",
      revision: 0,
      lastBar: "2026-04-30",
      lastRun: null,
      error: null,
      summary: {
        return: 0,
        drawdown: 0,
        trades: 0,
        winRate: null,
        benchmarkReturn: 0,
        signals: 1,
        days: 120,
        assessment: {
          method: "forward-conformance-1",
          verdict: "conforming",
          eligible,
          referenceHash: reference.contentHash,
          recommendation: eligible
            ? "CURRENT PAPER PASS"
            : "CONFORMING SHADOW ONLY",
          reasons: eligible ? [] : ["backtest-gates-not-passed"],
        },
      },
    };
    references.bindPaper(account.id, f.strategy, account.startedAt);
    const paper = new PaperRepository(f.repo.db);
    paper.create(account);
    f.repo.saveState(`promotion:${f.strategy.id}:2`, {
      at: 1,
      inputHash: reference.identity.inputHash,
      reasons: [],
    });
    expect(f.page().forward).toMatchObject({
      verdict: "conforming",
      eligible,
      promoted: eligible,
    });
    expect(f.page().forward?.recommendation).toBe(
      account.summary!.assessment!.recommendation,
    );
    paper.save(
      {
        ...account,
        summary: {
          ...account.summary!,
          assessment: {
            ...account.summary!.assessment!,
            referenceHash: "f".repeat(64),
          },
        },
      },
      0,
    );
    expect(f.page().forward).toMatchObject({
      verdict: "insufficient",
      eligible: false,
      promoted: false,
    });
    expect(f.repo.state(`shadow-summary:${f.strategy.id}:2`)).toEqual(
      f.historical,
    );
  },
);
