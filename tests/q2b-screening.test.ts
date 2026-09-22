import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bar, Job, Snapshot } from "../src/lib/domain";
import { settingsSchema } from "../src/lib/domain";
import { validateScreenFormula } from "../src/lib/formula-screen";
vi.mock("../src/server/data-sources/tdx/tdx", () => ({
  scan: vi.fn(),
  readSnapshot: vi.fn(),
}));
vi.mock("../src/server/jobs/jobs", async (original) => ({
  ...(await original<typeof import("../src/server/jobs/jobs")>()),
  runWorker: vi.fn(),
}));
import { scan, readSnapshot } from "../src/server/data-sources/tdx/tdx";
import { screenFormula } from "../src/server/screening/formula-screening";
import {
  saveFormula,
  savedFormulas,
  formulaScreenJob,
  exportFormulaScreen,
} from "../src/server/screening/formula-screen-service";
import { runWorker, cancelJob } from "../src/server/jobs/jobs";
import { get, list, put, sqlite } from "../src/server/db";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "../src/server/screening/screen-results";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "q2b-screen-"));
const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-01-${String(i + 1).padStart(2, "0")}`,
  open: i + 1,
  close: i + 2,
  high: i + 3,
  low: i,
  volume: 100,
  amount: 1000,
}));
const source: Snapshot = {
  id: "source",
  symbol: "sh600519",
  name: "fixture",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 0,
  hash: "original",
  bars,
};
const formula = {
  name: "测试",
  source: "选股:C>MA(C,N1);",
  parameters: { N1: 3 },
};
beforeEach(() => {
  vi.clearAllMocks();
  sqlite().prepare("DELETE FROM records").run();
  put(
    "settings",
    "settings",
    settingsSchema.parse({ tdxRoot: "fixture", autoAnalysis: false }),
  );
  vi.mocked(scan).mockResolvedValue({
    root: "fixture",
    scannedAt: 0,
    counts: {},
    securities: [
      {
        symbol: "sh600519",
        name: "fixture",
        period: "day",
        market: "sh",
        bytes: 960,
        modified: 0,
      },
    ],
  });
  vi.mocked(readSnapshot).mockResolvedValue(structuredClone(source));
});
it.each([
  ["q2b-buffett", "FINANCE", 1, { N1: 10, N2: 10, N3: 10 }],
  ["q2b-old-duck-original", "FINANCE", 12, {}],
  ["q2b-price-limits", "NAMEINCLUDE", 1, {}],
])(
  "original real formula %s is rejected end-to-end with name/line before persistence or worker I/O",
  async (file, name, line, parameters) => {
    const input = {
      name: file as string,
      source: readFileSync(join("tests/fixtures", `${file}.tdx`), "utf8"),
      parameters,
    };
    for (const fn of [validateScreenFormula, saveFormula, formulaScreenJob])
      expect(() => fn(input)).toThrow(`第${line}行 ${name}`);
    await expect(
      screenFormula({
        type: "formula-screen",
        root: "fixture",
        formula: input as typeof formula,
        now: Date.now(),
      }),
    ).rejects.toThrow(`第${line}行 ${name}`);
    expect(scan).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(list<Job>("job")).toEqual([]);
    expect(savedFormulas()).toEqual([]);
  },
);
it("name and parameter persistence round-trips; editing updates only this formula", () => {
  const saved = saveFormula(formula);
  expect(savedFormulas()).toEqual([saved]);
  saveFormula({ ...saved, name: "新名字", parameters: { N1: 7 } });
  expect(savedFormulas()).toHaveLength(1);
  expect(savedFormulas()[0]).toMatchObject({
    name: "新名字",
    parameters: { N1: 7 },
    source: formula.source,
  });
  expect(() =>
    saveFormula({ ...saved, source: "坏:=REF(C,-N1);C>0;" }),
  ).toThrow("REF");
  expect(savedFormulas()[0]!.name).toBe("新名字");
});
it("worker selection goes into existing candidate paging and export with immutable formula provenance", async () => {
  const progress = vi.fn();
  const result = await screenFormula(
    {
      type: "formula-screen",
      root: "fixture",
      formula,
      now: Date.parse("2026-02-01"),
    },
    progress,
  );
  expect(result.candidates.map((c) => c.symbol)).toEqual(["sh600519"]);
  const usage = list<import("../src/lib/research-usage").ResearchUsage>(
    "research-usage",
    -1,
  );
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    kind: "formula-screen",
    symbols: ["*"],
    universeSize: 1,
    candidateCount: 1,
    range: { start: bars[0]!.date, end: bars.at(-1)!.date },
  });
  expect(progress).toHaveBeenLastCalledWith(
    90,
    "公式选股",
    expect.objectContaining({ processed: 1, total: 1 }),
  );
  vi.mocked(runWorker).mockResolvedValue(result);
  const job = formulaScreenJob(formula);
  await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("completed"));
  const finished = get<Job>(job.id)!;
  expect(get<Snapshot>(result.snapshots[0]!.id)?.bars).toEqual(bars);
  expect(
    pageScreenResults(finished.result as StoredScreenResult, {
      page: 0,
      query: "",
      excludedPage: 0,
      errorPage: 0,
    }).count,
  ).toBe(1);
  expect(exportFormulaScreen(finished).parameters.formula).toEqual(formula);
  expect(list<Job>("job")).toHaveLength(1); // no automatic analysis / notification jobs
});
it("appending future bars cannot change the fixed-cutoff candidate or snapshot hash", async () => {
  const work = {
    type: "formula-screen" as const,
    root: "fixture",
    formula,
    now: Date.parse("2026-01-30T08:00:00Z"),
  };
  const first = await screenFormula(work);
  vi.mocked(readSnapshot).mockResolvedValue({
    ...source,
    hash: "new source bytes",
    bars: [...bars, { ...bars[0]!, date: "2026-02-01", close: 999 }],
  });
  const second = await screenFormula(work);
  expect(second.candidates).toEqual(first.candidates);
  expect(second.snapshots).toEqual(first.snapshots);
  expect(source.bars).toEqual(bars);
});
it("cancellation discards late worker results and saves no snapshots", async () => {
  const result = await screenFormula({
    type: "formula-screen",
    root: "fixture",
    formula,
    now: Date.now(),
  });
  let finish!: (value: typeof result) => void;
  vi.mocked(runWorker).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const job = formulaScreenJob(formula);
  await vi.waitFor(() => expect(runWorker).toHaveBeenCalledOnce());
  cancelJob(job.id);
  finish(result);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(get<Job>(job.id)?.result).toBeUndefined();
  expect(list("snapshot")).toEqual([]);
});
it("runtime function errors fail the whole task with symbol/function/line instead of skipping a stock", async () => {
  await expect(
    screenFormula({
      type: "formula-screen",
      root: "fixture",
      formula: { ...formula, source: "DMA(C,C/2)>0;" },
      now: Date.now(),
    }),
  ).rejects.toThrow("sh600519：第1行 DMA");
});

it("final progress includes stale-date exclusions computed after the scan", async () => {
  const coverage = await scan("fixture");
  vi.mocked(scan).mockResolvedValue({
    ...coverage,
    securities: [
      ...coverage.securities,
      { ...coverage.securities[0]!, symbol: "sh600000" },
    ],
  });
  vi.mocked(readSnapshot).mockImplementation(async (_root, symbol) => ({
    ...source,
    symbol,
    bars: symbol === "sh600000" ? bars.slice(0, -1) : bars,
  }));
  const progress = vi.fn();
  const result = await screenFormula(
    {
      type: "formula-screen",
      root: "fixture",
      formula,
      now: Date.parse("2026-02-01"),
    },
    progress,
  );
  expect(result.excluded).toContainEqual(
    expect.objectContaining({
      symbol: "sh600000",
      reason: "行情日期落后于公式选股基准日",
    }),
  );
  expect(progress).toHaveBeenLastCalledWith(
    90,
    "公式选股",
    expect.objectContaining({
      processed: 2,
      total: 2,
      excluded: result.excluded.length,
    }),
  );
});
it("zero/multiple outputs and dead-branch future calls never launch work", () => {
  for (const text of [
    "A:=C;",
    "A:C;B:V;",
    "X:IF(0,ZIG(C,3),C);",
    "X:REF(C,-1);",
  ])
    expect(() => formulaScreenJob({ ...formula, source: text })).toThrow();
  expect(runWorker).not.toHaveBeenCalled();
});

it("formula screening consumes persisted RPS and distinguishes missing from weak", async () => {
  const { RpsStore } = await import("../src/server/screening/rps-store");
  const { rpsDay } = await import("./rps-fixture");
  const store = new RpsStore(sqlite());
  const { day, rows } = rpsDay();
  store.saveDay({ ...day, date: bars.at(-1)!.date }, [
    { ...rows[9]!, symbol: source.symbol },
  ]);
  const work = {
    type: "formula-screen" as const,
    root: "fixture",
    now: Date.parse("2026-02-01T08:00:00Z"),
    formula: { name: "RPS", source: "RPS50>85;", parameters: {} },
  };
  expect((await screenFormula(work)).candidates.map((c) => c.symbol)).toEqual([
    source.symbol,
  ]);
  sqlite().prepare("DELETE FROM rps_values").run();
  const missing = await screenFormula(work);
  expect(missing.candidates).toEqual([]);
  expect(missing.excluded[0]!.reason).toContain("RPS缺失");
});

it("V5 formula calculation still returns unchanged results when usage put fails", async () => {
  const work = {
    type: "formula-screen" as const,
    root: "fixture",
    formula,
    now: Date.parse("2026-02-01"),
  };
  const expected = await screenFormula(work);
  // A database trigger exercises a real failed KV INSERT, without mocking the formula calculation.
  sqlite().exec(
    "CREATE TEMP TRIGGER reject_usage BEFORE INSERT ON records WHEN NEW.kind='research-usage' BEGIN SELECT RAISE(FAIL, 'usage rejected'); END",
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const actual = await screenFormula(work);
    expect({ ...actual, elapsedMs: 0 }).toEqual({ ...expected, elapsedMs: 0 });
    expect(warn).toHaveBeenCalledWith(
      "研究使用台账写入失败，本次运行可能未记录",
    );
    expect(list("research-usage", -1)).toHaveLength(1);
  } finally {
    sqlite().exec("DROP TRIGGER reject_usage");
    warn.mockRestore();
  }
});
