import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  financialReplayInput,
  financialReplayTargets,
  financialReplayYearStatus,
  type FinancialReplayInput,
} from "~/lib/financial/financial-replay";
import {
  financialReplayInstrumentReadiness,
  runFinancialReplay,
  type FinancialReplayCore,
} from "~/server/financial/financial-replay-core";
import {
  executeFinancialReplayWork,
  withFinancialReplayHostLock,
  type FinancialReplayWork,
} from "~/server/financial/financial-replay-work";
import { runFinancialReplayJob } from "~/server/financial/financial-replay-host";
import {
  financialReplayCodeHash,
  financialReplayCodeIdentity,
  financialReplayConfig,
  financialReplayPublicationFence,
  financialReplayRequestDirectory,
  financialReplayRequestIdentity,
  financialReplayResultDirectory,
  financialReplayRowMagicComplete,
  financialReplaySourceHash,
  financialReplaySourceIdentity,
  financialReplayYearCache,
  resolveFinancialReplayRun,
  type FinancialReplayAnnualSignal,
  type FinancialReplayFinancialRow,
} from "~/server/financial/financial-replay-source";
import type { FinancialReplayPreparedReady } from "~/server/financial/financial-replay-prepare";
import {
  financialReplayHistory,
  financialReplayResultPath,
  financialReplayTasks,
  readFinancialReplayResult,
  writeFinancialReplayResult,
} from "~/server/financial/financial-replay-store";
import { financialReplayResultIdentity } from "~/server/financial/financial-replay-prepare";
import {
  assertResearchRunActive,
  researchJsonHash,
  ResearchRunAbortedError,
} from "~/server/research/research-run";
import { background, cancelJob } from "~/server/jobs/jobs";
import { readJob } from "~/server/db/jobs";

const roots: string[] = [];
const fixture = new URL(
  "../../../packages/tstdx/tests/fixtures/local/gpcw20260930.dat",
  import.meta.url,
);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(files = 1) {
  const root = await mkdtemp(join(tmpdir(), "quant-financial-replay-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  const calendar = Buffer.alloc(3 * 32);
  [20251231, 20260105, 20261102].forEach((day, index) =>
    calendar.writeUInt32LE(day, index * 32),
  );
  await writeFile(join(root, "vipdoc/sh/lday/sh000001.day"), calendar);
  const body = await readFile(fixture);
  const day = (index: number) =>
    new Date(Date.UTC(2015, 0, 1) + index * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
  for (let index = 0; index < files; index++)
    await writeFile(
      join(
        root,
        "vipdoc/cw",
        index === 0 ? "gpcw20260930.dat" : `gpcw${day(index)}.dat`,
      ),
      body,
    );
  return root;
}
const input = financialReplayInput.parse({
  symbols: ["sh600519"],
  firstYear: 2026,
  lastYear: 2026,
  endDate: "2026-11-02",
  initial: 1000000,
  costScenario: "base",
  preset: "magic-formula",
});

describe("financial replay worker/server boundaries", () => {
  it("runs the annual evidence pass in the worker path and blocks missing annual reports", async () => {
    const root = await setup();
    const result = await runFinancialReplay(input, root);
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("年度财报");
    expect(result.request).toBeUndefined();
    expect(result.readinessByInstrument).toEqual([]);
    expect(result.years[0]).toMatchObject({
      year: 2026,
      asOf: "2025-12-31",
      executeAt: "2026-01-05",
      status: "blocked",
    });
    expect(result.diagnostics.checkedAt).not.toBe("2026-11-02T00:00:00.000Z");
    expect(result.readinessByInstrument).toHaveLength(0);
  });

  it("cancels before progress without publishing a result, then resumes from immutable checkpoints", async () => {
    const root = await setup();
    const plan = await resolveFinancialReplayRun(input, root);
    const work: FinancialReplayWork = {
      type: "financial-replay",
      root,
      input: plan.config.input,
      requestIdentity: financialReplayRequestIdentity(plan.config.input, root),
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeFinancialReplayWork(work, () => {}, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ResearchRunAbortedError);
    expect(await readFinancialReplayResult(plan.identity)).toBeNull();
    const firstJob = await executeFinancialReplayWork(work);
    const first = await readFinancialReplayResult(
      firstJob.reportId.slice("financial-replay-".length),
    );
    expect(first).not.toBeNull();
    await rm(financialReplayResultPath(first!.identity));
    const resumedJob = await executeFinancialReplayWork(work);
    const resumed = await readFinancialReplayResult(
      resumedJob.reportId.slice("financial-replay-".length),
    );
    expect(resumed?.diagnostics).toMatchObject({
      actualCalls: 0,
      restoredCheckpoints: 1,
    });
  });

  it("rejects a stored result whose semantic content no longer matches its hash", async () => {
    const root = await setup();
    const plan = await resolveFinancialReplayRun(input, root);
    const work: FinancialReplayWork = {
      type: "financial-replay",
      root,
      input: plan.config.input,
      requestIdentity: financialReplayRequestIdentity(plan.config.input, root),
    };
    const job = await executeFinancialReplayWork(work);
    const identity = job.reportId.slice("financial-replay-".length);
    const path = financialReplayResultPath(identity);
    const value = JSON.parse(await readFile(path, "utf8")) as {
      blockedReason: string;
    };
    value.blockedReason = "tampered";
    await writeFile(path, JSON.stringify(value));
    await expect(readFinancialReplayResult(identity)).rejects.toThrow(
      "内容哈希不符",
    );
  });

  it("reuses a completed result only for the same source identity and creates a new run after financial files change", async () => {
    const root = await setup();
    const plan = await resolveFinancialReplayRun(input, root);
    const work: FinancialReplayWork = {
      type: "financial-replay",
      root,
      input: plan.config.input,
      requestIdentity: financialReplayRequestIdentity(plan.config.input, root),
    };
    const first = await executeFinancialReplayWork(work);
    const second = await executeFinancialReplayWork(work);
    expect(second.reportId).toBe(first.reportId);
    await copyFile(
      join(root, "vipdoc/cw/gpcw20260930.dat"),
      join(root, "vipdoc/cw/gpcw20250101.dat"),
    );
    const changedPlan = await resolveFinancialReplayRun(input, root);
    expect(changedPlan.identity).not.toBe(plan.identity);
    const changed = await executeFinancialReplayWork({
      ...work,
      requestIdentity: financialReplayRequestIdentity(
        changedPlan.config.input,
        root,
      ),
    });
    expect(changed.reportId).not.toBe(first.reportId);
  });

  it("includes raw market source hashes in the final result identity", () => {
    const base = {
      annualIdentity: "a".repeat(64),
      calendarHash: "b".repeat(64),
      market: [
        {
          symbol: "sh600000",
          sourceHash: "c".repeat(64),
          adjustment: "forward",
          expectedDays: 3,
          presentDays: 3,
          missingDays: 0,
          missingExecutionDates: [],
        },
      ],
      corporateActions: "d".repeat(64),
      targets: [],
      costs: {},
      initial: 1000000,
      start: "2020-12-31",
      end: "2021-01-05",
      strategyId: "financial-replay-magic-annual",
    };
    expect(financialReplayResultIdentity(base)).not.toBe(
      financialReplayResultIdentity({
        ...base,
        market: [{ ...base.market[0]!, sourceHash: "e".repeat(64) }],
      }),
    );
  });

  it("orders three overlapping host lock requests and cancels a waiter without running it", async () => {
    const key = "f".repeat(64);
    const lockPath = join(
      await mkdtemp(join(tmpdir(), "quant-replay-lock-")),
      "run.lock",
    );
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withFinancialReplayHostLock(
      key,
      lockPath,
      new AbortController().signal,
      async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-end");
      },
    );
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    const second = withFinancialReplayHostLock(
      key,
      lockPath,
      new AbortController().signal,
      async () => {
        order.push("second");
      },
    );
    const thirdController = new AbortController();
    let thirdCalled = false;
    const third = withFinancialReplayHostLock(
      key,
      lockPath,
      thirdController.signal,
      async () => {
        thirdCalled = true;
        order.push("third");
      },
    );
    thirdController.abort();
    releaseFirst();
    await expect(third).rejects.toThrow();
    await first;
    await second;
    expect(thirdCalled).toBe(false);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("uses the direct-source marker even when a valid stale worker bundle exists", async () => {
    // The repository contains runtime/worker.cjs and its identity manifest, but
    // this direct TS test must never authenticate edited source with them.
    expect(existsSync(join(process.cwd(), "runtime/worker.cjs"))).toBe(true);
    const identity = financialReplayCodeIdentity();
    expect(identity.mode).toBe("source");
    expect(identity.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.workerSha256).toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), "quant-replay-source-"));
    const path = join(directory, "financial-dependency.ts");
    await writeFile(path, "export const revision = 1;\n");
    const before = financialReplaySourceIdentity([path]);
    await writeFile(path, "export const revision = 2;\n");
    expect(financialReplaySourceIdentity([path])).not.toBe(before);
  });
});

describe("financial replay source publication fences", () => {
  const annualContent = (
    root: string,
    sourceHash: string,
    shareHash: string,
    codeHash: string,
    reportHash: string,
  ) => ({
    version: "financial-theory-year-v1",
    asOf: "2020-12-31",
    executeAt: "2021-01-04",
    poolHash: shareHash,
    researchCodeHash: codeHash,
    calendarHash: shareHash,
    symbols: ["sh600000"],
    rows: [
      {
        symbol: "sh600000",
        result: {
          reportDate: "2020-12-31",
          fScore: { score: 9 },
          magic: {
            matched: true,
            eligible: true,
            enterpriseValue: { value: 100, inputs: [{ value: 100 }] },
            investedCapital: { value: 50, inputs: [{ value: 50 }] },
            ebit: { value: 10 },
            specialProductionAssets: [
              { code: "FN31", value: 0 },
              { code: "FN32", value: 0 },
            ],
          },
        },
        sourceReports: [
          {
            sourceFilename: "gpcw20260930.dat",
            sourceSha256: reportHash,
          },
        ],
      },
    ],
    selections: {
      fScore: { positions: [], cashWeight: 1 },
      magicFormula: { positions: [], cashWeight: 1 },
    },
    issues: [],
    counts: {
      total: 1,
      annualReport: 1,
      fScoreComplete: 1,
      magicEligible: 1,
    },
    warning: "fixture",
    sourceHash,
  });
  it("rejects a fresh annual checkpoint when financial source bytes change before commit", async () => {
    const root = await setup();
    const fixturePath = join(root, "vipdoc/cw/gpcw20260930.dat"),
      before = await readFile(fixturePath),
      sourceHash = await financialReplaySourceHash(root),
      reportHash = createHash("sha256").update(before).digest("hex"),
      codeHash = financialReplayCodeHash(),
      shareHash = "b".repeat(64),
      content = annualContent(
        root,
        sourceHash,
        shareHash,
        codeHash,
        reportHash,
      );
    const signal = {
      ...content,
      hash: researchJsonHash(content),
    } as unknown as FinancialReplayAnnualSignal;
    await writeFile(fixturePath, Buffer.concat([before, Buffer.from([0])]));
    const cache = financialReplayYearCache(
      root,
      "a".repeat(64),
      {},
      {
        poolHash: shareHash,
        calendarHash: shareHash,
        researchCodeHash: codeHash,
        financialSourceHash: sourceHash,
      },
    );
    await expect(
      cache.write(
        2021,
        { asOf: "2020-12-31", executeAt: "2021-01-04" },
        signal,
      ),
    ).rejects.toThrow("财务源文件已更新");
  });

  it("rejects a fresh annual checkpoint with a different frozen input identity", async () => {
    const root = await setup();
    const reportHash = createHash("sha256")
        .update(await readFile(join(root, "vipdoc/cw/gpcw20260930.dat")))
        .digest("hex"),
      sourceHash = await financialReplaySourceHash(root),
      codeHash = financialReplayCodeHash(),
      shareHash = "b".repeat(64),
      content = annualContent(
        root,
        sourceHash,
        shareHash,
        codeHash,
        reportHash,
      );
    const signal = {
      ...content,
      hash: researchJsonHash(content),
    } as unknown as FinancialReplayAnnualSignal;
    const cache = financialReplayYearCache(
      root,
      "c".repeat(64),
      {},
      {
        poolHash: "z".repeat(64),
        calendarHash: shareHash,
        researchCodeHash: codeHash,
        financialSourceHash: sourceHash,
      },
    );
    await expect(
      cache.write(
        2021,
        { asOf: "2020-12-31", executeAt: "2021-01-04" },
        signal,
      ),
    ).rejects.toThrow("年度检查点身份或内容不符");
  });

  it("does not publish a result when cancelled between write and publication", async () => {
    const root = await setup();
    const result = await runFinancialReplay(input, root);
    const controller = new AbortController();
    let calls = 0;
    await expect(
      writeFinancialReplayResult(result, () => {
        calls++;
        if (calls === 2) {
          controller.abort();
          assertResearchRunActive({ signal: controller.signal });
        }
      }),
    ).rejects.toBeInstanceOf(ResearchRunAbortedError);
    expect(await readFinancialReplayResult(result.identity)).toBeNull();
  });

  it("does not publish a result when financial source bytes change before publication", async () => {
    const root = await setup();
    const plan = await resolveFinancialReplayRun(input, root);
    const result = await runFinancialReplay(input, root);
    const fixturePath = join(root, "vipdoc/cw/gpcw20260930.dat"),
      before = await readFile(fixturePath);
    let calls = 0;
    await expect(
      writeFinancialReplayResult(result, async () => {
        calls++;
        if (calls !== 2) return;
        await writeFile(fixturePath, Buffer.concat([before, Buffer.from([0])]));
        await financialReplayPublicationFence(plan, {})();
      }),
    ).rejects.toThrow("财务源文件在结果发布前变化");
    expect(await readFinancialReplayResult(result.identity)).toBeNull();
  });

  it("accepts same-semantic duplicate publication but rejects changed content", async () => {
    const root = await setup();
    const result = await runFinancialReplay(input, root);
    const first = await writeFinancialReplayResult(result);
    const duplicate = JSON.parse(JSON.stringify(result)) as typeof result;
    duplicate.createdAt += 1000;
    duplicate.diagnostics.actualCalls += 1;
    duplicate.diagnostics.restoredCheckpoints += 1;
    duplicate.diagnostics.checkedAt = new Date(Date.now() + 1000).toISOString();
    expect((await writeFinancialReplayResult(duplicate)).createdAt).toBe(
      first.createdAt,
    );
    const changed = JSON.parse(JSON.stringify(result)) as typeof result;
    changed.blockedReason = "different economics";
    await expect(writeFinancialReplayResult(changed)).rejects.toThrow(
      "并发写入的财务回放结果身份或语义内容不一致",
    );
  });
});

describe("financial replay per-instrument readiness", () => {
  const dates = ["2020-12-31", "2021-01-04", "2021-01-05"];
  function prepared(missingDay?: string): FinancialReplayPreparedReady {
    const bars = dates
      .filter((date) => date !== missingDay)
      .map((date) => ({
        date,
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 1000000,
        amount: 10000000,
      }));
    const completeRow: FinancialReplayFinancialRow = {
      symbol: "sh600000",
      result: {
        reportDate: "2020-12-31",
        fScore: { score: 9 },
        magic: {
          matched: true,
          eligible: true,
          enterpriseValue: { value: 100, inputs: [{ value: 100 }] },
          investedCapital: { value: 50, inputs: [{ value: 50 }] },
          ebit: { value: 10 },
          specialProductionAssets: [
            { code: "FN31", value: 0 },
            { code: "FN32", value: 0 },
          ],
        },
      },
      sourceReports: [],
    };
    const missingRow: FinancialReplayFinancialRow = {
      symbol: "sz000001",
      result: {
        reportDate: null,
        fScore: { score: null },
        magic: {
          matched: null,
          eligible: false,
          enterpriseValue: { value: null, inputs: [] },
          investedCapital: { value: null, inputs: [] },
          ebit: { value: null },
          specialProductionAssets: [
            { code: "FN31", value: null },
            { code: "FN32", value: null },
          ],
        },
      },
      sourceReports: [],
    };
    const signal: FinancialReplayAnnualSignal = {
      asOf: "2020-12-31",
      executeAt: "2021-01-04",
      hash: "a".repeat(64),
      counts: {
        total: 2,
        annualReport: 1,
        fScoreComplete: 1,
        magicEligible: 1,
      },
      complete: { annualReport: 1, fScore: 1, magic: 1 },
      selections: {
        fScore: {
          positions: [{ symbol: "sh600000", weight: 0.5 }],
          cashWeight: 0.5,
        },
        magicFormula: {
          positions: [{ symbol: "sh600000", weight: 0.5 }],
          cashWeight: 0.5,
        },
      },
      version: "financial-theory-year-v1",
      poolHash: "b".repeat(64),
      calendarHash: "c".repeat(64),
      researchCodeHash: "d".repeat(64),
      warning: "rule-check-only",
      rows: [completeRow, missingRow],
      issues: [],
    };
    const enriched = [
      {
        ...signal,
        complete: { annualReport: 1, fScore: 1, magic: 1 },
      },
    ];
    const config = financialReplayConfig(
      {
        ...input,
        symbols: ["sh600000", "sz000001"],
        firstYear: 2021,
        lastYear: 2021,
        endDate: "2021-01-05",
      },
      "fixture-root",
      "c".repeat(64),
      "d".repeat(64),
    );
    const request: PortfolioRequest = {
      market: "cn-equity",
      initial: 100000,
      start: dates[0]!,
      end: dates[2]!,
      calendar: dates,
      instruments: ["sh600000", "sz000001"].map((symbol) => ({
        symbol,
        market: "cn-equity" as const,
        bars,
        signalBars: bars,
        execution: {
          minimum: 100,
          step: 100,
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
      })),
      strategies: [
        {
          id: config.strategyId,
          version: 1,
          market: "cn-equity",
          period: "day",
          universe: {
            kind: "symbols",
            symbols: ["sh600000", "sz000001"],
          },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 0.5 },
          sleeve: "annual",
        },
      ],
      sleeves: [{ id: "annual", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      scheduledTargets: financialReplayTargets(
        [signal],
        config.strategyId,
        "magic-formula",
      ),
      costs: {
        version: "cost-experiment-1",
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    };
    return {
      kind: "ready",
      plan: {
        config,
        identity: "e".repeat(64),
        calendar: { days: dates, hash: "c".repeat(64) },
        years: [{ year: 2021, asOf: "2020-12-31", executeAt: "2021-01-04" }],
      },
      annual: {
        signals: [signal],
        enriched,
        statuses: [financialReplayYearStatus(enriched[0]!, "magic-formula")],
        blockedReason: null,
        actualCalls: 1,
        restoredCheckpoints: 0,
        warnings: [],
      },
      request,
      marketCoverage: ["sh600000", "sz000001"].map((symbol) => ({
        symbol,
        expectedDays: 3,
        presentDays: bars.length,
        missingDays: 3 - bars.length,
        missingExecutionDates: [],
        sourceHash: "f".repeat(64),
        adjustment: "forward",
      })),
      expectedCalendar: dates,
      resultIdentity: "1".repeat(64),
      resultDirectory: financialReplayResultDirectory("1".repeat(64)),
    };
  }

  it("feeds the actual instrument and frozen calendar into shared readiness", () => {
    const readiness = financialReplayInstrumentReadiness(
      prepared(),
      0,
      "2026-11-17T10:00:00Z",
    ).readiness;
    expect(readiness.instrument).toBe("sh600000");
    expect(readiness.ruleCheck.status).toBe("checked");
    expect(readiness.dataQualification.status).toBe("partial");
    expect(readiness.dataQualification.series).toHaveLength(1);
    expect(readiness.dataQualification.series[0]).toMatchObject({
      expectedSlots: 3,
      slots: { total: 3, complete: 3, incomplete: 0 },
    });
    expect(readiness.dataQualification.source.adjustmentId).toBe("forward");
    expect(readiness.dataQualification.pointInTime.status).toBe("limited");
  });

  it("keeps a symbol with missing annual facts unqualified even when another symbol is complete", () => {
    const missing = financialReplayInstrumentReadiness(
      prepared(),
      1,
      "2026-11-17T10:00:00Z",
    ).readiness;
    expect(missing.instrument).toBe("sz000001");
    expect(missing.dataQualification.status).toBe("unqualified");
    expect(missing.dataQualification.financial.status).toBe("missing");
    expect(
      missing.dataQualification.financial.missingFacts.map((item) => item.fact),
    ).toEqual(["annual-report:2021", "magic-formula:2021"]);
    const complete = financialReplayInstrumentReadiness(
      prepared(),
      0,
      "2026-11-17T10:00:00Z",
    ).readiness;
    expect(complete.dataQualification.status).toBe("partial");
    expect(complete.dataQualification.financial.status).toBe("complete");
  });

  it("requires exactly two certified-zero special assets for complete magic facts", () => {
    const complete: FinancialReplayFinancialRow = {
      symbol: "sh600000",
      result: {
        reportDate: "2020-12-31",
        fScore: { score: 9 },
        magic: {
          matched: true,
          eligible: true,
          enterpriseValue: { value: 100, inputs: [{ value: 100 }] },
          investedCapital: { value: 50, inputs: [{ value: 50 }] },
          ebit: { value: 10 },
          specialProductionAssets: [
            { code: "FN31", value: 0 },
            { code: "FN32", value: 0 },
          ],
        },
      },
      sourceReports: [],
    };
    expect(financialReplayRowMagicComplete(complete)).toBe(true);
    const positive: FinancialReplayFinancialRow = structuredClone(complete);
    positive.result.magic.specialProductionAssets = [
      { code: "FN31", value: 0 },
      { code: "FN32", value: 500 },
    ];
    expect(financialReplayRowMagicComplete(positive)).toBe(false);
    const unknown: FinancialReplayFinancialRow = structuredClone(complete);
    unknown.result.magic.specialProductionAssets = [
      { code: "FN31", value: null },
      { code: "FN32", value: 0 },
    ];
    expect(financialReplayRowMagicComplete(unknown)).toBe(false);
    const decisive: FinancialReplayFinancialRow = structuredClone(complete);
    decisive.result.magic = {
      ...decisive.result.magic,
      matched: false,
      eligible: false,
      enterpriseValue: { value: null, inputs: [] },
      investedCapital: { value: null, inputs: [] },
      ebit: { value: null },
    };
    expect(financialReplayRowMagicComplete(decisive)).toBe(true);
  });

  it("keeps missing calendar days as explicit null slots", () => {
    const readiness = financialReplayInstrumentReadiness(
      prepared("2021-01-04"),
      0,
      "2026-11-17T10:00:00Z",
    ).readiness;
    expect(readiness.dataQualification.status).toBe("partial");
    expect(readiness.dataQualification.series[0]?.slots.incomplete).toBe(1);
    expect(
      readiness.dataQualification.series[0]?.incomplete[0]?.reason,
    ).toContain("缺此交易日");
  });
});

describe("financial replay real worker cancellation and immediate resume", () => {
  it("cancels the actual financial replay worker after preparation starts and immediately resumes", async () => {
    const root = await setup(2000);
    const requestIdentity = financialReplayRequestIdentity(input, root);
    const work: FinancialReplayWork = {
      type: "financial-replay",
      root,
      input,
      requestIdentity,
    };
    const first = background("research", work, (job, signal) =>
      runFinancialReplayJob(work, job.id, signal),
    );
    await vi.waitFor(
      () => {
        const job = readJob(first.id);
        expect(job?.status).toBe("running");
        expect(job?.phase).toBe("准备财务来源身份");
      },
      { timeout: 30000 },
    );
    const cancelled = cancelJob(first.id);
    expect(cancelled.outcome).toBe("accepted");
    await vi.waitFor(
      () => expect(readJob(first.id)?.status).toBe("cancelled"),
      { timeout: 30000 },
    );
    const second = background("research", work, (job, signal) =>
      runFinancialReplayJob(work, job.id, signal),
    );
    await vi.waitFor(
      () => expect(readJob(second.id)?.status).toBe("completed"),
      { timeout: 120000 },
    );
    expect(readJob(second.id)?.result).toMatchObject({ status: "blocked" });
    const tasks = financialReplayTasks();
    expect(
      tasks.some(
        (task) =>
          task.id === second.id &&
          task.status === "completed" &&
          !!task.reportId &&
          task.input?.symbols[0] === "sh600519",
      ),
    ).toBe(true);
    expect(
      financialReplayHistory().some((item) => item.status === "blocked"),
    ).toBe(true);
    await vi.waitFor(
      async () => {
        const journal = await readFile(
          join(
            financialReplayRequestDirectory(requestIdentity),
            "attempts.jsonl",
          ),
          "utf8",
        );
        expect(journal).toContain('"status":"cancelled"');
        expect(journal).toContain('"errorCode":"cancelled"');
      },
      { timeout: 10000 },
    );
  }, 180000);
});
