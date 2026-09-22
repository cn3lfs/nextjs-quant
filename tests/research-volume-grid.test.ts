import { describe, expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  classifyVolumePrice,
  researchVolumeSeries,
  volumeWarmupStart,
  type VolumePoint,
} from "../src/lib/research-volume";
import {
  evaluateVolumeGrid,
  volumeGridFacts,
  volumeGridIds,
  volumeGridPosition,
  volumeDayStatus,
  volumeTurnoverBand,
  type GridFacts,
  type PositionFacts,
  type VolumeGridId,
  type VolumeEvidence,
} from "../src/lib/research-volume-grid";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";

const position: PositionFacts = {
  higher: true,
  lower: false,
  touches: false,
  holds: true,
  ma20: 95,
  ma60: 90,
  ma20Prior5: 94,
  close: 100,
  rise: 0.2,
  drop: 0,
  bias: 0.05,
  stall: false,
  contracted10: false,
};
function fact(p: Partial<GridFacts> = {}): GridFacts {
  return {
    location: "up",
    support: 90,
    resistance: 100,
    position,
    ma5: 97,
    turnover: 1.5,
    turnoverBand: "normal",
    anomalies: {
      limit: false,
      corporateAction: false,
      suspension: false,
      resumption: false,
      etfFlow: false,
    },
    unverified: [],
    abnormal: false,
    highVolume60: 1000,
    lowVolume60: 50,
    highVolumeHistory: 1200,
    historicalStart: "2020-01-01",
    controlled: false,
    dryTurnover: false,
    stack: false,
    decreasing: false,
    pulses: false,
    isolated: false,
    stall: false,
    lowVolumeHigh: false,
    shapeRisk: false,
    ...p,
  };
}
function point(p: Partial<VolumePoint["values"]> = {}, i = 0): VolumePoint {
  const v = {
    close: 99,
    open: 98,
    high: 100,
    low: 97,
    volume: 100,
    change: 0,
    body: 0.005,
    vma5: 100,
    vma10: 100,
    vma5Prior: 100,
    vma20Prior: 100,
    ratio5: 1,
    ratio20Prior: 1,
    ma20: 95,
    ma60: 90,
    high20Prior: 100,
    high10: 100,
    low10: 90,
    riseFromLow60: 0.2,
    dropFromHigh60: 0,
    range10: 0.1,
    location: "up-ma-proxy" as const,
    grid: classifyVolumePrice(0, 0.005, 1),
    resumptionHold: false,
    ...p,
  };
  v.grid = classifyVolumePrice(v.change!, v.body!, v.ratio5!);
  return {
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    entry: false,
    exit: false,
    reason: null,
    values: v,
    candidate: null,
    decision: "base",
  };
}
function run(
  id: VolumeGridId,
  values: Partial<VolumePoint["values"]>[],
  facts: Partial<GridFacts>[] = [],
) {
  return evaluateVolumeGrid(
    id,
    values.map((v, i) => point(v, i)),
    values.map((_, i) => fact(facts[i])),
  );
}
const breakout = {
  close: 103,
  open: 100,
  high: 104,
  low: 100,
  change: 0.03,
  ratio5: 2,
  volume: 300,
};
const retest = {
  close: 101,
  open: 100,
  high: 102,
  low: 100,
  change: 0,
  ratio5: 1.1,
  volume: 150,
};

describe("complete position engineering definitions", () => {
  it.each([
    [{}, "up"],
    [{ higher: false }, "unknown"],
    [{ holds: false }, "unknown"],
    [{ ma20: 85, ma60: 90, close: 80, higher: false, lower: true }, "down"],
    [{ ma20: 85, ma60: 90, close: 80, higher: false, lower: false }, "unknown"],
    [{ higher: false, touches: true }, "range"],
    [
      {
        higher: false,
        touches: true,
        drop: 0.2,
        ma20: 90,
        ma60: 90,
        ma20Prior5: 90,
        contracted10: true,
      },
      "bottom",
    ],
    [
      {
        higher: false,
        touches: true,
        drop: 0.2,
        ma20: 90,
        ma60: 90,
        ma20Prior5: 90,
        contracted10: false,
      },
      "range",
    ],
    [{ rise: 0.5, bias: 0.1, stall: true }, "high"],
    [{ rise: 0.499, bias: 0.1, stall: true }, "up"],
    [{ rise: 0.5, bias: 0.099, stall: true }, "up"],
    [{ rise: 0.5, bias: 0.1, stall: false }, "up"],
    [{ ma60: null }, "unknown"],
  ] as [Partial<PositionFacts>, string][])("%j -> %s", (patch, want) =>
    expect(volumeGridPosition({ ...position, ...patch })).toBe(want),
  );
});

it("price-up expanded waits for shrinking-volume retest, and enforces the bottom R2 branch", () => {
  expect(
    run("vp-grid-up-expanded", [breakout, retest]).map((p) => p.entry),
  ).toEqual([false, true]);
  expect(
    run("vp-grid-up-expanded", [breakout, { ...retest, volume: 301 }]).at(-1)!
      .entry,
  ).toBe(false);
  expect(
    run(
      "vp-grid-up-expanded",
      [{ ...breakout, ratio5: 1.999 }, retest],
      [{ location: "bottom" }, { location: "bottom" }],
    ).some((p) => p.entry),
  ).toBe(false);
  expect(
    run(
      "vp-grid-up-expanded",
      [breakout, retest],
      [{ location: "bottom" }, { location: "bottom" }],
    ).at(-1)!.entry,
  ).toBe(true);
  expect(
    run("vp-grid-up-expanded", [breakout, { ...retest, low: 99 }]).at(-1)!
      .entry,
  ).toBe(false);
});
it("normal-volume rise routes the next contraction into a distinct five-bar confirmation", () => {
  const a = { ...breakout, ratio5: 1 },
    b = { close: 104, high: 105, low: 101, ratio5: 0.7, change: 0.03 },
    c = { close: 106, high: 107, low: 101, ratio5: 1.2 };
  const rows = run("vp-grid-up-normal", [a, b, c]);
  expect(rows.map((p) => p.entry)).toEqual([false, false, true]);
  expect(rows[1]!.gridState?.kind).toBe("contract");
  expect(
    run("vp-grid-up-normal", [a, b, { ...c, ratio5: 2.5 }]).at(-1)!.entry,
  ).toBe(false);
  expect(
    run("vp-grid-up-normal", [a, { ...c, ratio5: 1.5, change: 0.03 }]).at(-1)!
      .entry,
  ).toBe(true);
});
it.each(["vp-grid-up-contracted", "vp-grid-down-contracted"] as const)(
  "%s requires a subsequent demand breakout",
  (id) => {
    const a = {
      close: 99,
      high: 100,
      low: 96,
      change: id.includes("up-") ? 0.03 : -0.03,
      ratio5: 0.7,
    };
    expect(
      run(id, [a, { close: 101, high: 102, low: 97, ratio5: 1.5 }]).at(-1)!
        .entry,
    ).toBe(true);
    expect(
      run(id, [a, { close: 100, high: 102, low: 97, ratio5: 1.5 }]).at(-1)!
        .entry,
    ).toBe(false);
  },
);
it.each(["vp-grid-flat-expanded", "vp-grid-flat-contracted"] as const)(
  "%s freezes both edges and supports downward exit",
  (id) => {
    const a = { ratio5: id.includes("expanded") ? 1.5 : 0.7 };
    expect(
      run(id, [a, { close: 101, high: 102, ratio5: 1.5 }]).at(-1)!.entry,
    ).toBe(true);
    const down = {
      close: 89,
      open: 90,
      high: 91,
      low: 88,
      ratio5: 1.5,
      change: -0.011,
    };
    expect(run(id, [a, down]).at(-1)!.exit).toBe(true);
    expect(run(id, [a, { close: 100, ratio5: 1.5 }]).at(-1)!.entry).toBe(false);
  },
);
it("two weeks without direction becomes a frozen range and can subsequently break", () => {
  const input = [
    { ratio5: 1.5 },
    ...Array.from({ length: 10 }, () => ({})),
    { close: 101, high: 102, ratio5: 1.5 },
  ];
  const rows = run("vp-grid-flat-expanded", input);
  expect(rows[10]!.decision).toContain("转冻结");
  expect(rows[10]!.gridState?.phase).toBe(1);
  expect(rows[11]!.entry).toBe(true);
});
it("neutral cells are waiting states in a live grid, then route the new volume direction", () => {
  for (const change of [0, -0.03]) {
    const rows = run("vp-grid", [{ change }, breakout, retest]);
    expect(rows[0]!.entry).toBe(false);
    expect(rows[0]!.decision).toContain("等待下一根");
    expect(rows.at(-1)!.entry).toBe(true);
  }
});
it("location routes high/down to exit, unknown conservatively exits, and bottom panic needs two quiet bars", () => {
  for (const location of ["high", "down", "unknown"] as const)
    expect(
      run("vp-grid", [breakout], [{ location, resistance: 110 }])[0]!.exit,
    ).toBe(true);
  const a = {
    close: 96,
    open: 97,
    high: 98,
    low: 90,
    ratio5: 2.5,
    change: -0.03,
  };
  const values = [
    a,
    { close: 96, high: 97, low: 91, ratio5: 0.7 },
    { close: 97, high: 98, low: 92, ratio5: 0.7 },
    { close: 99, high: 100, low: 92, ratio5: 1.5 },
  ];
  expect(
    run(
      "vp-grid-down-expanded",
      values,
      values.map(() => ({ location: "bottom" })),
    ).at(-1)!.entry,
  ).toBe(true);
  expect(
    run(
      "vp-grid-down-expanded",
      [a, { ...values[1], ratio5: 0.8 }, ...values.slice(2)],
      values.map(() => ({ location: "bottom" })),
    ).some((p) => p.entry),
  ).toBe(false);
});
it.each([
  "vp-extreme-main",
  "vp-extreme-detail",
  "vp-extreme-history",
] as const)(
  "%s gives geometry priority and a real breakout entry baseline",
  (id) => {
    expect(run(id, [breakout])[0]!.entry).toBe(true);
    const v = { ...breakout, ratio5: 2.5, volume: 1300 };
    expect(run(id, [v], [{ location: "high", shapeRisk: true }])[0]!.exit).toBe(
      true,
    );
    expect(
      run(
        id,
        [{ ...v, ratio5: 1.9, volume: 900 }],
        [{ location: "high", shapeRisk: true }],
      )[0]!.exit,
    ).toBe(false);
  },
);
it("main/detail huge boundaries and available-history max are independent", () => {
  const v = { ...breakout, ratio5: 2, volume: 900 };
  const f = { location: "high" as const, shapeRisk: true };
  expect(run("vp-extreme-main", [v], [f])[0]!.exit).toBe(true);
  expect(run("vp-extreme-detail", [v], [f])[0]!.exit).toBe(false);
  expect(
    run("vp-extreme-history", [{ ...v, volume: 1100 }], [f])[0]!.exit,
  ).toBe(false);
  expect(run("vp-extreme-detail", [{ ...v, volume: 1100 }], [f])[0]!.exit).toBe(
    true,
  );
});
it("huge next-day shrink and later lower-volume new high exit; two growing highs invalidate", () => {
  const high = { location: "high" as const };
  const a = { ...breakout, ratio5: 2.5 };
  expect(
    run(
      "vp-extreme-detail",
      [a, { close: 103, high: 104, ratio5: 0.7 }],
      [high, high],
    )[1]!.exit,
  ).toBe(true);
  const rows = run(
    "vp-extreme-detail",
    [
      a,
      { close: 104, high: 105, ratio5: 1.5 },
      { close: 105, high: 106, ratio5: 1.5 },
      { close: 104, high: 106, ratio5: 0.7 },
    ],
    [high, high, high, high],
  );
  expect(rows[2]!.gridState).toBeNull();
  expect(rows[3]!.exit).toBe(false);
  expect(
    run(
      "vp-extreme-detail",
      [
        a,
        { close: 103, high: 104, ratio5: 1 },
        { close: 104, high: 105, ratio5: 0.7, volume: 100 },
      ],
      [high, high, high],
    )[2]!.exit,
  ).toBe(true);
});
it.each(["vp-dry-turnover-and", "vp-dry-turnover-or"] as const)(
  "%s requires separate mild stage and historical low turnover",
  (id) => {
    const a = { ratio5: 0.4, volume: 40 },
      b = { ratio5: 1.2 },
      c = { ratio5: 1.5, close: 101, high: 102 };
    const fs = [0, 1, 2].map(() => ({
      location: "bottom" as const,
      dryTurnover: true,
    }));
    expect(run(id, [a, b, c], fs).map((x) => x.entry)).toEqual([
      false,
      false,
      true,
    ]);
    expect(run(id, [a, c], fs).some((x) => x.entry)).toBe(false);
    expect(
      run(
        id,
        [a, b, c],
        fs.map((f) => ({ ...f, dryTurnover: false })),
      ).some((x) => x.entry),
    ).toBe(false);
    expect(run(id, [a], [{ dryTurnover: null }])[0]!.reason).toContain(
      "连续60根",
    );
  },
);
it("AND and OR ground-volume originals remain observably different", () => {
  const fs = [0, 1, 2].map(() => ({
    location: "bottom" as const,
    dryTurnover: true,
  }));
  const v = [
    { ratio5: 0.4, volume: 60 },
    { ratio5: 1.2 },
    { ratio5: 1.5, close: 101, high: 102 },
  ];
  expect(run("vp-dry-turnover-or", v, fs).at(-1)!.entry).toBe(true);
  expect(run("vp-dry-turnover-and", v, fs).at(-1)!.entry).toBe(false);
});
it.each([
  [0.999, "cold"],
  [1, "normal"],
  [3, "active"],
  [7, "very-active"],
  [15, "very-active"],
  [15.001, "extreme"],
  [NaN, null],
  [-1, null],
] as const)("turnover %s has boundary %s", (v, want) =>
  expect(volumeTurnoverBand(v)).toBe(want),
);
it("turnover rows change entry/exit rather than only describing the bands", () => {
  expect(
    run("vp-controlled-turnover", [{}], [{ controlled: true }])[0]!.entry,
  ).toBe(true);
  expect(
    run("vp-controlled-turnover", [{}], [{ controlled: false }])[0]!.entry,
  ).toBe(false);
  expect(
    run("vp-turnover-bands", [breakout], [{ turnover: 15 }])[0]!.entry,
  ).toBe(true);
  expect(
    run("vp-turnover-bands", [breakout], [{ turnover: 15.001 }])[0]!.entry,
  ).toBe(false);
  expect(
    run(
      "vp-turnover-location",
      [breakout],
      [{ location: "bottom", turnover: 16 }],
    )[0]!.entry,
  ).toBe(true);
  expect(
    run(
      "vp-turnover-location",
      [breakout],
      [{ location: "high", turnover: 16 }],
    )[0]!.exit,
  ).toBe(true);
});
it.each([1, 2, 3])(
  "wash reclaim clock %s preserves support and requires both phases",
  (days) => {
    const id = `vp-wash-${days}` as VolumeGridId;
    const a = {
      close: 100,
      open: 104,
      high: 105,
      low: 96,
      change: -0.04,
      ratio5: 1.6,
      volume: 300,
    };
    const b = { close: 106, open: 101, high: 107, low: 98, ratio5: 0.7 };
    const c = { ...b, ratio5: 1.5 };
    const good = run(id, [a, b, c]);
    expect(good[1]!.entry).toBe(true);
    expect(run(id, [{ ...a, low: 89 }])[0]!.exit).toBe(true);
    expect(run(id, [{ ...a, ratio5: 2.5 }])[0]!.exit).toBe(true);
    expect(run(id, [a, c]).at(-1)!.entry).toBe(false);
  },
);
it("multi-day table covers stacks, pulses, decreasing range, isolated confirmation and both exits", () => {
  expect(run("vp-multiday-grid", [{}], [{ stack: true }])[0]!.entry).toBe(true);
  expect(
    run("vp-multiday-grid", [breakout], [{ pulses: true }])[0]!.entry,
  ).toBe(true);
  expect(
    run("vp-multiday-grid", [{}, breakout], [{ decreasing: true }, {}])[1]!
      .entry,
  ).toBe(true);
  expect(
    run(
      "vp-multiday-grid",
      [breakout, { ...breakout, ratio5: 1.5 }],
      [{ isolated: true }, {}],
    ).map((x) => x.entry),
  ).toEqual([false, true]);
  expect(
    run(
      "vp-multiday-grid",
      [breakout, { ...breakout, ratio5: 0.7 }],
      [{ isolated: true }, {}],
    ).some((x) => x.entry),
  ).toBe(false);
  for (const patch of [{ stall: true }, { lowVolumeHigh: true }])
    expect(run("vp-multiday-grid", [{}], [patch])[0]!.exit).toBe(true);
});

function bars(n = 120): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 3) * 3 + i * 0.05;
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: c - 0.2,
      close: c,
      high: c + 1,
      low: c - 1,
      volume: 100,
      amount: 100 * c,
    };
  });
}
function evidence(input: Bar[]): VolumeEvidence {
  return Object.fromEntries(
    input.map((b) => [
      b.date,
      {
        date: b.date,
        availableDate: b.date,
        source: "fixed point-in-time fixture",
        floatShares: 10000,
        volumeUnit: "share",
        limit: false,
        corporateAction: false,
        suspension: false,
        resumption: false,
        etfFlow: false,
      },
    ]),
  );
}
it("historical float adapter rejects future/date-mismatched/unknown-unit values, preserving share units", () => {
  const b = bars(1)[0]!,
    e = evidence([b]);
  expect(volumeDayStatus(b, e).turnover).toBe(1);
  expect(
    volumeDayStatus(b, { [b.date]: { ...e[b.date]!, volumeUnit: "lot100" } })
      .turnover,
  ).toBe(100);
  for (const patch of [
    { availableDate: "2026-01-01" },
    { date: "2019-01-01" },
    { source: "" },
    { floatShares: 0 },
    { floatShares: Infinity },
    { volumeUnit: undefined },
  ])
    expect(
      volumeDayStatus(b, { [b.date]: { ...e[b.date]!, ...patch } }).turnover,
    ).toBeNull();
  expect(volumeDayStatus(b, {}).unverified).toHaveLength(5);
});
it.each([
  "limit",
  "corporateAction",
  "suspension",
  "resumption",
  "etfFlow",
] as const)(
  "%s is separately marked and removed from normal-volume windows",
  (key) => {
    const input = bars();
    const e = evidence(input);
    const date = input[90]!.date;
    const dirty = { ...e, [date]: { ...e[date]!, [key]: true } };
    const rows = researchVolumeSeries("vp-grid", input, dirty);
    expect(rows[90]!.reason).toContain(key);
    expect(rows[91]!.values.ratio5).toBeNull();
    expect(rows[90]!.entry).toBe(false);
  },
);
it("real bars feed exact geometry, 60-day history and turnover facts rather than current snapshots", () => {
  const input = bars();
  const e = evidence(input);
  const base = researchVolumeSeries("vp-breakout-1-5", input);
  const facts = volumeGridFacts(input, base, e);
  expect(facts.at(-1)!.highVolumeHistory).toBe(100);
  expect(facts.at(-1)!.historicalStart).toBe(input[0]!.date);
  expect(facts.at(-1)!.dryTurnover).toBe(false);
  const altered = input.map((b) => ({
    ...b,
    open: 99,
    close: 100,
    high: 104,
    low: 98,
  }));
  const shapes = volumeGridFacts(
    altered,
    researchVolumeSeries("vp-breakout-1-5", altered),
    e,
  );
  expect(shapes.at(-1)!.shapeRisk).toBe(true);
  const missing = { ...e };
  delete missing[input[100]!.date];
  expect(volumeGridFacts(input, base, missing).at(-1)!.dryTurnover).toBeNull();
  for (const id of volumeGridIds.filter((id) => id.includes("turnover")))
    expect(researchVolumeSeries(id, input).at(-1)!.reason).toContain("待数据");
});

it("the runnable daily adapter confirms an actual two-touch range breakout and retest", () => {
  const input = bars(140).map((b, i) => {
    const c = 100 + Math.sin(i / 3) * 2;
    return { ...b, open: c - 0.2, close: c, high: c + 1, low: c - 1 };
  });
  const ceiling = 103;
  input.push({
    ...input.at(-1)!,
    date: "2020-05-20",
    open: 104,
    close: 106,
    high: 107,
    low: 104,
    volume: 300,
  });
  input.push({
    ...input.at(-1)!,
    date: "2020-05-21",
    open: 104,
    close: 104,
    high: 105,
    low: ceiling,
    volume: 200,
  });
  const rows = researchVolumeSeries("vp-grid-up-expanded", input);
  expect(rows.at(-2)!.entry).toBe(false);
  expect(rows.at(-1)!.entry).toBe(true);
  expect(rows.at(-1)!.ruleStop?.price).toBeLessThanOrEqual(ceiling);
  const noVolume = input.map((b) => ({ ...b, volume: 100 }));
  expect(
    researchVolumeSeries("vp-grid-up-expanded", noVolume).at(-1)!.entry,
  ).toBe(false);
});

it("all-history proof starts at input origin and missing float errors expose the requested interval", async () => {
  const input = bars();
  const start = input[100]!.date,
    end = input.at(-1)!.date;
  expect(volumeWarmupStart(input, start, "vp-extreme-history")).toBe(
    input[0]!.date,
  );
  const spec = researchSpecSchema.parse({
    strategy: "vp-turnover-bands",
    start,
    end,
    validationStart: input[110]!.date,
  });
  await expect(
    researchSignals("sh600000", input, spec, async () => {
      throw new Error("not used");
    }),
  ).rejects.toThrow(`研究区间${start}至${end}没有可用量价输入`);
  await expect(
    researchSignals("sh600000", input, spec, async () => {
      throw new Error("not used");
    }),
  ).rejects.toThrow("流通股本");
});

it("historical turnover filters are computed from raw bars with exact 2% and 1% boundaries", () => {
  const input = bars().map((b, i) => {
    const c = 100 + i * 0.5;
    return { ...b, open: c - 0.5, close: c, high: c + 0.1, low: c - 0.6 };
  });
  const get = (data: Bar[], proof: VolumeEvidence) =>
    volumeGridFacts(
      data,
      researchVolumeSeries("vp-breakout-1-5", data),
      proof,
    ).at(-1)!;
  const proof = evidence(input),
    date = input.at(-1)!.date;
  expect(get(input, proof).controlled).toBe(true);
  expect(
    get(input, { ...proof, [date]: { ...proof[date]!, floatShares: 5000 } })
      .controlled,
  ).toBe(false);
  expect(
    get(
      input.map((b, i) =>
        i === input.length - 1 ? { ...b, low: b.close - 10 } : b,
      ),
      proof,
    ).controlled,
  ).toBe(false);
  const dry = input.map((b, i) =>
    i === input.length - 1 ? { ...b, volume: 50 } : b,
  );
  expect(get(dry, proof).dryTurnover).toBe(true);
  expect(get(input, proof).dryTurnover).toBe(false);
});

it("multi-day flags are calculated from measured volume sequences rather than asserted input labels", () => {
  const input = bars().map((b, i) => {
    const c = 100 + i * 0.1;
    return { ...b, open: c, close: c, high: c + 1, low: c - 1 };
  });
  const flags = (volumes: number[]) => {
    const data = input.map((b, i) => ({
      ...b,
      volume: volumes[i - (input.length - volumes.length)] ?? b.volume,
    }));
    return volumeGridFacts(
      data,
      researchVolumeSeries("vp-breakout-1-5", data),
    ).at(-1)!;
  };
  expect(flags([80, 90, 100, 110, 140, 180, 220]).stack).toBe(true);
  expect(flags([80, 90, 100, 110, 140, 180, 180]).stack).toBe(false);
  expect(flags([300, 20, 20, 300, 20, 20, 300]).pulses).toBe(true);
  expect(flags([300, 20, 160, 300, 20, 20, 300]).pulses).toBe(false);
  expect(flags([100, 90, 80]).decreasing).toBe(true);
  expect(flags([100, 90, 90]).decreasing).toBe(false);
  expect(flags([20, 20, 20, 300]).isolated).toBe(true);
  expect(flags([20, 100, 20, 300]).isolated).toBe(false);
});
