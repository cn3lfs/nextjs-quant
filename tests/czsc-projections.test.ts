import { afterAll, beforeAll, expect, it } from "vitest";
import { decodeCzscNative } from "../src/server/czsc-structures";
import {
  projectCzsc,
  closeCzsc,
  analyzeCzsc,
  type CzscProjections,
} from "../src/server/czsc";
import { czscNativeOutputs } from "../src/server/czsc-research-structures";
import { prepareCzscTestRuntime } from "./helpers/czsc-runtime";
import fixture from "./fixtures/czsc-sse.json";
function raw(): CzscProjections {
  const projections: Record<string, number[]> = {};
  for (const config of [0, 1100]) {
    projections[`${config}:59`] = [1, 1, 1, 0, 0, 0];
    projections[`${config}:92`] = Array(6).fill(-1);
    const trend = [1, config === 0 ? 1 : 2, -1, -1, 1, 3, 1, 2, 2, -1];
    trend.forEach(
      (v, i) => (projections[`${config}:${60 + i}:0`] = [v, v, v, 0, 0, 0]),
    );
  }
  projections["1100:70"] = [0, 0, 0, 0, 0, 3];
  // Same columns as TestNativeCandidateSlots in CzscProjectionTests.cpp.
  const expected = [
    1, 1, 3, 2, 3, 3, 6, 1, 1, 1, 2, 1, 10, 2, 2, 1, 1, 0, 1, 1, 6,
  ];
  for (let slot = 0; slot < 3; slot++) {
    const values = [...expected];
    values[0] = slot + 1;
    values[1] = slot + 1;
    values[11] = slot + 1;
    values.forEach(
      (v, i) => (projections[`1100:${71 + i}:${slot}`] = [0, 0, 0, 0, 0, v]),
    );
  }
  return { hash: "synthetic", registered: [], projections };
}
it("decodes all three same-bar classes and negative trend type; retains unknowns", () => {
  const decoded = decodeCzscNative(raw(), 0, 6);
  expect(decoded.trends[0]).toMatchObject({
    id: 1,
    type: -1,
    start: 0,
    end: 2,
    memberCenterIds: [1, 2],
    completion: "unknown",
    theoreticalLevel: null,
  });
  expect(decoded.highCandidates.map((c) => c.kind)).toEqual([1, 2, 3]);
  expect(decoded.highCandidates[0]).toMatchObject({
    config: 1100,
    segmentStart: 2,
    segmentEnd: 5,
    currentStart: 0,
    currentEnd: 5,
    weakSpeed: false,
  });
});
it("preserves overlapping N1 rows in independent slots and deduplicates covered bars", () => {
  const r = raw();
  r.projections["0:59"] = [1, 1, 2, 1, 1, 0];
  const second = [2, 1, -1, 0, 3, 5, 3, 3, 1, -1];
  second.forEach((v, i) => {
    const key = `0:${60 + i}:0`;
    r.projections[key]![3] = v;
    r.projections[key]![4] = v;
    r.projections[`0:${60 + i}:1`] = [0, 0, v, 0, 0, 0];
  });
  expect(
    decodeCzscNative(r, 0, 6).trends.map((t) => ({
      id: t.id,
      start: t.start,
      end: t.end,
      members: t.memberCenterIds,
    })),
  ).toEqual([
    { id: 1, start: 0, end: 2, members: [1, 2] },
    { id: 2, start: 2, end: 4, members: [3] },
  ]);
});
it.each([NaN, -1, 1.5, 16777217])("rejects invalid counts %s", (value) => {
  const r = raw();
  r.projections["0:59"]![0] = value;
  expect(() => decodeCzscNative(r, 0, 6)).toThrow("结构缺口");
});
it("checks ID before interpreting -1 and rejects missing slots, bad refs and coverage", () => {
  for (const key of ["0:60:0", "1100:80:0", "1100:71:2"]) {
    const r = raw();
    r.projections[key] = Array(6).fill(-1);
    expect(() => decodeCzscNative(r, 0, 6)).toThrow("结构缺口");
  }
  const r = raw();
  delete r.projections["1100:71:2"];
  expect(() => decodeCzscNative(r, 0, 6)).toThrow("缺失");
  const gap = raw();
  gap.projections["0:59"]![1] = 0;
  expect(() => decodeCzscNative(gap, 0, 6)).toThrow("结构缺口");
});
it("preserves maximum exact integer IDs without rounding", () => {
  const r = raw();
  r.projections["1100:80:0"]![5] = 16777216;
  expect(decodeCzscNative(r, 0, 6).highCandidates[0]!.trendId).toBe(16777216);
});
beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);
it("real SSE projections match native golden counts and independent endpoint/member columns", async () => {
  const input = fixture.date.map((date, i) => ({
    date,
    open: fixture.close[i]!,
    close: fixture.close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeCzsc(input, true, projectCzsc, true);
  for (const f of result.families) {
    expect(f.native!.highCandidates).toHaveLength(2);
    for (const t of f.native!.trends) {
      expect(t.start).toBe(f.centers[t.firstCenterId - 1]!.start);
      expect(t.end).toBe(f.centers[t.lastCenterId - 1]!.end);
      expect(t.memberCenterIds).toEqual(
        Array.from(
          { length: t.lastCenterId - t.firstCenterId + 1 },
          (_, i) => t.firstCenterId + i,
        ),
      );
    }
    const high = result.families[1]!;
    for (const c of f.native!.highCandidates) {
      expect(c.index).toBe(high.points[c.pointId - 1]!.index);
      expect(c.segmentStart).toBe(
        high.points[c.segmentStartPointId - 1]!.index,
      );
      expect(high.native!.trends.some((t) => t.id === c.trendId)).toBe(true);
    }
  }
  expect(result.families[0]!.native!.highCandidates).toEqual(
    result.families[1]!.native!.highCandidates,
  );
  const short = {
    high: fixture.high.slice(0, 301),
    low: fixture.low.slice(0, 301),
    close: fixture.close.slice(0, 301),
    volume: fixture.volume.slice(0, 301),
  };
  const serial = await projectCzsc(short, [0, 1100], czscNativeOutputs);
  const [a, b] = await Promise.all([
    projectCzsc(fixture, [0, 1100], czscNativeOutputs),
    projectCzsc(short, [0, 1100], czscNativeOutputs),
  ]);
  expect(b).toEqual(serial);
  expect(a.projections["0:70"]).toEqual(a.projections["1100:70"]);
  await expect(projectCzsc(short, [0], [109])).rejects.toThrow("Invalid");
});
it.each([0, 1, 2])(
  "new ABI handles nCount=%s including no slot cell",
  async (n) => {
    const input = {
      high: fixture.high.slice(0, n),
      low: fixture.low.slice(0, n),
      close: fixture.close.slice(0, n),
      volume: fixture.volume.slice(0, n),
    };
    const r = await projectCzsc(input, [0, 1100], czscNativeOutputs);
    expect(decodeCzscNative(r, 0, n).highCandidates).toEqual([]);
  },
);
