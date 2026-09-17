import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import type {
  CzscFamily,
  CzscHighCandidate,
  CzscResult,
} from "../src/lib/czsc";
import { chanNativeCandidates } from "../src/lib/research-chan-native";
import { researchSignals } from "../src/server/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";
const bars: Bar[] = Array.from({ length: 66 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  close: 10,
  high: 11,
  low: 9,
  volume: 100,
  amount: 1000,
}));
function context(): CzscResult {
  const highCandidate: CzscHighCandidate = {
    id: 7,
    config: 1100,
    index: 50,
    kind: 1,
    pointId: 2,
    segmentStartPointId: 1,
    segmentEndPointId: 2,
    segmentStart: 20,
    segmentEnd: 50,
    semantic: 1,
    divergence: true,
    trendId: 8,
    centerId: 1,
    source: 1,
    priority: 30,
    quality: 1,
    unit: 2,
    newExtreme: true,
    weakSpace: true,
    weakSpeed: false,
    weakMacd: true,
    currentStart: 10,
    currentEnd: 50,
  };
  const base = (config: 0 | 1100): CzscFamily => ({
    config,
    points: [],
    centers: [
      {
        start: 5,
        end: 15,
        startDate: bars[5]!.date,
        endDate: bars[15]!.date,
        direction: -1,
        ZD: 7,
        ZG: 8,
        DD: 6,
        GG: 12,
      },
    ],
    signals: [],
    movements: [],
    qualities: [],
    divergences: [],
    diagnostics: {
      version: "native-projections-b67f3c6-1",
      ma: [],
      lifecycle: [],
      nested: [],
    },
    native: {
      version: "native-projections-c2-1",
      config,
      trends: [],
      highCandidates: [
        highCandidate,
        { ...highCandidate, id: 9, kind: 2, source: 2 },
        { ...highCandidate, id: 10, kind: 3, source: 3 },
      ],
      completedSequence: "unavailable",
    },
  });
  const low = base(0),
    high = base(1100);
  low.points = [25, 40].map((index, i) => ({
    index,
    date: bars[index]!.date,
    direction: i === 0 ? 1 : -1,
    price: i === 0 ? 11 : 9,
  }));
  high.points = [20, 50].map((index, i) => ({
    index,
    date: bars[index]!.date,
    direction: i === 0 ? 1 : -1,
    price: i === 0 ? 11 : 9,
  }));
  high.native!.trends = [
    {
      id: 8,
      config: 1100,
      unit: 2,
      type: -1,
      start: 5,
      end: 15,
      firstCenterId: 1,
      lastCenterId: 1,
      memberCenterIds: [1],
      completion: "unknown",
      theoreticalLevel: null,
    },
  ];
  low.diagnostics!.nested = [
    {
      lowConfig: 0,
      sourceConfig: 1100,
      index: 40,
      level: 1,
      sourceCandidateId: 7,
      lowStartPointId: 1,
      lowEndPointId: 2,
      semantic: 1,
      confirmFlags: 7,
      direction: 1,
    },
  ];
  low.signals = [
    { index: 40, date: bars[40]!.date, kind: 3, quality: 1, centerId: 1 },
  ];
  return {
    status: "structure",
    hash: "fixed-c2",
    sourceCommit: "b67f3c6",
    families: [low, high],
  };
}
it("CH07 joins 50->71 by ID across bars, with no winning signals on either level", () => {
  const r = context();
  r.families[0]!.signals = [];
  const found = chanNativeCandidates("chan-nested-native", r, bars, 0);
  expect(found.gaps).toEqual([]);
  expect(found.signals).toHaveLength(1);
  expect(found.signals[0]!.containment).toMatchObject({
    highCandidate: { id: 7, index: 50 },
    lowStart: 25,
    lowEnd: 40,
  });
  expect(r.families[1]!.native!.highCandidates.map((c) => c.kind)).toEqual([
    1, 2, 3,
  ]);
});
it("CH07 rejects whole-segment equality, outside range and missing IDs; never cross-wires config0", () => {
  const r = context(),
    low = r.families[0]!;
  low.points[0]!.index = 20;
  low.points[1]!.index = 50;
  low.diagnostics!.nested[0]!.index = 50;
  expect(
    chanNativeCandidates("chan-nested-native", r, bars, 0).signals,
  ).toEqual([]);
  low.points[0]!.index = 19;
  expect(
    chanNativeCandidates("chan-nested-native", r, bars, 0).signals,
  ).toEqual([]);
  low.diagnostics!.nested[0]!.sourceCandidateId = 99;
  expect(
    chanNativeCandidates("chan-nested-native", r, bars, 0).gaps.join(),
  ).toContain("output50");
  const bad = context();
  bad.families[0]!.native!.trends = bad.families[1]!.native!.trends;
  bad.families[1]!.native!.trends = [];
  expect(
    chanNativeCandidates("chan-nested-native", bad, bars, 0).gaps.join(),
  ).toContain("config1100");
  expect(
    chanNativeCandidates("chan-nested-native", context(), bars, 1100).gaps
      .length,
  ).toBeGreaterThan(0);
});
it("CH07 accepts one equal boundary but requires native divergence confirmation", () => {
  const r = context();
  r.families[0]!.points[0]!.index = 20;
  expect(
    chanNativeCandidates("chan-nested-native", r, bars, 0).signals,
  ).toHaveLength(1);
  r.families[0]!.diagnostics!.nested[0]!.confirmFlags = 1;
  expect(
    chanNativeCandidates("chan-nested-native", r, bars, 0).signals,
  ).toEqual([]);
});
it("CH12 includes confirmed low third buys inside the high divergence interval, rejects outside, unconfirmed and bare kinds", () => {
  const r = context();
  expect(
    chanNativeCandidates("chan-rebound-native", r, bars, 0).signals,
  ).toHaveLength(1);
  const c = r.families[1]!.native!.highCandidates[0]!;
  c.divergence = false;
  expect(
    chanNativeCandidates("chan-rebound-native", r, bars, 0).signals,
  ).toEqual([]);
  c.divergence = true;
  c.quality = 0;
  expect(
    chanNativeCandidates("chan-rebound-native", r, bars, 0).signals,
  ).toEqual([]);
  c.quality = 1;
  const s = r.families[0]!.signals[0]!;
  s.index = 51;
  s.date = bars[51]!.date;
  expect(
    chanNativeCandidates("chan-rebound-native", r, bars, 0).signals,
  ).toEqual([]);
  s.index = 40;
  s.date = bars[40]!.date;
  s.quality = 0;
  expect(
    chanNativeCandidates("chan-rebound-native", r, bars, 0).signals,
  ).toEqual([]);
});
it.each(["chan-nested-native", "chan-rebound-native"] as const)(
  "%s freezes the first prefix that establishes containment, not the historical endpoint",
  async (id) => {
    const spec = researchSpecSchema.parse({
      strategy: id,
      start: bars[61]!.date,
      end: bars[65]!.date,
      validationStart: bars[64]!.date,
    });
    const calls: number[] = [];
    const read = async (prefix: readonly Bar[]) => {
      calls.push(prefix.length);
      const r = context();
      if (prefix.length < 63) {
        r.families[1]!.native!.highCandidates = [];
        r.families[0]!.diagnostics!.nested = [];
      }
      return r;
    };
    const events = await researchSignals("sh600000", bars, spec, read);
    expect(calls).toEqual([61, 62, 63, 64, 65, 66]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      endpointDate: bars[40]!.date,
      observedDate: bars[62]!.date,
    });
    expect(JSON.parse(events[0]!.evidence!)).toMatchObject({
      candidateAt: bars[40]!.date,
      confirmedAt: bars[62]!.date,
      point: { containment: { highCandidate: { id: 7 } } },
    });
    expect(
      await researchSignals(
        "sh600000",
        bars.slice(0, 62),
        { ...spec, end: bars[61]!.date, validationStart: bars[61]!.date },
        read,
      ),
    ).toEqual([]);
  },
);
