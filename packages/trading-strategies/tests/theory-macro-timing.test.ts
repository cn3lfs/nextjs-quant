import { describe, expect, it } from "vitest";
import {
  createExtendedStudyRule,
  evaluateMacroClockEtfRotation,
  evaluateMacroErpAllocation,
  evaluateStrategy,
  generateMacroClockSchedule,
  latestVisibleMacro,
  unifiedStrategyCatalog,
  visibleMacroHistory,
  type MacroObservation,
  type MacroSeriesId,
} from "../src/index.js";
import { candle } from "./ohlc-fixtures.js";

function row(
  seriesId: MacroSeriesId,
  reportPeriod: string,
  value: number,
  availableAt = reportPeriod,
): MacroObservation {
  return {
    seriesId,
    reportPeriod,
    availableAt,
    value,
    publicationBasis: "official",
  };
}

describe("publication-time visibility", () => {
  const dec = row("cpi-yoy", "2023-12-31", 1, "2024-01-12");
  const jan = row("cpi-yoy", "2024-01-31", 2, "2024-02-09");
  const revised = row("cpi-yoy", jan.reportPeriod, 3, "2024-02-15");
  const oldRevision = row("cpi-yoy", dec.reportPeriod, 8, "2024-02-16");
  const observations = [
    revised,
    row("cpi-yoy", "2024-02-29", 5, "2024-03-10"),
    jan,
    oldRevision,
    row("ppi-yoy", "2024-02-16", 90),
    dec,
    row("cpi-yoy", jan.reportPeriod, NaN, "2024-02-17"),
  ];

  it("keeps the original vintage until the revision's exact release date", () => {
    expect(latestVisibleMacro(observations, "cpi-yoy", "2024-01-31")).toEqual(
      dec,
    );
    expect(visibleMacroHistory(observations, "cpi-yoy", "2024-02-14")).toEqual([
      dec,
      jan,
    ]);
    expect(visibleMacroHistory(observations, "cpi-yoy", "2024-02-15")).toEqual([
      dec,
      revised,
    ]);
    expect(visibleMacroHistory(observations, "cpi-yoy", "2024-02-29")).toEqual([
      oldRevision,
      revised,
    ]);
    expect(latestVisibleMacro(observations, "cpi-yoy", "2024-02-29")).toEqual(
      revised,
    );
  });

  it("uses only the visibility date, even when it precedes the period label", () => {
    const early = row("pmi-mfg", "2024-03-31", 51, "2024-03-29");
    expect(latestVisibleMacro([early], "pmi-mfg", "2024-03-28")).toBeNull();
    expect(visibleMacroHistory([early], "cpi-yoy", "2024-03-29")).toEqual([]);
    expect(latestVisibleMacro([early], "pmi-mfg", "2024-03-29")).toBe(early);
    expect(visibleMacroHistory([early], "pmi-mfg", "2024-03-29")).toEqual([
      early,
    ]);
  });
});

const first = "2024-01-31",
  second = "2024-02-29";
function pair(id: MacroSeriesId, prior: number, current: number) {
  return [row(id, first, prior), row(id, second, current)];
}
const clock = (observations: MacroObservation[]) =>
  evaluateMacroClockEtfRotation({ asOf: second, observations });
describe("domestic ETF clock", () => {
  it.each([
    {
      regime: "recovery",
      pmi: [50, 50],
      cpi: [2, 3],
      ppi: [4, 2],
      delta: -0.5,
      targets: { sh510300: 0.4, sz159915: 0.4, sh510880: 0.2 },
    },
    {
      regime: "overheat",
      pmi: [48, 48.5],
      cpi: [2, 1],
      ppi: [2, 5],
      delta: 1,
      targets: { sh512400: 0.3, sh515220: 0.3, sh518880: 0.2, sh510300: 0.2 },
    },
    {
      regime: "stagflation",
      pmi: [51, 50.5],
      cpi: [1, 3],
      ppi: [4, 3],
      delta: 0.5,
      targets: { sh518880: 0.4, sh510880: 0.3, sh511010: 0.3 },
    },
    {
      regime: "recession",
      pmi: [48, 48.25],
      cpi: [1, 2],
      ppi: [3, 2],
      delta: 0,
      targets: { sh511010: 0.6, sh518880: 0.2, sh510880: 0.2 },
    },
  ] as const)(
    "maps $regime from PMI and mean CPI/PPI change",
    ({ regime, pmi, cpi, ppi, delta, targets }) => {
      const result = clock([
        ...pair("pmi-mfg", pmi[0], pmi[1]),
        ...pair("cpi-yoy", cpi[0], cpi[1]),
        ...pair("ppi-yoy", ppi[0], ppi[1]),
        row("bond-1y", first, 2),
        row("bond-10y", second, 3.25),
      ]);
      expect(result).toMatchObject({
        status: "ok",
        regime,
        diagnostics: { inflationChange: delta, termSpread: 1.25 },
      });
      expect(result.targets).toEqual(targets);
    },
  );

  it.each(["cpi-yoy", "ppi-yoy"] as const)(
    "can use %s alone and ignores later revisions to both axes",
    (id) => {
      const visible = [
        ...pair("pmi-mfg", 49, 51),
        ...pair(id, 1, 2),
        ...pair("gdp-yoy", 4, 3),
      ];
      const result = clock(visible);
      expect(result).toMatchObject({
        regime: "overheat",
        growth: "up",
        inflation: "up",
        diagnostics: { termSpread: null },
      });
      expect(
        clock([
          ...visible,
          row(id, second, -6, "2024-03-01"),
          row("pmi-mfg", second, 45, "2024-03-01"),
        ]),
      ).toEqual(result);
    },
  );

  it("requires two distinct visible periods on each axis, even with GDP and a yield curve", () => {
    const other = [
      ...pair("gdp-yoy", 2, 4),
      row("bond-1y", first, 2),
      row("bond-10y", second, 3),
    ];
    const noGrowth = clock([
      ...other,
      ...pair("cpi-yoy", 1, 2),
      row("pmi-mfg", first, 50),
      row("pmi-mfg", first, 51, second),
    ]);
    const noInflation = clock([
      ...other,
      ...pair("pmi-mfg", 49, 51),
      row("cpi-yoy", first, 1),
      row("ppi-yoy", second, 2),
    ]);
    for (const result of [noGrowth, noInflation]) {
      expect(result).toMatchObject({ regime: "unknown", status: "unknown" });
      expect(result.targets).toEqual({});
    }
    expect(noGrowth.growth).toBeNull();
    expect(noInflation.inflation).toBeNull();
  });

  it("uses only releases visible at each calendar close and skips the unfinished tail", () => {
    const calendar = [first, second, "2024-03-28", "2024-03-29", "2024-04-01"];
    const observations = [
      ...pair("pmi-mfg", 49, 50),
      row("ppi-yoy", first, 2),
      row("ppi-yoy", second, 1, "2024-03-01"),
    ];
    const monthly = generateMacroClockSchedule({ calendar, observations });
    expect(monthly.map((r) => [r.date, r.availableAt, r.regime])).toEqual([
      [first, first, "unknown"],
      [second, second, "unknown"],
      ["2024-03-29", "2024-03-29", "recovery"],
    ]);
    expect(monthly[0]!.targets).toEqual({});
    expect(monthly[2]!.targets).toEqual({
      sh510300: 0.4,
      sz159915: 0.4,
      sh510880: 0.2,
    });
    expect(monthly.every((r) => r.reason.length > 0)).toBe(true);
    expect(
      generateMacroClockSchedule({
        calendar,
        observations,
        rebalanceCadence: "quarter-end",
      }),
    ).toEqual(monthly.slice(2));
    expect(
      generateMacroClockSchedule({ calendar: [first, second], observations }),
    ).toEqual(monthly.slice(0, 2));
  });
});

const day = (n: number) => candle(n - 1, 1).date;
const peSeries = (pes: number[]) =>
  pes.map((pe, i) => ({ date: day(i + 1), pe }));
const yield2 = [row("bond-10y", day(1), 2)];
const unknownErp = {
  status: "unknown",
  erp: null,
  percentile: null,
  targets: {},
};
describe("equity-bond ERP", () => {
  it.each([
    { currentPe: 13, rank: 0.7, equity: 0.8, treasury: 0.2 },
    { currentPe: 15, rank: 0.5, equity: 0.5, treasury: 0.5 },
    { currentPe: 17, rank: 0.3, equity: 0.2, treasury: 0.8 },
  ])(
    "includes the current ERP at rank $rank and applies the inclusive cutoffs",
    ({ currentPe, rank, equity, treasury }) => {
      const pes = Array.from({ length: 10 }, (_, i) => 10 + i);
      const equityPeSeries = peSeries([
        ...pes.filter((pe) => pe !== currentPe),
        currentPe,
      ]);
      const result = evaluateMacroErpAllocation({
        asOf: day(10),
        observations: yield2,
        equityPeSeries,
        minObservations: 10,
      });
      expect(result.erp).toBeCloseTo(1 / currentPe - 0.02, 12);
      expect(result).toMatchObject({
        status: "ok",
        percentile: rank,
        targets: { sh510300: equity, sh511010: treasury },
      });
    },
  );

  it("joins yields as of each PE date and includes ties without backfilling revisions", () => {
    const input = {
      asOf: day(5),
      equityPeSeries: peSeries([20, 20, 20, 20, 20]),
      minObservations: 4,
      observations: [
        row("bond-10y", day(1), 50, day(5)),
        row("bond-10y", day(4), 3),
        row("bond-10y", day(1), 1, day(2)),
        row("bond-10y", day(1), 4, day(3)),
      ],
    };
    // Day one has no released yield. ERPs on days 2–5 are 4%, 1%, 2%, 2%.
    const result = evaluateMacroErpAllocation(input);
    expect(result.percentile).toBe(3 / 4);
    expect(result.erp).toBeCloseTo(0.02, 12);
    expect(
      evaluateMacroErpAllocation({
        ...input,
        observations: [
          ...input.observations,
          row("bond-10y", day(4), 100, day(6)),
        ],
        equityPeSeries: [...input.equityPeSeries, { date: day(6), pe: 1 }],
      }),
    ).toEqual(result);
    expect(
      evaluateMacroErpAllocation({ ...input, minObservations: 5 }),
    ).toEqual(unknownErp);
  });

  it("uses at most 250 distinct PE sessions and needs 60 usable pairs by default", () => {
    const equityPeSeries = peSeries([1, ...Array<number>(250).fill(20)]);
    const last = equityPeSeries.at(-1)!.date;
    expect(
      evaluateMacroErpAllocation({
        asOf: last,
        observations: yield2,
        equityPeSeries,
      }).percentile,
    ).toBe(1);
    expect(
      evaluateMacroErpAllocation({
        asOf: day(59),
        observations: yield2,
        equityPeSeries,
      }),
    ).toEqual(unknownErp);
    expect(
      evaluateMacroErpAllocation({
        asOf: day(60),
        observations: yield2,
        equityPeSeries,
      }).status,
    ).toBe("ok");
  });

  it("does not reuse stale PE, double count dates, or reach outside the requested window", () => {
    const input = {
      asOf: day(4),
      observations: yield2,
      equityPeSeries: peSeries([12, 15, 0, 20]),
      lookbackDays: 3,
      minObservations: 3,
    };
    expect(
      evaluateMacroErpAllocation({
        ...input,
        equityPeSeries: [...input.equityPeSeries, ...input.equityPeSeries],
      }),
    ).toEqual(unknownErp);
    expect(
      evaluateMacroErpAllocation({ ...input, lookbackDays: 4 }).status,
    ).toBe("ok");
    expect(
      evaluateMacroErpAllocation({
        ...input,
        asOf: day(5),
        minObservations: 1,
      }),
    ).toEqual(unknownErp);
    expect(
      evaluateMacroErpAllocation({
        ...input,
        minObservations: 1,
        observations: [row("bond-10y", day(1), 2, day(5))],
      }),
    ).toEqual(unknownErp);
  });

  it.each([0, -1, Infinity, NaN])(
    "fails closed for invalid as-of PE %s",
    (pe) => {
      expect(
        evaluateMacroErpAllocation({
          asOf: day(2),
          observations: yield2,
          equityPeSeries: peSeries([20, pe]),
          minObservations: 1,
        }),
      ).toEqual(unknownErp);
    },
  );
});

const id = "calendar-turn-of-month";
const flat = { entry: 0, entryIndex: -1 };
const datedBars = (dates: string[]) =>
  dates.map((date, i) => ({ ...candle(i, 10), date }));
describe("turn-of-month daily signal", () => {
  it("never reads a later bar even when no session falls in the entry window", () => {
    // The final three days of April contain no bars in this supplied series.
    const bars = datedBars(["2023-04-27", "2023-05-04"]);
    Object.defineProperty(bars, 1, {
      get() {
        throw new Error("read a future bar");
      },
    });
    const rule = createExtendedStudyRule(id, bars)!;
    expect(rule(0, flat)).toEqual({ enter: false, exit: false });
  });

  it("is an executable event signal from the very first completed bar", () => {
    expect(unifiedStrategyCatalog.find((d) => d.id === id)).toMatchObject({
      name: "月末月初日历效应",
      category: "event",
      family: "事件",
      implementation: "implemented",
      output: "signal",
      warmupBars: 0,
    });
    const bars = datedBars(["2024-12-30"]);
    expect(
      evaluateStrategy({ strategyId: id }, { bars, asOf: bars[0]!.date }),
    ).toEqual({ kind: "signal", enter: true, exit: false });
  });

  it("enters during leap February's final three days and exits on March's third completed session", () => {
    const bars = datedBars([
      "2024-02-26",
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
      "2024-03-04",
      "2024-03-05",
    ]);
    const rule = createExtendedStudyRule(id, bars)!;
    const held = { entry: 10, entryIndex: 2 };
    for (const [i, bar] of bars.entries()) {
      const position = i < 2 ? flat : held;
      const expected = { enter: i === 1, exit: i === 6 };
      expect(rule(i, position), bar.date).toEqual(expected);
      expect(
        createExtendedStudyRule(id, bars.slice(0, i + 1))!(i, position),
      ).toEqual(expected);
      expect(
        evaluateStrategy(
          { strategyId: id },
          { bars, asOf: bar.date, position },
        ),
      ).toEqual({ kind: "signal", ...expected });
    }
  });

  it("exits after three new-month sessions across a year or holiday, including a next-month fill", () => {
    const bars = datedBars([
      "2024-12-31",
      "2025-01-02",
      "2025-01-03",
      "2025-01-06",
    ]);
    const rule = createExtendedStudyRule(id, bars)!;
    for (const entryIndex of [0, 1]) {
      const held = { entry: 10, entryIndex };
      expect(rule(2, held).exit).toBe(false);
      expect(rule(3, held).exit).toBe(true);
    }
    const holiday = datedBars([
      "2024-09-30",
      "2024-10-08",
      "2024-10-10",
      "2024-10-11",
    ]);
    expect(
      createExtendedStudyRule(id, holiday)!(3, { entry: 10, entryIndex: 0 })
        .exit,
    ).toBe(true);
  });

  it("caps holding at ten bars even if the month-end exit condition has not fired", () => {
    const bars = datedBars([
      "2024-01-11",
      "2024-01-12",
      "2024-01-15",
      "2024-01-16",
      "2024-01-17",
      "2024-01-18",
      "2024-01-19",
      "2024-01-22",
      "2024-01-23",
      "2024-01-24",
      "2024-01-25",
    ]);
    const rule = createExtendedStudyRule(id, bars)!;
    expect(rule(9, { entry: 10, entryIndex: 0 }).exit).toBe(false);
    expect(rule(10, { entry: 10, entryIndex: 0 }).exit).toBe(true);
  });
});
