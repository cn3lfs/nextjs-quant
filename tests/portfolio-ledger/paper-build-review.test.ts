import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { PaperBuildReviewRepository } from "~/server/db/paper-build-review-repository";
import {
  reviewPaperBuild,
  confirmPaperBuild,
} from "~/server/paper/build-review";
import type {
  PaperAccount,
  PaperState,
  FrozenCandidate,
} from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";

const runtime = vi.hoisted(() => ({
  version: "runtime-execution-1",
  strategyHash: "a".repeat(64),
  engineHash: "b".repeat(64),
  hash: "c".repeat(64),
  workerSha256: "d".repeat(64),
}));
vi.mock("~/server/research/forward-identity", () => ({
  runtimeExecutionIdentity: () => runtime,
}));
const connections: Database.Database[] = [];
beforeEach(() => {
  runtime.engineHash = "b".repeat(64);
});
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
});
function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const paper = new PaperRepository(db),
    repo = new PaperBuildReviewRepository(db);
  const strategy = strategyObjectSchema.parse({
    id: "version-review-fixture",
    version: 1,
    market: "crypto",
    period: "day",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  });
  const bars = ["2026-01-01", "2026-01-02", "2026-01-03"].map((date) => ({
    date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  }));
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 10000,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((bar) => bar.date),
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
          evidence: "fixed QA",
        },
      },
    ],
  };
  const account: PaperAccount = {
    id: "paper:build-review-fixture",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: Date.parse("2026-01-01"),
    initial: 10000,
    candidates: [
      { ...(frozen.candidates[0] as unknown as FrozenCandidate), strategy },
    ],
    mirror: { venue: "off" },
    mirrorRevision: "fixed",
    revision: 0,
    lastBar: bars.at(-1)!.date,
    lastRun: 1,
    summary: null,
    error: null,
  };
  paper.create(account);
  const checkpoint: PaperState & { build: string } = {
    request,
    result: runPortfolio(request),
    benchmark: bars,
    decisions: [],
    build: "prior-reviewed-build",
  };
  paper.saveState(account.id, checkpoint);
  return { db, paper, repo, account, checkpoint };
}
describe("manual paper execution-build review", () => {
  it("review never changes accounting; explicit confirmation changes only build and appends immutable audit", () => {
    const f = fixture(),
      before = f.repo.snapshot(f.account.id);
    const manifest = reviewPaperBuild(f.account.id, f.repo);
    expect(manifest).toMatchObject({
      version: "paper-build-review-1",
      exact: true,
      firstDifference: null,
      strategyHash: runtime.strategyHash,
      engineHash: runtime.engineHash,
      validationHash: runtime.hash,
    });
    expect(f.repo.snapshot(f.account.id).raw).toBe(before.raw);
    expect(() =>
      confirmPaperBuild(
        { manifestHash: manifest.manifestHash, confirmed: false as true },
        f.repo,
      ),
    ).toThrow();
    const applied = confirmPaperBuild(
      { manifestHash: manifest.manifestHash, confirmed: true },
      f.repo,
    );
    expect(applied.financialHistoryChanged).toBe(false);
    const after = f.repo.snapshot(f.account.id);
    expect(after.account).toEqual(before.account);
    expect({ ...after.state, build: before.state.build }).toEqual(before.state);
    expect(JSON.stringify({ ...after.state, build: before.state.build })).toBe(
      before.raw,
    );
    expect(
      f.repo.record(`paper-build-confirmation:${manifest.manifestHash}`),
    ).toMatchObject({
      requestHash: manifest.requestHash,
      resultHash: manifest.resultHash,
    });
    expect(() =>
      confirmPaperBuild(
        { manifestHash: manifest.manifestHash, confirmed: true },
        f.repo,
      ),
    ).toThrow("已变化");
  });
  it("a changed financial result cannot be accepted or overwritten", () => {
    const f = fixture();
    f.checkpoint.result.equity[0]!.equity += 1;
    f.paper.saveState(f.account.id, f.checkpoint);
    const before = f.repo.snapshot(f.account.id).raw,
      manifest = reviewPaperBuild(f.account.id, f.repo);
    expect(manifest.exact).toBe(false);
    expect(manifest.firstDifference!.path).toContain("equity");
    expect(() =>
      confirmPaperBuild(
        { manifestHash: manifest.manifestHash, confirmed: true },
        f.repo,
      ),
    ).toThrow("不完全一致");
    expect(f.repo.snapshot(f.account.id).raw).toBe(before);
  });
  it.each(["revision", "checkpoint", "runtime", "manifest"])(
    "rejects %s changes made after review",
    (field) => {
      const f = fixture(),
        manifest = reviewPaperBuild(f.account.id, f.repo);
      if (field === "revision")
        f.paper.save({ ...f.account, error: "concurrent task" }, 0);
      if (field === "checkpoint") {
        f.checkpoint.decisions.push({
          strategyId: "changed",
          symbol: "BTCUSDT",
          date: "2026-01-02",
          entry: false,
          exit: false,
          stop: null,
          observedAt: 1,
          source: "concurrent",
        });
        f.paper.saveState(f.account.id, f.checkpoint);
      }
      if (field === "runtime") runtime.engineHash = "e".repeat(64);
      if (field === "manifest")
        f.db
          .prepare(
            "UPDATE records SET payload=json_set(payload,'$.revision',5) WHERE id=?",
          )
          .run(`paper-build-review:${manifest.manifestHash}`);
      expect(() =>
        confirmPaperBuild(
          { manifestHash: manifest.manifestHash, confirmed: true },
          f.repo,
        ),
      ).toThrow();
      expect(f.repo.snapshot(f.account.id).state.build).toBe(
        "prior-reviewed-build",
      );
    },
  );
  it("refuses to reformat noncanonical frozen financial bytes during a metadata-only confirmation", () => {
    const f = fixture();
    const raw = JSON.stringify(f.checkpoint, null, 2);
    f.db
      .prepare("UPDATE paper_state SET payload=? WHERE account_id=?")
      .run(raw, f.account.id);
    const manifest = reviewPaperBuild(f.account.id, f.repo);
    expect(manifest.exact).toBe(true);
    expect(() =>
      confirmPaperBuild(
        { manifestHash: manifest.manifestHash, confirmed: true },
        f.repo,
      ),
    ).toThrow("只更新执行版本");
    expect(f.repo.snapshot(f.account.id).raw).toBe(raw);
  });
});
