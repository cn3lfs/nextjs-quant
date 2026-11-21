import { expect, it } from "vitest";
import { chanMovementFixture } from "../../../helpers/chan-movements";
import {
  chanC4SmallTurnFromSignal,
  chanC4SmallTurnSignalDecisions,
  type ChanC4DecisionObservation,
} from "trading-strategies/research/chan/research-chan-movements";

it("CH18 adapter refuses time-envelope guesses without explicit matching native references", () => {
  const f = chanMovementFixture();
  f.signal.kind = 3;
  expect(chanC4SmallTurnFromSignal(f.result, f.bars, 0, f.signal).status).toBe(
    "missing",
  );
});

it("CH18 resolves original third-buy retest outside the center, small top and successor pullback", () => {
  const f = chanMovementFixture();
  const original = f.bars;
  f.bars = Array.from({ length: 31 }, (_, i) => ({
    ...(i >= 9 && i < 29 ? original[i - 9]! : original[0]!),
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
  }));
  for (let i = 9; i < 29; i++) {
    const b = original[i - 9]!;
    Object.assign(f.bars[i]!, {
      open: 50 - b.open,
      close: 50 - b.close,
      high: 50 - b.low,
      low: 50 - b.high,
    });
  }
  Object.assign(f.bars[6]!, { open: 39, close: 39, high: 40, low: 38 });
  Object.assign(f.bars[8]!, { open: 36, close: 36, high: 37, low: 35 });
  f.family.points.forEach((p) => {
    p.index += 9;
    p.date = f.bars[p.index]!.date;
    p.direction *= -1;
    p.price = 50 - p.price;
  });
  f.family.centers.forEach((c) => {
    c.start += 9;
    c.end += 9;
    c.startDate = f.bars[c.start]!.date;
    c.endDate = f.bars[c.end]!.date;
    [c.ZD, c.ZG] = [50 - c.ZG, 50 - c.ZD];
    [c.DD, c.GG] = [50 - c.GG, 50 - c.DD];
  });
  f.table.centers.forEach((c) => {
    c.start += 9;
    c.end += 9;
    c.centerStart += 9;
    c.centerEnd += 9;
    c.established += 9;
    c.completed! += 9;
    [c.ZD, c.ZG] = [50 - c.ZG, 50 - c.ZD];
  });
  const small = f.table.movements[0]!;
  Object.assign(small, {
    start: 9,
    end: 27,
    completed: 28,
    type: 1,
    successorId: 4,
  });
  f.signal.index = 27;
  f.signal.date = f.bars[27]!.date;
  f.signal.kind = -1;
  // The mirrored small trend is an up trend ended by the top at bar 27.
  Object.assign(f.family.native!.trends[0]!, {
    type: 1,
    start: 9,
    end: 22,
    completedAt: 28,
    completedByIndex: 27,
    confirmedAt: 28,
  });
  const mainCenter = {
    ...f.table.centers[0]!,
    id: 3,
    level: 2,
    start: 2,
    end: 5,
    centerStart: 2,
    centerEnd: 5,
    ZG: 30,
    ZD: 28,
  };
  f.table.centers.push(mainCenter, {
    ...mainCenter,
    id: 4,
    start: 0,
    end: 1,
    centerStart: 0,
    centerEnd: 1,
  });
  f.table.movements.push(
    { ...small, id: 2, level: 2, start: 0, centerIds: [4, 3], successorId: 0 },
    {
      ...small,
      id: 3,
      start: 6,
      end: 8,
      completed: 9,
      type: -1,
      high: 40,
      low: 35,
      successorId: 1,
    },
    {
      ...small,
      id: 4,
      start: 27,
      end: 29,
      completed: 30,
      type: -1,
      low: 34,
      successorId: 5,
    },
    {
      ...small,
      id: 5,
      start: 29,
      end: 30,
      completed: null,
      type: 1,
      successorId: 0,
    },
  );
  f.family.centers.push(
    { ...f.family.centers[0]!, start: 0, end: 1 },
    {
      ...f.family.centers[0]!,
      start: 2,
      end: 5,
      ZD: 28,
      ZG: 30,
      startDate: f.bars[2]!.date,
      endDate: f.bars[5]!.date,
    },
  );
  f.family.points.push(
    { index: 6, date: f.bars[6]!.date, price: 40, direction: 1 },
    { index: 8, date: f.bars[8]!.date, price: 35, direction: -1 },
  );
  f.family.native!.trends.push({
    id: 2,
    config: 0,
    unit: 1,
    type: 1,
    start: 0,
    end: 27,
    firstCenterId: 3,
    lastCenterId: 4,
    memberCenterIds: [3, 4],
    completedAt: null,
    completedByIndex: -1,
    confirmedAt: -1,
  });
  f.table.associations.push({
    id: 2,
    structureId: 2,
    movementId: 2,
    completionId: 0,
    level: 2,
    status: "verified",
    centerIds: [4, 3],
  });
  const third = {
    ...f.signal,
    index: 8,
    date: f.bars[8]!.date,
    kind: 3,
    centerId: 4,
    structure: {
      ...f.signal.structure!,
      trendId: 2,
      pointId: 6,
      leavePointId: 5,
      retestPointId: 6,
    },
  };
  f.family.signals.push(third);
  expect(chanC4SmallTurnFromSignal(f.result, f.bars, 0, third)).toMatchObject({
    status: "matched",
    action: "exit",
  });
  const observations: ChanC4DecisionObservation[] = f.table.movements.map(
    (movement) => ({ state: "confirmed", evidence: { id: movement.id } }),
  );
  const originalInput = JSON.stringify(f.result);
  const decisions = chanC4SmallTurnSignalDecisions(
    f.result,
    f.bars,
    0,
    2,
    third,
    observations,
  );
  expect(
    decisions.map((decision) => [
      decision.verdict.action,
      decision.key,
      decision.endpoint,
    ]),
  ).toEqual([
    ["exit", `small:${third.date}`, third.date],
    ["enter", `third:${third.date}`, third.date],
  ]);
  expect(decisions[0]!.verdict).toEqual(
    chanC4SmallTurnFromSignal(f.result, f.bars, 0, third),
  );
  expect(JSON.stringify(f.result)).toBe(originalInput);
  expect(
    chanC4SmallTurnSignalDecisions(f.result, f.bars, 0, 1, third, observations),
  ).toEqual([]);
  expect(
    chanC4SmallTurnSignalDecisions(
      f.result,
      f.bars,
      0,
      2,
      f.signal,
      observations,
    ),
  ).toEqual([]);
  const revised = observations.map((row) =>
    row.evidence?.id === 4 ? { ...row, state: "revised" as const } : row,
  );
  expect(
    chanC4SmallTurnSignalDecisions(f.result, f.bars, 0, 2, third, revised).map(
      (decision) => decision.verdict.action,
    ),
  ).toEqual(["enter"]);
  const candidateOnly = observations.map((row) =>
    row.evidence?.id === 2 ? { ...row, state: "candidate" as const } : row,
  );
  expect(
    chanC4SmallTurnSignalDecisions(
      f.result,
      f.bars,
      0,
      2,
      third,
      candidateOnly,
    ).map((decision) => decision.verdict.action),
  ).toEqual(["exit"]);
  f.table.movements.find((m) => m.id === 4)!.low = 40;
  expect(chanC4SmallTurnFromSignal(f.result, f.bars, 0, third)).toMatchObject({
    status: "not-matched",
    action: "hold",
  });
});
