import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
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
import type {
  CzscRawFamily,
  CzscRawSignal,
  CzscSnapshot,
} from "~/server/strategies/chan/czsc-api";
import { closeCzsc, projectCzsc } from "~/server/strategies/chan/czsc";
import { captureNativeChanObservations } from "~/server/strategies/strategy-center-native";
import { replayDailyStudy, studySignalBars } from "quant-backtest";
import {
  executeStrategyCenterStudy,
  strategyCenterRunSchema,
} from "~/server/strategies/strategy-center-service";
import { prepareCzscTestRuntime } from "../helpers/czsc-runtime";
import nativeFixture from "../fixtures/czsc-sse.json";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bars(length = 160): Bar[] {
  return Array.from({ length }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1000000,
    amount: 10000000,
  }));
}
function rawSignal(index: number, confirmedAt: number): CzscRawSignal {
  return {
    index,
    confirmedAt,
    revokedAt: -1,
    type: 3,
    quality: 1,
    hindsight: 1,
    center: 0,
    pivot: 1,
    movement: -1,
    breakout: -1,
    basedOn: -1,
    stop: 8,
    context: 0,
    secondBasePivot: -1,
    secondTurnPivot: -1,
    smallTurnBasePivot: -1,
    smallTurnLeavePivot: -1,
    smallTurnRetestPivot: -1,
    divergence: {
      prevStart: -1,
      prevEnd: -1,
      curStart: -1,
      curEnd: -1,
      prevSpace: 0,
      prevSpeed: 0,
      prevArea: 0,
      curSpace: 0,
      curSpeed: 0,
      curArea: 0,
      newExtreme: 0,
      weakSpace: 0,
      weakSpeed: 0,
      weakArea: 0,
      holds: 0,
      semantic: 0,
    },
  };
}
function snapshot(length: number): CzscSnapshot {
  const family: CzscRawFamily = {
    pivots: [10, 20].map((index) => ({
      index,
      kind: 1,
      price: 10,
      fractalAt: index,
      confirmedAt: index,
      extremeIndex: index,
    })),
    centers: [
      {
        start: length >= 146 ? 11 : 10,
        end: 20,
        firstPivot: 0,
        lastPivot: 1,
        zg: length >= 144 ? 8.01 : 8,
        zd: 7,
        gg: 11,
        dd: 6,
        direction: 1,
        confirmedAt: 20,
        relationToPrev: 0,
        lifecycle: 0,
        established: 20,
      },
    ],
    signals: [
      rawSignal(120, 130),
      ...(length >= 142 && length !== 145 ? [rawSignal(135, 141)] : []),
    ],
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
    hash: "a".repeat(64),
    apiVersion: 22,
    buildCommit: "actual-native-build",
    configId: "locked-defaults",
    families: { 0: family, 1100: { ...structuredClone(family), signals: [] } },
    nested: [],
  };
}

it("captures serial full prefixes, freezes raw DLL identity and never replays baseline or revised points", async () => {
  const input = bars(),
    before = structuredClone(input),
    lengths: number[] = [];
  let active = 0,
    maximum = 0;
  const project: typeof projectCzsc = async (prefix, request) => {
    active++;
    maximum = Math.max(maximum, active);
    lengths.push(prefix.close.length);
    expect(prefix.close[0]).toBe(input[0]!.close);
    expect(request).toMatchObject({
      recursion: true,
      nested: true,
      bars: true,
    });
    await Promise.resolve();
    active--;
    return snapshot(prefix.close.length);
  };
  const capture = await captureNativeChanObservations(
    input,
    140,
    undefined,
    project,
  );
  expect(maximum).toBe(1);
  expect(lengths).toEqual(Array.from({ length: 21 }, (_, i) => 140 + i));
  expect(capture.identity).toMatchObject({
    dllHash: "a".repeat(64),
    apiVersion: 22,
    buildCommit: "actual-native-build",
    configId: "locked-defaults",
  });
  expect(capture.identity.buildCommit).not.toBe("czsc-api-v4");
  expect(capture.observations[0]).toMatchObject({
    date: input[139]!.date,
    baseline: true,
    prefixHash: digest(input.slice(0, 140)),
  });
  expect(capture.observations.flatMap((row) => row.signals)).toHaveLength(2);
  const reassigned = capture.audit.find(
    (row) =>
      row.event === "revised" &&
      row.before?.center.start === 10 &&
      row.after?.center.start === 11,
  );
  expect(reassigned).toBeDefined();
  expect(reassigned!.before!.key).toBe(reassigned!.after!.key);
  expect(capture.audit.map((row) => row.event)).toEqual(
    expect.arrayContaining([
      "baseline",
      "first-seen",
      "revised",
      "withdrawn",
      "reappeared",
    ]),
  );
  expect(JSON.stringify(capture)).not.toContain('"families"');
  const options = {
    strategy: "research-chan" as const,
    start: input[140]!.date,
    end: input[159]!.date,
    initial: 1000000,
    nativeObservations: capture.observations,
  };
  const result = replayDailyStudy(input, [], options);
  expect(
    result.fills.map((fill) => [fill.side, fill.signalDate, fill.date]),
  ).toEqual([
    ["buy", input[141]!.date, input[142]!.date],
    ["sell", input[147]!.date, input[148]!.date],
  ]);
  expect(result.options).not.toHaveProperty("nativeObservations");
  expect(input).toEqual(before);
  const future = [
    ...input,
    { ...input[159]!, date: "2020-06-10", close: 100000, high: 100001 },
  ];
  expect(replayDailyStudy(future, [], options)).toEqual(result);
});

it("rejects missing metadata, version changes, structural timing gaps, malformed feeds and bars overrides", async () => {
  const input = bars();
  await expect(
    captureNativeChanObservations(input, 140, undefined, async () => ({
      ...snapshot(140),
      buildCommit: "",
    })),
  ).rejects.toThrow("身份元数据");
  await expect(
    captureNativeChanObservations(input, 140, undefined, async (prefix) => ({
      ...snapshot(prefix.close.length),
      hash: (prefix.close.length === 140 ? "a" : "b").repeat(64),
    })),
  ).rejects.toThrow("DLL或配置变化");
  await expect(
    captureNativeChanObservations(input, 140, undefined, async () => {
      const raw = snapshot(140);
      raw.families[0]!.signals[0]!.confirmedAt = 999;
      return raw;
    }),
  ).rejects.toThrow("结构元数据缺口");
  const capture = await captureNativeChanObservations(
    input,
    140,
    undefined,
    async (prefix) => snapshot(prefix.close.length),
  );
  const common = {
    start: input[140]!.date,
    end: input[159]!.date,
    initial: 1000000,
  };
  expect(() =>
    replayDailyStudy(input, [], {
      ...common,
      strategy: "research-chan",
      nativeObservations: capture.observations.slice(1),
    }),
  ).toThrow("完整覆盖");
  // Deliberately exercise runtime callers, where compile-time discriminated unions cannot protect the boundary.
  expect(() =>
    replayDailyStudy(input, [], {
      ...common,
      strategy: "ma",
      nativeObservations: capture.observations,
    } as never),
  ).toThrow("不得覆盖");
  expect(() =>
    replayDailyStudy(input, [], {
      ...common,
      strategy: "research-chan",
    } as never),
  ).toThrow("缺少逐前缀");
});

it("records unconfirmed native endpoints without buying and cancels before the next serial DLL call", async () => {
  const input = bars(),
    controller = new AbortController();
  let calls = 0;
  const pending = await captureNativeChanObservations(
    input,
    140,
    undefined,
    async (prefix) => {
      const raw = snapshot(prefix.close.length);
      raw.families[0]!.signals.forEach((row) => {
        row.confirmedAt = -1;
      });
      return raw;
    },
  );
  expect(pending.observations.every((row) => row.signals.length === 0)).toBe(
    true,
  );
  expect(pending.pending.length).toBeGreaterThan(0);
  await expect(
    captureNativeChanObservations(input, 140, controller.signal, async () => {
      calls++;
      controller.abort();
      return snapshot(140);
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("executes a confirmed CH03 against a currently established center before its outer bounds are final", async () => {
  const input = bars();
  const capture = await captureNativeChanObservations(
    input,
    140,
    undefined,
    async (prefix) => {
      const raw = snapshot(prefix.close.length);
      raw.families[0]!.centers[0]!.confirmedAt = -1;
      return raw;
    },
  );
  const first = capture.observations.find(
    (row) => !row.baseline && row.signals.length > 0,
  )!;
  expect(first.signals[0]!.center).toMatchObject({
    established: 20,
    confirmedAt: -1,
  });
  expect(capture.pending).toEqual([]);
  const result = replayDailyStudy(input, [], {
    strategy: "research-chan",
    start: input[140]!.date,
    end: input[159]!.date,
    initial: 1000000,
    nativeObservations: capture.observations,
  });
  expect(result.fills[0]).toMatchObject({
    side: "buy",
    signalDate: input[141]!.date,
    date: input[142]!.date,
  });
  for (const formed of [undefined, 999]) {
    await expect(
      captureNativeChanObservations(input, 140, undefined, async () => {
        const raw = snapshot(140);
        if (formed === undefined)
          Reflect.deleteProperty(raw.families[0]!.centers[0]!, "established");
        else raw.families[0]!.centers[0]!.established = formed;
        return raw;
      }),
    ).rejects.toThrow("结构元数据缺口");
  }
});

beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);
it("freezes causal dividend-normalized prefixes through the complete strategy-center service", async () => {
  const input = bars(180),
    source: Snapshot = {
      id: "stock",
      symbol: "sh600519",
      source: "tdx-local",
      period: "day",
      adjustment: "none",
      createdAt: 1,
      hash: "raw-source",
      bars: input,
    };
  const calendar = { ...source, symbol: "sh000001", hash: "calendar" };
  const actions: BacktestActions = {
    version: "backtest-actions-1",
    status: "partial",
    symbol: source.symbol,
    start: input[0]!.date,
    end: input[179]!.date,
    events: [
      {
        date: input[150]!.date,
        category: 1,
        name: "cash dividend",
        dividend: 1,
        bonusRatio: 0,
        rightsRatio: 0,
        rightsPrice: 0,
      },
    ],
    warnings: [],
  };
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      symbol === source.symbol ? source : calendar,
    ),
    readBacktestActions: vi.fn(async () => actions),
    projectCzsc: vi.fn<typeof projectCzsc>(async (prefix) =>
      snapshot(prefix.close.length),
    ),
  };
  const request = {
    strategyId: "research-chan" as const,
    symbol: source.symbol,
    start: input[140]!.date,
    end: input[179]!.date,
    initial: 1000000,
  };
  const result = await executeStrategyCenterStudy(request, "fixture", readers);
  const native = result.frozen.native!;
  const adjusted = studySignalBars(input, [
    { date: input[150]!.date, perShare: 1 },
  ]);
  expect(native.priceBasis).toBe("forward-cash-dividend-adjusted");
  expect(native.originDate).toBe(input[0]!.date);
  expect(native.baselineDate).toBe(input[139]!.date);
  expect(native.observations[11]!.prefixHash).toBe(
    digest(adjusted.slice(0, 151)),
  );
  expect(native.observations[11]!.prefixHash).not.toBe(
    digest(input.slice(0, 151)),
  );
  expect(native.observations[10]!.prefixHash).toBe(digest(input.slice(0, 150)));
  expect(readers.projectCzsc.mock.calls[11]![0].close[150]).toBeCloseTo(
    100 / 9,
  );
  expect(result.frozen.bars).toEqual(input);
  expect(result.frozen.dividends).toEqual([
    { date: input[150]!.date, perShare: 1 },
  ]);
  expect(result.inputHash).toBe(digest(result.frozen));
  expect(result.result.fills[0]).toMatchObject({
    signalDate: input[141]!.date,
    date: input[142]!.date,
  });
  actions.events = [];
  const withoutLaterDividend = await executeStrategyCenterStudy(
    request,
    "fixture",
    readers,
  );
  expect(withoutLaterDividend.frozen.native!.observations.slice(0, 11)).toEqual(
    native.observations.slice(0, 11),
  );
  expect(withoutLaterDividend.inputHash).not.toBe(result.inputHash);
  expect(
    strategyCenterRunSchema.safeParse({
      ...request,
      start: "2024-01-01",
      end: "2024-12-31",
    }).success,
  ).toBe(true);
  expect(
    strategyCenterRunSchema.safeParse({
      ...request,
      start: "2024-01-01",
      end: "2025-01-01",
    }).success,
  ).toBe(false);
});
it("replays actual DLL complete prefixes through the same cash engine with pinned identity", async () => {
  // A fixed SSE fixture segment with two known confirmed native CH03 points;
  // the earlier 0..500 segment contains no CH03 and cannot exercise execution.
  const input = nativeFixture.high.slice(450, 900).map((high, index) => ({
    date: new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10),
    open: nativeFixture.close[index + 450]!,
    high,
    low: nativeFixture.low[index + 450]!,
    close: nativeFixture.close[index + 450]!,
    volume: nativeFixture.volume[index + 450]!,
    amount: 0,
  }));
  const capture = await captureNativeChanObservations(input, 140);
  expect(capture.observations).toHaveLength(311);
  expect(capture.identity.dllHash).toMatch(/^[a-f0-9]{64}$/);
  expect(capture.identity.apiVersion).toBe(22);
  expect(capture.identity.buildCommit).not.toBe("czsc-api-v4");
  const earlyConfirmed = capture.observations.find(
    (row) =>
      !row.baseline &&
      row.signals.some((point) => point.center.confirmedAt === -1),
  );
  expect(earlyConfirmed).toBeDefined();
  expect(
    earlyConfirmed!.signals.every(
      (point) =>
        point.center.established <=
        input.findIndex((bar) => bar.date === earlyConfirmed!.date),
    ),
  ).toBe(true);
  const result = replayDailyStudy(input, [], {
    strategy: "research-chan",
    start: input[140]!.date,
    end: input[449]!.date,
    initial: 1000000,
    nativeObservations: capture.observations,
  });
  expect(result.tradingDays).toBe(310);
  expect(result.fills.length).toBeGreaterThan(0);
  expect(result.fills.every((fill) => fill.signalDate < fill.date)).toBe(true);
  expect(result.quality).toBe("rule-check-only");
  expect(
    result.curve.every((row) => row.cash >= 0 && row.shares % 100 === 0),
  ).toBe(true);
}, 60000);
