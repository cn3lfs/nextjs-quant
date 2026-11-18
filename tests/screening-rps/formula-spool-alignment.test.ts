import { expect, it, vi } from "vitest";
import type { Coverage, Snapshot } from "~/lib/domain";
import type { FormulaRangeWork } from "~/server/screening/formula-range";
import type { ScreeningFormula } from "trading-strategies/formula/formula-screen";
const captured = vi.hoisted(() => ({
  retained: [] as number[],
  files: [] as string[],
}));
vi.mock("~/server/data-sources/tdx/tdx", () => ({ scan: vi.fn() }));
vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
vi.mock("~/server/screening/formula-shards", async () => {
  const { scanFormulaRange } = await import("~/server/screening/formula-range");
  return {
    scanFormulaParallel: async (
      work: FormulaRangeWork,
      formula: ScreeningFormula,
      securities: { symbol: string; name: string }[],
    ) => {
      const parts = await Promise.all(
        [securities.slice(0, 1), securities.slice(1)].map((range) =>
          scanFormulaRange(work, formula, range),
        ),
      );
      captured.retained = parts.map((part) => part.snapshots.length);
      captured.files = parts.flatMap((part) => part.snapshotFiles);
      return parts;
    },
  };
});
import { scan } from "~/server/data-sources/tdx/tdx";
import { readBars } from "~/server/market/bar-store/read-bars";
import { screenFormula } from "~/server/screening/formula-screening";
import { executeFormulaScreen } from "~/server/screening/formula-screen-work";
import { put, list } from "~/server/db";

it("globally excludes an older shard before persisting identical full-history snapshots", async () => {
  const securities = [
    { symbol: "sh600000", name: "older" },
    { symbol: "sh600001", name: "latest" },
  ];
  vi.mocked(scan).mockResolvedValue({
    root: "fixture",
    counts: { day: 2 },
    scannedAt: 1,
    securities: securities.map((security) => ({
      ...security,
      market: "cn-equity",
      period: "day",
      bytes: 0,
      modified: 1,
    })),
  } satisfies Coverage);
  vi.mocked(readBars).mockImplementation(async (input) => {
    const count = input.instrument.symbol === "sh600000" ? 199 : 200;
    const bars = Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 20,
      high: 21,
      low: 19,
      close: 20,
      volume: 1000,
      amount: 20000,
    }));
    return {
      id: input.instrument.symbol,
      symbol: input.instrument.symbol,
      period: "day",
      market: "cn-equity",
      source: "tdx-local",
      adjustment: "forward",
      createdAt: 1,
      hash: "source",
      bars,
      rawBars: bars.map((bar) => ({ ...bar })),
      barStore: {
        version: "bar-store-1",
        market: "cn-equity",
        sourceFingerprint: "fixture",
        sourceVersions: [],
        adjustment: "forward",
        adjustmentReference: null,
        coverage: {
          from: bars[0]!.date,
          to: bars.at(-1)!.date,
          count,
          historyExhausted: true,
        },
        formingDates: [],
        overlay: null,
        excluded: [],
      },
    } satisfies Awaited<ReturnType<typeof readBars>>;
  });
  const work = {
    type: "formula-screen" as const,
    root: "fixture",
    now: Date.parse("2026-01-01"),
    formula: { name: "all", source: "选股:C>0;", parameters: {} },
  };
  const expected = await screenFormula(work);
  expect(expected.candidates.map((candidate) => candidate.symbol)).toEqual([
    "sh600001",
  ]);
  expect(expected.excluded).toContainEqual(
    expect.objectContaining({
      symbol: "sh600000",
      reason: "行情日期落后于公式选股基准日",
    }),
  );
  put("job", "alignment", {
    id: "alignment",
    type: "screen",
    input: work,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    progress: 0,
  });
  const actual = await executeFormulaScreen(work, "alignment");
  expect(captured.retained).toEqual([0, 0]);
  expect(captured.files).toHaveLength(2);
  const {
    snapshots,
    snapshotFiles: _files,
    elapsedMs: _old,
    ...expectedMeta
  } = expected;
  const { elapsedMs: _new, ...actualMeta } = actual;
  expect(actualMeta).toEqual(expectedMeta);
  const saved = list<Snapshot>("snapshot", 200);
  expect(saved).toHaveLength(1);
  expect(JSON.stringify(saved)).toBe(JSON.stringify(snapshots));
  expect(saved[0]!.bars).toHaveLength(200);
  expect(saved[0]!.rawBars).toHaveLength(200);
});
