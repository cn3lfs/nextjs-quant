import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sourceVersion: "v1",
  engineMode: "fail" as "fail" | "success" | "source-change",
  engineCalls: 0,
  srcReads: 0,
  driftSrcAfterFirstRead: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const actualReaddir = actual.readdir as unknown as (
    path: string,
    options?: { recursive?: boolean },
  ) => Promise<string[]>;
  const actualReadFile = actual.readFile as unknown as (
    path: string | URL,
    options?: unknown,
  ) => Promise<Buffer | string>;
  const artifactRoots = new Set([
    "src",
    "packages/quant-backtest/dist",
    "packages/quant-performance/dist",
    "packages/trading-strategies/dist",
    "packages/trading-strategy-core/dist",
    "packages/tstdx/dist",
    "packages/quant-rps/dist",
    "packages/quant-backtest/src",
    "packages/quant-performance/src",
    "packages/trading-strategies/src",
    "packages/trading-strategy-core/src",
    "packages/tstdx/src",
    "packages/quant-rps/src",
  ]);
  const normalize = (path: unknown) => String(path).replaceAll("\\", "/");
  return {
    ...actual,
    readdir: async (path: string, options?: { recursive?: boolean }) => {
      if (artifactRoots.has(normalize(path))) return ["fixture.ts"];
      return actualReaddir(path, options);
    },
    readFile: async (path: string | URL, options?: unknown) => {
      const normalized = normalize(path);
      const isRunner =
        normalized === "src/fixture.ts" ||
        normalized.endsWith("/scripts/theory-study.ts");
      if (isRunner) {
        state.srcReads++;
        if (state.driftSrcAfterFirstRead && state.srcReads > 1)
          return Buffer.from("v2");
        return Buffer.from(state.sourceVersion);
      }
      if (normalized.startsWith("src/") || normalized.startsWith("packages/"))
        return Buffer.from(state.sourceVersion);
      if (
        normalized.includes("lifecycle-20261116/l3/sources/source-") &&
        normalized.endsWith(".json")
      )
        return JSON.stringify({
          identities: {
            classic: {
              normalized: {
                executionSymbols: [
                  "sh600000",
                  "sh600004",
                  "sh600008",
                  "sh600009",
                ],
              },
            },
          },
        });
      return actualReadFile(path, options);
    },
  } as unknown as typeof actual;
});

vi.mock("quant-backtest", () => ({
  runPortfolio: vi.fn(() => {
    state.engineCalls++;
    if (state.engineMode === "fail") throw new Error("engine boom");
    if (state.engineMode === "source-change") state.sourceVersion = "v2";
    return {
      curve: [{ equity: 1_000_000 }],
      fills: [],
      rejections: [],
      positions: [],
      quality: "rule-check-only",
    };
  }),
  createPortfolioPreparation: () => ({}),
  maBaselineBuildHash: "engine-hash",
}));

vi.mock("tstdx/local", () => ({
  parseGbbqFile: () => ({ events: new Map() }),
  adjustmentFactors: () => [],
  applyAdjustmentAtAnchor: (bars: unknown) => bars,
}));

vi.mock("../../src/server/research/corporate-actions", () => ({
  researchCorporateActions: () => [],
  researchExecutionAt: () => ({
    evidence: "fixture",
    minimum: 0.01,
    step: 0.01,
    limitUp: null,
    limitDown: null,
    tradable: true,
  }),
}));

vi.mock("../../src/server/data-sources/binance/public-data-store", () => ({
  readPublicData: async () => ({
    gaps: [],
    rows: [
      {
        bar: {
          date: "2026-11-10",
          open: 10,
          high: 11,
          low: 9,
          close: 10,
          volume: 100,
          amount: 1000,
        },
      },
    ],
    files: [],
  }),
}));

vi.mock("../../src/server/data-sources/gf/gf-calendar", () => ({
  gfCalendarReference: async () => ({
    days: ["2026-11-10"],
    closedDays: [],
    source: "fixture",
    hash: "calendar-fixture",
  }),
}));

vi.mock("../../src/server/research/theory-price-ticks", () => ({
  loadTheoryPriceTicks: async () => ({}),
}));

vi.mock("../../src/server/research/theory-multiperiod-source", () => ({
  loadTheoryMultiperiodSource: async (input: {
    strategy: { market: string };
    start: string;
    end: string;
  }) => ({
    sources: [],
    start: input.start,
    end: input.end,
    calendar: ["2026-11-10"],
    boundary: "fixture",
    instruments: [
      {
        market: input.strategy.market,
        symbol:
          input.strategy.market === "cn-equity" ? "sh600000" : "cxBTCUSDT",
        bars: [
          {
            date: "2026-11-10",
            open: 10,
            high: 11,
            low: 9,
            close: 10,
            volume: 100,
            amount: 1000,
          },
        ],
        signalBars: [
          {
            date: "2026-11-10",
            open: 10,
            high: 11,
            low: 9,
            close: 10,
            volume: 100,
            amount: 1000,
          },
        ],
        execution: () => null,
      },
    ],
  }),
}));

import { runTheoryStudy } from "../../scripts/theory-study";
import { runB2MultiperiodPreparation } from "../../scripts/lib/research/b2-multiperiod-source";
import {
  ResearchCheckpointError,
  ResearchIdentityError,
  researchDigest,
} from "~/server/research/research-run";

const taskRoot = resolve(".test-data/strategy-closure-20261117/runner");
const testRoot = join(taskRoot, `workflow-${process.pid}-${randomUUID()}`);

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

beforeEach(() => {
  state.sourceVersion = "v1";
  state.engineMode = "fail";
  state.engineCalls = 0;
  state.srcReads = 0;
  state.driftSrcAfterFirstRead = false;
});

function uniqueOutput(name: string) {
  return join(testRoot, `${name}-${randomUUID()}`);
}

async function theorySourceFixture() {
  const root = join(testRoot, `source-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const executionSymbols = Array.from(
    { length: 799 },
    (_, index) => `sh${String(600000 + index).padStart(6, "0")}`,
  ).sort();
  const rawBars = [["2020-01-02", 10, 11, 9, 10, 100, 1000]];
  const rawText = JSON.stringify(rawBars);
  const rawCompressed = gzipSync(rawText);
  const rawPath = join(root, "raw.json.gz");
  await writeFile(rawPath, rawCompressed);
  const rosterCompressed = gzipSync(
    JSON.stringify({ symbols: executionSymbols }),
  );
  const rosterPath = join(root, "roster.json.gz");
  await writeFile(rosterPath, rosterCompressed);
  const gbbqBytes = Buffer.from("gbbq-fixture");
  const gbbqPath = join(root, "gbbq.bin");
  await writeFile(gbbqPath, gbbqBytes);
  const source = {
    identities: {
      classic: {
        signalBasis: {
          gbbq: { path: gbbqPath, hash: researchDigest(gbbqBytes) },
          origins: executionSymbols.map((symbol) => ({
            symbol,
            rawSource: {
              path: rawPath,
              hash: researchDigest(rawCompressed),
              decodedContentHash: researchDigest(Buffer.from(rawText)),
            },
            anchor: "2020-01-02",
          })),
        },
        normalized: {
          roster: { path: rosterPath, hash: researchDigest(rosterCompressed) },
          executionSymbols,
        },
      },
      crypto: { root: join(root, "crypto") },
    },
    biasTags: [],
  };
  const sourcePath = join(root, "source.json");
  await writeFile(sourcePath, JSON.stringify(source));
  return sourcePath;
}

function journalEvents(text: string) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
}

describe("research runner workflow negatives", () => {
  it("records an ordinary theory engine failure as a blocked row and blocked journal", async () => {
    state.engineMode = "fail";
    const sourcePath = await theorySourceFixture();
    const output = uniqueOutput("theory-blocked");
    const previousDataDir = process.env.QUANT_DATA_DIR;
    try {
      await runTheoryStudy([
        "--output",
        output,
        "--source",
        sourcePath,
        "--limit",
        "1",
        "--strategies",
        "rsi2",
      ]);
    } finally {
      process.env.QUANT_DATA_DIR = previousDataDir;
    }

    const files = await readdir(output);
    const journalPath = join(
      output,
      files.find((name) => name.startsWith("attempts-"))!,
    );
    const resultsPath = join(
      output,
      files.find((name) => name.startsWith("results-"))!,
    );
    const events = journalEvents(await readFile(journalPath, "utf8"));
    expect(events.filter((entry) => entry.event === "blocked").length).toBe(
      events.filter((entry) => entry.event === "started").length,
    );
    expect(events.some((entry) => entry.event === "completed")).toBe(false);

    const results = JSON.parse(await readFile(resultsPath, "utf8")) as {
      rows: { status: string; reason?: string }[];
    };
    expect(results.rows.length).toBeGreaterThan(0);
    expect(results.rows.every((row) => row.status === "blocked")).toBe(true);
    expect(results.rows[0]?.reason).toContain("engine boom");
  });

  it("aborts before committing a success checkpoint when source identity changes after the engine", async () => {
    state.engineMode = "source-change";
    const sourcePath = await theorySourceFixture();
    const output = uniqueOutput("theory-source-change");
    const previousDataDir = process.env.QUANT_DATA_DIR;
    try {
      await expect(
        runTheoryStudy([
          "--output",
          output,
          "--source",
          sourcePath,
          "--limit",
          "1",
          "--strategies",
          "rsi2",
        ]),
      ).rejects.toBeInstanceOf(ResearchIdentityError);
    } finally {
      process.env.QUANT_DATA_DIR = previousDataDir;
    }

    const files = await readdir(output);
    expect(files.some((name) => name.startsWith("results-"))).toBe(false);
    expect(
      files.some(
        (name) => name.includes("-cn-equity-") || name.includes("-crypto-"),
      ),
    ).toBe(false);
    const journalPath = join(
      output,
      files.find((name) => name.startsWith("attempts-"))!,
    );
    expect(
      journalEvents(await readFile(journalPath, "utf8")).some(
        (entry) => entry.event === "aborted",
      ),
    ).toBe(true);
  });

  it("rejects source drift before resuming a checkpoint without calling the engine", async () => {
    state.driftSrcAfterFirstRead = true;
    const sourcePath = await theorySourceFixture();
    const output = uniqueOutput("theory-resume-drift");
    const previousDataDir = process.env.QUANT_DATA_DIR;
    try {
      await expect(
        runTheoryStudy([
          "--output",
          output,
          "--source",
          sourcePath,
          "--limit",
          "1",
          "--strategies",
          "rsi2",
        ]),
      ).rejects.toBeInstanceOf(ResearchIdentityError);
    } finally {
      process.env.QUANT_DATA_DIR = previousDataDir;
    }
    expect(state.engineCalls).toBe(0);
    const files = await readdir(output);
    expect(files.some((name) => name.startsWith("results-"))).toBe(false);
    expect(
      files.some(
        (name) => name.includes("-cn-equity-") || name.includes("-crypto-"),
      ),
    ).toBe(false);
  });

  it("fails a completed multiperiod summary case with no checkpoint evidence and calls no engine", async () => {
    state.engineMode = "success";
    const output = uniqueOutput("multiperiod-missing");
    const previousDataDir = process.env.QUANT_DATA_DIR;
    process.env.QUANT_DATA_DIR = join(testRoot, "data");
    try {
      const first = await runB2MultiperiodPreparation(false, { output });
      const summaryPath = join(
        output,
        `${first.registrationHash}-summary.json`,
      );
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
        cases: Record<string, unknown>;
      };
      summary.cases["cn-equity-week-day-cost-1"] = {
        status: "completed",
        attempts: 0,
        inputHash: "fixture-input",
        resultHash: "0".repeat(64),
      };
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));

      state.engineCalls = 0;
      await expect(
        runB2MultiperiodPreparation(true, { output }),
      ).rejects.toBeInstanceOf(ResearchCheckpointError);
      expect(state.engineCalls).toBe(0);
    } finally {
      process.env.QUANT_DATA_DIR = previousDataDir;
    }
  });
});
