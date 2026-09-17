import { afterAll, beforeAll, expect, it } from "vitest";
import type { CzscResult, CzscSignalStructure } from "~/lib/czsc";
import {
  chanStructureCriterion,
  chanStructureTasks,
} from "~/lib/research-chan-criteria";
import { analyzeCzsc, closeCzsc, projectCzsc } from "~/server/czsc";
import {
  czscResearchOutputs,
  decodeCzscResearchStructures,
} from "~/server/czsc-research-structures";
import { prepareCzscTestRuntime } from "./helpers/czsc-runtime";
import fixture from "./fixtures/czsc-sse.json";

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

it("real DLL extended projection decoding preserves old signal identity and native ownership", async () => {
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
    "7f2b2ec4703ed67c811046d0b2b73a1f40b6266cd3abaeb2620e2ece47e77457",
  );
  for (const [i, f] of full.families.entries()) {
    expect(
      f.signals.map(({ index, date, kind, quality }) => ({
        index,
        date,
        kind,
        quality,
      })),
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
it("extended decoding uses the same serial projection owner on successive full prefixes", async () => {
  const sizes: number[] = [];
  let active = 0;
  const read: typeof projectCzsc = async (input, configs, outputs) => {
    expect(active).toBe(0);
    active++;
    sizes.push(input.high.length);
    expect(outputs).toEqual(expect.arrayContaining(czscResearchOutputs));
    try {
      return await projectCzsc(input, configs, outputs);
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
it("missing/non-finite/truncated native projections are explicit structure gaps", () => {
  const projections = Object.fromEntries(
    czscResearchOutputs.map((o) => [`0:${o}`, [0, 0]]),
  );
  const raw = { hash: "fixture", registered: [0, 0], projections };
  expect(decodeCzscResearchStructures(raw, 0, 2).diagnostics.nested).toEqual(
    [],
  );
  projections["0:50"] = [1];
  expect(() => decodeCzscResearchStructures(raw, 0, 2)).toThrow("长度");
  projections["0:50"] = [0, NaN];
  expect(() => decodeCzscResearchStructures(raw, 0, 2)).toThrow("非有限");
  delete projections["0:50"];
  expect(() => decodeCzscResearchStructures(raw, 0, 2)).toThrow("缺失");
  projections["0:50"] = [0, 1.5];
  expect(() => decodeCzscResearchStructures(raw, 0, 2)).toThrow("结构缺口");
});
it("nested source is retained as candidate ordinal and level-zero semantic is not discarded", () => {
  const projections = Object.fromEntries(
    czscResearchOutputs.map((o) => [`0:${o}`, [0, 0]]),
  );
  projections["0:56"] = [0, 2];
  projections["0:57"] = [0, 3];
  projections["0:58"] = [0, 1];
  const r = decodeCzscResearchStructures(
    { hash: "fixture", registered: [0, 0], projections },
    0,
    2,
  );
  expect(r.diagnostics.nested).toEqual([
    {
      index: 1,
      level: 0,
      lowConfig: 0,
      sourceConfig: 1100,
      sourceCandidateId: 0,
      lowStartPointId: 0,
      lowEndPointId: 0,
      semantic: 2,
      confirmFlags: 3,
      direction: 1,
    },
  ]);
  expect(chanStructureTasks.CH07).toContain("Candidates完整表");
  expect(Object.keys(chanStructureTasks)).toHaveLength(16);
});

function context() {
  const meta: CzscSignalStructure = {
    contextFlags: 2048 | 4096,
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
    sourceCommit: "b67f3c6",
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
  signal.structure!.contextFlags = 4096;
  expect(check().status).toBe("not-matched");
  signal.structure!.contextFlags = 2048 | 4096;
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
