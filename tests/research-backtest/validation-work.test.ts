import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { researchCandidates, strategyBuildHash } from "trading-strategies";
import { validationInputSchema } from "~/server/research/validation-model";
import {
  replayValidationInput,
  projectToExecutionClock,
  scoreValidationResult,
} from "~/server/research/validation-replay";
import {
  validationHash,
  researchHistoryBefore,
  type FrozenValidationInput,
  type ValidationDataset,
} from "~/server/research/validation-capture";
import {
  readValidationInput,
  writeValidationArtifact,
} from "~/server/research/validation-artifacts";
import {
  saveValidationScoreboard,
  validationScoreboardPage,
} from "~/server/db/validation-scoreboard";
import { dataDirectory } from "~/server/db";
import { createJob, saveJob, readJob } from "~/server/db/jobs";
import { executeValidationWork } from "~/server/research/validation-work";
import { validationBuildHash } from "~/server/research/validation-identity";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";

const network = vi.fn(() => {
  throw new Error("No network in a frozen replay");
});
afterEach(() => {
  expect(network).toHaveBeenCalledTimes(0);
  vi.unstubAllGlobals();
});
function fixture(): FrozenValidationInput {
  const bars = Array.from({ length: 180 }, (_, i) => {
    const price = 100 + i / 5 + Math.sin(i / 4) * 8;
    return {
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      open: price,
      close: price,
      high: price + 0.5,
      low: price - 0.5,
      volume: 100000,
      amount: 10000000,
    };
  });
  const dates = bars.slice(60).map((b) => b.date);
  return {
    version: "research-validation-input-1",
    root: "QA public spot fixture",
    strategyBuildHash,
    validationBuildHash: "f".repeat(64),
    evidence: {
      universeComplete: false,
      executionVerified: false,
      firstVintageFinancials: false,
    },
    input: validationInputSchema.parse({
      market: "crypto",
      start: dates[0],
      end: dates.at(-1),
      symbols: ["BTCUSDT", "ETHUSDT"],
    }),
    universe: null,
    native: [],
    financials: [],
    lowZones: [],
    rpsAudit: [],
    excluded: [],
    gaps: [],
    selection: "QA fixture, not real results",
    datasets: [
      {
        period: "day",
        benchmark: bars,
        dates,
        benchmarkName: "QA BTC",
        sources: [],
        instruments: ["BTCUSDT", "ETHUSDT"].map((symbol) => ({
          symbol,
          market: "crypto",
          bars,
          signalBars: bars,
          execution: {
            minimum: 0.001,
            step: 0.001,
            tradable: true,
            evidence: "QA",
            limitUp: null,
            limitDown: null,
          },
          external: {},
        })),
      },
    ],
    candidateMenu: researchCandidates(["BTCUSDT", "ETHUSDT"], "crypto"),
  };
}
describe("research validation application boundary", () => {
  it("retains financial timing quality on the combined equity book and the low-zone sleeve", () => {
    const frozen = fixture();
    const symbols = ["sh600000", "sz000001"];
    frozen.input.market = "cn-equity";
    frozen.datasets[0]!.instruments = frozen.datasets[0]!.instruments.map(
      (i, index) => ({
        ...i,
        market: "cn-equity",
        symbol: symbols[index]!,
        execution: {
          minimum: 100,
          step: 100,
          evidence: "QA",
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
        external: {
          rps: i.bars.map((b) => ({
            date: b.date,
            periods: [20, 50, 120],
            values: [20, 50, 120].map(() => ({
              return: 0.1,
              rank: 1,
              rps: 90,
            })),
          })),
        },
      }),
    );
    frozen.candidateMenu = researchCandidates(symbols, "cn-equity").filter(
      (c) => ["rps-multi", "historical-low"].includes(c.family),
    );
    const rows = replayValidationInput(frozen).rows;
    expect(rows.filter((r) => r.level === "market")).toHaveLength(2);
    for (const row of rows.filter(
      (r) =>
        r.level === "market" ||
        (r.level === "sleeve" && r.sleeve === "low-zone"),
    ))
      expect(row.bias.financial).toContain("PIT announcement");
    expect(
      rows.find((r) => r.level === "sleeve" && r.sleeve === "swing")!.bias
        .financial,
    ).toBe("Not used");
  });
  it("does not publish a scoreboard or qualify strategies when cancelled after freezing", async () => {
    vi.stubGlobal("fetch", network);
    const frozen = fixture();
    frozen.validationBuildHash = validationBuildHash();
    const hash = await writeValidationArtifact("input", frozen);
    const job = createJob({
      id: "cancelled-research",
      type: "backtest",
      status: "running",
      progress: 0,
      phase: "QA",
      input: {},
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      executeValidationWork(
        {
          type: "strategy-validation",
          root: "",
          input: {},
          frozenHash: hash,
          jobId: job.id,
        },
        (progress) => {
          if (progress === 40)
            saveJob({ ...readJob(job.id)!, status: "cancelled", updatedAt: 2 });
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(validationScoreboardPage({ market: "crypto" }).metadata).toBeNull();
  });
  it("stops pagination at candle opening without requesting an inverted interval", () => {
    expect(
      researchHistoryBefore("2026-04-17T04:00:00+00:00", "4h", "2026-04-17"),
    ).toBeNull();
    expect(
      researchHistoryBefore("2026-04-17T00:15:00+00:00", "15m", "2026-04-17"),
    ).toBeNull();
    expect(researchHistoryBefore("2026-04-17", "day", "2026-04-17")).toBeNull();
    expect(
      researchHistoryBefore("2026-04-17T08:00:00+00:00", "4h", "2026-04-17"),
    ).toBe("2026-04-17T03:59:59.999Z");
    expect(researchHistoryBefore("2026-04-18", "day", "2026-04-17")).toBe(
      "2026-04-17T23:59:59.999Z",
    );
  });
  it("replays reproducibly, retains statistical gates, and labels unverified free-data evidence", () => {
    vi.stubGlobal("fetch", network);
    const frozen = fixture(),
      before = validationHash(frozen);
    const result = replayValidationInput(frozen);
    expect(replayValidationInput(frozen)).toEqual(result);
    expect(validationHash(frozen)).toBe(before);
    expect(result.rows.filter((r) => r.level === "strategy")).toHaveLength(18);
    expect(result.promoted).toEqual([]);
    expect(result.rows.every((r) => r.status === "research")).toBe(true);
    for (const row of result.rows.filter((r) => r.level === "strategy")) {
      expect(row.biasTags?.map((t) => [t.code, t.severity])).toEqual([
        ["historical-universe-incomplete", "high"],
        ["historical-venue-filters-and-liquidity-unverified", "high"],
      ]);
      expect(row.reasons).not.toContain("historical-universe-incomplete");
      expect(row.reasons).not.toContain(
        "historical-venue-filters-and-liquidity-unverified",
      );
      expect(row.reasons.length).toBeGreaterThan(0);
    }
    // Evidence flags change labels only. They cannot rescue a failing statistical gate.
    const verified = fixture();
    verified.evidence.universeComplete = true;
    verified.evidence.executionVerified = true;
    expect(
      replayValidationInput(verified).rows.map((r) => [
        r.id,
        r.status,
        r.reasons,
      ]),
    ).toEqual(result.rows.map((r) => [r.id, r.status, r.reasons]));
    expect(result.suites[0]!.suite.rows[0]!.windows).toHaveLength(6);
    expect(result.missing.some((r) => r.id.includes("15m"))).toBe(true);
    expect(result.suites[0]!.diagnostics).toHaveProperty("cscv");
    const bad = fixture();
    bad.datasets[0]!.instruments[0]!.signalBars[70]!.close = NaN;
    expect(() => replayValidationInput(bad)).toThrow("Invalid strategy bars");
  });
  it("uses the first segment open for the benchmark, and never zero-fills an absent day", () => {
    const frozen = fixture(),
      dataset = frozen.datasets[0]!;
    const bars = dataset.instruments[0]!.bars.slice(60, 62);
    const request: PortfolioRequest = {
      market: "crypto",
      initial: 1000,
      start: bars[0]!.date,
      end: bars[1]!.date,
      calendar: bars.map((b) => b.date),
      instruments: [{ ...dataset.instruments[0]!, bars, signalBars: bars }],
      strategies: [
        {
          ...frozen.candidateMenu[0]!.strategy,
          entry: { kind: "constant", value: false },
          exit: {},
        },
      ],
      sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    };
    const result = runPortfolio(request);
    const score = scoreValidationResult(result, request, dataset);
    expect(score.return).toBe(0);
    expect(score.excess).toBeCloseTo(-(bars[1]!.close / bars[0]!.open - 1), 12);
    expect(score.riskAdjusted?.benchmarkSharpe).not.toBeNull();
    expect(score.riskAdjusted?.benchmarkCalmar).toBeNull();
    expect(
      scoreValidationResult(result, request, {
        ...dataset,
        benchmark: [bars[0]!],
      }).excess,
    ).toBeNull();
    const missing = scoreValidationResult(result, request, {
      ...dataset,
      benchmark: [bars[0]!],
    });
    expect(missing.riskAdjusted?.sharpeDifference).toBeNull();
    expect(missing.riskAdjusted?.calmarDifference).toBeNull();
  });
  it("projects completed 4h decisions to the common clock without early entry and preserves stop duration", () => {
    const frozen = fixture(),
      original = frozen.datasets[0]!.instruments[0]!;
    const time = (n: number) =>
      new Date(Date.UTC(2020, 0, 1, 0, n * 15)).toISOString();
    const bars = Array.from({ length: 20 }, (_, i) => ({
      ...original.bars[0]!,
      date: time(i + 1),
    }));
    const base: ValidationDataset = {
      period: "15m",
      instruments: [{ ...original, bars, signalBars: bars }],
      benchmark: bars,
      dates: ["2020-01-01"],
      benchmarkName: "QA",
      sources: [],
    };
    const s = {
      ...frozen.candidateMenu.find((c) => c.family === "dual-ma-4h")!.strategy,
      entry: {
        kind: "external" as const,
        id: "native",
        side: "entry" as const,
      },
      exit: { maxBars: 10 },
    };
    const request: PortfolioRequest = {
      market: "crypto",
      initial: 1000,
      start: "2020-01-01",
      end: "2020-01-01",
      calendar: [time(16)],
      strategies: [s],
      sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      instruments: [
        {
          ...original,
          external: {
            signals: [
              {
                id: "native",
                date: time(16),
                availableAt: time(16),
                entry: true,
                exit: false,
              },
            ],
          },
        },
      ],
    };
    const projected = projectToExecutionClock(request, base, 16);
    const signals = projected.instruments[0]!.external!.signals!;
    expect(signals.filter((p) => p.entry).map((p) => p.date)).toEqual([
      time(16),
    ]);
    expect(projected.strategies[0]!.exit.maxBars).toBe(160);
    expect(runPortfolio(projected).fills[0]!.date).toBe(time(17));
  });
  it("detects hash tampering before accepting replay data and preserves server pagination/null sorting", async () => {
    vi.stubGlobal("fetch", network);
    const frozen = fixture(),
      hash = await writeValidationArtifact("input", frozen);
    const file = join(
      dataDirectory(),
      "research-validation",
      `input-${hash}.json`,
    );
    const body = await readFile(file, "utf8");
    await writeFile(
      file,
      body.replace("QA public spot fixture", "QA tampered fixture"),
    );
    await expect(readValidationInput(hash)).rejects.toThrow("hash mismatch");
    const result = replayValidationInput(fixture());
    const rows = Array.from({ length: 45 }, (_, i) => ({
      ...result.rows[0]!,
      id: String(i).padStart(2, "0"),
      excess: i === 44 ? null : i / 100,
    }));
    saveValidationScoreboard({
      market: "crypto",
      inputHash: hash,
      resultHash: hash,
      buildHash: strategyBuildHash,
      rows,
      missing: [],
      createdAt: 1,
      runtimeMs: 1,
      universe: "QA",
      gaps: [],
    });
    expect(
      validationScoreboardPage({
        market: "crypto",
        sort: "excess",
        descending: true,
      }).rows.map((r) => r.id),
    ).toEqual(Array.from({ length: 20 }, (_, i) => String(43 - i)));
    expect(
      validationScoreboardPage({
        market: "crypto",
        sort: "excess",
        descending: true,
        page: 2,
      }).rows.at(-1)!.id,
    ).toBe("44");
    expect(
      validationScoreboardPage({ market: "cn-equity" }).metadata,
    ).toBeNull();
  });
});
