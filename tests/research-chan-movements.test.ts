import { expect, it } from "vitest";
import type { ChanMovement } from "../src/lib/czsc-movements";
import {
  chanC4Presets,
  chanC4Trend,
  chanC4Sequence,
  chanC4Decomposition,
  chanC4MonthlyBottom,
  chanC4SmallTurn,
  chanC4Observations,
} from "../src/lib/research-chan-movements";

import { chanMovementFixture as fixture } from "./helpers/chan-movements";

it("CH06 needs completed mapped multi-center trend and confirmed new-low MACD divergence", () => {
  const f = fixture();
  expect(f.trend()).toMatchObject({ status: "matched", action: "enter" });
  f.table.associations[0]!.status = "unknown";
  expect(f.trend().status).toBe("missing");
  f.table.associations[0]!.status = "verified";
  f.table.movements[0]!.completed = null;
  expect(f.trend().status).toBe("missing");
});
it.each([0, 100, 120])(
  "CH06 MACD ratio %s is not weakening evidence",
  (ratio) => {
    const f = fixture();
    f.signal.divergence!.areaRatio = ratio;
    expect(f.trend().status).toBe("not-matched");
  },
);
it("CH06 cannot substitute kind/direction/config or missing new extreme for trend proof", () => {
  const f = fixture();
  f.signal.divergence!.flags = 16;
  expect(f.trend().status).toBe("not-matched");
  delete f.family.native!.recursiveMovements;
  expect(f.trend().status).toBe("missing");
});

function pattern() {
  const f = fixture(),
    last = f.table.movements[0]!;
  const m = (
    id: number,
    type: -1 | 0 | 1,
    start: number,
    end: number,
    successorId: number,
  ): ChanMovement => ({
    ...last,
    id,
    type,
    start,
    end,
    successorId,
    completed: end + 1,
  });
  f.table.movements = [
    m(2, -1, 0, 4, 3),
    m(3, 0, 4, 8, 1),
    { ...last, start: 8 },
  ];
  return f;
}
it("CH08/CH09 use the same consecutive down-consolidation-down entry evidence", () => {
  const f = pattern();
  // Native signal proof is taken before the sequence fixture supplies its preceding decompositions.
  const entry = {
    status: "matched" as const,
    action: "enter" as const,
    reason: "fixed native mapped first buy",
    evidence: f.signal,
    proof: { anchor: 1, config: 0, movementId: 1 },
  };
  for (const method of ["CH08", "CH09"] as const)
    expect(chanC4Decomposition(method, f.table, 1, entry, 1)).toMatchObject({
      status: "matched",
      action: "enter",
    });
  f.table.movements[1]!.type = 1;
  expect(chanC4Decomposition("CH09", f.table, 1, entry, 1).action).toBe(
    "observe",
  );
  f.table.movements[1]!.type = 0;
  f.table.movements[1]!.completed = null;
  expect(chanC4Sequence(f.table, 1).status).toBe("missing");
});
it("CH08 rejects mixed level, broken connection and detached proof", () => {
  const f = pattern();
  f.table.movements[1]!.level = 2;
  expect(chanC4Sequence(f.table, 1).status).toBe("missing");
  f.table.movements[1]!.level = 1;
  f.table.movements[1]!.start++;
  expect(chanC4Sequence(f.table, 1).status).toBe("missing");
});
it("CH08 holds consolidation; CH09 exits completed consolidation/up rebound as separate variant", () => {
  const f = pattern(),
    last = f.table.movements[2]!;
  last.successorId = 4;
  f.table.movements.push({
    ...last,
    id: 4,
    type: 0,
    start: 18,
    end: 19,
    completed: 19,
    successorId: 0,
  });
  const entry = {
    status: "not-matched" as const,
    action: "observe" as const,
    reason: "no new entry",
    evidence: null,
  };
  expect(chanC4Decomposition("CH08", f.table, 1, entry, 1, 1).action).toBe(
    "hold",
  );
  expect(chanC4Decomposition("CH09", f.table, 1, entry, 1, 1).action).toBe(
    "exit",
  );
  f.table.movements[3]!.type = -1;
  expect(chanC4Decomposition("CH08", f.table, 1, entry, 1, 1).action).toBe(
    "exit",
  );
  f.table.movements[3]!.completed = null;
  expect(chanC4Decomposition("CH09", f.table, 1, entry, 1, 1).action).toBe(
    "hold",
  );
});

it("CH13 requires genuine monthly anchor and ends only at linked successor first third point", () => {
  const f = fixture();
  expect(chanC4MonthlyBottom(f.table, 1, f.trend()).status).toBe("missing");
  f.table.anchor = 3;
  const entry = f.trend();
  expect(chanC4MonthlyBottom(f.table, 1, entry).action).toBe("enter");
  f.table.movements[0]!.successorId = 2;
  f.table.movements.push({
    ...f.table.movements[0]!,
    id: 2,
    type: 0,
    centerIds: [3],
    successorId: 0,
  });
  expect(
    chanC4MonthlyBottom(f.table, 1, entry, {
      movementId: 2,
      centerId: 3,
      kind: 3,
    }).action,
  ).toBe("exit");
  expect(
    chanC4MonthlyBottom(f.table, 1, entry, {
      movementId: 2,
      centerId: 2,
      kind: 3,
    }).status,
  ).toBe("missing");
});

it("CH18-small-to-large: strict boundary break then linked upward pullback exits, never sufficient reversal", () => {
  const f = fixture(),
    base = f.table.movements[0]!;
  base.type = 1;
  f.table.centers[1]!.children = [2];
  f.table.movements.push(
    {
      ...base,
      id: 2,
      level: 0,
      type: -1,
      high: 14,
      low: 12,
      start: 14,
      end: 16,
      completed: 17,
    },
    {
      ...base,
      id: 3,
      level: 0,
      type: -1,
      start: 18,
      end: 19,
      low: 14,
      completed: 19,
      successorId: 4,
    },
    { ...base, id: 4, level: 0, type: 1, start: 19, end: 19, completed: null },
    { ...base, id: 5, level: 0, start: 16, end: 18 },
  );
  const refs = {
    trendId: 1,
    referenceId: 2,
    downId: 3,
    thirdBuyMovementId: 2,
    smallDivergenceMovementId: 5,
    necessary: {
      status: "matched" as const,
      action: "observe" as const,
      reason: "native necessary evidence",
      evidence: null,
    },
  };
  expect(chanC4SmallTurn(f.table, refs).action).toBe("hold"); // equality
  f.table.movements[2]!.low = 13;
  expect(chanC4SmallTurn(f.table, refs).action).toBe("observe");
  expect(chanC4SmallTurn(f.table, { ...refs, pullbackId: 4 })).toMatchObject({
    action: "exit",
    status: "matched",
  });
  f.table.movements[2]!.completed = null;
  expect(chanC4SmallTurn(f.table, refs).status).toBe("missing");
  f.table.movements[2]!.completed = 19;
  f.table.movements[1]!.start = 12;
  expect(chanC4SmallTurn(f.table, refs).status).toBe("missing");
});

it("C4 discovery freezes observation time, survives ID drift and exposes completed-group revision", () => {
  const f = fixture(),
    observe = chanC4Observations("fixed-dll/input");
  const first = observe(f.bars, f.table);
  expect(first[0]).toMatchObject({
    candidateAt: "2020-01-20",
    confirmedAt: "2020-01-20",
    state: "confirmed",
  });
  const next = [...f.bars, { ...f.bars.at(-1)!, date: "2020-01-21" }];
  f.table.movements[0]!.id = 91;
  expect(observe(next, f.table)[0]!.confirmedAt).toBe("2020-01-20");
  f.table.movements[0]!.type = 1;
  const revision = observe(
    [...next, { ...next.at(-1)!, date: "2020-01-22" }],
    f.table,
  )[0]!;
  expect(revision.state).toBe("revised");
  expect(revision.confirmedAt).toBe("2020-01-20");
  expect(() => observe(f.bars, f.table)).toThrow("前缀");
});
it("all final five methods registered only after actual DLL verification", () => {
  expect([...new Set(chanC4Presets.map((p) => p.method))]).toEqual([
    "CH06",
    "CH08",
    "CH09",
    "CH13",
    "CH18-small-to-large",
  ]);
  expect(chanC4Presets).toHaveLength(9);
  expect(
    chanC4Presets
      .filter((p) => p.anchor === 2)
      .every((p) => p.window?.join("/") === "2000-01-04/2022-11-30"),
  ).toBe(true);
  expect(
    chanC4Presets.every(
      (p) =>
        p.status === "implemented-variant" &&
        p.enabled &&
        p.validation === "real-dll-prefix-verified",
    ),
  ).toBe(true);
});
