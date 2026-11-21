import { expect, it } from "vitest";
import { chanMovementFixture } from "../../../tests/helpers/chan-movements.js";
import type {
  ChanMovement,
  CzscMovements,
} from "../src/research/chan/czsc-movements.js";
import {
  chanC4Sequence,
  chanC4SmallTurnSignalDecisions,
} from "../src/research/chan/research-chan-movements.js";

function chain(length: number): CzscMovements {
  const movements = Array.from({ length }, (_, i): ChanMovement => ({
    id: i + 1,
    level: 1,
    type: 0,
    start: i,
    end: i + 1,
    established: i + 1,
    completed: i + 1,
    successorId: i + 1 < length ? i + 2 : 0,
    high: 20,
    low: 10,
    centerIds: [],
    connectionIds: [],
  }));
  return {
    version: "native-movements-c4-1",
    anchor: 1,
    config: 0,
    centers: [],
    connections: [],
    associations: [],
    movements,
  };
}

it("follows 5000 explicitly linked movements in successor order despite reversed input", () => {
  const table = chain(5000);
  const rows = [...table.movements];
  table.movements.reverse();
  expect(chanC4Sequence(table, 1)).toEqual({
    status: "ready",
    rows,
    reason: "显式级别、已完成状态与后继连接均有原生证据",
  });
});

it("preserves the reason for merged roots, loops, unfinished links and broken endpoints", () => {
  const table = chain(3);
  const [first, second, last] = table.movements as [
    ChanMovement,
    ChanMovement,
    ChanMovement,
  ];
  first.successorId = 3;
  expect(chanC4Sequence(table, 1)).toEqual({
    status: "missing",
    rows: [],
    reason: "同级别后继不是单条完整链",
  });

  first.successorId = 2;
  last.successorId = 2;
  last.end = second.start;
  expect(chanC4Sequence(table, 1)).toEqual({
    status: "missing",
    rows: [],
    reason: "后继循环",
  });

  last.successorId = 0;
  last.end = 3;
  second.completed = null;
  expect(chanC4Sequence(table, 1)).toEqual({
    status: "missing",
    rows: [],
    reason: "未完成走势不能跳过",
  });

  second.completed = 2;
  second.start++;
  expect(chanC4Sequence(table, 1)).toEqual({
    status: "missing",
    rows: [],
    reason: "同级别连接端点不一致",
  });
  second.start--;
  last.completed = null;
  expect(chanC4Sequence(table, 1)).toMatchObject({
    status: "ready",
    rows: [first, second],
  });
});

it("uses the first verified association for the signal's structure and preserves the resulting verdict", () => {
  const { result, bars, table, signal } = chanMovementFixture();
  const third = { ...signal, kind: 3 };
  const association = table.associations[0]!;
  const decisions = () =>
    chanC4SmallTurnSignalDecisions(result, bars, 0, 1, third, []);
  const expected = [
    {
      key: `small:${third.date}`,
      endpoint: third.date,
      verdict: {
        status: "missing",
        action: "observe",
        reason:
          "缺108最后中枢关联与原三买回试段两端完全一致引用；不以时间包含猜测",
        evidence: null,
      },
    },
  ];
  expect(decisions()).toEqual(expected);

  const differentLevel = { ...association, id: 2, movementId: 2, level: 2 };
  table.movements.push({ ...table.movements[0]!, id: 2, level: 2 });
  table.associations = [
    { ...differentLevel, id: 3, status: "unknown" },
    { ...differentLevel, id: 4, structureId: 99 },
    association,
    differentLevel,
  ];
  expect(decisions()).toEqual(expected);

  association.status = "unknown";
  expect(decisions()).toEqual([]);
});
