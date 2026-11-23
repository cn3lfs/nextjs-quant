import { expect, it, vi } from "vitest";
import {
  nativeChanSignals,
  nativeChanSharedPoints,
  createNativeChanProfileRule,
  resolveNativeChanFirstIndex,
  nativeChanProfiles,
  createNativeStudyRule,
  type FrozenChanObservation,
} from "../src/native-study.js";
import type { CzscResult } from "../src/research/chan/czsc.js";
import {
  prepareStrategy,
  type StrategyObjectInput,
} from "../src/strategy-object.js";

const bars = Array.from({ length: 160 }, (_, i) => ({
  date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 100,
  amount: 1000,
}));
function result(): CzscResult {
  return {
    status: "structure",
    hash: "a".repeat(64),
    sourceCommit: "czsc-api-v4",
    configId: "fixture-config",
    families: [
      {
        config: 0,
        points: [],
        movements: [],
        qualities: [],
        divergences: [],
        centers: [
          {
            start: 90,
            end: 100,
            startDate: bars[90]!.date,
            endDate: bars[100]!.date,
            direction: 1,
            ZD: 7,
            ZG: 8,
            DD: 6,
            GG: 9,
            confirmedAt: 104,
            established: 103,
          },
        ],
        signals: [
          {
            index: 137,
            date: bars[137]!.date,
            kind: 3,
            quality: 1,
            centerId: 1,
            confirmedAt: 140,
            revokedAt: -1,
          },
        ],
      },
    ],
  };
}
function feed(): FrozenChanObservation[] {
  const signal = nativeChanSignals(bars.slice(0, 141), result()).signals[0]!;
  return bars.slice(139).map((bar, j) => ({
    date: bar.date,
    prefixHash: "b".repeat(64),
    identity: {
      dllHash: "a".repeat(64),
      apiVersion: 22,
      buildCommit: "fixture-native-build",
      configId: "fixture-config",
      config: 0,
      anchor: 1,
    },
    baseline: j === 0,
    signals: j === 1 ? [signal] : [],
    gaps: [],
  }));
}

const chanStrategy = {
  id: "native-chan-test",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "chan-third-buy", firstIndex: 140 },
  exit: { maxBars: 5 },
  sizing: { kind: "weight", weight: 1 },
  sleeve: "test",
} satisfies StrategyObjectInput;

it("prepares an empty native strategy without requiring observations", () => {
  expect(() => prepareStrategy(chanStrategy, [])).not.toThrow();
});

it("requires serial native observations only from the first executable bar", () => {
  const prepared = prepareStrategy(chanStrategy, bars);
  expect(prepared.evaluate(138).entry).toBeNull();
  expect(prepared.evaluate(139).entry).toBe(false);
  expect(() => prepared.evaluate(140)).toThrow(
    "Missing serial native observations",
  );
});

it("matches the native rule and validates the observation feed only once", () => {
  const observations = feed();
  const nativeRule = createNativeStudyRule(bars, 140, observations);
  const readBaseline = vi.fn(() => observations[0]!);
  const trackedFeed = [...observations];
  Object.defineProperty(trackedFeed, 0, { get: readBaseline });
  const prepared = prepareStrategy(chanStrategy, bars, { chan: trackedFeed });

  expect(prepared.evaluate(138).entry).toBeNull();
  expect(prepared.evaluate(139).entry).toBe(false);
  expect(readBaseline).not.toHaveBeenCalled();

  for (let i = 139; i < bars.length; i++) {
    const expected = i === 140;
    expect(nativeRule(i, { entry: 0, entryIndex: i }).enter).toBe(expected);
    expect(prepared.evaluate(i).entry).toBe(expected);
  }
  expect(readBaseline).toHaveBeenCalledTimes(1);
});

it("rejects a DLL hash change even in the last observation on first evaluation", () => {
  const chan = feed();
  chan.at(-1)!.identity.dllHash = "c".repeat(64);
  const prepared = prepareStrategy(chanStrategy, bars, { chan });
  expect(() => prepared.evaluate(140)).toThrow("回放期间原生DLL或配置变化");
});

it("rejects a signal referring to a future bar during native evaluation", () => {
  const chan = feed();
  chan[1]!.signals = chan[1]!.signals.map((signal) => ({
    ...signal,
    confirmedAt: 141,
    confirmedDate: bars[141]!.date,
  }));
  const prepared = prepareStrategy(chanStrategy, bars, { chan });
  expect(() => prepared.evaluate(140)).toThrow("引用超出当前已知前缀");
});

it("does not backdate an endpoint and waits for current-prefix confirmation", () => {
  const earlier = result();
  earlier.families[0]!.signals[0]!.confirmedAt = -1;
  expect(nativeChanSignals(bars.slice(0, 140), earlier)).toMatchObject({
    signals: [],
    gaps: [],
    pending: [expect.any(String)],
  });
  const observed = nativeChanSignals(bars.slice(0, 141), result());
  expect(observed.signals).toMatchObject([
    { endpointDate: bars[137]!.date, confirmedDate: bars[140]!.date },
  ]);
  expect(observed.gaps).toEqual([]);
});
it("rejects future/native missing confirmation metadata and excludes revoked signals", () => {
  const future = result();
  expect(nativeChanSignals(bars.slice(0, 140), future).gaps).toHaveLength(1);
  future.families[0]!.signals[0]!.confirmedAt = undefined;
  expect(nativeChanSignals(bars, future).gaps).toHaveLength(1);
  const revoked = result();
  revoked.families[0]!.signals[0]!.revokedAt = 145;
  expect(nativeChanSignals(bars, revoked).signals).toEqual([]);
});
it("admits an established center without waiting for later finalization of its extended end", () => {
  const current = result();
  current.families[0]!.centers[0]!.confirmedAt = -1;
  const decoded = nativeChanSignals(bars.slice(0, 141), current);
  expect(decoded.signals).toHaveLength(1);
  expect(decoded.signals[0]!.center).toMatchObject({
    established: 103,
    confirmedAt: -1,
  });
  const rows = feed();
  rows[1]!.signals = decoded.signals;
  expect(
    createNativeStudyRule(bars, 140, rows)(140, { entry: 0, entryIndex: 140 })
      .enter,
  ).toBe(true);
  current.families[0]!.centers[0]!.established = 141;
  expect(nativeChanSignals(bars.slice(0, 141), current).gaps).toHaveLength(1);
  current.families[0]!.centers[0]!.established = undefined;
  expect(nativeChanSignals(bars.slice(0, 141), current).gaps).toHaveLength(1);
});
it("uses actual observation dates, ignores baseline entries, and exits after five held records", () => {
  const rows = feed(),
    rule = createNativeStudyRule(bars, 140, rows);
  expect(rule(139, { entry: 0, entryIndex: 139 }).enter).toBe(false);
  expect(rule(140, { entry: 0, entryIndex: 140 }).enter).toBe(true);
  expect(rule(141, { entry: 0, entryIndex: 141 }).enter).toBe(false);
  expect(rule(145, { entry: 10, entryIndex: 141 }).exit).toBe(false);
  expect(rule(146, { entry: 10, entryIndex: 141 }).exit).toBe(true);
  const baseline = feed();
  baseline[0]!.signals = baseline[1]!.signals.map((signal) => ({
    ...signal,
    confirmedAt: 139,
    confirmedDate: bars[139]!.date,
  }));
  baseline[1]!.signals = [];
  expect(
    createNativeStudyRule(
      bars,
      140,
      baseline,
    )(139, { entry: 0, entryIndex: 139 }).enter,
  ).toBe(false);
});
it("rejects missing dates, changed DLL/configuration, duplicate entries, gaps and future references", () => {
  expect(() => createNativeStudyRule(bars, 140, feed().slice(1))).toThrow(
    "完整覆盖",
  );
  const changed = feed();
  changed[2]!.identity.dllHash = "c".repeat(64);
  expect(() => createNativeStudyRule(bars, 140, changed)).toThrow("配置变化");
  const duplicate = feed();
  duplicate[2]!.signals = duplicate[1]!.signals;
  expect(() => createNativeStudyRule(bars, 140, duplicate)).toThrow("重复");
  const gaps = feed();
  gaps[2]!.gaps = ["missing center"];
  expect(() => createNativeStudyRule(bars, 140, gaps)).toThrow("无效");
  const future = feed();
  future[1]!.signals[0]!.center.confirmedAt = 159;
  expect(() => createNativeStudyRule(bars, 140, future)).toThrow("超出");
});

function signedFeed() {
  const snapshot = result();
  const family = snapshot.families[0]!;
  const template = family.signals[0]!;
  const center = family.centers[0]!;
  family.centers.push({ ...center, ZD: 12, ZG: 13 });
  family.signals = ([1, 2, 3, -1, -2, -3] as const).map((kind, j) => ({
    ...template,
    kind,
    index: 130 + j,
    date: bars[130 + j]!.date,
    centerId: kind === 1 || kind === -3 ? 2 : 1,
    divergence: {
      semantic: 1,
      flags: 17,
      areaRatio: 1,
      speedRatio: 1,
      priceRatio: 1,
    },
  }));
  const decoded = nativeChanSharedPoints(bars.slice(0, 141), snapshot);
  expect(decoded.gaps).toEqual([]);
  expect(decoded.signals).toEqual(
    nativeChanSignals(bars.slice(0, 141), snapshot).signals,
  );
  expect(decoded.points.map((p) => p.kind)).toEqual([1, 2, 3, -1, -2, -3]);
  const rows = feed();
  for (const [i, row] of rows.entries()) {
    row.projectionVersion = 2;
    row.points = decoded.points
      .slice(i - 1, i)
      .map((p) => ({ ...p, confirmedAt: 139 + i, confirmedDate: row.date }));
    row.signals = row.points
      .filter((p) => p.kind === 3)
      .map((p) => ({
        ...decoded.signals[0]!,
        confirmedAt: p.confirmedAt,
        confirmedDate: p.confirmedDate,
      }));
  }
  return rows;
}

it("uses each signed kind on its observation date and preserves legacy third-buy decisions", () => {
  const rows = signedFeed();
  const legacy = createNativeStudyRule(bars, 140, rows);
  const flat = { entry: 0, entryIndex: 140 };
  const held = { entry: 10, entryIndex: 140 };
  for (const [n, profile] of nativeChanProfiles.entries()) {
    const rule = createNativeChanProfileRule(profile, bars, rows);
    for (let i = 139; i < bars.length; i++) {
      expect(rule(i, flat).enter).toBe(
        n === 3 ? i >= 140 && i <= 142 : i === 140 + n,
      );
      expect(rule(i, held).exit).toBe(
        n === 3 ? i >= 143 && i <= 145 : i >= 145,
      );
      if (n === 2) expect(rule(i, held)).toEqual(legacy(i, held));
    }
  }
  const v1 = feed();
  for (let i = 139; i < bars.length; i++)
    expect(
      createNativeChanProfileRule("chan-third-native", bars, v1)(i, held),
    ).toEqual(createNativeStudyRule(bars, 140, v1)(i, held));
  expect(() =>
    createNativeChanProfileRule("chan-first-native", bars, v1),
  ).toThrow("v2");
});

it("keeps a simultaneous CH14 buy eligible while flat and honors the next sell while holding", () => {
  const rows = signedFeed();
  const buyRow = rows[1]!;
  const sellRow = rows[5]!;
  buyRow.points = [
    ...buyRow.points!,
    {
      ...sellRow.points![0]!,
      confirmedAt: 140,
      confirmedDate: buyRow.date,
    },
  ];
  sellRow.points = [];
  const profile = "chan-hold-cash-native";
  const rule = createNativeChanProfileRule(profile, bars, rows);
  const entry = { kind: "chan-native", profile, side: "entry" } as const;
  const prepared = prepareStrategy(
    { ...chanStrategy, entry, exit: { rule: { ...entry, side: "exit" } } },
    bars,
    { chan: rows },
  );
  for (const flat of [undefined, { entry: 0, entryIndex: 140 }]) {
    expect(rule(140, flat)).toEqual({ enter: true, exit: false });
    expect(prepared.evaluate(140, flat)).toMatchObject({
      entry: true,
      exit: false,
    });
  }
  const held = { entry: 10, entryIndex: 141 };
  expect(rule(143, held).exit).toBe(true);
  expect(prepared.evaluate(143, held)).toMatchObject({
    entry: false,
    exit: true,
  });
});

it("rejects future sell confirmation, unproven divergence, inconsistent third buys and duplicate signed keys", () => {
  const rule = (rows: FrozenChanObservation[]) =>
    createNativeChanProfileRule("chan-hold-cash-native", bars, rows);
  const future = signedFeed();
  future[4]!.points![0]!.confirmedAt++;
  expect(() => rule(future)).toThrow("超出");
  const invalid = signedFeed();
  invalid[1]!.points![0]!.divergence!.flags = 16;
  expect(() => rule(invalid)).toThrow("原生信号");
  const inconsistent = signedFeed();
  inconsistent[3]!.signals = [];
  expect(() => rule(inconsistent)).toThrow("不一致");
  const duplicate = signedFeed();
  duplicate[8]!.points = duplicate[4]!.points;
  expect(() => rule(duplicate)).toThrow("重复");
});

it("infers each symbol's baseline, suppresses baseline buys and sells, and validates new rules at baseline", () => {
  for (const first of [140, 145]) {
    const rows = signedFeed().slice(first - 140);
    rows[0]!.baseline = true;
    expect(resolveNativeChanFirstIndex(bars, rows)).toBe(first);
    const rule = createNativeChanProfileRule(
      "chan-hold-cash-native",
      bars,
      rows,
    );
    expect(rule(first - 1, { entry: 10, entryIndex: 0 })).toEqual({
      enter: false,
      exit: false,
    });
    const entry = {
      kind: "chan-native",
      profile: "chan-hold-cash-native",
      side: "entry",
    } as const;
    const prepared = prepareStrategy({ ...chanStrategy, entry }, bars, {
      chan: rows,
    });
    expect(prepared.evaluate(first - 2).entry).toBeNull();
    expect(prepared.evaluate(first - 1).entry).toBe(false);
    const legacy = prepareStrategy(
      { ...chanStrategy, entry: { kind: "chan-third-buy" } },
      bars,
      { chan: rows },
    );
    expect(legacy.evaluate(first).entry).toBe(rows[1]!.signals.length > 0);
    expect(() => resolveNativeChanFirstIndex(bars, rows, first + 1)).toThrow(
      "基线",
    );
    rows.at(-1)!.identity.apiVersion = 21;
    const malformed = prepareStrategy({ ...chanStrategy, entry }, bars, {
      chan: rows,
    });
    expect(() => malformed.evaluate(first - 1)).toThrow("身份");
  }
});
