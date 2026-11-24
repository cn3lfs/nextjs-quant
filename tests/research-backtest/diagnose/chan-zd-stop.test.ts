import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  prepareStrategy,
  type NativeStudyIdentity,
  type StrategyObjectInput,
} from "trading-strategies";
import {
  attachNativeChanMulti,
  buildNativeChanZdLevels,
  NATIVE_CHAN_ZD_STOP_KEY,
  nativeChanZdStopRules,
} from "~/server/research/diagnose/chan-native";
import type { projectCzsc } from "~/server/strategies/chan/czsc";
import type {
  CzscRawFamily,
  CzscRawSignal,
} from "~/server/strategies/chan/czsc-api";

const symbol = "sh600519";
const identity: NativeStudyIdentity = {
  dllHash: "a".repeat(64),
  apiVersion: 22,
  buildCommit: "fixture",
  configId: "defaults",
  config: 0,
  anchor: 1,
};
const dates = Array.from(
  { length: 215 },
  (_, i) => new Date(Date.UTC(2024, 0, i + 1)),
)
  .filter((date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
  .map((date) => date.toISOString().slice(0, 10))
  .slice(0, 149);
const first = 140;
const buySignal = 141;
const stopBar = 143;
const sellSignal = 145;

function signal(type: 2 | -2, confirmedAt: number): CzscRawSignal {
  return {
    type,
    index: confirmedAt - 1,
    confirmedAt,
    center: 0,
    hindsight: 1,
    quality: 1,
    revokedAt: -1,
    pivot: 1,
    movement: -1,
    breakout: -1,
    basedOn: -1,
    stop: 0,
    context: 0,
    secondBasePivot: -1,
    secondTurnPivot: -1,
    smallTurnBasePivot: -1,
    smallTurnLeavePivot: -1,
    smallTurnRetestPivot: -1,
    divergence: {
      semantic: 1,
      holds: 1,
      newExtreme: 1,
      weakSpace: 0,
      weakSpeed: 0,
      weakArea: 0,
      prevStart: -1,
      prevEnd: -1,
      curStart: -1,
      curEnd: -1,
      prevArea: 0,
      curArea: 0,
      prevSpace: 0,
      curSpace: 0,
      prevSpeed: 0,
      curSpeed: 0,
    },
  };
}

function projector() {
  return vi.fn<typeof projectCzsc>(async (input, request) => {
    expect(request).toEqual({ levels: [0], bars: false });
    const index = input.close.length - 1;
    const zd = index < sellSignal ? 9 : 7;
    const family: CzscRawFamily = {
      pivots: [5, 10].map((i) => ({
        index: i,
        kind: 1,
        price: 10,
        extremeIndex: i,
        fractalAt: i,
        confirmedAt: i,
      })),
      centers: [
        {
          start: 5,
          end: 10,
          firstPivot: 0,
          lastPivot: 1,
          zg: 10,
          zd,
          gg: 11,
          dd: zd - 1,
          direction: 1,
          confirmedAt: 12,
          established: 11,
          relationToPrev: 0,
          lifecycle: 0,
        },
      ],
      signals:
        index === buySignal
          ? [signal(2, buySignal)]
          : index === sellSignal
            ? [signal(-2, sellSignal)]
            : [],
      movements: [],
      breakouts: [],
      events: [],
      bars: [],
      nodes: [],
      children: [],
      recursiveCenters: [],
      connections: [],
    };
    return {
      hash: identity.dllHash,
      apiVersion: identity.apiVersion,
      buildCommit: identity.buildCommit,
      configId: identity.configId,
      families: { 0: family },
      nested: [],
    };
  });
}

function frozen(useZd: boolean, touchesStop = true, invalidEntry = false) {
  const bars = dates.map((date, index) => ({
    date,
    open: invalidEntry && index === buySignal + 1 ? 8.9 : 10,
    close: 10,
    high: 10.5,
    low:
      (touchesStop && index === stopBar) ||
      (invalidEntry && index === buySignal + 1)
        ? 8.8
        : 9.5,
    volume: 1000000,
    amount: 10000000,
  }));
  const entry = {
    kind: "chan-native",
    profile: "chan-hold-cash-native",
    side: "entry",
  } as const;
  const strategy: StrategyObjectInput = {
    id: useZd ? NATIVE_CHAN_ZD_STOP_KEY : "research-chan-hold-cash",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: [symbol] },
    ...(useZd
      ? nativeChanZdStopRules()
      : { entry, exit: { rule: { ...entry, side: "exit" } } }),
    sizing: { kind: "weight", weight: 0.4 },
    sleeve: "test",
  };
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: dates[first]!,
    end: dates.at(-1)!,
    calendar: dates.slice(first),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          minimum: 100,
          step: 100,
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "test", share: 1, riskPerTrade: 1, maxPositions: 1 }],
  };
  return { request, sources: [] as Record<string, unknown>[] };
}

it("reuses the warm CH14 v2 cache with zero projections and freezes exact causal ZD levels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chan-zd-stop-"));
  try {
    const project = projector();
    const options = {
      nativeCacheDir: dir,
      project,
      resolveIdentity: async () => identity,
    };
    const baseline = frozen(false);
    expect((await attachNativeChanMulti(baseline, options))[0]).toMatchObject({
      cached: false,
      projectionVersion: 2,
    });
    expect(project).toHaveBeenCalledTimes(dates.length - first + 1);
    expect(baseline.request.instruments[0]?.external?.levels).toBeUndefined();
    project.mockClear();

    const variant = frozen(true);
    const [disclosure] = await attachNativeChanMulti(variant, options);
    expect(disclosure).toMatchObject({
      cached: true,
      projectionVersion: 2,
      zdStop: { levelCount: 2, entrySignalsMissingZd: 0 },
    });
    expect(project).toHaveBeenCalledTimes(0);
    expect(await readdir(dir)).toHaveLength(1);
    const { external, signalBars } = variant.request.instruments[0]!;
    const rows = external!.chan!;
    expect(rows).toEqual(baseline.request.instruments[0]?.external?.chan);
    expect(external!.levels).toEqual([
      {
        date: dates[buySignal],
        availableAt: dates[buySignal],
        field: "chan-zd",
        value: 9,
      },
      {
        date: dates[sellSignal],
        availableAt: dates[sellSignal],
        field: "chan-zd",
        value: 7,
      },
    ]);
    expect(
      buildNativeChanZdLevels(
        rows.filter((row) => row.date < dates[sellSignal]!),
      ),
    ).toEqual(external!.levels!.slice(0, 1));
    const strategy = variant.request.strategies[0]!;
    expect(strategy.exit.stop?.kind).toBe("structure");
    const rule = prepareStrategy(strategy, signalBars, external);
    expect(rule.evaluate(buySignal - 1).stopLevel).toBeNull();
    expect(rule.evaluate(buySignal)).toMatchObject({
      entry: true,
      stopLevel: 9,
    });
    expect(rule.evaluate(stopBar).stopLevel).toBeNull();
    const result = runPortfolio(variant.request);
    expect(result.fills.map(({ side, date }) => [side, date])).toEqual([
      ["buy", dates[buySignal + 1]],
      ["sell", dates[stopBar]],
    ]);
    expect(result.orders.find(({ side }) => side === "sell")).toMatchObject({
      trigger: "stop",
      status: "filled",
    });
    expect(runPortfolio(baseline.request).fills.at(-1)?.date).toBe(
      dates[sellSignal + 1],
    );
  } finally {
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  }
});

it("retains the real CH14 sell without a stop touch, and rejects missing or invalid initial ZD", async () => {
  const normal = frozen(true, false);
  const options = {
    project: projector(),
    resolveIdentity: async () => identity,
  };
  await attachNativeChanMulti(normal, options);
  expect(runPortfolio(normal.request).fills.at(-1)).toMatchObject({
    side: "sell",
    date: dates[sellSignal + 1],
  });

  const missing = frozen(true, false);
  await attachNativeChanMulti(missing, options);
  missing.request.instruments[0]!.external!.levels = [];
  const invalid = frozen(true, false, true);
  await attachNativeChanMulti(invalid, options);
  for (const fixture of [missing, invalid]) {
    const result = runPortfolio(fixture.request);
    expect(result.fills).toHaveLength(0);
    expect(result.orders).toContainEqual(
      expect.objectContaining({
        side: "buy",
        status: "rejected",
        reason: "缺失或无效初始止损",
      }),
    );
  }
});
