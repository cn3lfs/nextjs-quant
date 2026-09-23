import { afterAll, beforeAll, expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import type { CzscResult } from "../../../../src/lib/research/methods/chan/czsc";
import { chanNativeCandidates } from "../../../../src/lib/research/methods/chan/research-chan-native";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { analyzeCzsc, closeCzsc } from "../../../../src/server/strategies/chan/czsc";
import { prepareCzscTestRuntime } from "../../../helpers/czsc-runtime";
import fixture from "../../../fixtures/czsc-sse.json";

const chanNativeIds = [
  "chan-first-native",
  "chan-second-native",
  "chan-third-native",
] as const;
const bars: Bar[] = Array.from({ length: 66 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  close: 10,
  high: 11,
  low: 9,
  volume: 100,
  amount: 1000,
}));
function native(kind: number): CzscResult {
  return {
    status: "structure",
    hash: "fixture-native",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        points: [],
        centers: [
          {
            start: 10,
            end: 20,
            startDate: bars[10]!.date,
            endDate: bars[20]!.date,
            direction: 1,
            ZD: kind === 1 ? 10 : 7,
            ZG: kind === 1 ? 12 : 8,
            DD: 6,
            GG: 13,
          },
        ],
        movements: [],
        qualities: [],
        divergences: [],
        signals: [
          {
            index: 30,
            date: bars[30]!.date,
            kind,
            quality: 1,
            centerId: 1,
            divergence: {
              areaRatio: 0.5,
              priceRatio: 0.5,
              speedRatio: 0.5,
              semantic: 1,
              flags: 17,
            },
          },
        ],
      },
    ],
  };
}
it.each(chanNativeIds)(
  "%s selects only its native kind with valid 1-based center ownership",
  (id) => {
    const kind = chanNativeIds.indexOf(id) + 1,
      r = native(kind);
    expect(chanNativeCandidates(id, r, bars, 0)).toMatchObject({
      signals: [{ kind }],
      gaps: [],
    });
    r.families[0]!.signals[0]!.quality = 0;
    expect(chanNativeCandidates(id, r, bars, 0).signals).toEqual([]);
    r.families[0]!.signals[0]!.quality = 1;
    r.families[0]!.signals[0]!.centerId = 0;
    expect(chanNativeCandidates(id, r, bars, 0).gaps[0]).toContain("结构缺口");
  },
);
it("first buy rejects bare kind, consolidation semantics and unconfirmed divergence; third equality is not above ZG", () => {
  const r = native(1),
    s = r.families[0]!.signals[0]!;
  s.divergence!.semantic = 2;
  expect(chanNativeCandidates("chan-first-native", r, bars, 0).signals).toEqual(
    [],
  );
  s.divergence!.semantic = 1;
  s.divergence!.flags = 1;
  expect(chanNativeCandidates("chan-first-native", r, bars, 0).signals).toEqual(
    [],
  );
  delete s.divergence;
  expect(
    chanNativeCandidates("chan-first-native", r, bars, 0).gaps[0],
  ).toContain("背驰");
  const third = native(3);
  third.families[0]!.centers[0]!.ZG = 9;
  expect(
    chanNativeCandidates("chan-third-native", third, bars, 0).signals,
  ).toEqual([]);
});
it("native Float32 equality cannot become a false above-ZG third buy", () => {
  const r = native(3),
    input = structuredClone(bars);
  input[30]!.low = 8.2;
  r.families[0]!.centers[0]!.ZG = Math.fround(8.2);
  expect(input[30]!.low).toBeGreaterThan(r.families[0]!.centers[0]!.ZG);
  expect(
    chanNativeCandidates("chan-third-native", r, input, 0).signals,
  ).toEqual([]);
  expect(
    chanNativeCandidates("chan-third-native", { ...r, families: [] }, input, 0)
      .gaps[0],
  ).toContain("结构缺口");
});
it.each(chanNativeIds)(
  "%s observes delayed endpoints through serial complete prefixes and does not relabel the past",
  async (id) => {
    const kind = chanNativeIds.indexOf(id) + 1,
      calls: number[] = [],
      spec = researchSpecSchema.parse({
        strategy: id,
        start: bars[61]!.date,
        end: bars[65]!.date,
        validationStart: bars[64]!.date,
      });
    let active = 0,
      maxActive = 0;
    const read = async (prefix: readonly Bar[]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(prefix.length);
      await Promise.resolve();
      active--;
      const r = native(kind);
      if (prefix.length < 63) r.families[0]!.signals = [];
      return r;
    };
    const e = await researchSignals("sh600000", bars, spec, read);
    expect(calls).toEqual([61, 62, 63, 64, 65, 66]);
    expect(maxActive).toBe(1);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      endpointDate: bars[30]!.date,
      observedDate: bars[62]!.date,
      strategyVersion: `${id}-engineering-1/b67f3c6/fixture-native`,
    });
    expect(
      await researchSignals(
        "sh600000",
        bars.slice(0, 62),
        { ...spec, end: bars[61]!.date, validationStart: bars[61]!.date },
        read,
      ),
    ).toEqual([]);
    await expect(
      researchSignals("sh600000", bars, spec, async (p) => {
        const r = await read(p);
        if (p.length === 64) r.hash = "changed";
        return r;
      }),
    ).rejects.toThrow("DLL版本变化");
  },
);
it("missing native metadata is a structural gap, not a silent zero-signal result", async () => {
  const spec = researchSpecSchema.parse({
    strategy: "chan-third-native",
    start: bars[61]!.date,
    end: bars[65]!.date,
    validationStart: bars[64]!.date,
  });
  await expect(
    researchSignals("sh600000", bars, spec, async () => {
      const r = native(3);
      delete r.families[0]!.signals[0]!.centerId;
      return r;
    }),
  ).rejects.toThrow("结构缺口");
});

beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);
it("locked real DLL fixture proves third-buy ownership; this fixture has no first/second buys", async () => {
  const b = fixture.date.map((date, i) => ({
    date,
    open: fixture.close[i]!,
    close: fixture.close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeCzsc(b, true);
  expect(result.hash).toBe(
    "7f2b2ec4703ed67c811046d0b2b73a1f40b6266cd3abaeb2620e2ece47e77457",
  );
  for (const id of chanNativeIds) {
    const selected = chanNativeCandidates(id, result, b, 0);
    expect(selected.gaps).toEqual([]);
    if (id === "chan-third-native")
      expect(selected.signals.length).toBeGreaterThan(0);
    else {
      expect(
        result.families
          .find((f) => f.config === 0)!
          .signals.filter(
            (p) => p.kind === (id === "chan-first-native" ? 1 : 2),
          ),
      ).toEqual([]);
      expect(selected.signals).toEqual([]);
    }
    expect(selected.signals.every((p) => p.centerId! >= 1)).toBe(true);
  }
});
