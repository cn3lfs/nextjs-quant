import { expect, it } from "vitest";
import {
  chanProjectionMode,
  chanAnchorDateCodes,
} from "../../../../src/lib/research/methods/chan/czsc-movements";
import { decodeCzscMovements } from "../../../../src/server/strategies/chan/czsc-movements";
import type { CzscNativeProjection } from "../../../../src/lib/research/methods/chan/czsc";
import type { CzscProjections } from "../../../../src/server/strategies/chan/czsc";

function fixed() {
  const high = [12, 13, 12, 16, 17, 17, 17, 21, 22],
    low = [10, 11, 10, 15, 15, 15, 15, 20, 20];
  const bars = high.map((h, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    high: h,
    low: low[i]!,
    open: h,
    close: h,
    volume: 1,
    amount: 1,
  }));
  const raw: CzscProjections = {
    hash: "fixed-contract-not-real-dll",
    registered: high,
    projections: {},
  };
  const put = (o: number, slot: number, f: number, v: number) => {
    raw.projections[`0:${o}:${slot}:${f}`] = [...Array(8).fill(0), v];
  };
  const row = (o: number, slot: number, values: number[]) =>
    values.forEach((v, f) => put(o, slot, f, v));
  row(100, 0, [4]);
  row(101, 0, [2]);
  row(103, 0, [1]);
  row(105, 0, [1]);
  row(107, 0, [1]);
  row(102, 0, [1, 0, 1, 4, 1, 3, 3, 4, 5, 2, 0, 1, 2, 16, 10, 12, 11]);
  row(102, 1, [2, 0, 4, 8, 5, 7, 7, 8, 9, 0, 0, 1, 2, 21, 15, 17, 15]);
  row(104, 0, [1, 0, 1, 1, 8, 7, 9, 0, 2, 1, 1, 2, 21, 10]);
  put(104, 0, 100, 1);
  put(104, 0, 102, 2);
  put(104, 0, 101, 1);
  row(106, 0, [1, 1, 2, -1, 3, 5, 5, 0, 3]);
  [3, 4, 5].forEach((v, i) => put(106, 0, 100 + i, v));
  row(108, 0, [1, 1, 1, 1, 0, 1, 2, 1, 1]);
  put(108, 0, 100, 1);
  put(108, 0, 101, 2);
  const legacy: CzscNativeProjection = {
    version: "native-projections-c2-1",
    config: 0,
    completedSequence: "unavailable",
    highCandidates: [],
    trends: [
      {
        id: 1,
        config: 0,
        unit: 1,
        type: 1,
        start: 0,
        end: 6,
        firstCenterId: 1,
        lastCenterId: 2,
        memberCenterIds: [1, 2],
        completion: "unknown",
        theoreticalLevel: null,
      },
    ],
    recursive: {
      anchor: 1,
      config: 0,
      nodes: [],
      transitions: [],
      completions: [
        {
          id: 1,
          trendId: 1,
          space: 0,
          connectionPointId: 1,
          connection: 7,
          requiredPointId: 2,
          required: 8,
          observed: 8,
          successorId: 0,
          successorEstablished: null,
          level: null,
        },
      ],
    },
  };
  const centers = [
    { start: 0, end: 2, ZG: 12, ZD: 11, GG: 13, DD: 10 },
    { start: 4, end: 6, ZG: 17, ZD: 15, GG: 17, DD: 15 },
  ];
  return {
    raw,
    bars,
    legacy,
    centers,
    put,
    decode: () => decodeCzscMovements(raw, bars, 0, 1, legacy, centers),
  };
}

it("C4 explicit ABI avoids 100/config collision and keeps old modes", () => {
  expect(chanProjectionMode(0, 100)).toBe(-1000);
  expect(chanProjectionMode(1100, 100)).toBe(-11001000);
  for (const config of [0, 1100])
    for (let output = 0; output <= 108; output++) {
      const mode = chanProjectionMode(config, output);
      expect(Math.fround(mode)).toBe(mode);
      if (output < 100) expect(mode).toBe(config * 1000 + output * 10);
    }
  expect(() => chanProjectionMode(0, 109)).toThrow();
});

it("monthly anchor is independent, with calendar-complete input owned by monthly adapter", () => {
  expect(
    chanAnchorDateCodes(["2019-12-31", "2020-01-31", "2020-02-28"], 3),
  ).toEqual([191231, 200131, 200228]);
  expect(() => chanAnchorDateCodes(["2020-01-02", "2020-01-03"], 3)).toThrow(
    "月份",
  );
  expect(() => chanAnchorDateCodes(["2020-02-30"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2020-02-28", "2020-01-31"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2020-01-02T09:35:00+08:00"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2023-01-03T09:35:00+08:00"], 2)).toThrow(
    "窗口",
  );
});

it("decodes fixed C4 multi-center members, connection evidence and explicit 97 association", () => {
  const f = fixed(),
    table = f.decode();
  expect(table.movements[0]).toMatchObject({
    type: 1,
    level: 0,
    centerIds: [1, 2],
    connectionIds: [1],
    completed: 8,
  });
  expect(table.connections[0]).toMatchObject({
    space: 0,
    level: -1,
    members: [3, 4, 5],
  });
  expect(table.associations[0]).toMatchObject({
    completionId: 1,
    level: 0,
    status: "verified",
  });
  expect(f.legacy.recursive!.completions[0]!.level).toBeNull(); // 97 unchanged
});

it.each([
  [100, 0, 0, 0],
  [104, 0, 2, 0],
  [104, 0, 1, 1],
  [104, 0, 6, 8],
  [104, 0, 102, 1],
  [106, 0, 3, 0],
  [106, 0, 101, 5],
  [106, 0, 6, 4],
  [108, 0, 3, 9],
  [108, 0, 4, 1],
  [108, 0, 100, 2],
  [108, 0, 5, 0],
  [102, 1, 15, NaN],
  [103, 0, 0, 0.5],
  [103, 0, 0, 16777217],
])(
  "rejects corrupt table at output %s slot %s field %s",
  (o, slot, field, v) => {
    const f = fixed();
    f.put(o!, slot!, field!, v!);
    expect(f.decode).toThrow("C4结构缺口");
  },
);

it("refuses time-only association and snapshot backfill, accepts explicit unknown", () => {
  const f = fixed();
  f.centers[0]!.ZG += 0.25;
  expect(f.decode).toThrow("价格");
  f.put(108, 0, 2, 0);
  f.put(108, 0, 4, -1);
  f.put(108, 0, 5, 0);
  f.put(108, 0, 6, 0);
  expect(f.decode().associations[0]!.level).toBeNull();
  f.raw.projections["0:100:0:0"]![0] = 4;
  expect(f.decode).toThrow("回填");
});
