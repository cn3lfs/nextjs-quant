import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import { registerPaperCandidates } from "~/server/paper/registration";
import {
  freezeLifecycleCandidateSource,
  readLifecycleCandidateSource,
  type LifecycleCandidateSource,
} from "~/server/research/lifecycle-candidate";
import { forwardDefinitionHash } from "~/server/db/forward-reference-repository";
import { strategyLabDetail } from "~/server/db/strategy-lab";
import { executionCostsSchema } from "trading-strategy-core/costs";
import type { StrategyObjectInput } from "trading-strategies";

it("freezes and registers the actual initial/sleeve/cost policy and resolves a candidate's exact OOS result anchor", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new AlertRepository(db);
    const strategy: StrategyObjectInput = {
      id: "l3-policy-fixture",
      version: 1,
      market: "crypto",
      period: "day",
      universe: { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] },
      entry: { kind: "constant", value: false },
      exit: {},
      sizing: { kind: "equal", positions: 2 },
      sleeve: "swing",
      overlay: { symbolWeight: 0.15 },
    };
    const inputHash = "a".repeat(64),
      resultHash = "b".repeat(64),
      buildHash = "c".repeat(64);
    const row: LifecycleCandidateSource["row"] = {
      id: strategy.id,
      strategyVersion: 1,
      evidenceScope: "candidate",
      evidence: { inputHash, resultHash, buildHash },
      method: "lifecycle-2",
      purpose: "preregistered",
      level: "strategy",
      market: "crypto",
      sleeve: "swing",
      rule: "constant",
      status: "live-candidate",
      return: null,
      excess: null,
      drawdown: null,
      trades: 0,
      oosWindows: 0,
      positiveWindows: 0,
      reasons: [],
      bias: {
        universe: "fixed fixture",
        adjustment: "none",
        financial: "none",
        execution: "fixture only",
      },
    };
    const source: LifecycleCandidateSource = {
      strategy,
      definitionHash: forwardDefinitionHash(strategy),
      row,
      executionPolicy: {
        initial: 1000000,
        sleeves: [
          { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 2 },
        ],
        costs: executionCostsSchema.parse({ commissionBps: 10 }),
      },
      sourceContext: {
        inputHash,
        resultHash,
        buildHash,
        configHash: "d".repeat(64),
        manifestPath: "fixture only",
        sourceKey: "crypto-day",
        universeSymbols: ["BTCUSDT", "ETHUSDT"],
        rawUniverse: {
          symbols: ["BTCUSDT", "ETHUSDT"],
          source: "immutable fixture cross section",
          hash: "1".repeat(64),
        },
      },
    };
    freezeLifecycleCandidateSource(source, repo);
    expect(readLifecycleCandidateSource(strategy, repo)).toEqual(source);
    expect(() =>
      freezeLifecycleCandidateSource(
        {
          ...source,
          sourceContext: {
            ...source.sourceContext,
            resultHash: "e".repeat(64),
          },
        },
        repo,
      ),
    ).toThrow("不能覆盖");
    repo.strategies.saveStrategy(strategy);
    repo.records.save(
      "strategy-qualification",
      `strategy-qualification-${strategy.id}`,
      { status: "live-candidate", reasons: [], inputHash },
    );
    repo.records.save("validation-scoreboard", "validation-scoreboard-crypto", {
      market: "crypto",
      rows: [row],
      inputHash,
      resultHash: "f".repeat(64),
      buildHash,
      createdAt: 1,
      runtimeMs: 1,
      universe: "fixture",
      missing: [],
      gaps: [],
    });
    expect(strategyLabDetail(strategy.id, 1, repo).resultHash).toBe(resultHash);
    const paper = new PaperRepository(db);
    registerPaperCandidates(paper, Date.parse("2026-11-16T00:00:00Z"), {
      cryptoInitial: 12345,
    });
    const account = paper
      .ids()
      .map((id) => paper.account(id)!)
      .find((a) => a.candidates.some((c) => c.strategy.id === strategy.id))!;
    expect(account.initial).toBe(1000000);
    expect(account.candidates[0]!.executionPolicy).toEqual(
      source.executionPolicy,
    );
    expect(account.candidates[0]!.sourceContext?.resultHash).toBe(resultHash);
    expect(account.candidates[0]!.sourceContext?.rawUniverse).toEqual(
      source.sourceContext.rawUniverse,
    );
    expect(account.mirror).toEqual({ venue: "off" });
    expect(
      repo.state<{ active: boolean }>(`shadow:${strategy.id}:1`)?.active,
    ).toBe(false);
  } finally {
    db.close();
  }
});
