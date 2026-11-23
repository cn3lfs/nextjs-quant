import { mkdtemp, rm, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import {
  nativeChanProfiles,
  type NativeChanProfile,
  type NativeStudyIdentity,
  type StrategyObjectInput,
} from "trading-strategies";
import { captureNativeChanObservations } from "~/server/strategies/strategy-center-native";
import type { projectCzsc } from "~/server/strategies/chan/czsc";
import type {
  CzscRawFamily,
  CzscRawSignal,
} from "~/server/strategies/chan/czsc-api";
import {
  attachNativeChanMulti,
  loadNativeObservations,
} from "../../../scripts/lib/backtest-diagnose/chan-native";

const identity: NativeStudyIdentity = {
  dllHash: "a".repeat(64),
  buildCommit: "fixture",
  apiVersion: 22,
  configId: "defaults",
  config: 0,
  anchor: 1,
};
const sessions: string[] = [];
for (let n = 0; sessions.length < 212; n++) {
  const d = new Date(Date.UTC(2024, 0, n + 1));
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
    sessions.push(d.toISOString().slice(0, 10));
}
function instrument(
  symbol: string,
  skip = 0,
  blocked = false,
): PortfolioInstrument {
  const price = skip ? 20 : 10;
  const bars = sessions.slice(skip).map((date) => ({
    date,
    open: price,
    close: price,
    high: price + 1,
    low: price - 1,
    volume: 1000000,
    amount: 1000000 * price,
  }));
  return {
    symbol,
    market: "cn-equity",
    bars,
    signalBars: bars,
    execution: Object.fromEntries(
      bars.map((b) => [
        b.date,
        {
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: blocked && b.date === sessions[205] ? price : null,
        },
      ]),
    ),
  };
}
function strategy(profile: NativeChanProfile): StrategyObjectInput {
  const entry = { kind: "chan-native", profile, side: "entry" } as const;
  return {
    id: profile,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600519", "sh688981"] },
    entry,
    exit:
      profile === "chan-hold-cash-native"
        ? { rule: { ...entry, side: "exit" } }
        : { maxBars: 5 },
    sizing: { kind: "weight", weight: 0.4 },
    sleeve: "test",
  };
}
function frozen(
  instruments: PortfolioInstrument[],
  profile: NativeChanProfile = "chan-hold-cash-native",
) {
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: sessions[200]!,
    end: sessions.at(-1)!,
    calendar: sessions.slice(200),
    instruments,
    strategies: [strategy(profile)],
    sleeves: [{ id: "test", share: 1, riskPerTrade: 0.01, maxPositions: 2 }],
  };
  return { request, sources: [] as Record<string, unknown>[] };
}
function signal(
  type: number,
  index: number,
  confirmedAt: number,
): CzscRawSignal {
  return {
    type,
    index,
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
// A baseline sell disappears then reappears. A fresh sell precedes all buys.
// The buy on day 201 and sell on day 204 each occur exactly once.
function projector(id: NativeStudyIdentity, sellsOnly = false) {
  return vi.fn<typeof projectCzsc>(async (input, request) => {
    expect(request).toEqual({ levels: [0], bars: false });
    const price = input.close[0]!,
      first = price === 20 ? 145 : 200,
      last = input.close.length - 1,
      day = last - first;
    const signals = [
      ...(day !== 0 ? [signal(-2, first - 7, first - 1)] : []),
      ...(day === 0 ? [signal(-2, first - 5, first)] : []),
      ...(day === 1 && !sellsOnly ? [signal(2, first, first + 1)] : []),
      ...(day === 4 ? [signal(-2, first + 3, first + 4)] : []),
    ];
    const family: CzscRawFamily = {
      pivots: [5, 10].map((index) => ({
        index,
        kind: 1,
        price,
        extremeIndex: index,
        fractalAt: index,
        confirmedAt: index,
      })),
      centers: [
        {
          start: 5,
          end: 10,
          firstPivot: 0,
          lastPivot: 1,
          zg: price,
          zd: price - 1,
          gg: price + 1,
          dd: price - 2,
          direction: 1,
          confirmedAt: 12,
          established: 11,
          relationToPrev: 0,
          lifecycle: 0,
        },
      ],
      signals,
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
      hash: id.dllHash,
      apiVersion: id.apiVersion,
      buildCommit: id.buildCommit,
      configId: id.configId,
      families: { 0: family },
      nested: [],
    };
  });
}

it("shares every prefix across four profiles and invalidates the warm cache for a changed DLL or config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chan-multi-"));
  try {
    const id = { ...identity };
    const project = projector(id);
    const options = {
      nativeCacheDir: dir,
      project,
      resolveIdentity: async () => ({ ...id }),
    };
    for (const [i, profile] of nativeChanProfiles.entries()) {
      const f = frozen([instrument("sh600519")], profile);
      const [disclosure] = await attachNativeChanMulti(f, options);
      expect(disclosure).toMatchObject({
        firstIndex: 200,
        projectionVersion: 2,
        dllHash: id.dllHash,
        cached: i > 0,
        mode: "current-dll-compute",
      });
      expect(
        runPortfolio(f.request).fills.filter((fill) => fill.side === "buy"),
      ).toHaveLength(
        profile === "chan-second-native" || profile === "chan-hold-cash-native"
          ? 1
          : 0,
      );
      expect(project).toHaveBeenCalledTimes(13);
    }
    for (const [i, change] of [
      { dllHash: "b".repeat(64) },
      { configId: "changed-defaults" },
    ].entries()) {
      Object.assign(id, change);
      const f = frozen([instrument("sh600519")]);
      const [fresh] = await attachNativeChanMulti(f, options);
      expect(fresh).toMatchObject({ cached: false, identity: { ...id } });
      expect(project).toHaveBeenCalledTimes(13 * (i + 2));
      const [warm] = await attachNativeChanMulti(f, options);
      expect(warm?.cached).toBe(true);
      const [replay] = await attachNativeChanMulti(f, {
        mode: "frozen-replay",
        resolveIdentity: () => {
          throw new Error("replay consulted installed DLL");
        },
      });
      expect(replay).toMatchObject({
        mode: "frozen-replay",
        identity: { ...id },
      });
      expect(project).toHaveBeenCalledTimes(13 * (i + 2));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("infers indices 200 and 145 in one portfolio and fills both symbols at the first open after the confirmed sell", async () => {
  const f = frozen([instrument("sh600519"), instrument("sh688981", 55)]);
  const project = projector(identity);
  const disclosures = await attachNativeChanMulti(f, {
    project,
    resolveIdentity: async () => identity,
  });
  expect(disclosures.map((d) => d.firstIndex)).toEqual([200, 145]);
  expect(f.request.strategies[0]!.entry).not.toHaveProperty("firstIndex");
  const result = runPortfolio(f.request);
  expect(result.rejections).toEqual([]);
  for (const symbol of ["sh600519", "sh688981"])
    expect(result.fills.filter((f) => f.symbol === symbol)).toMatchObject([
      { side: "buy", signalAt: sessions[201], date: sessions[202] },
      { side: "sell", signalAt: sessions[204], date: sessions[205] },
    ]);
  expect(project).toHaveBeenCalledTimes(26);
});

it("keeps a blocked sell pending and fills the same order on the next legal open with no new sell signal", async () => {
  const f = frozen([instrument("sh600519", 0, true)]);
  await attachNativeChanMulti(f, {
    project: projector(identity),
    resolveIdentity: async () => identity,
  });
  const result = runPortfolio(f.request);
  expect(result.orders).toHaveLength(2);
  const sell = result.orders[1]!;
  expect(sell).toMatchObject({
    side: "sell",
    signalAt: sessions[204],
    status: "filled",
    trigger: "signal",
    attempts: 2,
  });
  expect(result.rejections).toEqual([
    {
      orderId: sell.id,
      date: sessions[205],
      reason: expect.stringContaining("跌停"),
    },
  ]);
  expect(result.fills[1]).toMatchObject({
    orderId: sell.id,
    signalAt: sessions[204],
    date: sessions[206],
    side: "sell",
  });
});

it("fills a CH14 buy despite a first-seen sell on the same flat close, then fills a later sell", async () => {
  const f = frozen([instrument("sh600519")]);
  const project = projector(identity);
  await attachNativeChanMulti(f, {
    resolveIdentity: async () => identity,
    project: async (input, request) => {
      const raw = await project(input, request);
      if (input.close.length === 202)
        raw.families[0]!.signals.push(signal(-2, 198, 201));
      return raw;
    },
  });
  const rows = f.request.instruments[0]!.external!.chan!;
  expect(
    rows.find((r) => r.date === sessions[201])!.points!.map((p) => p.kind),
  ).toEqual([-2, 2]);
  const { orders, fills } = runPortfolio(f.request);
  expect(orders).toMatchObject([
    { side: "buy", signalAt: sessions[201], status: "filled" },
    { side: "sell", signalAt: sessions[204], status: "filled" },
  ]);
  expect(fills).toMatchObject([
    { orderId: orders[0]!.id, date: sessions[202] },
    { orderId: orders[1]!.id, date: sessions[205], holdingAfter: 0 },
  ]);
});

it("preserves a valid third buy alongside a sell with no center and blocks profiles requiring the complete projection", async () => {
  const stock = instrument("sh600519");
  const f = frozen([stock], "chan-third-native");
  const project = projector(identity);
  await attachNativeChanMulti(f, {
    resolveIdentity: async () => identity,
    project: async (input, request) => {
      const raw = await project(input, request);
      if (input.close.length === 202) {
        const family = raw.families[0]!;
        family.centers[0]!.zg = 8;
        family.centers[0]!.zd = 7;
        family.signals = [
          signal(3, 199, 201),
          { ...signal(-2, 198, 201), center: -1 },
        ];
      }
      return raw;
    },
  });
  const row = stock.external!.chan!.find((r) => r.date === sessions[201])!;
  expect(row).toMatchObject({
    gaps: [],
    pointGaps: [expect.stringContaining("中枢归属")],
    points: [{ kind: 3 }],
    signals: [{ key: `${sessions[199]}:3` }],
  });
  for (const entry of [
    { kind: "chan-third-buy" } as const,
    strategy("chan-third-native").entry,
  ]) {
    f.request.strategies = [{ ...strategy("chan-third-native"), entry }];
    expect(runPortfolio(f.request).fills[0]).toMatchObject({
      side: "buy",
      signalAt: sessions[201],
      date: sessions[202],
    });
  }
  for (const profile of nativeChanProfiles.filter(
    (p) => p !== "chan-third-native",
  )) {
    f.request.strategies = [strategy(profile)];
    expect(() => runPortfolio(f.request)).toThrow("结构缺口");
  }
});

it("ignores confirmed sells while flat and never emits a withdrawn baseline point again", async () => {
  const stock = instrument("sh600519");
  const capture = await captureNativeChanObservations(
    stock.bars,
    200,
    undefined,
    projector(identity, true),
  );
  const key = `${sessions[193]}:-2`;
  expect(
    capture.audit.filter((a) => a.key === key).map((a) => a.event),
  ).toEqual(["baseline", "withdrawn", "reappeared"]);
  expect(
    capture.observations.flatMap((o) => o.points!).filter((p) => p.key === key),
  ).toHaveLength(1);
  expect(capture.observations[1]!.points?.some((p) => p.kind < 0)).toBe(true);
  stock.external = { chan: capture.observations };
  expect(runPortfolio(frozen([stock]).request).orders).toEqual([]);
});

it("reuses the cold identity probe as the real baseline and refuses a linked cache directory", async () => {
  const project = projector(identity);
  await loadNativeObservations(instrument("sh600519"), 200, { project });
  expect(project.mock.calls.map(([p]) => p.close.length)).toEqual(
    Array.from({ length: 13 }, (_, i) => 200 + i),
  );
  const parent = await mkdtemp(join(tmpdir(), "chan-multi-link-"));
  try {
    const link = join(parent, "cache");
    await symlink(parent, link, "junction");
    await expect(
      loadNativeObservations(instrument("sh600519"), 200, {
        project,
        nativeCacheDir: link,
      }),
    ).rejects.toThrow("non-symlink");
    expect(await readdir(parent)).toEqual(["cache"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("coalesces competing warm-cache writers and refuses to cache a changed identity mid-capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chan-writers-"));
  try {
    const stock = instrument("sh600519");
    const project = projector(identity);
    const options = {
      nativeCacheDir: dir,
      project,
      resolveIdentity: async () => identity,
    };
    const [a, b] = await Promise.all([
      loadNativeObservations(stock, 200, options),
      loadNativeObservations(stock, 200, options),
    ]);
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(project).toHaveBeenCalledTimes(13);
    const files = await readdir(dir);
    await expect(
      loadNativeObservations(stock, 200, {
        ...options,
        resolveIdentity: async () => ({
          ...identity,
          configId: "changed-at-lookup",
        }),
      }),
    ).rejects.toThrow("当前DLL");
    expect(await readdir(dir)).toEqual(files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rebinds an explicit legacy index only for a single symbol and drops a shared index in a portfolio", async () => {
  const project = projector(identity);
  const options = { project, resolveIdentity: async () => identity };
  const legacy = {
    ...strategy("chan-third-native"),
    entry: { kind: "chan-third-buy" as const, firstIndex: 140 },
  };
  const single = frozen([instrument("sh600519")]);
  single.request.strategies = [legacy];
  await attachNativeChanMulti(single, options);
  expect(single.request.strategies[0]!.entry).toEqual({
    kind: "chan-third-buy",
    firstIndex: 200,
  });
  const multi = frozen([instrument("sh600519"), instrument("sh688981", 55)]);
  multi.request.strategies = [legacy];
  await attachNativeChanMulti(multi, options);
  expect(multi.request.strategies[0]!.entry).toEqual({
    kind: "chan-third-buy",
  });
  expect(() => runPortfolio(multi.request)).not.toThrow();
  single.request.strategies = [
    {
      ...legacy,
      entry: {
        kind: "chan-native",
        profile: "chan-first-native",
        side: "entry",
        firstIndex: 145,
      },
    },
  ];
  await expect(attachNativeChanMulti(single, options)).rejects.toThrow(
    "显式执行起点",
  );
  expect(project).toHaveBeenCalledTimes(39);
});
