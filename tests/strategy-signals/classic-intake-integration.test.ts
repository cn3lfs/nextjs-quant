import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";
import { replayDailyStudy } from "quant-backtest";
import {
  classicDefinitions,
  classicIds,
  studyStrategies,
  studyWarmup,
  strategyBuildHash,
  getStrategyDefinition,
} from "trading-strategies";
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
  const day = new Date("2020-01-01T00:00:00Z");
  while (dates.length < 530) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const bars = dates.map((date, i) => {
    const open = 100 + 0.02 * i + 10 * Math.sin(i / 13);
    const close = open + 2 * Math.sin(i / 3);
    return {
      date,
      open,
      close,
      high: open + 3,
      low: open - 3,
      volume: 100000 + (i % 7) * 50000,
      amount: 10000000,
    };
  });
  const source: Snapshot = {
    id: "fixture",
    symbol: "sh600519",
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    hash: "source-hash",
    createdAt: 1,
    bars,
  };
  const calendar = { ...source, symbol: "sh000001", hash: "calendar-hash" };
  const actions: BacktestActions = {
    version: "backtest-actions-1",
    status: "partial",
    symbol: source.symbol,
    start: dates[0]!,
    end: dates.at(-1)!,
    source: {
      file: "fixture/gbbq",
      hash: "actions-hash",
      modified: 1,
      fetchedAt: 2,
    },
    events: [],
    warnings: [],
  };
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      symbol === source.symbol ? source : calendar,
    ),
    readBacktestActions: vi.fn(async () => actions),
  };
  return {
    source,
    readers,
    options: { start: dates[300]!, end: dates[499]!, initial: 1000000 },
  };
}
it("all ten official-source intake rules are admitted by the real daily task schema", () => {
  const { source, options } = fixture();
  expect(
    studyStrategies.filter((id) =>
      (classicIds as readonly string[]).includes(id),
    ),
  ).toEqual([...classicIds]);
  for (const id of classicIds) {
    expect(studyStrategies).toContain(id);
    expect(
      strategyCenterRunSchema.parse({
        ...options,
        symbol: source.symbol,
        strategyId: id,
      }).strategyId,
    ).toBe(id);
    expect(getStrategyDefinition(id)).toMatchObject({
      implementation: "implemented",
      output: "signal",
    });
    expect(getStrategyDefinition(id)!.sources).toEqual(
      classicDefinitions.find((d) => d.id === id)!.sources,
    );
    expect(studyWarmup(id)).toBe(
      Math.max(140, classicDefinitions.find((d) => d.id === id)!.warmupBars),
    );
  }
});
it.each(classicIds)(
  "%s runs real cash-equity replay, next-open execution and future-prefix invariant",
  (id) => {
    const { source, options } = fixture();
    const before = structuredClone(source.bars);
    const short = replayDailyStudy(source.bars.slice(0, 500), [], {
      ...options,
      strategy: id,
    });
    const full = replayDailyStudy(
      source.bars,
      [{ date: source.bars[520]!.date, perShare: 5 }],
      { ...options, strategy: id },
    );
    expect(full).toEqual(short);
    expect(full.quality).toBe("rule-check-only");
    expect(full.curve).toHaveLength(200);
    expect(full.fills.length).toBeGreaterThan(0);
    for (const fill of full.fills) {
      expect(fill.signalDate < fill.date).toBe(true);
      expect(fill.price).toBe(
        source.bars.find((b) => b.date === fill.date)!.open,
      );
      expect(fill.shares % 100).toBe(0);
      expect(fill.cash).toBeGreaterThanOrEqual(0);
    }
    const warmup = studyWarmup(id);
    expect(() =>
      replayDailyStudy(source.bars.slice(301 - warmup), [], {
        ...options,
        strategy: id,
      }),
    ).toThrow(`预热至少${warmup}`);
    expect(source.bars).toEqual(before);
  },
);
it("all ten task captures freeze the exact source inputs and built strategy identity", async () => {
  const { source, readers, options } = fixture();
  for (const id of classicIds) {
    const run = await executeStrategyCenterStudy(
      { ...options, symbol: source.symbol, strategyId: id },
      "fixture",
      readers,
    );
    expect(run.frozen.strategy?.id).toBe(id);
    expect(run.frozen.strategy?.sources).toEqual(
      getStrategyDefinition(id)!.sources,
    );
    expect(run.frozen.strategyBuildHash).toBe(strategyBuildHash);
    expect(run.frozen.strategyBuildHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.frozen.bars).toHaveLength(200 + studyWarmup(id));
    expect(run.frozen.sourceHash).toBe("source-hash");
    expect(run.frozen.calendarHash).toBe("calendar-hash");
    expect(run.result).toEqual(
      replayDailyStudy(run.frozen.bars, [], {
        ...options,
        strategy: id,
        symbol: source.symbol,
      }),
    );
    expect(run.inputHash).toBe(
      createHash("sha256").update(JSON.stringify(run.frozen)).digest("hex"),
    );
  }
});
it("built strategy identity includes actual classic rules and current shared engine source", () => {
  const root = resolve(import.meta.dirname, "../..");
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory()
        ? files(resolve(directory, item.name))
        : /\.(ts|json)$/.test(item.name)
          ? [resolve(directory, item.name)]
          : [],
    );
  }
  const inputs = [
    "trading-strategies",
    "trading-strategy-core",
    "quant-backtest",
    "tstdx",
    "quant-rps",
  ].flatMap((name) => files(resolve(root, "packages", name, "src")));
  inputs.push(
    resolve(root, "pnpm-lock.yaml"),
    resolve(root, "packages/trading-strategies/build-identity.mjs"),
  );
  inputs.sort((a, b) =>
    relative(root, a)
      .replaceAll("\\", "/")
      .localeCompare(relative(root, b).replaceAll("\\", "/"), "en"),
  );
  expect(
    inputs.some(
      (path) =>
        path.endsWith("classics/rules.ts") ||
        path.endsWith("classics\\rules.ts"),
    ),
  ).toBe(true);
  const hash = createHash("sha256");
  for (const file of inputs)
    hash.update(
      JSON.stringify([
        relative(root, file).replaceAll("\\", "/"),
        readFileSync(file, "utf8").replaceAll("\r\n", "\n"),
      ]),
    );
  expect(strategyBuildHash).toBe(hash.digest("hex"));
});
