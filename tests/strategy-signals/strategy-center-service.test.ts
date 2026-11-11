import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";

vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/backtest/backtest-actions", () => ({
  readBacktestActions: vi.fn(),
}));
vi.mock("~/server/infra/settings", () => ({ settings: vi.fn() }));
vi.mock("~/server/jobs/jobs", () => ({
  background: vi.fn(),
  updateJob: vi.fn(),
}));
import {
  executeStrategyCenterStudy,
  strategyCenterRunSchema,
} from "~/server/strategies/strategy-center-service";

function fixture() {
  const dates: string[] = [];
  const cursor = new Date("2023-01-02T00:00:00Z");
  while (dates.length < 400) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6)
      dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const source: Snapshot = {
    id: "fixture",
    symbol: "sh600519",
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    hash: "source-hash",
    createdAt: 1,
    bars: dates.map((date, i) => ({
      date,
      open: 10 + i / 100,
      high: 10.2 + i / 100,
      low: 9.8 + i / 100,
      close: 10.05 + i / 100,
      volume: 1000000,
      amount: 10000000,
    })),
  };
  const calendar: Snapshot = {
    ...structuredClone(source),
    symbol: "sh000001",
    hash: "calendar-hash",
  };
  const actions: BacktestActions = {
    version: "backtest-actions-1",
    status: "partial",
    symbol: source.symbol,
    start: dates[10]!,
    end: dates[399]!,
    events: [],
    warnings: [],
    source: {
      file: "fixture/gbbq",
      modified: 1,
      fetchedAt: 2,
      hash: "actions-hash",
    },
  };
  const input = {
    strategyId: "sma200" as const,
    symbol: source.symbol,
    start: dates[310]!,
    end: dates[399]!,
    initial: 1000000,
  };
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      symbol === source.symbol ? source : calendar,
    ),
    readBacktestActions: vi.fn(async () => actions),
  };
  return { source, calendar, actions, input, readers };
}

describe("strategy center frozen daily execution", () => {
  it("rejects impossible dates, reversed windows, unsupported symbols and non-finite capital", () => {
    const { input } = fixture();
    for (const change of [
      { start: "2024-02-30" },
      { end: "not-a-date" },
      { start: "2025-01-01" },
      { symbol: "sh000001" },
      { symbol: "sz399001" },
      { symbol: "sh688001" },
      { initial: Number.POSITIVE_INFINITY },
      { initial: 0 },
      { strategyId: "unregistered" },
    ])
      expect(
        strategyCenterRunSchema.safeParse({ ...input, ...change }).success,
      ).toBe(false);
  });

  it("freezes the exact warmup, executes after the decision close and reproduces the input hash", async () => {
    const { source, calendar, input, readers } = fixture();
    const original = structuredClone(source);
    const run = await executeStrategyCenterStudy(input, "fixture", readers);
    expect(run.frozen.bars).toHaveLength(390);
    expect(run.frozen.bars[0]!.date).toBe(source.bars[10]!.date);
    expect(run.frozen.sourceHash).toBe(source.hash);
    expect(run.frozen.calendarHash).toBe(calendar.hash);
    expect(run.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.result.fills.length).toBeGreaterThan(0);
    expect(run.result.fills[0]).toMatchObject({
      side: "buy",
      signalDate: source.bars[309]!.date,
      date: input.start,
    });
    expect(run.result.fills.every((fill) => fill.signalDate < fill.date)).toBe(
      true,
    );
    expect(source).toEqual(original);
    const replay = await executeStrategyCenterStudy(input, "fixture", readers);
    expect(replay.inputHash).toBe(run.inputHash);
    expect(replay.result).toEqual(run.result);
  });

  it("refuses missing company-action evidence rather than assuming no events", async () => {
    const f = fixture();
    f.actions.status = "missing";
    await expect(
      executeStrategyCenterStudy(f.input, "fixture", f.readers),
    ).rejects.toThrow("公司行动来源缺失");
  });

  it.each([11, 12, 13, 14, 1])(
    "rejects non-cash company action category %i",
    async (category) => {
      const f = fixture();
      f.actions.events = [
        {
          date: f.input.start,
          category,
          name: "fixture",
          dividend: 0,
          bonusRatio: 0.1,
          rightsRatio: 0,
          rightsPrice: 0,
        },
      ];
      await expect(
        executeStrategyCenterStudy(f.input, "fixture", f.readers),
      ).rejects.toThrow("非现金公司行动");
    },
  );

  it("rejects a missing stock session instead of synthesizing a suspension bar", async () => {
    const f = fixture();
    f.source.bars.splice(350, 1);
    await expect(
      executeStrategyCenterStudy(f.input, "fixture", f.readers),
    ).rejects.toThrow("交易日历不一致");
  });

  it("rejects repaired or discarded stock input", async () => {
    const f = fixture();
    f.source.sourceNote = "fixture repaired bars";
    await expect(
      executeStrategyCenterStudy(f.input, "fixture", f.readers),
    ).rejects.toThrow("修复或丢弃");
  });

  it("rejects a repaired benchmark calendar rather than certifying its sessions", async () => {
    const f = fixture();
    f.calendar.sourceNote = "fixture discarded benchmark session";
    await expect(
      executeStrategyCenterStudy(f.input, "fixture", f.readers),
    ).rejects.toThrow("修复或丢弃");
  });

  it("rejects insufficient warmup and incomplete end-date coverage", async () => {
    const f = fixture();
    await expect(
      executeStrategyCenterStudy(
        { ...f.input, start: f.source.bars[100]!.date },
        "fixture",
        f.readers,
      ),
    ).rejects.toThrow("预热");
    f.calendar.bars.pop();
    await expect(
      executeStrategyCenterStudy(f.input, "fixture", f.readers),
    ).rejects.toThrow("超出行情或日历覆盖");
  });
});
