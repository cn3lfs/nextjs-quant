import { expect, it } from "vitest";
import {
  nativeChanSignals,
  createNativeStudyRule,
  type FrozenChanObservation,
} from "../src/native-study.js";
import type { CzscResult } from "../src/research/chan/czsc.js";

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
