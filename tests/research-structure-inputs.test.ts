import { expect, it } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import { researchStructureWeekly } from "~/server/research-structure-weekly";
import {
  researchStructureRs,
  type StructureBenchmark,
} from "~/server/research-structure-rs";
import {
  researchStructureTargets,
  structurePfColumns,
} from "~/lib/research-structure-targets";

const dates = Array.from(
  { length: 28 },
  (_, i) => new Date(Date.UTC(2020, 0, 6 + i)),
)
  .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
  .map((d) => d.toISOString().slice(0, 10));
const bar = (date: string, close = 10): Bar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1000,
});
const snapshot = (
  symbol = "sh600000",
  bars = dates.map((d) => bar(d)),
): Snapshot => ({
  id: symbol,
  symbol,
  bars,
  hash: "fixture",
  source: "fixture",
  createdAt: 0,
  period: "day",
  adjustment: "none",
});
const calendar = {
  days: dates,
  source: "fixture-calendar",
  hash: "fixture-hash",
};

it("completed week cutoff is Friday; incomplete and wholly missing weeks cannot be compressed", () => {
  const s = snapshot();
  const ready = researchStructureWeekly(s, calendar, "2020-01-31", 3);
  expect(ready.status).toBe("ready");
  expect(ready.weeks.map((w) => [w.week, w.bar.volume])).toEqual([
    ["2020-01-13", 500],
    ["2020-01-20", 500],
    ["2020-01-27", 500],
  ]);
  expect(
    researchStructureWeekly(s, calendar, "2020-01-30", 2).weeks.at(-1)?.bar
      .date,
  ).toBe("2020-01-24");
  for (const missing of [["2020-01-22"], dates.slice(10, 15)]) {
    const r = researchStructureWeekly(
      { ...s, bars: s.bars.filter((b) => !missing.includes(b.date)) },
      calendar,
      "2020-01-31",
      3,
    );
    expect(r.status).toBe("missing");
    expect(r.weeks).toEqual([]);
    expect(r.gaps[0]?.week).toBe("2020-01-20");
  }
});
it("only explicitly closed whole weeks are skipped; unknown weekdays are not holidays", () => {
  const holiday = dates.slice(10, 15),
    s = snapshot();
  s.bars = s.bars.filter((b) => !holiday.includes(b.date));
  const reference = {
    ...calendar,
    days: dates.filter((d) => !holiday.includes(d)),
    closedDays: holiday,
  };
  expect(
    researchStructureWeekly(s, reference, "2020-01-31", 3).weeks.map(
      (w) => w.week,
    ),
  ).toEqual(["2020-01-06", "2020-01-13", "2020-01-27"]);
  expect(
    researchStructureWeekly(
      s,
      { ...reference, closedDays: [] },
      "2020-01-31",
      3,
    ).status,
  ).toBe("missing");
  expect(
    researchStructureWeekly(s, { ...reference, hash: null }, "2020-01-31", 3)
      .status,
  ).toBe("missing");
});
it("weekly adapter cuts future bars before validation and retains zero-volume gaps", () => {
  const s = snapshot(),
    before = researchStructureWeekly(s, calendar, "2020-01-24", 2);
  s.bars.push({ ...bar("2020-02-03"), close: NaN });
  expect(researchStructureWeekly(s, calendar, "2020-01-24", 2)).toEqual(before);
  const empty = snapshot();
  const partial = snapshot();
  partial.bars.at(-2)!.volume = 0;
  expect(
    researchStructureWeekly(partial, calendar, "2020-01-31", 2).status,
  ).toBe("missing");
  expect(() =>
    researchStructureWeekly(
      { ...snapshot(), historicalAsOf: "2020-01-30" },
      calendar,
      "2020-01-31",
      2,
    ),
  ).toThrow("截止");
  empty.bars = empty.bars.map((b) => ({ ...b, volume: 0 }));
  expect(researchStructureWeekly(empty, calendar, "2020-01-31", 2).status).toBe(
    "missing",
  );
  expect(() =>
    researchStructureWeekly(snapshot(), calendar, "2020-02-31", 2),
  ).toThrow("日期");
});

const start = dates[0]!,
  end = dates.at(-1)!;
function benchmark(
  role: "industry" | "market",
  symbol: string,
): StructureBenchmark {
  return {
    snapshot: snapshot(symbol),
    availableAt: `${end}T15:00:00+08:00`,
    identity: {
      role,
      stock: "sh600000",
      benchmark: symbol,
      name: role,
      source: "historical-fixture",
      effectiveFrom: start,
      effectiveTo: end,
      availableAt: `${start}T09:00:00+08:00`,
      capturedAt: `${end}T16:00:00+08:00`,
    },
  };
}
const rs = (
  s = snapshot(),
  b = [benchmark("industry", "sh000004"), benchmark("market", "sh000300")],
) => researchStructureRs(s, b, calendar, start, end, `${end}T15:00:00+08:00`);
it("dual RS reuses normalized price ratios and retains equality as neutral", () => {
  expect(rs()).toMatchObject({ status: "ready", bothStronger: false });
  const s = snapshot();
  s.bars.at(-1)!.close = 12;
  const r = rs(s);
  expect(r.status).toBe("ready");
  expect(r.bothStronger).toBe(true);
  expect(r.evidence.market?.rows.at(-1)?.rs).toBe(120);
  expect(r.evidence.industry?.changePercent).toBeCloseTo(20);
});
it("RS rejects present-day membership, duplicate roles, shared missing days and late bars", () => {
  const late = [
    benchmark("industry", "sh000004"),
    benchmark("market", "sh000300"),
  ];
  late[0]!.identity.availableAt = `${end}T09:00:00+08:00`;
  expect(rs(snapshot(), late)).toMatchObject({
    status: "missing",
    bothStronger: null,
  });
  expect(rs(snapshot(), [late[1]!, late[1]!]).status).toBe("missing");
  const b = [
      benchmark("industry", "sh000004"),
      benchmark("market", "sh000300"),
    ],
    s = snapshot();
  s.bars.splice(4, 1);
  b.forEach((v) => v.snapshot.bars.splice(4, 1));
  expect(rs(s, b).gaps).toContain("标的缺少研究日历交易日");
  b[0]!.availableAt = `${end}T16:00:00+08:00`;
  expect(rs(snapshot(), b).gaps).toContain("industry行情可用时点无效");
});
it("future benchmark garbage cannot revise a completed comparison", () => {
  const b = [
    benchmark("industry", "sh000004"),
    benchmark("market", "sh000300"),
  ];
  const before = rs(snapshot(), b);
  b[0]!.snapshot.bars.push(bar("2020-02-03", NaN));
  expect(rs(snapshot(), b)).toEqual(before);
  expect(
    researchStructureRs(
      snapshot(),
      b,
      { ...calendar, hash: null },
      start,
      end,
      `${end}T15:00:00+08:00`,
    ).status,
  ).toBe("missing");
  expect(
    researchStructureRs(
      snapshot(),
      b,
      { ...calendar, closedDays: [start] },
      start,
      end,
      `${end}T15:00:00+08:00`,
    ).gaps,
  ).toContain("研究交易日历开闭市冲突");
});

it("single-box P&F reversals are strictly greater; same-direction moves extend one column", () => {
  const b = [10, 11, 12, 14, 13, 12, 10, 11, 12].map((p, i) =>
    bar(dates[i]!, p),
  );
  const r = structurePfColumns(b, 8, 16, 1);
  expect(r.count).toBe(3);
  expect(
    structurePfColumns([bar(start, 10), { ...bar(end, 11), low: 20 }], 8, 16, 1)
      .status,
  ).toBe("missing");
  expect(r.columns.map((c) => [c.direction, c.extreme])).toEqual([
    [1, 14],
    [-1, 10],
    [1, 12],
  ]);
  expect(
    structurePfColumns([bar(start, 10), bar(end, 11)], 8, 16, 1).count,
  ).toBe(0);
  expect(
    structurePfColumns([bar(start, 10), bar(end, 11)], 8, 16, 0).status,
  ).toBe("missing");
});
it("column projection and width heuristics remain separately named and priced", () => {
  const bars = [10, 12, 10, 12, 10, 12, 10, 12, 10, 12].map((p, i) =>
    bar(dates[i]!, p),
  );
  const input = {
    bars,
    low: 8,
    high: 16,
    boxSize: 1,
    direction: 1 as const,
    breakoutPrice: 17,
    confirmedAt: dates[10]!,
  };
  expect(
    researchStructureTargets({ ...input, model: "pf-close-reversal-1box" })
      .targets,
  ).toEqual([26]);
  expect(
    researchStructureTargets({ ...input, model: "source-width-123" }).targets,
  ).toEqual([24, 32, 40]);
  expect(
    researchStructureTargets({ ...input, model: "source-width-time-columns" })
      .targets,
  ).toEqual([20, 52, 88]);
  expect(
    researchStructureTargets({
      ...input,
      model: "source-width-123",
      confirmedAt: bars.at(-1)!.date,
    }).status,
  ).toBe("missing");
  expect(
    researchStructureTargets({
      ...input,
      model: "source-width-123",
      direction: -1,
      breakoutPrice: 7,
    }).status,
  ).toBe("missing");
});
it("width/time source conflicts are retained, not silently sorted to a favourable ladder", () => {
  const bars = dates.map((d, i) => bar(d, i < 10 ? 10 : 12));
  const r = researchStructureTargets({
    bars,
    model: "source-width-time-columns",
    low: 8,
    high: 16,
    boxSize: 1,
    direction: 1,
    breakoutPrice: 17,
    confirmedAt: "2020-02-03",
  });
  expect(r.targets).toEqual([24, 20, 24]);
  expect(r.status === "computed" && r.ordered).toBe(false);
});
