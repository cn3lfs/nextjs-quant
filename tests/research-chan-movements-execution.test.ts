import { expect, it } from "vitest";
import { chanMovementFixture } from "./helpers/chan-movements";
import { researchSignals } from "../src/server/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";
import type { CzscResult } from "../src/lib/czsc";
import { chanC4SmallTurnFromSignal } from "../src/server/research-chan-movements";

it.each([
  "chan-trend-completed-daily-c4",
  "chan-same-level-daily-c4",
  "chan-down-consolidation-down-daily-c4",
])(
  "%s executes only after complete mapped evidence first appears",
  async (strategy) => {
    const f = chanMovementFixture();
    // Supply preceding same-level decompositions, while keeping A within its trend.
    if (!strategy.includes("trend-completed")) {
      const last = f.table.movements[0]!;
      last.start = 2;
      Object.assign(f.family.points[0]!, {
        index: 2,
        date: f.bars[2]!.date,
        price: f.bars[2]!.high,
      });
      f.table.movements.unshift(
        {
          ...last,
          id: 2,
          type: -1,
          start: 0,
          end: 1,
          completed: 2,
          successorId: 3,
          centerIds: [1],
        },
        {
          ...last,
          id: 3,
          type: 0,
          start: 1,
          end: 2,
          completed: 3,
          successorId: 1,
          centerIds: [1],
        },
      );
    }
    const spec = researchSpecSchema.parse({
      strategy,
      start: f.bars[0]!.date,
      end: f.bars.at(-1)!.date,
      validationStart: f.bars.at(-1)!.date,
    });
    const calls: number[] = [];
    const native = async (
      bars: Readonly<typeof f.bars>,
      anchor?: 1 | 2 | 3,
    ): Promise<CzscResult> => {
      calls.push(bars.length);
      expect(anchor).toBe(1);
      if (bars.length === 20) return structuredClone(f.result);
      const r = structuredClone(f.result),
        t = r.families[0]!.native!.recursiveMovements!;
      r.families[0]!.signals = [];
      t.movements = [];
      t.centers = [];
      t.associations = [];
      return r;
    };
    const result = await researchSignals("sh600000", f.bars, spec, native);
    expect(calls).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      observedDate: "2020-01-20",
      endpointDate: "2020-01-19",
    });
    expect(JSON.parse(result[0]!.evidence).confirmedAt).toBe("2020-01-20");
    f.table.associations[0]!.status = "unknown";
    expect(await researchSignals("sh600000", f.bars, spec, native)).toEqual([]);
  },
);

it("unified C4 rejects absent tables and records missing monthly calendar without daily substitution", async () => {
  const f = chanMovementFixture();
  const native = async () => {
    const r = structuredClone(f.result);
    delete r.families[0]!.native!.recursiveMovements;
    return r;
  };
  const base = {
    start: f.bars[0]!.date,
    end: f.bars.at(-1)!.date,
    validationStart: f.bars.at(-1)!.date,
  };
  await expect(
    researchSignals(
      "sh600000",
      f.bars,
      researchSpecSchema.parse({
        ...base,
        strategy: "chan-trend-completed-daily-c4",
      }),
      native,
    ),
  ).rejects.toThrow("100–108");
  let calls = 0;
  expect(
    await researchSignals(
      "sh600000",
      f.bars,
      researchSpecSchema.parse({ ...base, strategy: "chan-bottom-monthly-c4" }),
      async () => {
        calls++;
        return f.result;
      },
    ),
  ).toEqual([]);
  expect(calls).toBe(0);
});

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
    completion: "unknown",
    theoreticalLevel: null,
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
  f.table.movements.find((m) => m.id === 4)!.low = 40;
  expect(chanC4SmallTurnFromSignal(f.result, f.bars, 0, third)).toMatchObject({
    status: "not-matched",
    action: "hold",
  });
});

it("CH13 unified replay aggregates complete months and confirms monthly divergence at discovery day", async () => {
  const f = chanMovementFixture();
  const days: string[] = [];
  for (
    let d = new Date("2018-01-01");
    d < new Date("2019-09-01");
    d.setUTCDate(d.getUTCDate() + 1)
  )
    if (![0, 6].includes(d.getUTCDay()))
      days.push(d.toISOString().slice(0, 10));
  const monthDays = Array.from({ length: 20 }, (_, i) =>
    days.filter(
      (d) =>
        d.slice(0, 7) ===
        new Date(Date.UTC(2018, i, 1)).toISOString().slice(0, 7),
    ),
  );
  const bars = monthDays.flatMap((ds, i) =>
    ds.map((date) => ({ ...f.bars[i]!, date })),
  );
  const monthly = f.bars.map((b, i) => ({
    ...b,
    date: monthDays[i]!.at(-1)!,
    volume: b.volume * monthDays[i]!.length,
    amount: b.amount * monthDays[i]!.length,
  }));
  f.table.anchor = 3;
  f.table.movements[0]!.level = 0;
  f.table.centers.forEach((c) => (c.level = 0));
  f.table.associations[0]!.level = 0;
  f.family.points.forEach((p) => (p.date = monthly[p.index]!.date));
  f.family.centers.forEach((c) => {
    c.startDate = monthly[c.start]!.date;
    c.endDate = monthly[c.end]!.date;
  });
  f.signal.date = monthly[f.signal.index]!.date;
  const stock = {
    id: "monthly-source",
    symbol: "sh600000",
    period: "day",
    adjustment: "none",
    source: "fixed-daily",
    createdAt: 0,
    hash: "fixed",
    bars,
  };
  const rows = monthDays.map((ds) => ({
    symbol: "sh600000",
    date: ds.at(-1)!,
    source: "fixed-calendar",
    availableAt: `${ds.at(-1)}T15:01:00+08:00`,
    stock,
    calendar: {
      days,
      closedDays: [],
      source: "fixed-calendar",
      hash: "fixed",
      availableAt: "2017-12-31T15:00:00+08:00",
    },
  }));
  const spec = researchSpecSchema.parse({
    strategy: "chan-bottom-monthly-c4",
    start: days[0],
    end: days.at(-1),
    validationStart: days.at(-1),
    wyckoffStructureInputs: rows,
  });
  let calls = 0;
  const native = async (
    prefix: readonly (typeof bars)[number][],
    anchor?: 1 | 2 | 3,
  ) => {
    expect(anchor).toBe(3);
    calls++;
    expect(prefix).toEqual(monthly.slice(0, prefix.length));
    const r = structuredClone(f.result);
    if (prefix.length < 20) {
      r.families[0]!.signals = [];
      Object.assign(r.families[0]!.native!.recursiveMovements!, {
        centers: [],
        movements: [],
        associations: [],
      });
    }
    return r;
  };
  const events = await researchSignals(
    "sh600000",
    bars,
    spec,
    native,
    undefined,
    undefined,
    days,
  );
  expect(calls).toBe(20);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    observedDate: days.at(-1),
    endpointDate: monthly[18]!.date,
  });
  expect(JSON.parse(events[0]!.evidence).anchor.name).toBe("monthly-anchor-v1");
  calls = 0;
  const bad = {
    ...spec,
    wyckoffStructureInputs: spec.wyckoffStructureInputs!.map((r) => ({
      ...r,
      calendar: { ...r.calendar, availableAt: "2020-01-01T00:00:00+08:00" },
    })),
  };
  expect(
    await researchSignals(
      "sh600000",
      bars,
      bad,
      native,
      undefined,
      undefined,
      days,
    ),
  ).toEqual([]);
  expect(calls).toBe(0);
});
