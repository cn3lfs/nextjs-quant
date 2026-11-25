import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  strategyObjectSchema,
  type FrozenChanObservation,
} from "trading-strategies";
import type {
  FinancialReportSnapshot,
  FinancialCell,
} from "tstdx/financial-model";
import type { Bar } from "trading-strategy-core/bars";
import { settingsSchema } from "~/lib/domain";
import { saveSettings } from "~/server/infra/settings";
import gbbq from "../../fixtures/tdx-gbbq.json";
import {
  buildLabDraftFromHandoff,
  customBookId,
  normalizeDiagnoseBookInput,
  buildScanToLabHandoffHref,
  isDiagnosticOnlyStrategyKey,
  labDiagnoseRunInputSchema,
  normalizePortfolioHandoffSymbols,
  ScanToLabHandoffSchema,
  parseScanToLabHandoff,
  DIAGNOSE_SCENARIO_PRESETS,
  DIAGNOSE_CHECK_GROUPS,
  diagnoseTimeHoldoutSchema,
  type LabDiagnoseRunInput,
  type ScanToLabHandoff,
} from "~/lib/research/diagnose-contract";
import {
  listDiagnoseArchives,
  readDiagnoseArchive,
} from "~/server/research/diagnose/archive";
import { runGroupedDiagnoseScenarios } from "~/server/research/diagnose/grouped-run";
import * as diagnoseCell from "~/server/research/diagnose/cell";
import { tradeMarks } from "~/lib/chart/chart-trade-marks";
import type { PrepareDiagnoseRequestInput } from "~/server/research/diagnose/prepare-request";
import { readBars, type BarSeries } from "~/server/market/bar-store/read-bars";
import { readResearchPriceActions } from "~/server/research/causal-price-basis";
import * as lab from "~/server/research/lab-backtest";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";
import { runDiagnose } from "../../../scripts/lib/backtest-diagnose/run";

vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
vi.mock("~/server/market/bar-store/corporate-actions", () => ({
  corporateActions: async () => ({ events: new Map(), fingerprint: "fixture" }),
}));
vi.mock("~/server/research/causal-price-basis", async (original) => ({
  ...(await original<typeof import("~/server/research/causal-price-basis")>()),
  readResearchPriceActions: vi.fn(),
}));
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "test-build",
}));

const symbol = "sh600000";
const start = "2021-03-30",
  end = "2021-04-16";
const config = settingsSchema.parse({ tdxRoot: "D:/diagnose-fixture" });
const scenarios = ["strict", "clamp", "cap-0.5-clip"] as const;
const identity = {
  dllHash: "a".repeat(64),
  apiVersion: 22,
  buildCommit: "fixture",
  configId: "test",
  config: 0,
  anchor: 1,
} as const;
const resolveIdentity = async () => identity;
const input = (strategyKey: string): LabDiagnoseRunInput => ({
  symbols: [symbol],
  strategyKey,
  start,
  end,
  initial: 200_000,
  costScenario: "fixed",
  scenarios: [...scenarios],
  confirmed: true,
});
const temp = () => mkdtemp(join(process.env.QUANT_DATA_DIR!, "diagnose-"));

function marketBars(amount: number, openAtHigh = false) {
  const bars: Bar[] = [];
  for (
    let day = Date.parse("2020-01-01");
    day <= Date.parse(end);
    day += 86_400_000
  ) {
    const current = new Date(day),
      date = current.toISOString().slice(0, 10);
    if ([0, 6].includes(current.getUTCDay()) || date === "2021-04-05") continue;
    const close =
      date === "2021-03-31" ? 104 : date === "2021-04-06" ? 108 : 100;
    bars.push({
      date,
      close,
      open: 100,
      high: Math.max(103.5, close + 1),
      low: 99,
      volume: 1_000_000,
      amount,
      ...(openAtHigh && { high: 100, close: 100 }),
    });
  }
  return bars;
}

function marketFixture(
  amount = 8_000_000,
  repaired = false,
  openAtHigh = false,
) {
  const bars = marketBars(amount, openAtHigh);
  vi.mocked(readBars).mockImplementation(
    async ({ instrument, period }) =>
      ({
        id: instrument.symbol,
        hash: "fixture-bars",
        symbol: instrument.symbol,
        market: "cn-equity",
        period,
        source: "tdx-local",
        requestedSource: "local",
        adjustment: "none",
        createdAt: 0,
        bars,
        rawBars: bars,
        barStore: {
          version: "bar-store-1",
          market: "cn-equity",
          sourceFingerprint: "fixture",
          sourceVersions: ["fixture"],
          adjustment: "none",
          adjustmentReference: "raw",
          priceRepaired: repaired,
          coverage: {
            from: bars[0]!.date,
            to: end,
            count: bars.length,
            historyExhausted: true,
          },
          formingDates: [],
          overlay: null,
          excluded: [],
        },
      }) satisfies BarSeries,
  );
}

async function configureWorkerMarket(symbols = [symbol]) {
  const tdxRoot = await temp();
  const lday = join(tdxRoot, "vipdoc/sh/lday");
  const cache = join(tdxRoot, "T0002/hq_cache");
  await mkdir(lday, { recursive: true });
  await mkdir(cache, { recursive: true });
  await mkdir(join(tdxRoot, "vipdoc/cw"), { recursive: true });
  const rows = marketBars(100_000_000).map((bar) => {
    const row = Buffer.alloc(32);
    row.writeUInt32LE(Number(bar.date.replaceAll("-", "")));
    [bar.open, bar.high, bar.low, bar.close].forEach((price, i) =>
      row.writeUInt32LE(Math.round(price * 100), 4 + 4 * i),
    );
    row.writeFloatLE(bar.amount!, 20);
    row.writeUInt32LE(bar.volume, 24);
    return row;
  });
  const days = Buffer.concat(rows);
  for (const code of [...symbols, "sh000001", "sh000300"]) {
    await writeFile(join(lday, code + ".day"), days);
  }
  await writeFile(join(cache, "gbbq"), Buffer.from(gbbq.gbbqBase64, "base64"));
  saveSettings(settingsSchema.parse({ tdxRoot }));
}

const captureNative = vi.fn<
  NonNullable<PrepareDiagnoseRequestInput["captureNative"]>
>(async (bars, first = 140) => {
  const baselineDate = bars[first - 1]!.date,
    endpointDate = bars[first - 3]!.date;
  const signal = {
    key: endpointDate + ":3",
    endpointIndex: first - 3,
    endpointDate,
    confirmedAt: first,
    confirmedDate: bars[first]!.date,
    centerId: 1,
    center: {
      start: 90,
      end: 100,
      startDate: bars[90]!.date,
      endDate: bars[100]!.date,
      ZD: 70,
      ZG: 80,
      confirmedAt: 104,
      established: 103,
    },
  };
  const observations: FrozenChanObservation[] = bars
    .slice(first - 1)
    .map((bar, offset) => ({
      date: bar.date,
      prefixHash: createHash("sha256")
        .update(JSON.stringify(bars.slice(0, first + offset)))
        .digest("hex"),
      identity,
      baseline: offset === 0,
      projectionVersion: 2,
      points: offset === 1 ? [{ ...signal, kind: 3 }] : [],
      signals: offset === 1 ? [signal] : [],
      gaps: [],
    }));
  return {
    version: "strategy-center-native-2",
    identity,
    originDate: bars[0]!.date,
    baselineDate,
    priceBasis: "forward-cash-dividend-adjusted",
    observations,
    audit: [],
    pending: [],
    boundary: "fixture",
  };
});

function financialField(id: number, value: number): FinancialCell {
  return {
    code: "FN" + id,
    label: "field " + id,
    section: "fixture",
    slot: id - 1,
    raw: value,
    value,
    unit: "fixture",
    rawUnit: "fixture",
    scale: 1,
    timing: "unknown",
    status: "value",
    reason: null,
  };
}

const readFinancialHistory = vi.fn(async () => {
  const reports: FinancialReportSnapshot[] = [2017, 2018, 2019, 2020].map(
    (year, i) => ({
      symbol,
      financialCompany: false,
      reportDate: year + "-12-31",
      announcementDate: year + 1 + "-03-31",
      availableFrom: year + 1 + "-04-01",
      sourceFilename: "gpcw" + year + "1231.dat",
      sourceSha256: "fixture",
      contentSha256: "fixture",
      recordOffset: 0,
      mappingVersion: "fixture",
      fields: [
        financialField(1, 2 * 1.5 ** i),
        financialField(6, i === 3 ? 26 : 19),
        financialField(7, 2.5 * 1.5 ** i),
        financialField(230, [90, 120, 150, 210][i]!),
        financialField(232, [15, 20, 25, 40][i]!),
        financialField(311, [1.5, 2, 2, 3.2][i]!),
      ],
      warnings: [],
    }),
  );
  return { reports, issues: [] };
});
const evidence = { captureNative, resolveIdentity, readFinancialHistory };

beforeEach(() => {
  vi.clearAllMocks();
  marketFixture();
  vi.mocked(readResearchPriceActions).mockResolvedValue({
    events: new Map(),
    issues: [],
    recordCount: 0,
    sourceSha256: "fixture",
  });
});

// Compare every column exported by the CLI, including absent optional fields
// and its explicit false for unclipped fills. The fixtures fit in one sample.
async function expectCsvRows(path: string, rows: readonly object[]) {
  const [header, ...lines] = (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n");
  const keys = header!.split(",");
  const expected = rows.map((row) =>
    keys
      .map((key) => {
        const value = Reflect.get(row, key);
        const text = String(value ?? (key === "capacityClipped" ? false : ""));
        return /[",\r\n]/.test(text)
          ? '"' + text.replaceAll('"', '""') + '"'
          : text;
      })
      .join(","),
  );
  expect(lines).toEqual(expected);
}

it.each([
  { strategyKey: "research-chan", mode: undefined, from: start },
  { strategyKey: "research-canslim-pit", mode: undefined, from: start },
  { strategyKey: "hold", mode: undefined, from: start },
  { strategyKey: "research-chan", mode: "portfolio" as const, from: "auto" },
])(
  "$strategyKey ($mode, $from) replays all three profiles from one snapshot with identical CLI hashes, checks and every exported trade",
  async ({ strategyKey, mode, from }) => {
    const root = await temp();
    const detail = await runGroupedDiagnoseScenarios(
      { ...input(strategyKey), mode, start: from },
      {
        archiveDir: join(root, "archives"),
        config,
        ...evidence,
      },
    );
    expect(vi.mocked(readBars).mock.calls).toHaveLength(2);
    expect(
      vi
        .mocked(readBars)
        .mock.calls.map(([q]) => q.instrument.symbol)
        .sort(),
    ).toEqual(["sh000001", symbol]);
    expect(readResearchPriceActions).toHaveBeenCalledTimes(
      strategyKey === "hold" ? 0 : 1,
    );
    expect(captureNative).toHaveBeenCalledTimes(
      strategyKey === "research-chan" ? 1 : 0,
    );
    expect(readFinancialHistory).toHaveBeenCalledTimes(
      strategyKey === "research-canslim-pit" ? 1 : 0,
    );
    expect(detail.cells[0]!.mode).toBe(mode ?? "per-symbol");
    const metrics = detail.cells[0]!.scenarios;
    expect(metrics.map((row) => row.scenarioId)).toEqual(scenarios);
    for (const [i, scenarioId] of scenarios.entries()) {
      const profile = DIAGNOSE_SCENARIO_PRESETS[scenarioId];
      const outDir = join(root, scenarioId);
      await mkdir(outDir);
      const {
        cells: [cell],
      } = await runDiagnose({
        ...evidence,
        tdxRoot: config.tdxRoot,
        symbols: [symbol],
        strategies: strategyKey === "hold" ? [] : [strategyKey],
        controls: strategyKey === "hold" ? ["hold"] : [],
        mode: mode ?? "per-symbol",
        start: from,
        end,
        initial: 200_000,
        cost: "fixed",
        outDir,
        ...profile,
      });
      const row = metrics[i]!;
      expect(cell?.status, cell?.error).toBe("ok");
      expect(row.status, row.error).toBe("ok");
      expect(row.counts.fills).toBeGreaterThan(0);
      expect(row.counts).toEqual(cell!.counts);
      expect(row.checks).toEqual(cell!.checks);
      expect(row.checks.map((check) => check.id)).toEqual(
        expect.arrayContaining(Object.keys(DIAGNOSE_CHECK_GROUPS)),
      );
      expect(row.rejectionReasons).toEqual(cell!.rejectionReasons);
      const run = JSON.parse(
        await readFile(join(cell!.runPath, "run.json"), "utf8"),
      );
      expect(row.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(detail.cells[0]!.start).toBe(run.start);
      expect(run.mode).toBe(mode ?? "per-symbol");
      expect(run.strategyConfig.sizing).toEqual(
        mode === "portfolio"
          ? { kind: "equal", positions: 1, tranches: 1 }
          : { kind: "weight", weight: 1, tranches: 1 },
      );
      expect(row.inputHash).toBe(run.inputHash);
      await expectCsvRows(join(cell!.runPath, "orders.csv"), row.sampleOrders);
      await expectCsvRows(join(cell!.runPath, "fills.csv"), row.sampleFills);
      await expectCsvRows(
        join(cell!.runPath, "rejections.csv"),
        row.sampleRejections,
      );
    }
    expect(metrics[2]!.counts.capacityClippedFills).toBeGreaterThan(0);
  },
);

it("archives a stop fill from the 51st order and projects its stop marker", async () => {
  const replayCell = diagnoseCell.replayDiagnoseCell;
  const spy = vi
    .spyOn(diagnoseCell, "replayDiagnoseCell")
    .mockImplementationOnce((...args) => {
      const cell = replayCell(...args);
      const ledger = cell.replay.result;
      const order = ledger.orders[0]!;
      const rejected = Array.from({ length: 50 }, (_, i) => ({
        ...order,
        id: i + 1,
        status: "rejected" as const,
        reason: "容量受限",
      }));
      const stop = {
        ...order,
        id: 51,
        side: "sell" as const,
        trigger: "stop" as const,
      };
      ledger.orders = [...rejected, stop];
      ledger.fills = [
        { ...ledger.fills[0]!, side: stop.side, orderId: stop.id },
      ];
      return cell;
    });
  try {
    const { cells } = await runGroupedDiagnoseScenarios(
      { ...input("hold"), scenarios: ["strict"] },
      { archiveDir: await temp(), config },
    );
    const scenario = cells[0]!.scenarios[0]!;
    expect(scenario.sampleOrders).toHaveLength(50);
    expect(scenario.sampleOrders.some((order) => order.id === 51)).toBe(false);
    expect(scenario.sampleFills).toMatchObject([
      { orderId: 51, trigger: "stop" },
    ]);
    expect(
      tradeMarks({
        symbol,
        bars: marketBars(100_000_000),
        period: "day",
        scenario,
      }),
    ).toMatchObject({
      marks: [{ text: "止损" }],
      unknownTriggerCount: 0,
    });
  } finally {
    spy.mockRestore();
  }
});

it("discloses inactive participation when the execution bars lack turnover", async () => {
  marketFixture(0);
  const result = await runGroupedDiagnoseScenarios(input("hold"), {
    archiveDir: await temp(),
    config,
  });
  expect(result.cells[0]!.scenarios[2]).toMatchObject({
    capacityActive: false,
    capacityNote: expect.any(String),
  });
});

it("reads the auto-start portfolio once and preserves strict rejections when clamp can fill", async () => {
  marketFixture(8_000_000, false, true);
  const symbols = [symbol, "sz000001"];
  const result = await runGroupedDiagnoseScenarios(
    {
      ...input("hold"),
      symbols,
      start: "auto",
      scenarios: ["clamp", "strict"],
    },
    { archiveDir: await temp(), config },
  );
  expect(
    vi
      .mocked(readBars)
      .mock.calls.map(([q]) => q.instrument.symbol)
      .sort(),
  ).toEqual(["sh000001", ...symbols]);
  const [cell] = result.cells;
  expect(cell!.mode).toBe("portfolio");
  const [clamp, strict] = cell!.scenarios;
  expect(
    clamp!.counts.fills,
    clamp!.error ?? JSON.stringify(clamp!.rejectionReasons),
  ).toBeGreaterThan(0);
  expect(strict!.counts.fills).toBe(0);
  expect(strict!.counts.rejections).toBeGreaterThan(0);
  const outDir = await temp();
  const {
    cells: [cli],
  } = await runDiagnose({
    symbols,
    mode: "portfolio",
    strategies: [],
    controls: ["hold"],
    start: "auto",
    end,
    initial: 200_000,
    cost: "fixed",
    outDir,
    tdxRoot: config.tdxRoot,
    executionProfile: "strict",
  });
  expect(strict!.rejectionReasons).toEqual(cli!.rejectionReasons);
});

it("cancels after the first replay without publishing an archive", async () => {
  const archiveDir = join(await temp(), "diagnose-archives"),
    controller = new AbortController();
  const original = lab.replayLabBacktest;
  const replay = vi
    .spyOn(lab, "replayLabBacktest")
    .mockImplementationOnce((...args) => {
      const result = original(...args);
      controller.abort(new Error("cancel between scenarios"));
      return result;
    });
  try {
    await expect(
      runGroupedDiagnoseScenarios(input("hold"), {
        archiveDir,
        config,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel between scenarios");
    expect(replay).toHaveBeenCalledTimes(1);
    const published = await readdir(archiveDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    expect(published).toEqual([]);
  } finally {
    replay.mockRestore();
  }
});

it("hides an archive on disk from both readers while its job is running and after cancellation", async () => {
  const { newJob, updateJob, cancelJob } = await import("~/server/jobs/jobs");
  const job = newJob("backtest", { type: "lab-diagnose" });
  const options = { archiveDir: await temp(), source: "lab-archive" as const };
  updateJob(job.id, { status: "running" });
  const {
    summary: { id },
  } = await runGroupedDiagnoseScenarios(input("hold"), {
    ...options,
    config,
    jobId: job.id,
  });
  expect(id).toBe(`lab-${job.id}`);
  expect(await readdir(options.archiveDir)).toContain(id);
  expect(await listDiagnoseArchives(options)).toEqual([]);
  expect(await readDiagnoseArchive(id, options)).toBeNull();
  expect(cancelJob(job.id).status).toBe("cancelled");
  expect(await readdir(options.archiveDir)).toContain(id);
  expect(await listDiagnoseArchives(options)).toEqual([]);
  expect(await readDiagnoseArchive(id, options)).toBeNull();
});

it("routes native Chan and external PIT variants to diagnostics", () => {
  for (const key of [
    "research-chan",
    "research-chan-third",
    "research-canslim-pit",
    "research-canslim-pit-market",
    "research-sepa-pit",
    "research-sepa-pit-tolerant",
    "core-4",
    "research-chan-hold-cash-zd-stop",
    "research-sepa-vcp-close-price",
    "research-sepa-vcp-close-pit",
    "research-wy-sow-lpsy",
    "wy-trend-pullback-confirm-vol10-diagnostic",
  ])
    expect(isDiagnosticOnlyStrategyKey(key)).toBe(true);
  for (const key of ["research-growth", "dual-ma", ""])
    expect(isDiagnosticOnlyStrategyKey(key)).toBe(false);
});

it("discards the staged worker archive when cancelled before the host takes the publish lock", async () => {
  await configureWorkerMarket();
  const archive = await import("~/server/research/diagnose/archive");
  const { strategyLabRouter } =
    await import("~/server/api/routers/strategy-lab");
  const jobs = await import("~/server/jobs/jobs");
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  const run = jobs.runWorker;
  const publish = vi.spyOn(archive, "publishStagedDiagnoseArchive");
  const wrapped = vi
    .spyOn(jobs, "runWorker")
    .mockImplementationOnce(
      async <T>(work: Parameters<typeof run>[0], id?: string) => {
        const result = await run<T>(work, id);
        if (work.type !== "lab-diagnose")
          throw new Error("expected diagnostic worker");
        expect((await readdir(work.stagingDir)).sort()).toEqual([
          "diagnose-group.json",
          "fill-evidence.json",
        ]);
        expect(jobs.cancelJob(work.jobId).outcome).toBe("accepted");
        return result;
      },
    );
  try {
    const job = await caller.strategyLabDiagnoseRun({
      ...input("hold"),
      scenarios: ["strict"],
    });
    await vi.waitFor(
      async () => {
        const result = await caller.strategyLabDiagnoseResult({
          jobId: job.id,
        });
        expect(result.status).toBe("cancelled");
        expect(result.detail).toBeNull();
        expect(
          await readdir(join(process.env.QUANT_DATA_DIR!, "diagnose-archives")),
        ).toEqual([]);
      },
      { timeout: 15_000 },
    );
    expect(wrapped).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    wrapped.mockRestore();
    publish.mockRestore();
  }
});

it("ordinary Lab rejects both repaired prices and unresolved GBBQ records without diagnostic options", async () => {
  const work = {
    type: "lab-backtest" as const,
    input: {
      source: "local" as const,
      strategy: buildStrategy("double-breakout", [symbol], "single"),
      start,
      end,
      initial: 200_000,
      costScenario: "fixed" as const,
    },
  };
  marketFixture(8_000_000, true);
  await expect(
    lab.prepareLabBacktest(work, undefined, undefined, undefined, { config }),
  ).rejects.toThrow("包含修复行情");
  marketFixture();
  vi.mocked(readResearchPriceActions).mockResolvedValue({
    events: new Map(),
    issues: [{ symbol, offset: 12, reason: "invalid event" }],
    recordCount: 1,
    sourceSha256: "fixture",
  });
  await expect(
    lab.prepareLabBacktest(work, undefined, undefined, undefined, { config }),
  ).rejects.toThrow(/GBBQ|因果价格/);
});

async function readVisibleArchive(
  ...args: Parameters<typeof readDiagnoseArchive>
) {
  const detail = await readDiagnoseArchive(...args);
  expect(detail).not.toBeNull();
  return detail!;
}

it("recovers a CLI stop from the full order ledger when only the first 50 orders are displayed", async () => {
  const repoRoot = await temp();
  const dir = join(repoRoot, ".test-data", "late-stop");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ strategyKey: "dual-ma", symbols: [symbol] }),
  );
  const orders = Array.from(
    { length: 50 },
    (_, i) =>
      `${i + 1},dual-ma,main,${symbol},buy,${start},${end},rejected,"容量受限, 已拒绝",1,signal`,
  );
  await writeFile(
    join(dir, "orders.csv"),
    [
      "id,strategyId,sleeve,symbol,side,signalAt,due,status,reason,attempts,trigger",
      ...orders,
      `51,dual-ma,main,${symbol},sell,${start},${end},filled,,1,stop`,
    ].join("\n"),
  );
  await writeFile(
    join(dir, "fills.csv"),
    [
      "orderId,strategyId,sleeve,symbol,side,signalAt,date,price,quantity,fee,cashAfter,holdingAfter",
      `51,dual-ma,main,${symbol},sell,${start},${end},9,100,1,1000,0`,
    ].join("\n"),
  );
  const archive = await readVisibleArchive("cli-late-stop", { repoRoot });
  const scenario = archive.cells[0]!.scenarios[0]!;
  expect(scenario.sampleOrders).toHaveLength(50);
  expect(scenario.sampleOrders.at(-1)?.id).toBe(50);
  expect(scenario.sampleFills).toMatchObject([
    { orderId: 51, trigger: "stop" },
  ]);
});

it("opens a CLI archive with a truncated fill, keeping valid rows and flagging the missing field", async () => {
  const repoRoot = await temp();
  const outDir = join(repoRoot, ".test-data", "partial");
  await mkdir(outDir, { recursive: true });
  const {
    cells: [cell],
  } = await runDiagnose({
    tdxRoot: config.tdxRoot,
    symbols: [symbol],
    strategies: [],
    controls: ["hold"],
    mode: "per-symbol",
    start,
    end,
    initial: 200_000,
    cost: "fixed",
    holdoutStart: "2021-04-08",
    outDir,
  });
  const path = join(cell!.runPath, "fills.csv");
  const [header, fill] = (await readFile(path, "utf8")).trimEnd().split("\n");
  const partial = fill!
    .split(",")
    .slice(0, header!.split(",").indexOf("price"))
    .join(",");
  await writeFile(path, [header, partial, fill].join("\n"));
  const detail = await readVisibleArchive("cli-partial", { repoRoot });
  expect(detail.boundaryState).toBe("missing-files");
  expect(detail.summary.missingFiles).toEqual([
    expect.stringMatching(/fills\.csv$/),
  ]);
  expect(detail.summary.driftWarnings.join(" ")).toMatch(
    /fills\.csv: 第 2 行.*price/,
  );
  const metrics = detail.cells[0]!.scenarios[0]!;
  expect(metrics.timeHoldout).toMatchObject({
    status: "insufficient",
    holdoutStart: "2021-04-08",
  });
  expect(metrics.timeHoldout).toEqual(cell!.timeHoldout);
  expect(metrics.sampleFills).toHaveLength(1);
  expect(metrics.sampleFills[0]!.price).toBeGreaterThan(0);
  expect(metrics.totalFees).toBeNull();
});

it("reads paged CLI cells and persisted Lab boundaries, warns on DLL drift and missing artifacts", async () => {
  const repoRoot = await temp(),
    archiveDir = join(repoRoot, "diagnose-archives");
  const options = { repoRoot, archiveDir, currentDllHash: "b".repeat(64) };
  const outDir = join(repoRoot, ".test-data", "cli-smoke");
  await mkdir(outDir, { recursive: true });
  const { cells } = await runDiagnose({
    ...evidence,
    tdxRoot: config.tdxRoot,
    symbols: [symbol],
    strategies: ["research-chan", "research-canslim-pit"],
    controls: [],
    mode: "per-symbol",
    start,
    end,
    initial: 200_000,
    cost: "fixed",
    outDir,
  });
  const [summary] = await listDiagnoseArchives({
    ...options,
    source: "cli-report",
  });
  expect(summary).toMatchObject({
    source: "cli-report",
    strategyKeys: expect.arrayContaining([
      "research-chan",
      "research-canslim-pit",
    ]),
  });
  const first = await readVisibleArchive(summary!.id, {
    ...options,
    page: 1,
    pageSize: 1,
  });
  const second = await readVisibleArchive(summary!.id, {
    ...options,
    page: 2,
    pageSize: 1,
  });
  expect(first.boundaryState).toBe("ok");
  expect(first.pagination).toEqual({ page: 1, pageSize: 1, totalCells: 2 });
  expect(second.cells[0]!.strategyKey).not.toBe(first.cells[0]!.strategyKey);
  expect(first.summary.driftWarnings.join(" ")).toContain("DLL");
  const cliMetrics = first.cells[0]!.scenarios[0]!;
  expect(cliMetrics.sampleFills.length).toBeGreaterThan(0);
  expect(cliMetrics.sampleFills[0]!.price).toEqual(expect.any(Number));
  expect(cliMetrics.totalFees).toBeGreaterThan(0);
  const fillsFile = join(cells[0]!.runPath, "fills.csv");
  const [header, trade] = (await readFile(fillsFile, "utf8"))
    .trimEnd()
    .split("\n");
  expect(trade).toBeTruthy();
  await writeFile(fillsFile, header + "\n" + (trade + "\n").repeat(40_000));
  const large = await readVisibleArchive(summary!.id, options);
  const capped = large.cells.find((c) => c.strategyKey === cells[0]!.strategy)!
    .scenarios[0]!;
  expect(capped.sampleFills).toHaveLength(50);
  expect(capped.totalFees).toBeNull();
  expect(large.summary.driftWarnings.join(" ")).toContain("fills.csv");
  await rename(
    join(cells[0]!.runPath, "diagnostics.json"),
    join(cells[0]!.runPath, "unavailable.json"),
  );
  const incomplete = await readVisibleArchive(summary!.id, options);
  expect(incomplete.boundaryState).toBe("missing-files");
  expect(incomplete.summary.missingFiles.join(" ")).toContain(
    "diagnostics.json",
  );

  const grouped = await runGroupedDiagnoseScenarios(
    input("research-canslim-pit"),
    {
      archiveDir,
      config,
      readFinancialHistory: async () => ({ reports: [], issues: [] }),
    },
  );
  const zero = await readVisibleArchive(grouped.summary.id, options);
  expect(zero.boundaryState).toBe("zero-signal");
  expect(zero.summary.statusCounts).toEqual({
    ok: 3,
    zeroSignal: 3,
    blocked: 0,
    failed: 0,
  });
  vi.mocked(readBars).mockRejectedValueOnce(new Error("缺少行情"));
  const blocked = await runGroupedDiagnoseScenarios(input("hold"), {
    archiveDir,
    config,
  });
  expect(
    (await readVisibleArchive(blocked.summary.id, options)).boundaryState,
  ).toBe("blocked");
  const listed = await listDiagnoseArchives({
    ...options,
    source: "lab-archive",
    strategyKey: "hold",
    symbol,
  });
  expect(listed.map((report) => report.id)).toEqual([blocked.summary.id]);
});

it.runIf(process.platform === "win32")(
  "rejects CLI archive IDs that differ only in case on Windows",
  async () => {
    const repoRoot = await temp();
    const outDir = join(repoRoot, ".test-data", "Foo");
    await mkdir(outDir, { recursive: true });
    await runDiagnose({
      tdxRoot: config.tdxRoot,
      symbols: [symbol],
      strategies: ["hold"],
      controls: [],
      mode: "per-symbol",
      start,
      end,
      initial: 200_000,
      cost: "fixed",
      outDir,
    });
    expect(
      (await readVisibleArchive("cli-Foo", { repoRoot })).boundaryState,
    ).toBe("ok");
    const { strategyLabRouter } =
      await import("~/server/api/routers/strategy-lab");
    const caller = strategyLabRouter.createCaller({ headers: new Headers() });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    try {
      await expect(
        caller.strategyLabDiagnoseCompare({
          leftId: "cli-Foo",
          rightId: "cli-foo",
        }),
      ).rejects.toThrow("不能将同一份诊断归档与自身对比");
    } finally {
      cwd.mockRestore();
    }
  },
);

it("permits standalone Lab archives only when the database path is absent", async () => {
  const root = await temp();
  const archiveDir = join(root, "diagnose-archives");
  const id = "lab-standalone";
  await mkdir(join(archiveDir, id), { recursive: true });
  vi.stubEnv("QUANT_DATA_DIR", root);
  try {
    expect((await readDiagnoseArchive(id, { archiveDir }))?.boundaryState).toBe(
      "missing-files",
    );
    await mkdir(join(root, "quant.sqlite"));
    await expect(readDiagnoseArchive(id, { archiveDir })).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("retains the CLI core-4 summary's holdout legs, correlations and per-sleeve contributions", async () => {
  const repoRoot = await temp();
  const outDir = join(repoRoot, ".test-data", "book");
  await mkdir(outDir, { recursive: true });
  const {
    cells: [book],
  } = await runDiagnose({
    ...evidence,
    tdxRoot: config.tdxRoot,
    indexBars: marketBars(8_000_000),
    symbols: [symbol],
    mode: "portfolio",
    book: "core-4",
    strategies: [],
    controls: [],
    start: "2021-02-01",
    end,
    holdoutStart: start,
    initial: 200_000,
    cost: "fixed",
    outDir,
  });
  expect(book!.status, book!.error).toBe("ok");
  expect(book!.timeHoldout?.status).toBe("reviewed");
  expect(book!.sleeveAttribution?.sleeves).toHaveLength(4);
  const detail = await readVisibleArchive("cli-book", {
    repoRoot,
    currentDllHash: identity.dllHash,
  });
  const scenario = detail.cells[0]!.scenarios[0]!;
  expect(scenario.timeHoldout).toEqual(book!.timeHoldout);
  const review = scenario.timeHoldout!;
  if (review.status !== "reviewed")
    throw new Error("Expected reviewed holdout");
  const { calmar, benchmarkCalmar, calmarDifference, ...legacy } =
    review.holdout.base;
  expect([calmar, benchmarkCalmar, calmarDifference]).not.toContain(undefined);
  const parseBase = (base: unknown) =>
    diagnoseTimeHoldoutSchema.safeParse({
      ...review,
      holdout: { ...review.holdout, base },
    }).success;
  expect(parseBase(legacy)).toBe(true);
  expect(parseBase({ ...legacy, calmar: Infinity })).toBe(false);
  expect(parseBase({ ...legacy, unknownMetric: 1 })).toBe(false);
  expect(scenario.sleeveAttribution).toEqual(book!.sleeveAttribution);
  expect(scenario.sleeveInvestment).toEqual(book!.sleeveInvestment);
  expect(scenario.sleeveTrades).toEqual(book!.sleeveTrades);
  expect(scenario.sessionEvidence).toEqual(book!.suspensionEvidence);
  const statistics = {
    pbo: null,
    effectiveTrials: 1,
    rawCandidateCount: 2,
    clusters: [["a", "b"]],
    excluded: [],
    dsr: null,
    dsrThreshold: 0.95,
    pboReason: "insufficient-independent-trials",
  };
  // Wave 1 writes a separate comparison for each mode and universe.
  await writeFile(
    join(outDir, "report.json"),
    JSON.stringify({
      comparisons: [
        {
          mode: "portfolio",
          symbols: [symbol],
          familyHoldout: { family: "fixture-exits", statistics },
        },
      ],
    }),
  );
  const familyDetail = await readVisibleArchive("cli-book", {
    repoRoot,
    currentDllHash: identity.dllHash,
  });
  expect(familyDetail.summary.familyHoldout).toEqual({
    ...statistics,
    family: "fixture-exits",
  });
  expect(familyDetail.cells[0]!.scenarios[0]!.familyHoldout).toEqual(
    familyDetail.summary.familyHoldout,
  );

  // Simulate the pre-sidecar group file with no Stage 1 fields or Calmar metrics.
  const archiveDir = join(repoRoot, "lab");
  const id = "lab-legacy";
  const oldScenario = { ...scenario };
  delete oldScenario.sessionEvidence;
  delete oldScenario.sleeveInvestment;
  delete oldScenario.sleeveTrades;
  for (const leg of Object.values(review.holdout)) {
    delete leg.calmar;
    delete leg.benchmarkCalmar;
    delete leg.calmarDifference;
  }
  const oldSummary = { ...detail.summary, id, source: "lab-archive" as const };
  await mkdir(join(archiveDir, id), { recursive: true });
  await writeFile(
    join(archiveDir, id, "diagnose-group.json"),
    JSON.stringify({
      ...detail,
      summary: oldSummary,
      cells: [{ ...detail.cells[0], scenarios: [oldScenario] }],
    }),
  );
  const options = {
    archiveDir,
    source: "lab-archive" as const,
    currentDllHash: identity.dllHash,
  };
  expect(await listDiagnoseArchives(options)).toEqual([oldSummary]);
  const archived = await readVisibleArchive(id, options);
  expect(archived.summary.run).toBeUndefined();
  expect(archived.cells[0]!.scenarios).toEqual([oldScenario]);
});

it("rejects traversal and linked report directories for archive reads and publication", async () => {
  const repoRoot = await temp(),
    archiveDir = join(repoRoot, "lab"),
    cliDir = join(repoRoot, ".test-data"),
    outside = await temp();
  await mkdir(archiveDir);
  await mkdir(cliDir);
  await writeFile(join(outside, "report.md"), "private fixture");
  await symlink(outside, join(archiveDir, "lab-link"), "junction");
  await symlink(outside, join(cliDir, "linked"), "junction");
  for (const id of [
    "lab-../outside",
    "../outside",
    "cli-../outside",
    "lab-link",
    "cli-linked",
  ]) {
    await expect(
      readDiagnoseArchive(id, { archiveDir, repoRoot }),
    ).rejects.toThrow();
  }
  await expect(
    runGroupedDiagnoseScenarios(input("hold"), {
      config,
      archiveDir: join(archiveDir, "lab-link"),
    }),
  ).rejects.toThrow();
  expect(await readdir(outside)).toEqual(["report.md"]);
});

it("round-trips scan provenance and creates a validated editable single-symbol draft at the frozen date", () => {
  const handoff: ScanToLabHandoff = {
    handoffSource: "pattern",
    symbol,
    strategyHint: "research-chan-first",
    frozenDate: end,
    scope: "single-symbol-diagnose",
    label: "一买",
    returnTo: "/scan?view=pattern&symbol=" + symbol,
  };
  const href = buildScanToLabHandoffHref(handoff);
  expect(href).toMatch(/^\/lab\/backtest\?handoff=1&/);
  const search = new URL(href, "https://lab.local").searchParams;
  const result = parseScanToLabHandoff(search);
  expect(result).toMatchObject({ kind: "valid", handoff });
  expect(result).toEqual(
    parseScanToLabHandoff(new URLSearchParams([...search].reverse())),
  );
  expect(parseScanToLabHandoff(new URLSearchParams())).toEqual({
    kind: "none",
  });
  for (const strategyHint of [
    "dual-ma",
    "double-breakout",
    "research-chan",
    "research-chan-first",
    "research-chan-second",
    "research-sepa-pit",
    "formula",
  ] as const) {
    const draft = buildLabDraftFromHandoff({ ...handoff, strategyHint });
    expect(strategyObjectSchema.parse(JSON.parse(draft.strategyJson))).toEqual(
      buildStrategy(strategyHint, [symbol], "single"),
    );
    expect(draft.end).toBe(end);
    expect(draft.start < draft.end).toBe(true);
    expect(draft.scopeNote).toContain("历史证券池");
  }
  for (const returnTo of [
    "https://evil.com",
    "//evil.com",
    "/scan/../admin",
    "/scan?next=https://evil.com",
    "/scanner",
  ]) {
    expect(() => buildScanToLabHandoffHref({ ...handoff, returnTo })).toThrow();
    search.set("returnTo", returnTo);
    expect(parseScanToLabHandoff(search).kind).toBe("invalid");
  }
});

it("preserves portfolio selection order and counts only distinct valid codes beyond the limit", () => {
  const valid = Array.from({ length: 13 }, (_, i) => "sh" + (600000 + i));
  const raw = ["bad", valid[0]!, ...valid, valid[12]!, "SH600519"];
  const normalized = normalizePortfolioHandoffSymbols(raw);
  expect(normalized).toEqual({
    symbols: valid.slice(0, 12),
    droppedInvalidCount: 2,
    truncatedCount: 1,
  });
  expect(normalizePortfolioHandoffSymbols(raw, 2)).toEqual({
    symbols: valid.slice(0, 2),
    droppedInvalidCount: 2,
    truncatedCount: 11,
  });
  const payload = {
    handoffSource: "account-review",
    scope: "portfolio-diagnose",
    symbols: normalized.symbols,
    returnTo: "/accounts/review?month=2021-04",
  } as const;
  const handoff = ScanToLabHandoffSchema.parse(payload);
  expect(handoff.symbol).toBe(valid[0]);
  const query = new URL(buildScanToLabHandoffHref(payload), "https://lab.local")
    .searchParams;
  expect(query.get("symbols")).toBe(normalized.symbols.join(","));
  query.delete("symbol");
  expect(parseScanToLabHandoff(query)).toMatchObject({
    kind: "valid",
    handoff,
  });
  expect(buildLabDraftFromHandoff(handoff).strategy.universe).toEqual({
    kind: "symbols",
    symbols: normalized.symbols,
  });
  expect(
    ScanToLabHandoffSchema.safeParse({ ...payload, returnTo: "/accounts" })
      .success,
  ).toBe(true);
  for (const symbols of [undefined, [], valid, [symbol, symbol], ["sh123"]]) {
    expect(
      ScanToLabHandoffSchema.safeParse({ ...payload, symbols }).success,
    ).toBe(false);
  }
  for (const returnTo of [
    "//accounts",
    "/accounts/../scan",
    "/accounts?next=%252e%252e%252fadmin",
    "/accounts/review?next=//example.com",
    "/accounts?next=javascript:alert(1)",
    "/accounts/reviews",
  ]) {
    query.set("returnTo", returnTo);
    expect(parseScanToLabHandoff(query).kind).toBe("invalid");
  }
});

it("normalizes core-4 and the historical cutoff and rejects contradictory replay windows", () => {
  const run = { ...input("hold"), start: "2020-01-01", end: "2023-12-31" };
  expect(labDiagnoseRunInputSchema.parse(run)).toMatchObject({
    includeHoldout: false,
  });
  const book = {
    ...run,
    strategyKey: undefined,
    bookPreset: "core-4",
    includeHoldout: true,
  };
  expect(labDiagnoseRunInputSchema.parse(book)).toMatchObject({
    strategyKey: "core-4",
    mode: "portfolio",
    holdoutStart: "2023-01-01",
  });
  for (const invalid of [
    { ...book, mode: "per-symbol" },
    { ...book, holdoutStart: run.start },
    { ...book, start: "auto", holdoutStart: "2024-01-01" },
    { ...book, holdoutStart: "2023-02-30" },
  ])
    expect(labDiagnoseRunInputSchema.safeParse(invalid).success).toBe(false);
});

it("validates 2–6 normalized sleeve identifiers, executable strategies and finite positive weights", async () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      strategyKey: "dual-ma",
      share: 1 / n,
    }));
  const valid = (sleeves: ReturnType<typeof make>) =>
    labDiagnoseRunInputSchema.safeParse({
      ...input(""),
      strategyKey: undefined,
      book: { sleeves },
    }).success;
  for (const n of [2, 3, 4, 5, 6]) expect(valid(make(n))).toBe(true);
  const [a, b] = make(2) as [
    ReturnType<typeof make>[number],
    ReturnType<typeof make>[number],
  ];
  for (const invalid of [
    make(1),
    make(7),
    [a, { ...b, id: " s0 " }],
    [a, { ...b, id: "../b" }],
    [a, { ...b, id: " " }],
    [a, { ...b, share: 0.4 }],
    [a, { ...b, share: 0 }],
    [a, { ...b, share: -1 }],
    [a, { ...b, share: Infinity }],
    [a, { ...b, share: NaN }],
    [a, { ...b, strategyKey: "" }],
    [a, { ...b, strategyKey: "unknown" }],
    [a, { ...b, strategyKey: "core-4" }],
  ])
    expect(valid(invalid)).toBe(false);
  const { STRATEGY_KEYS } =
    await import("~/server/research/diagnose/strategy-specs");
  const { studyStrategies } = await import("trading-strategies");
  for (const key of new Set([...STRATEGY_KEYS, ...studyStrategies]))
    expect(valid([a, { ...b, strategyKey: key }]), key).toBe(
      (STRATEGY_KEYS as readonly string[]).includes(key),
    );
  const id = customBookId([a, b]);
  expect(id).toMatch(/^custom-[0-9a-f]{8}$/);
  expect(customBookId([{ ...b, id: " s1 " }, a])).toBe(id);
  expect(customBookId([a, { ...b, strategyKey: "hold" }])).not.toBe(id);
  expect(
    customBookId([
      { ...a, share: 0.4 },
      { ...b, share: 0.6 },
    ]),
  ).not.toBe(id);
  expect(normalizeDiagnoseBookInput("core-4")).toEqual(
    normalizeDiagnoseBookInput({ preset: "core-4" }),
  );
  expect(normalizeDiagnoseBookInput({ sleeves: [b, a] })).toEqual({
    sleeves: [a, b],
  });
});

it.each(["watchlist", "pool"] as const)(
  "retains %s provenance and symbol order through a portfolio link",
  (handoffSource) => {
    const payload = {
      handoffSource,
      scope: "portfolio-diagnose" as const,
      symbols: [symbol, "sz000001"],
    };
    const handoff = ScanToLabHandoffSchema.parse(payload);
    expect(
      parseScanToLabHandoff(
        new URL(buildScanToLabHandoffHref(payload), "https://lab.local")
          .searchParams,
      ),
    ).toMatchObject({ kind: "valid", handoff: { ...payload, symbol } });
    expect(buildLabDraftFromHandoff(handoff).strategy.universe).toEqual({
      kind: "symbols",
      symbols: payload.symbols,
    });
  },
);

it("executes two independent sleeves in the worker and publishes the same parameters and evidence in detail and sidecar", async () => {
  await configureWorkerMarket();
  const { strategyLabRouter } =
    await import("~/server/api/routers/strategy-lab");
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  const sleeves = [
    { id: "first", strategyKey: "hold", share: 0.3 },
    { id: "second", strategyKey: "hold", share: 0.7000000005 },
  ];
  const params = {
    ...input("hold"),
    strategyKey: undefined,
    book: { sleeves },
    start: "auto",
    scenarios: ["strict" as const, "cap-0.5-clip" as const],
  };
  const job = await caller.strategyLabDiagnoseRun(params);
  const result = await vi.waitFor(
    async () => {
      const row = await caller.strategyLabDiagnoseResult({ jobId: job.id });
      expect(row.status, row.error ?? undefined).toBe("completed");
      return row.detail!;
    },
    { timeout: 15_000 },
  );
  const { summary, cells } = result;
  const id = customBookId(sleeves);
  expect(summary.run).toEqual({
    mode: "portfolio",
    symbols: [symbol],
    strategyKey: id,
    strategies: ["hold", "hold"],
    book: { sleeves },
    start: "auto",
    end,
    initial: 200_000,
    costScenario: "fixed",
    scenarios: params.scenarios,
    includeHoldout: false,
  });
  expect(
    labDiagnoseRunInputSchema.parse({ ...summary.run, confirmed: true }),
  ).toEqual(
    labDiagnoseRunInputSchema.parse({
      ...params,
      strategies: ["hold", "hold"],
    }),
  );
  expect(summary.suspensionSummary).toEqual({
    symbolSuspensionDays: 0,
    portfolioAffectedDays: 0,
    unknownDays: 0,
  });
  expect(cells.map((c) => c.strategyKey)).toEqual([id]);
  const sidecar = JSON.parse(
    await readFile(
      join(
        process.env.QUANT_DATA_DIR!,
        "diagnose-archives",
        summary.id,
        "summary.json",
      ),
      "utf8",
    ),
  );
  expect(sidecar.run).toEqual(summary.run);
  expect(sidecar.suspensionSummary).toEqual(summary.suspensionSummary);
  for (const [index, s] of cells[0]!.scenarios.entries()) {
    expect(s.status, s.error).toBe("ok");
    expect(s.sampleFills.map((f) => f.sleeve)).toEqual(["first"]);
    expect(s.sampleOrders).toContainEqual(
      expect.objectContaining({
        sleeve: "second",
        status: "rejected",
        reason: "账户跨分仓单票权重上限",
      }),
    );
    expect(s.sleeveAttribution?.sleeves.map((r) => r.initialEquity)).toEqual([
      expect.closeTo(60_000, 3),
      expect.closeTo(140_000, 3),
    ]);
    expect(s.sleeveInvestment?.sleeves.map((r) => r.id)).toEqual([
      "first",
      "second",
    ]);
    expect(s.sleeveTrades?.sleeves.map((r) => r.id)).toEqual([
      "first",
      "second",
    ]);
    expect(sidecar.sleeveScenarios[index]).toMatchObject({
      scenarioId: s.scenarioId,
      sleeveInvestment: s.sleeveInvestment,
      sleeveTrades: s.sleeveTrades,
    });
  }
  expect(
    await caller.strategyLabDiagnoseArchiveDetail({ id: summary.id }),
  ).toEqual(result);
  expect(
    await caller.strategyLabDiagnoseArchives({
      strategyKey: id,
      source: "lab-archive",
    }),
  ).toContainEqual(summary);
});

it("reads completed Worker archives side by side with the historical holdout and all four sleeves", async () => {
  const symbols = Array.from({ length: 11 }, (_, i) => "sh" + (600000 + i));
  await configureWorkerMarket(symbols);
  const { strategyLabRouter } =
    await import("~/server/api/routers/strategy-lab");
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  const job = await caller.strategyLabDiagnoseRun({
    ...input("hold"),
    symbols,
    mode: "per-symbol",
    scenarios: ["strict"],
  });
  const completed = await vi.waitFor(
    async () => {
      const result = await caller.strategyLabDiagnoseResult({ jobId: job.id });
      expect(result.status, result.error ?? undefined).toBe("completed");
      return result;
    },
    { timeout: 15_000 },
  );
  const id = completed.detail!.summary.id;
  expect(id).toBe(`lab-${job.id}`);
  const { sqlite } = await import("~/server/db");
  expect(sqlite().pragma("user_version", { simple: true })).toBe(25);
  expect(
    completed.detail!.cells[0]!.scenarios[0]!.counts.fills,
  ).toBeGreaterThan(0);
  expect(await caller.strategyLabDiagnoseArchiveDetail({ id })).toEqual(
    completed.detail,
  );
  expect(
    await caller.strategyLabDiagnoseArchives({
      source: "lab-archive",
      strategyKey: "hold",
    }),
  ).toContainEqual(completed.detail!.summary);

  const book = await caller.strategyLabDiagnoseRun({
    ...input("core-4"),
    symbols: symbols.slice(0, 2),
    bookPreset: "core-4",
    start: "2021-02-01",
    includeHoldout: true,
    holdoutStart: start,
  });
  const { closeCzsc } = await import("~/server/strategies/chan/czsc");
  try {
    const result = await vi.waitFor(
      async () => {
        const r = await caller.strategyLabDiagnoseResult({ jobId: book.id });
        expect(r.status, r.error ?? undefined).toBe("completed");
        return r;
      },
      { timeout: 30_000 },
    );
    const right = result.detail!;
    const rightId = right.summary.id;
    expect(right.summary).toMatchObject({
      bookPreset: "core-4",
      holdoutStart: start,
    });
    const cell = right.cells[0]!;
    expect(cell.mode).toBe("portfolio");
    for (const [i, row] of cell.scenarios.entries()) {
      expect(row.status, row.error).toBe("ok");
      expect(row).toMatchObject({
        scenarioId: scenarios[i],
        maxParticipation: i === 2 ? 0.005 : null,
        capacityPolicy: i === 2 ? "clip" : null,
        capacityActive: i === 2,
        timeHoldout: {
          status: "reviewed",
          holdoutStart: start,
          holdout: { base: { trades: expect.any(Number) } },
        },
      });
      expect(row.sleeveAttribution!.sleeves.map((s) => s.id)).toEqual([
        "canslim",
        "chan",
        "ibs",
        "vcp",
      ]);
      expect(row.sleeveAttribution!.correlations).toHaveLength(6);
    }
    const compare = (leftId: string, other = rightId) =>
      caller.strategyLabDiagnoseCompare({ leftId, rightId: other });
    const pair = await compare(id);
    expect(completed.detail!.cells).toHaveLength(10);
    const exported = await caller.strategyLabDiagnoseExport({
      archiveId: id,
      format: "json",
    });
    expect(exported.filename).toBe(`${id}.json`);
    expect(JSON.parse(exported.content)).toEqual({
      ...pair.left,
      allCells: pair.left.cells,
    });
    const markdown = await caller.strategyLabDiagnoseExport({
      archiveId: id,
      format: "markdown",
    });
    expect(markdown.filename).toBe(`${id}.md`);
    expect(markdown.content).toContain("# 回测诊断报告");
    for (const code of symbols) expect(markdown.content).toContain(code);
    for (const unsafe of [
      "lab-../outside",
      "cli-../outside",
      "cli-~Li4vb3V0c2lkZQ",
    ])
      await expect(
        caller.strategyLabDiagnoseExport({ archiveId: unsafe, format: "json" }),
      ).rejects.toThrow();
    expect(pair.left.cells.map((c) => c.symbols[0])).toEqual(symbols);
    expect(pair.right.cells).toEqual(right.cells);
    expect(pair.right.summary).toEqual(right.summary);
    await expect(compare(id, id)).rejects.toThrow("请选择两份不同");
    const incompleteId = "lab-missing-group";
    await mkdir(
      join(process.env.QUANT_DATA_DIR!, "diagnose-archives", incompleteId),
    );
    expect(
      (await caller.strategyLabDiagnoseArchiveDetail({ id: incompleteId }))
        ?.boundaryState,
    ).toBe("missing-files");
    await expect(compare(incompleteId)).rejects.toThrow(
      "左侧诊断归档缺少完整产物",
    );
    await expect(compare(id, incompleteId)).rejects.toThrow(
      "右侧诊断归档缺少完整产物",
    );
    await expect(compare("lab-../outside")).rejects.toThrow(
      "左侧诊断归档不可读取",
    );
    const { newJob, updateJob, cancelJob } = await import("~/server/jobs/jobs");
    const hidden = newJob("backtest", { type: "lab-diagnose" });
    updateJob(hidden.id, { status: "running" });
    const hiddenId = "lab-" + hidden.id;
    await runGroupedDiagnoseScenarios(input("hold"), {
      config,
      jobId: hidden.id,
    });
    await expect(compare(id, hiddenId)).rejects.toThrow("右侧诊断归档不可读取");
    cancelJob(hidden.id);
    await expect(compare(hiddenId)).rejects.toThrow("左侧诊断归档不可读取");
  } finally {
    await closeCzsc();
  }
});
