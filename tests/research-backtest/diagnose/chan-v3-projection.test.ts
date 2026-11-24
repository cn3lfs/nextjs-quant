import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  runPortfolio,
  type PortfolioRequest,
  type PortfolioFill,
  type PortfolioInstrument,
  type PortfolioOrder,
} from "quant-backtest";
import {
  createNativeChanProfileRule,
  nativeChanV3Profiles,
  type FrozenChanObservation,
} from "trading-strategies";
import { CZSC_CTX } from "trading-strategies/research/chan/czsc";
import { chanNativeCandidates } from "trading-strategies/research/chan/research-chan-native";
import {
  analyzeCzsc,
  closeCzsc,
  getCzscTelemetry,
  projectCzsc,
} from "~/server/strategies/chan/czsc";
import type {
  CzscRawFamily,
  CzscRawSignal,
} from "~/server/strategies/chan/czsc-api";
import { captureNativeChanObservations } from "~/server/strategies/strategy-center-native";
import {
  attachNativeChanMulti,
  buildNativeChanZdAtrLevels,
  buildNativeChanZdLevels,
  decomposeChanZdImpact,
  loadNativeObservations,
  nativeChanCacheKey,
  nativeChanCh04Rules,
  nativeChanCh07Rules,
  nativeChanCh12Rules,
  nativeChanZdAtrStopRules,
} from "~/server/research/diagnose/chan-native";
import { prepareCzscTestRuntime } from "../../helpers/czsc-runtime";

beforeAll(prepareCzscTestRuntime);
afterAll(async () => {
  const { workerPid } = await getCzscTelemetry();
  await closeCzsc();
  expect(await getCzscTelemetry()).toMatchObject({
    pending: 0,
    workerPid: null,
  });
  if (workerPid !== null)
    expect(() => process.kill(workerPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
});

// Each seed produces its own swing widths and sizes. The replay starts a few
// prefixes before the first native CH07 or CH12 match on the vendored DLL.
const markets = [
  {
    symbol: "sh600000",
    seed: 2097,
    first: 935,
    positiveProfile: "chan-nested-native",
  },
  {
    symbol: "sz000001",
    seed: 1316,
    first: 618,
    positiveProfile: "chan-rebound-native",
  },
] as const;

function stock(symbol: string, bars: readonly Bar[]): PortfolioInstrument {
  return {
    symbol,
    market: "cn-equity",
    bars,
    signalBars: bars,
    execution: {
      evidence: "fixture",
      tradable: true,
      limitUp: null,
      limitDown: null,
    },
  };
}

function fixedBars({ first, seed }: (typeof markets)[number]): Bar[] {
  let state: number = seed;
  function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  }

  const bars: Bar[] = [];
  const length = first + 8;
  let start = 1000;
  for (let leg = 0; bars.length < length; leg++) {
    const span = 5 + Math.floor(random() * 6);
    const magnitude = 5 + Math.floor(random() * 70);
    const change = leg % 2 === 0 ? magnitude : -magnitude;
    for (let offset = 0; offset < span && bars.length < length; offset++) {
      const close = start + Math.round((change * offset) / span);
      bars.push({
        date: new Date(Date.UTC(2021, 0, 1 + bars.length))
          .toISOString()
          .slice(0, 10),
        open: close,
        close,
        high: close + 1,
        low: close - 1,
        volume: 1000,
        amount: 0,
      });
    }
    start += change;
  }
  return bars;
}

it.each(markets)(
  "$symbol matches direct candidates with one serial DLL call per frozen prefix",
  async (market) => {
    const bars = fixedBars(market);
    const project = vi.fn<typeof projectCzsc>(projectCzsc);
    const { observations } = await captureNativeChanObservations(
      bars,
      market.first,
      undefined,
      project,
      undefined,
      "v3",
    );
    expect(observations).toHaveLength(bars.length - market.first + 1);
    expect(project.mock.calls.map(([input]) => input.close.length)).toEqual(
      observations.map((_, i) => market.first + i),
    );
    const seen = new Set<string>();
    for (const [offset, row] of observations.entries()) {
      const prefix = bars.slice(0, market.first + offset);
      const direct = await analyzeCzsc(prefix, true, projectCzsc, true, 1);
      expect(direct.families.map((family) => family.config)).toEqual([0, 1100]);
      expect(row.v3?.configs).toEqual([0, 1100]);
      for (const profile of nativeChanV3Profiles) {
        const { signals, gaps } = chanNativeCandidates(
          profile,
          direct,
          prefix,
          0,
        );
        const fresh = signals.flatMap((signal) => {
          if (
            signal.kind <= 0 ||
            (signal.revokedAt ?? -1) >= 0 ||
            (profile !== "chan-nested-native" &&
              (signal.confirmedAt ?? -1) < signal.index)
          )
            return [];
          const key = `${signal.date}:${signal.kind}`;
          const identity = `${profile}:${key}`;
          if (seen.has(identity)) return [];
          seen.add(identity);
          const confirmedAt =
            profile === "chan-nested-native"
              ? prefix.length - 1
              : signal.confirmedAt!;
          const containment = signal.containment;
          return [
            {
              key,
              kind: signal.kind,
              endpointIndex: signal.index,
              endpointDate: signal.date,
              confirmedAt,
              confirmedDate: prefix[confirmedAt]!.date,
              ...(containment && {
                containment: {
                  highStart: containment.highCandidate.segmentStart,
                  highEnd: containment.highCandidate.segmentEnd,
                  lowStart: containment.lowStart,
                  lowEnd: containment.lowEnd,
                },
              }),
            },
          ];
        });
        expect(row.v3!.profiles[profile].signals).toEqual(fresh);
        expect(row.v3!.profiles[profile].gaps).toEqual(gaps);
      }
    }
    expect(
      observations
        .slice(1)
        .flatMap((row) => row.v3!.profiles[market.positiveProfile].signals),
      `${market.positiveProfile} must produce a fresh DLL match after warmup`,
    ).toHaveLength(1);
  },
);

it.each(markets)(
  "$symbol preserves observations and ATR stops through the cutoff after appending future bars",
  async (market) => {
    const bars = fixedBars(market);
    const { date: cutoff, close: lastClose } = bars.at(-1)!;
    const tail = [3, 0.3, 4, 0.2, 2].map((factor, i) => {
      const date = new Date(Date.parse(cutoff) + (i + 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const close = lastClose * factor;
      return {
        date,
        open: close,
        low: close * 0.9,
        high: close * 1.1,
        close,
        volume: 100,
        amount: close * 100,
      };
    });
    const original = await captureNativeChanObservations(
      bars,
      market.first,
      undefined,
      projectCzsc,
      undefined,
      "v3",
    );
    const extended = await captureNativeChanObservations(
      [...bars, ...tail],
      market.first,
      undefined,
      projectCzsc,
      undefined,
      "v3",
    );
    expect(original.observations.at(-1)?.date).toBe(cutoff);
    expect(extended.observations.filter(({ date }) => date <= cutoff)).toEqual(
      original.observations,
    );
    expect(
      extended.observations
        .filter(({ date }) => date > cutoff)
        .map(({ date }) => date),
    ).toEqual(tail.map(({ date }) => date));
    const before = buildNativeChanZdAtrLevels(original.observations, bars);
    expect(before.length).toBeGreaterThan(0);
    expect(
      buildNativeChanZdAtrLevels(extended.observations, [
        ...bars,
        ...tail,
      ]).filter(({ date }) => date <= cutoff),
    ).toEqual(before);
    const zd = buildNativeChanZdLevels(original.observations);
    for (const level of before) {
      const end = bars.findIndex(({ date }) => date === level.date);
      const range =
        bars.slice(end - 13, end + 1).reduce((sum, bar, j) => {
          const previous = bars[end - 14 + j]!.close;
          return (
            sum +
            Math.max(
              bar.high - bar.low,
              Math.abs(bar.high - previous),
              Math.abs(bar.low - previous),
            )
          );
        }, 0) / 14;
      expect(level.value).toBeCloseTo(
        zd.find(({ date }) => date === level.date)!.value - range,
        10,
      );
      expect(level.availableAt).toBe(level.date);
    }
  },
);

it.each(markets)(
  "$symbol keeps v1/v2 hashes and baseline behavior with zero extra DLL calls on a warm v3 replay",
  async (market) => {
    const cache = await mkdtemp(join(tmpdir(), "chan-v3-"));
    try {
      const bars = fixedBars(market);
      const instrument = stock(market.symbol, bars);
      const options = { nativeCacheDir: cache, projectionVersion: 3 as const };
      const before = (await getCzscTelemetry()).requests;
      const cold = await loadNativeObservations(
        instrument,
        market.first,
        options,
      );
      const { requests: afterCold, workerPid } = await getCzscTelemetry();
      expect(workerPid).not.toBeNull();
      expect(cold.cached).toBe(false);
      expect(afterCold - before).toBe(cold.entry.observations.length);
      const warm = await loadNativeObservations(
        instrument,
        market.first,
        options,
      );
      expect(warm.cached).toBe(true);
      expect(warm.entry).toEqual(cold.entry);
      expect((await getCzscTelemetry()).requests).toBe(afterCold);
      const v2 = await loadNativeObservations(instrument, market.first, {
        nativeCacheDir: cache,
      });
      const { identity: id, barsDigest } = v2.entry;
      const input = {
        symbol: market.symbol,
        firstIndex: market.first,
        barsDigest,
        dllIdentity: id,
      };
      for (const version of [1, 2]) {
        const oldHash = createHash("sha256")
          .update(
            JSON.stringify([
              "chan-native-cache-2",
              market.symbol,
              market.first,
              barsDigest,
              id.dllHash,
              id.apiVersion,
              id.buildCommit,
              id.configId,
              id.config,
              id.anchor,
              version,
            ]),
          )
          .digest("hex");
        expect(
          nativeChanCacheKey({
            ...input,
            projectionVersion: version,
            configs: [0],
          }),
        ).toBe(oldHash);
      }
      const v3Key = nativeChanCacheKey({ ...input, projectionVersion: 3 });
      expect(
        nativeChanCacheKey({
          ...input,
          projectionVersion: 3,
          configs: [1100, 0, 0],
        }),
      ).toBe(v3Key);
      expect(
        nativeChanCacheKey({ ...input, projectionVersion: 3, configs: [0] }),
      ).not.toBe(v3Key);
      expect(nativeChanCacheKey({ ...input, projectionVersion: 2 })).not.toBe(
        v3Key,
      );
      const v2Warm = await loadNativeObservations(instrument, market.first, {
        nativeCacheDir: cache,
      });
      expect(v2Warm.cached).toBe(true);
      expect(v2Warm.entry).toEqual(v2.entry);
      expect(
        v2.entry.observations.every(
          (row) => row.projectionVersion === 2 && row.v3 === undefined,
        ),
      ).toBe(true);
      const v1: FrozenChanObservation[] = v2.entry.observations.map((row) => ({
        date: row.date,
        prefixHash: row.prefixHash,
        identity: row.identity,
        baseline: row.baseline,
        signals: row.signals,
        gaps: row.gaps,
      }));
      const legacy = await loadNativeObservations(
        { ...instrument, external: { chan: v1 } },
        market.first,
        { mode: "frozen-replay" },
      );
      expect(legacy.entry.projectionVersion).toBe(1);
      expect(legacy.entry.observations).toEqual(v1);
      expect(v2.entry.observations.map(({ signals }) => signals)).toEqual(
        cold.entry.observations.map(({ signals }) => signals),
      );
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  },
);

const positiveBars = Array.from({ length: 147 }, (_, i): Bar => ({
  date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
  open: 10,
  close: 10,
  high: 11,
  low: 9,
  volume: 100_000,
  amount: 1_000_000,
}));

/** The three criteria have independent leaves, including CH07's explicit high
 * candidate ID and a low subinterval which is strictly inside the high leg. */
function candidateProjector() {
  return vi.fn<typeof projectCzsc>(async ({ close }, request) => {
    expect(request).toEqual({ recursion: true, nested: true, bars: true });
    const firstSeen = 140;
    const active =
      close.length === firstSeen + 1 || close.length >= firstSeen + 3;
    const signal: CzscRawSignal = {
      index: 130,
      type: 3,
      quality: 1,
      hindsight: 1,
      confirmedAt: firstSeen,
      revokedAt: -1,
      pivot: 2,
      center: 0,
      movement: 0,
      breakout: 0,
      basedOn: -1,
      stop: 7,
      context: CZSC_CTX.overlap,
      secondBasePivot: 0,
      secondTurnPivot: 1,
      smallTurnBasePivot: -1,
      smallTurnLeavePivot: -1,
      smallTurnRetestPivot: -1,
      divergence: {
        semantic: 1,
        holds: 1,
        newExtreme: 1,
        weakSpace: 1,
        weakSpeed: 0,
        weakArea: 1,
        prevStart: -1,
        prevEnd: -1,
        curStart: 1,
        curEnd: 2,
        prevArea: 2,
        curArea: 1,
        prevSpace: 2,
        curSpace: 1,
        prevSpeed: 2,
        curSpeed: 1,
      },
    };
    const pivot = (index: number, kind: number) => ({
      index,
      kind,
      price: kind > 0 ? 11 : 9,
      extremeIndex: index,
      fractalAt: index,
      confirmedAt: index,
    });
    const base: CzscRawFamily = {
      pivots: [pivot(110, -1), pivot(120, 1), pivot(130, -1)],
      centers: [
        {
          start: 50,
          end: 70,
          firstPivot: 0,
          lastPivot: 1,
          zg: 8,
          zd: 7,
          gg: 11,
          dd: 6,
          direction: -1,
          confirmedAt: 80,
          established: 75,
          relationToPrev: 0,
          lifecycle: 0,
        },
      ],
      signals: active ? [signal] : [],
      movements: [
        {
          type: -1,
          start: 50,
          end: 70,
          firstCenter: 0,
          lastCenter: 0,
          completedAt: -1,
          completedByIndex: -1,
          confirmedAt: -1,
          connectionStart: -1,
          connectionEnd: -1,
          successor: -1,
          successorEstablishedAt: -1,
          completedBy: -1,
          zhongyinStart: -1,
        },
      ],
      breakouts: [
        {
          center: 0,
          direction: 1,
          leavePivot: 1,
          retestPivot: 2,
          third: 1,
          confirmedAt: firstSeen,
          divergence: signal.divergence,
        },
      ],
      events: [],
      bars: [],
      nodes: [],
      children: [],
      recursiveCenters: [],
      connections: [],
    };
    const high: CzscRawFamily = {
      ...base,
      breakouts: [],
      pivots: [pivot(100, 1), pivot(135, -1)],
      signals: active
        ? [
            {
              ...signal,
              index: 135,
              type: 1,
              pivot: 1,
              breakout: -1,
              context: 0,
              divergence: { ...signal.divergence, curStart: 0, curEnd: 1 },
            },
          ]
        : [],
    };
    return {
      hash: "a".repeat(64),
      apiVersion: 22,
      buildCommit: "fixture",
      configId: "defaults",
      families: { 0: base, 1100: high },
      nested: active
        ? [
            {
              lowSignal: 0,
              highSignal: 0,
              highSegmentStart: 100,
              highSegmentEnd: 135,
              insideHighSegment: 1,
              confirmed: 1,
              newExtreme: 1,
              smallTurn: 0,
              highPrevStartLow: -1,
              highPrevEndLow: -1,
              highCurStartLow: -1,
              highCurEndLow: -1,
            },
          ]
        : [],
    };
  });
}

it("consumes genuine fixture matches once per profile, with confirmation and containment inside the known prefix", async () => {
  const project = candidateProjector();
  const bars = positiveBars;
  const instrument = stock("sh600000", bars);
  const strategies = [
    nativeChanCh04Rules(),
    nativeChanCh07Rules(),
    nativeChanCh12Rules(),
    nativeChanZdAtrStopRules(),
  ].map((rules, index) => ({
    ...rules,
    id: `test-${index}`,
    sleeve: "chan",
    version: 1,
    market: "cn-equity" as const,
    period: "day" as const,
    sizing: { kind: "weight" as const, weight: 0.1 },
    universe: { kind: "symbols" as const, symbols: [instrument.symbol] },
  }));
  const fixture = {
    sources: [],
    request: {
      start: bars[140]!.date,
      end: bars.at(-1)!.date,
      instruments: [instrument],
      strategies,
      calendar: bars.slice(140).map(({ date }) => date),
      initial: 100_000,
      market: "cn-equity" as const,
      sleeves: [{ id: "chan", share: 1, riskPerTrade: 0.01, maxPositions: 1 }],
    },
  } satisfies { sources: Record<string, unknown>[]; request: PortfolioRequest };
  const [evidence] = await attachNativeChanMulti(fixture, { project });
  expect(project).toHaveBeenCalledTimes(bars.length - 139);
  expect(evidence).toMatchObject({
    projectionVersion: 3,
    zdAtrStop: { levelCount: 1 },
  });
  const rows = instrument.external!.chan!;
  for (const profile of nativeChanV3Profiles) {
    const rule = createNativeChanProfileRule(profile, bars, rows);
    expect(rows[1]!.v3!.profiles[profile].signals).toHaveLength(1);
    expect(rule(139).enter).toBe(false);
    expect(rule(140).enter).toBe(true);
    expect(rule(142).enter).toBe(false);
    expect(rule(144, { entry: 10, entryIndex: 141 }).exit).toBe(false);
    expect(rule(145, { entry: 10, entryIndex: 141 }).exit).toBe(true);
  }
  for (const strategy of fixture.request.strategies.filter(
    ({ entry }) => entry.kind === "external",
  )) {
    const fills = runPortfolio({
      ...fixture.request,
      strategies: [strategy],
    }).fills;
    expect(fills.map(({ side, date }) => ({ side, date }))).toEqual([
      { side: "buy", date: bars[141]!.date },
      { side: "sell", date: bars[146]!.date },
    ]);
  }
  expect(
    rows[1]!.v3!.profiles["chan-nested-native"].signals[0]!.containment,
  ).toEqual({ highStart: 100, highEnd: 135, lowStart: 120, lowEnd: 130 });
  expect(instrument.external!.levels).toEqual([
    {
      date: bars[140]!.date,
      availableAt: bars[140]!.date,
      field: "chan-zd-atr",
      value: 5,
    },
  ]);
  const forged = structuredClone(rows);
  const mutable = forged[1]!.v3!.profiles["chan-nested-native"].signals[0]!;
  mutable.containment!.highEnd = 141;
  expect(() =>
    createNativeChanProfileRule("chan-nested-native", bars, forged),
  ).toThrow("区间无效");
});

it("attributes initial ZD rejects and fee-inclusive early exits of the same CH14 entry", () => {
  const order = (
    id: number,
    symbol: string,
    side: "buy" | "sell",
    day: string,
    trigger: PortfolioOrder["trigger"] = "signal",
  ): PortfolioOrder => ({
    id,
    symbol,
    sleeve: "chan",
    strategyId: "ch14",
    side,
    signalAt: "2024-01-01",
    due: day,
    status: "filled",
    reason: null,
    attempts: 1,
    trigger,
  });
  const fill = (o: PortfolioOrder, price: number): PortfolioFill => ({
    orderId: o.id,
    symbol: o.symbol,
    sleeve: o.sleeve,
    strategyId: o.strategyId,
    side: o.side,
    signalAt: o.signalAt,
    date: o.due!,
    quantity: 100,
    price,
    fee: 5,
    cashAfter: 0,
    holdingAfter: o.side === "buy" ? 100 : 0,
  });
  const a = order(1, "sh600000", "buy", "2024-01-02");
  const rejected = order(2, "sh600001", "buy", "2024-01-02");
  const normalSell = order(3, a.symbol, "sell", "2024-01-08");
  const blockedSell = order(4, rejected.symbol, "sell", "2024-01-08");
  const stop = order(5, a.symbol, "sell", "2024-01-04", "stop");
  const reason = "缺失或无效初始止损";
  const breakdown = decomposeChanZdImpact(
    {
      orders: [a, rejected, normalSell, blockedSell],
      fills: [
        fill(a, 10),
        fill(rejected, 10),
        fill(normalSell, 12),
        fill(blockedSell, 11),
      ],
      corporateActions: [],
      rejections: [],
    },
    {
      orders: [a, { ...rejected, status: "rejected", reason }, stop],
      fills: [fill(a, 10), fill(stop, 9)],
      corporateActions: [],
      rejections: [{ orderId: rejected.id, date: rejected.due!, reason }],
    },
  );
  expect(breakdown.initialZdInvalidRejections).toMatchObject([
    { orderId: rejected.id, baselineNetPnl: 90 },
  ]);
  expect(breakdown.sharedEntryEarlyStops).toMatchObject([
    {
      baseNetPnl: 190,
      zdNetPnl: -110,
      netPnlDelta: -300,
      baseExitDate: "2024-01-08",
      zdExitDate: "2024-01-04",
    },
  ]);
  expect(breakdown.sharedEntryEarlyStopNetPnlDelta).toBe(-300);
});
