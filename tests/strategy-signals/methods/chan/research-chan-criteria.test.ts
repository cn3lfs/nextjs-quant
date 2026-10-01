import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CZSC_CTX,
  type CzscResult,
  type CzscSignalStructure,
} from "~/lib/research/methods/chan/czsc";
import {
  chanStructureCriterion,
  chanStructureTasks,
} from "~/lib/research/methods/chan/research-chan-criteria";
import {
  analyzeCzsc,
  closeCzsc,
  projectCzsc,
} from "~/server/strategies/chan/czsc";
import { CZSC_FLAG_HIGHER } from "~/server/strategies/chan/czsc-api";
import { prepareCzscTestRuntime } from "../../../helpers/czsc-runtime";
import fixture from "../../../fixtures/czsc-sse.json";

const bars = fixture.date.map((date, i) => ({
  date,
  open: fixture.close[i]!,
  close: fixture.close[i]!,
  high: fixture.high[i]!,
  low: fixture.low[i]!,
  volume: fixture.volume[i]!,
  amount: 0,
}));
beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);

it("real DLL research decoding preserves plain signal identity and native ownership", async () => {
  const plain = await analyzeCzsc(bars);
  const details = await analyzeCzsc(bars, true);
  expect(
    details.families.every(
      (f) =>
        f.diagnostics === undefined &&
        f.signals.every((s) => s.structure === undefined),
    ),
  ).toBe(true);
  const full = await analyzeCzsc(bars, true, projectCzsc, true);
  expect(full.hash).toBe(
    "c5c749bc2f6841a1f38a8a737fedec1132051943e245d2095235eabe544d54e7",
  );
  for (const [i, f] of full.families.entries()) {
    expect(
      f.signals.map(
        ({ index, date, kind, quality, confirmedAt, revokedAt, stop }) => ({
          index,
          date,
          kind,
          quality,
          confirmedAt,
          revokedAt,
          stop,
        }),
      ),
    ).toEqual(plain.families[i]!.signals);
    expect(f.diagnostics?.ma).toHaveLength(bars.length);
    for (const s of f.signals) {
      expect(f.points[s.structure!.pointId - 1]?.index).toBe(s.index);
      for (const [key, id] of Object.entries(s.structure!)) {
        if (!key.endsWith("PointId") || id === 0) continue;
        expect(Number.isInteger(id)).toBe(true);
        expect(f.points[id - 1]?.index).toBeLessThanOrEqual(s.index);
      }
    }
  }
});
it("research decoding uses the same serial snapshot owner on successive full prefixes", async () => {
  const sizes: number[] = [];
  let active = 0;
  const read: typeof projectCzsc = async (input, configs, flags, nested) => {
    expect(active).toBe(0);
    active++;
    sizes.push(input.high.length);
    expect([flags, nested]).toEqual([CZSC_FLAG_HIGHER, true]);
    try {
      return await projectCzsc(input, configs, flags, nested);
    } finally {
      active--;
    }
  };
  for (const size of [300, 301, 302]) {
    const a = await analyzeCzsc(bars.slice(0, size), true, read, true);
    expect(a.families.every((f) => f.diagnostics?.ma.length === size)).toBe(
      true,
    );
  }
  expect(sizes).toEqual([300, 301, 302]);
});
function context() {
  const meta: CzscSignalStructure = {
    contextFlags: CZSC_CTX.overlap,
    pointId: 5,
    trendId: 1,
    breakoutId: 1,
    leavePointId: 4,
    retestPointId: 5,
    secondBasePointId: 3,
    secondTurnPointId: 4,
    smallTurnBasePointId: 3,
    smallTurnLeavePointId: 4,
    smallTurnRetestPointId: 5,
    previousStartPointId: 1,
    previousEndPointId: 2,
    currentStartPointId: 4,
    currentEndPointId: 5,
    centerLifecycle: 0,
  };
  const input = bars
    .slice(0, 60)
    .map((b) => ({ ...b, open: 11, close: 11, low: 10, high: 12 }));
  const result: CzscResult = {
    status: "structure",
    hash: "fixture",
    sourceCommit: "czsc-api-v4",
    families: [
      {
        config: 0,
        points: [5, 10, 30, 35, 40].map((index, i) => ({
          index,
          date: input[index]!.date,
          price: i % 2 ? 12 : 10,
          direction: i % 2 ? 1 : -1,
        })),
        centers: [
          {
            start: 10,
            end: 20,
            startDate: input[10]!.date,
            endDate: input[20]!.date,
            ZD: 8,
            ZG: 9,
            DD: 7,
            GG: 12,
            direction: 1,
          },
        ],
        signals: [
          {
            index: 40,
            date: input[40]!.date,
            kind: 2,
            quality: 1,
            centerId: 1,
            structure: meta,
            divergence: {
              semantic: 1,
              flags: 17,
              areaRatio: 0.5,
              priceRatio: 0.5,
              speedRatio: 0.5,
            },
          },
        ],
        movements: [],
        qualities: [],
        divergences: [],
      },
    ],
  };
  return { input, result, signal: result.families[0]!.signals[0]! };
}
it("overlap needs both association chains; bare kind and equality above ZG cannot prove it", () => {
  const { input, result, signal } = context();
  const check = () =>
    chanStructureCriterion("overlap", result, input, 0, signal);
  expect(check().status).toBe("matched");
  signal.structure!.contextFlags = CZSC_CTX.firstRetest;
  expect(check().status).toBe("not-matched");
  signal.structure!.contextFlags = CZSC_CTX.overlap;
  result.families[0]!.centers[0]!.ZG = 10;
  expect(check().status).toBe("not-matched");
  result.families[0]!.centers[0]!.ZG = 9;
  signal.structure!.secondBasePointId = 0;
  expect(check().status).toBe("missing");
  expect(check().gaps).toContain("缺少有效原生端点关联：secondBasePointId");
});
it("trend IDs do not prove the missing two-center sequence; consolidation requires A/C endpoints", () => {
  const { input, result, signal } = context();
  signal.kind = 1;
  expect(
    chanStructureCriterion("trend-divergence", result, input, 0, signal).status,
  ).toBe("missing");
  signal.divergence!.semantic = 2;
  expect(
    chanStructureCriterion("consolidation-divergence", result, input, 0, signal)
      .status,
  ).toBe("matched");
  signal.structure!.currentStartPointId = 5;
  expect(
    chanStructureCriterion("consolidation-divergence", result, input, 0, signal)
      .status,
  ).toBe("not-matched");
});
it("small-turn predicate stays necessary-only and requires its linked endpoints", () => {
  const { input, result, signal } = context();
  signal.kind = 3;
  signal.divergence!.semantic = 3;
  const r = chanStructureCriterion(
    "small-turn-necessary",
    result,
    input,
    0,
    signal,
  );
  expect(r.status).toBe("matched");
  expect(r.boundary).toContain("必要条件");
  signal.structure!.smallTurnRetestPointId = 0;
  expect(
    chanStructureCriterion("small-turn-necessary", result, input, 0, signal)
      .status,
  ).toBe("missing");
});
