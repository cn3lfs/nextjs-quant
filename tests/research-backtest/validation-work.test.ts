import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { researchCandidates, strategyBuildHash } from "trading-strategies";
import superjson from "superjson";
import { benchmarkBasisLabel } from "~/components/research/benchmark-basis";
import { validationInputSchema } from "~/server/research/validation-model";
import { strategyCenterRouter } from "~/server/api/routers/strategy-center";
import { paperRouter } from "~/server/api/routers/paper";
import { summarizePaper } from "~/server/paper/assessment";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import { PaperRepository } from "~/server/db/paper-repository";
import paperCandidates from "~/server/data/paper-candidates.json";
import {
  replayValidationInput,
  projectToExecutionClock,
  scoreValidationResult,
} from "~/server/research/validation-replay";
import {
  captureValidationInput,
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
import {
  validateFrozenValidationUniverse,
  validationLifecycleEvidence,
  validationMembersAt,
  validationTerminalStatuses,
} from "~/server/research/validation-universe";
import { prepareLabBacktest } from "~/server/research/lab-backtest";
import { combinedBook } from "~/server/research/validation-replay/combined-book";

const network = vi.fn(() => {
  throw new Error("No network in a frozen replay");
});
const terminalArchive = vi.hoisted(() => ({
  bytes: undefined as Buffer | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) =>
      terminalArchive.bytes &&
      typeof path === "string" &&
      path.endsWith("/terminal-status-evidence.json")
        ? Promise.resolve(terminalArchive.bytes)
        : actual.readFile(path, options),
  };
});
afterEach(() => {
  expect(network).toHaveBeenCalledTimes(0);
  terminalArchive.bytes = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function terminalNotices() {
  const notice = {
    lastTradingDate: "2020-06-18",
    suspensionFrom: "2020-06-19",
    suspensionNoticePublishedOn: "2020-06-17",
    suspensionSource: "https://example.com/final-trading-day",
    listingEndsOn: "2020-06-25",
    listingNoticePublishedOn: "2020-06-23",
    listingSource: "https://example.com/listing-termination",
  };
  return Buffer.from(
    JSON.stringify({
      version: "lifecycle-terminal-status-evidence-1",
      events: [
        { ...notice, symbol: "sh600010" },
        { ...notice, symbol: "sh600011" },
        { ...notice, symbol: "sh600012", lastTradingDate: undefined },
      ],
    }),
  );
}

async function writeLocalDay(root: string, symbol: string, dates: string[]) {
  const directory = join(root, "vipdoc", symbol.slice(0, 2), "lday");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(dates.length * 32);
  dates.forEach((date, index) => {
    const offset = index * 32;
    bytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
    for (const [field, price] of [1000, 1100, 900, 1000].entries())
      bytes.writeUInt32LE(price, offset + 4 + field * 4);
    bytes.writeFloatLE(10000, offset + 20);
    bytes.writeUInt32LE(1000, offset + 24);
  });
  await writeFile(join(directory, `${symbol}.day`), bytes);
}

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
  it("fails validation before publishing when the shared raw and signal budget is exhausted", async () => {
    const root = resolve(dataDirectory(), "budget-fixture");
    const actionsDirectory = join(root, "T0002", "hq_cache");
    await mkdir(actionsDirectory, { recursive: true });
    await mkdir(join(root, "vipdoc", "cw"), { recursive: true });
    await writeFile(join(actionsDirectory, "gbbq"), Buffer.alloc(4));
    const symbols = ["sh600010", "sh600011", "sh600012"];
    const dates = fixture().datasets[0]!.dates;
    await Promise.all(
      ["sh000300", ...symbols].map((symbol) =>
        writeLocalDay(root, symbol, dates),
      ),
    );
    const artifacts = join(dataDirectory(), "research-validation");
    await mkdir(artifacts, { recursive: true });
    const before = await readdir(artifacts);
    const maxBars = 6 * dates.length;
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", String(maxBars));
    vi.stubEnv("QUANT_BAR_STORE_MAX_ESTIMATED_BYTES", undefined);
    await expect(
      executeValidationWork({
        type: "strategy-validation",
        root,
        input: {
          market: "cn-equity",
          start: dates[0],
          end: dates.at(-1),
          symbols,
        },
      }),
    ).rejects.toMatchObject({
      code: "BAR_STORE_BUDGET_EXCEEDED",
      diagnostic: {
        symbol: symbols[2],
        period: "day",
        stage: "output",
        retainedBars: 5 * dates.length,
        requestedBars: 2 * dates.length,
        maxBars,
      },
    });
    expect(await readdir(artifacts)).toEqual(before);
  });

  it("freezes delisted stock history while requiring independent final trading-date and close evidence for terminal valuation", async () => {
    vi.stubGlobal("fetch", network);
    const root = resolve(dataDirectory(), "terminal-history-fixture");
    const actionsDirectory = join(root, "T0002", "hq_cache");
    await mkdir(actionsDirectory, { recursive: true });
    await mkdir(join(root, "vipdoc", "cw"), { recursive: true });
    await writeFile(join(actionsDirectory, "gbbq"), Buffer.alloc(4));
    const dates = fixture()
      .datasets[0]!.benchmark.map(({ date }) => date)
      .filter((date) => ![0, 6].includes(new Date(date).getUTCDay()));
    const observed = dates.filter((date) => date <= "2020-06-18");
    const symbols = ["sh600010", "sh600011", "sh600012", "sh600013"];
    await Promise.all([
      writeLocalDay(root, "sh000300", dates),
      writeLocalDay(root, symbols[0]!, [...observed, "2020-06-19"]),
      writeLocalDay(root, symbols[1]!, observed.slice(0, -1)),
      writeLocalDay(
        root,
        symbols[2]!,
        dates.filter((date) => date < "2020-06-25"),
      ),
      writeLocalDay(root, symbols[3]!, dates),
    ]);
    terminalArchive.bytes = terminalNotices();
    const frozen = await captureValidationInput(
      validationInputSchema.parse({
        market: "cn-equity",
        start: "2020-04-01",
        end: "2020-06-26",
        symbols,
      }),
      root,
    );
    expect(frozen.excluded).toEqual([]);
    const dataset = frozen.datasets[0]!;
    expect(dataset).toMatchObject({
      benchmarkBasis: "price-index-ex-dividends",
      benchmarkName: expect.stringContaining("沪深300"),
    });
    expect(dataset.benchmark.at(-1)?.date).toBe("2020-06-26");
    const [verified, missingClose, unknownDay, active] = dataset.instruments;
    expect(verified?.bars.map(({ date }) => date)).toEqual(observed);
    expect(verified?.terminal).toMatchObject({
      date: "2020-06-18",
      valuation: "last-close",
    });
    expect(missingClose?.bars.map(({ date }) => date)).toEqual(
      observed.slice(0, -1),
    );
    expect(missingClose?.terminal).toBeUndefined();
    expect(unknownDay?.bars.at(-1)?.date).toBe("2020-06-24");
    expect(unknownDay?.terminal).toBeUndefined();
    expect(active?.bars.at(-1)?.date).toBe("2020-06-26");
    expect(dataset.sources[0]?.terminalCoverage).toEqual({
      listingEndsOn: "2020-06-25",
      lastTradingDate: "2020-06-18",
      lastObservedDate: "2020-06-18",
      gap: null,
      unavailableFrom: null,
    });
    expect(dataset.sources[1]?.terminalCoverage).toMatchObject({
      lastTradingDate: "2020-06-18",
      lastObservedDate: "2020-06-17",
      unavailableFrom: "2020-06-18",
      gap: expect.stringContaining("Missing observed raw close"),
    });
    expect(dataset.sources[2]?.terminalCoverage).toMatchObject({
      lastTradingDate: null,
      unavailableFrom: "2020-06-25",
    });
    expect(validationMembersAt(frozen.universe!, "2020-06-18")).toContain(
      symbols[0],
    );
    expect(validationMembersAt(frozen.universe!, "2020-06-19")).not.toContain(
      symbols[0],
    );
    expect(validationMembersAt(frozen.universe!, "2020-06-24")).toContain(
      symbols[2],
    );
    expect(validationMembersAt(frozen.universe!, "2020-06-25")).not.toContain(
      symbols[2],
    );
    const requestFor = (symbol: string): PortfolioRequest => ({
      market: "cn-equity",
      initial: 100000,
      start: "2020-06-15",
      end: "2020-06-26",
      calendar: dataset.dates,
      instruments: dataset.instruments,
      strategies: [
        {
          ...frozen.candidateMenu[0]!.strategy,
          sleeve: "swing",
          universe: { kind: "symbols", symbols: [symbol] },
          entry: { kind: "constant", value: true },
          exit: {},
          sizing: { kind: "weight", weight: 0.2 },
        },
      ],
      sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    });
    for (const i of [1, 2]) {
      const symbol = symbols[i]!;
      const request = requestFor(symbol);
      const result = runPortfolio(request);
      expect(result.positions).toContainEqual(
        expect.objectContaining({ symbol }),
      );
      const score = scoreValidationResult(
        result,
        request,
        dataset,
        "lifecycle-2",
      );
      const gap = dataset.sources[i]!.terminalCoverage!;
      expect(score).toMatchObject({
        valuation: {
          status: "blocked",
          positions: [
            {
              symbol,
              sleeve: "swing",
              unavailableFrom: gap.unavailableFrom,
              reason: gap.gap,
            },
          ],
        },
        return: null,
        excess: null,
        drawdown: null,
        riskAdjusted: { sharpe: null, calmar: null, sharpeDifference: null },
        daily: result.equity.map(() => null),
      });
    }
    const verifiedRequest = requestFor(symbols[0]!);
    const verifiedReplay = runPortfolio(verifiedRequest);
    expect(verifiedReplay.terminalValuations).toHaveLength(1);
    expect(
      scoreValidationResult(verifiedReplay, verifiedRequest, dataset).return,
    ).not.toBeNull();
    const early = { ...requestFor(symbols[1]!), end: "2020-06-17" };
    expect(
      scoreValidationResult(runPortfolio(early), early, dataset).return,
    ).not.toBeNull();
    const activeRequest = requestFor(symbols[3]!);
    expect(
      scoreValidationResult(runPortfolio(activeRequest), activeRequest, dataset)
        .return,
    ).not.toBeNull();
    const secondary: PortfolioRequest = {
      ...activeRequest,
      strategies: activeRequest.strategies.map((strategy) => ({
        ...strategy,
        id: "active-low-zone",
        sleeve: "low-zone",
      })),
      sleeves: activeRequest.sleeves.map((sleeve) => ({
        ...sleeve,
        id: "low-zone",
      })),
    };
    const book = combinedBook(
      frozen,
      dataset,
      requestFor(symbols[1]!),
      secondary,
    );
    expect(book.benchmarkBasis).toBe("price-index-ex-dividends");
    for (const variant of book.variants) {
      expect(variant.score.valuation?.status).toBe("blocked");
      expect(variant.sleeveCurves).toBeNull();
      expect(variant.correlation).toBeNull();
      expect(variant.sleeveScores).toHaveLength(2);
      for (const sleeve of variant.sleeveScores)
        expect(sleeve).toMatchObject({
          return: null,
          drawdown: null,
          observed: 0,
          valuation: { status: "blocked" },
        });
    }
    for (const row of book.rows) {
      expect(row).toMatchObject({
        benchmarkBasis: "price-index-ex-dividends",
        status: "research",
        return: null,
        drawdown: null,
      });
      expect(row.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining("terminal-valuation-blocked: sh600011"),
        ]),
      );
    }
    const hash = await writeValidationArtifact("input", frozen);
    expect(validationHash(await readValidationInput(hash))).toBe(hash);
  });
  it("uses publication cutoffs and leaves last trading dates unknown for suspension-only notices", () => {
    const archive = terminalNotices();
    expect(validationTerminalStatuses(archive, "2020-06-16").size).toBe(0);
    expect(
      validationTerminalStatuses(archive, "2020-06-22").get("sh600010"),
    ).toMatchObject({
      lastTrading: { date: "2020-06-18", publishedOn: "2020-06-17" },
      listingEnd: null,
    });
    expect(
      validationTerminalStatuses(archive, "2020-06-26").get("sh600012"),
    ).toMatchObject({
      lastTrading: null,
      listingEnd: { date: "2020-06-25" },
    });
  });
  it("retains financial timing quality and an unknown legacy basis on the combined equity book", async () => {
    const frozen = fixture();
    const symbols = ["sh600000", "sz000001"];
    frozen.input.market = "cn-equity";
    frozen.datasets[0]!.benchmarkName = "沪深300价格指数（不含股息）";
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
      (c) =>
        ["rps-multi", "historical-low", "double-breakout"].includes(c.family),
    );
    const before = await writeValidationArtifact("input", frozen);
    const legacy = await readValidationInput(before);
    const { rows, missing, timingStatus, benchmarkBasis, combinedBooks } =
      replayValidationInput(legacy);
    expect(timingStatus).toBe("drift");
    expect(benchmarkBasis).toBeNull();
    expect(combinedBooks[0]?.benchmarkBasis).toBeNull();
    expect(rows.every((row) => row.benchmarkBasis === null)).toBe(true);
    expect(validationHash(legacy)).toBe(before);
    expect(rows.some((row) => row.id.includes("double-breakout"))).toBe(false);
    expect(missing).toContainEqual(
      expect.objectContaining({
        id: "r2a-cn-equity-double-breakout-atr",
        reason: expect.stringContaining("逐 bar 因果因子"),
      }),
    );
    expect(rows.find((row) => row.level === "strategy")).toMatchObject({
      strategySemanticVersion: "1.0.0",
    });
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
  it("uses cached delisting status only once the Shanghai cutoff reaches its observation time", () => {
    const end = "2020-06-30";
    const record = {
      version: "security-lifecycle-2",
      symbol: "sh600000",
      source: "QA cache",
      evidenceHash: "a".repeat(64),
      listingDate: "2020-06-01",
      delistingDate: "2020-06-15",
      fetchedAt: Date.parse("2020-06-30T15:59:59.999Z"),
    };
    const afterCutoff = {
      ...record,
      symbol: "sz000001",
      fetchedAt: record.fetchedAt + 1,
    };
    const { lifecycle, late } = validationLifecycleEvidence(
      [record, afterCutoff],
      end,
    );
    expect(late).toBe(1);
    expect([...lifecycle.keys()]).toEqual([record.symbol]);
    const member = { ...record, name: record.symbol, local: true };
    const unknown = {
      ...member,
      symbol: afterCutoff.symbol,
      listingDate: null,
      delistingDate: null,
      fetchedAt: null,
      evidenceHash: null,
    };
    const roster = {
      members: [member, unknown],
      lifecycleEvidenceThrough: end,
    };
    expect(() => validateFrozenValidationUniverse(roster, end)).not.toThrow();
    expect(validationMembersAt(roster, "2020-06-12")).toEqual([
      record.symbol,
      unknown.symbol,
    ]);
    expect(validationMembersAt(roster, "2020-06-15")).toEqual([
      record.symbol,
      unknown.symbol,
    ]);
    expect(validationMembersAt(roster, "2020-06-29")).toContain(record.symbol);
    expect(validationMembersAt(roster, end)).toEqual([unknown.symbol]);
    expect(() =>
      validateFrozenValidationUniverse(
        { ...roster, members: [member, { ...member, ...afterCutoff }] },
        end,
      ),
    ).toThrow("late frozen lifecycle evidence");
    expect(() =>
      validateFrozenValidationUniverse(
        { ...roster, members: [member, member] },
        end,
      ),
    ).toThrow("duplicate frozen roster member");
  });
  it("rejects vendor forward prices for an absolute-price formula before loading bars", async () => {
    const base = researchCandidates(["sh600000"], "cn-equity")[0]!.strategy;
    const read = vi.fn();
    await expect(
      prepareLabBacktest(
        {
          type: "lab-backtest",
          input: {
            source: "thsdk",
            strategy: {
              ...base,
              entry: { kind: "formula", source: "选股:C>8;" },
            },
            start: "2020-06-01",
            end: "2020-06-30",
            initial: 100000,
          },
        },
        undefined,
        read,
      ),
    ).rejects.toThrow("同花顺仅提供区间前复权");
    expect(read).not.toHaveBeenCalled();
  });
  it("propagates the caller's abort reason during frozen validation", async () => {
    const frozen = fixture();
    frozen.candidateMenu = frozen.candidateMenu.filter(
      (candidate) =>
        candidate.family === "dual-ma-day" && candidate.variant === "atr",
    );
    frozen.validationBuildHash = validationBuildHash();
    const hash = await writeValidationArtifact("input", frozen);
    const controller = new AbortController();
    const reason = new DOMException("Window replay cancelled", "AbortError");
    await expect(
      executeValidationWork(
        { type: "strategy-validation", root: "", input: {}, frozenHash: hash },
        (_n, phase) => {
          if (phase.startsWith("验证 ")) controller.abort(reason);
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
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
    ).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("cancelled"),
    });
    expect(validationScoreboardPage({ market: "crypto" }).metadata).toBeNull();
  });
  it("preserves a declared total-return basis through the frozen report, CLI result and scoreboard API", async () => {
    const frozen = fixture();
    frozen.datasets[0]!.benchmarkBasis = "total-return";
    frozen.candidateMenu = frozen.candidateMenu.filter(
      (candidate) =>
        candidate.family === "dual-ma-day" && candidate.variant === "atr",
    );
    const inputHash = await writeValidationArtifact("input", frozen);
    expect(
      (await readValidationInput(inputHash)).datasets[0]!.benchmarkBasis,
    ).toBe("total-return");
    const result = await executeValidationWork({
      type: "strategy-validation",
      root: "",
      input: {},
      frozenHash: inputHash,
    });
    const archive = JSON.parse(
      await readFile(
        join(
          dataDirectory(),
          "research-validation",
          `report-${result.resultHash}.json`,
        ),
        "utf8",
      ),
    ) as { result: ReturnType<typeof replayValidationInput> };
    expect(archive.result.benchmarkBasis).toBe("total-return");
    expect(archive.result.suites[0]?.benchmarkBasis).toBe("total-return");
    expect(JSON.parse(JSON.stringify(result)).rows[0].benchmarkBasis).toBe(
      "total-return",
    );

    const caller = strategyCenterRouter.createCaller({
      headers: new Headers(),
    });
    const page = await caller.strategyScoreboard({ market: "crypto" });
    const uiRow = superjson.deserialize<typeof page>(superjson.serialize(page))
      .rows[0];
    expect(uiRow?.benchmarkBasis).toBe("total-return");
    expect(benchmarkBasisLabel(uiRow?.benchmarkBasis)).toBe("total-return");
    expect(benchmarkBasisLabel("price-index-ex-dividends")).toBe(
      "价格指数（不含股息）",
    );
    expect(benchmarkBasisLabel(null)).toBe("未知口径");
  });
  it("preserves the paper benchmark basis and return through the account API", async () => {
    const candidate = paperCandidates
      .candidates[0] as unknown as FrozenCandidate;
    const { strategy } = candidate;
    const base = fixture().datasets[0]!.instruments[0]!;
    const bars = base.bars.slice(60, 62);
    const request: PortfolioRequest = {
      market: "cn-equity",
      initial: 1000,
      start: bars[0]!.date,
      end: bars[1]!.date,
      calendar: bars.map((bar) => bar.date),
      instruments: [
        {
          ...base,
          market: "cn-equity",
          symbol: "sh600000",
          bars,
          signalBars: bars,
        },
      ],
      strategies: [strategy],
      sleeves: [
        { id: strategy.sleeve, share: 1, riskPerTrade: 1, maxPositions: 1 },
      ],
    };
    const account: PaperAccount = {
      id: "qa-paper-benchmark",
      market: "cn-equity",
      currency: "CNY",
      sleeve: strategy.sleeve,
      startedAt: Date.parse(request.start),
      initial: request.initial,
      candidates: [candidate],
      mirror: { venue: "off" },
      mirrorRevision: "qa",
      revision: 0,
      lastBar: null,
      lastRun: null,
      error: null,
      summary: null,
    };
    const summary = summarizePaper(
      account,
      {
        request,
        result: runPortfolio(request),
        benchmark: bars,
        decisions: [],
      },
      Date.parse(request.end),
    );
    expect(summary.benchmarkName).toContain("中证800");
    expect(summary.benchmarkReturn).toBeCloseTo(
      bars[1]!.close / bars[0]!.open - 1,
      12,
    );
    expect(new PaperRepository().create({ ...account, summary })).toBe(true);
    const caller = paperRouter.createCaller({ headers: new Headers() });
    const read = await caller.paperAccount(account.id);
    expect(
      superjson.deserialize<typeof read>(superjson.serialize(read)).summary,
    ).toMatchObject({
      benchmarkBasis: "price-index-ex-dividends",
      benchmarkReturn: summary.benchmarkReturn,
    });
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
    const firstRow = result.suites[0]!.suite.rows[0]!;
    expect(firstRow.windows).toHaveLength(4);
    expect(firstRow.windows.every((w) => w.end < firstRow.holdout.start)).toBe(
      true,
    );
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
    expect(score.dailyDates).toBeUndefined();
    expect(score.tradeListHash).toBeUndefined();
    const corrected = scoreValidationResult(
      result,
      request,
      dataset,
      "lifecycle-2",
    );
    expect(corrected.dailyDates).toEqual(
      result.equity.map((point) => point.date),
    );
    expect(corrected.tradeListHash).toMatch(/^[a-f0-9]{64}$/);
    expect(corrected.riskAdjusted?.basis).toContain("zero risk-free");
    expect(corrected.return).toBe(score.return);
    expect(corrected.excess).toBe(score.excess);
    const fill: (typeof result.fills)[number] = {
      orderId: 1,
      strategyId: "base",
      sleeve: "swing",
      symbol: "sh600000",
      side: "buy",
      signalAt: bars[0]!.date,
      date: bars[1]!.date,
      price: 10,
      quantity: 100,
      fee: 5,
      cashAfter: 98995,
      holdingAfter: 100,
    };
    const signature = (execution: typeof fill) =>
      scoreValidationResult(
        { ...result, fills: [execution] },
        request,
        dataset,
        "lifecycle-2",
      ).tradeListHash;
    expect(signature({ ...fill, strategyId: "base-neighbor-entry-90" })).toBe(
      signature(fill),
    );
    expect(signature({ ...fill, fee: 6, cashAfter: 98994 })).not.toBe(
      signature(fill),
    );
    expect(signature({ ...fill, strategyId: "different-strategy" })).not.toBe(
      signature(fill),
    );
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
