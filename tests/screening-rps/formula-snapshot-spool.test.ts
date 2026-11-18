import { expect, it, vi } from "vitest";
import { readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "~/lib/domain";
vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
import { readBars } from "~/server/market/bar-store/read-bars";
import { scanFormulaRange } from "~/server/screening/formula-range";
import {
  createFormulaSnapshotSpool,
  clearFormulaSnapshotSpool,
  readFormulaSnapshots,
} from "~/server/screening/formula-snapshot-spool";

const bars = Array.from({ length: 200 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  open: 10 + index / 100,
  high: 11 + index / 100,
  low: 9 + index / 100,
  close: 10 + index / 100,
  volume: 1000,
  amount: 10000,
}));
vi.mocked(readBars).mockImplementation(
  async (input) =>
    ({
      id: input.instrument.symbol,
      symbol: input.instrument.symbol,
      period: "day",
      source: "tdx-local",
      market: "cn-equity",
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
          count: bars.length,
          historyExhausted: true,
        },
        formingDates: [],
        overlay: null,
        excluded: [],
      },
      adjustment: "forward",
      createdAt: 1,
      hash: "source",
      bars: bars.map((b) => ({ ...b })),
      rawBars: bars.map((b) => ({ ...b })),
    }) satisfies Awaited<ReturnType<typeof readBars>>,
);
const formula = { name: "all", source: "选股:C>0;", parameters: {} };
const work = { root: "fixture", now: Date.parse("2026-01-01") };

it("moves full selected histories to disk without putting bar objects in shard messages", async () => {
  const securities = Array.from({ length: 120 }, (_, i) => ({
    symbol: `sh${600000 + i}`,
    name: String(i),
  }));
  const expected = await scanFormulaRange(work, formula, securities);
  const directory = await createFormulaSnapshotSpool("spool-equivalence");
  try {
    const actual = await scanFormulaRange(
      { ...work, snapshotDirectory: directory },
      formula,
      securities,
    );
    expect(actual.candidates).toEqual(expected.candidates);
    expect(actual.observed).toEqual(expected.observed);
    expect(actual.snapshots).toEqual([]);
    expect(actual.snapshotFiles).toHaveLength(1);
    const restored: Snapshot[] = [];
    for await (const snapshot of readFormulaSnapshots(
      "spool-equivalence",
      actual.snapshotFiles,
    ))
      restored.push(snapshot);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(expected.snapshots));
    expect(
      restored.every(
        (snapshot) =>
          snapshot.bars.length === 200 && snapshot.rawBars?.length === 200,
      ),
    ).toBe(true);
  } finally {
    await clearFormulaSnapshotSpool("spool-equivalence");
  }
  await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("closes a partially consumed reader and refuses to remove unexpected files", async () => {
  const directory = await createFormulaSnapshotSpool("spool-owned-cleanup");
  const part = await scanFormulaRange(
    { ...work, snapshotDirectory: directory },
    formula,
    [
      { symbol: "sh600000", name: "one" },
      { symbol: "sh600001", name: "two" },
    ],
  );
  for await (const snapshot of readFormulaSnapshots(
    "spool-owned-cleanup",
    part.snapshotFiles,
  )) {
    expect(snapshot.symbol).toBe("sh600000");
    break;
  }
  await writeFile(join(directory, "unrelated.txt"), "keep");
  await expect(
    clearFormulaSnapshotSpool("spool-owned-cleanup"),
  ).rejects.toThrow("非本任务文件");
  expect(await readdir(directory)).toContain("unrelated.txt");
  await unlink(join(directory, "unrelated.txt"));
  await clearFormulaSnapshotSpool("spool-owned-cleanup");
  await clearFormulaSnapshotSpool("spool-owned-cleanup");
});

it("rejects cross-job snapshot pointers before reading", async () => {
  const own = await createFormulaSnapshotSpool("spool-own");
  const foreign = await createFormulaSnapshotSpool("spool-foreign");
  try {
    const part = await scanFormulaRange(
      { ...work, snapshotDirectory: foreign },
      formula,
      [{ symbol: "sh600000", name: "one" }],
    );
    await expect(
      (async () => {
        for await (const _snapshot of readFormulaSnapshots(
          "spool-own",
          part.snapshotFiles,
        )) {
        }
      })(),
    ).rejects.toThrow("不属于当前任务");
    expect(await readdir(own)).toEqual([]);
  } finally {
    await clearFormulaSnapshotSpool("spool-own");
    await clearFormulaSnapshotSpool("spool-foreign");
  }
});
