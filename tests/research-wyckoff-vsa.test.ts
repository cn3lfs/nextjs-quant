import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchWyckoffVsaSeries as series,
  wyckoffVsaPatterns as patterns,
  wyckoffInputsSchema,
  type WyckoffInput,
  type VsaContext,
  wyckoffVsaIds,
} from "../src/lib/research-wyckoff-vsa";
import { researchSignals } from "../src/server/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";
import { researchMethodSnapshot } from "../src/server/research-method";

function fixture(down = true): Bar[] {
  const anchors = [
    [0, down ? 130 : 70],
    [40, down ? 110 : 90],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 100],
  ];
  return Array.from({ length: 90 }, (_, i) => {
    const j = anchors.findIndex((a) => a[0]! >= i),
      a = anchors[Math.max(0, j - 1)]!,
      b = anchors[j]!;
    const close =
      a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / Math.max(1, b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 100,
      amount: 10000,
    };
  });
}
function add(b: Bar[], row: Partial<Bar>) {
  b.push({
    date: new Date(Date.UTC(2020, 0, b.length + 1)).toISOString().slice(0, 10),
    open: 98,
    close: 98,
    high: 99,
    low: 97,
    volume: 100,
    amount: 10000,
    ...row,
  });
}
function inputs(bars: Bar[]): WyckoffInput[] {
  return bars.map((b) => ({
    symbol: "sh600000",
    date: b.date,
    source: "fixed-fixture",
    availableAt: `${b.date}T15:00:00+08:00`,
    limit: false,
    corporateAction: false,
    openingCrash: false,
    specialDate: false,
    marketCapYuan: 5e9,
  }));
}
function run(
  id: Parameters<typeof series>[0],
  bars: Bar[],
  rows = inputs(bars),
) {
  return series(
    id,
    bars,
    bars.map((b) => b.date),
    rows,
    "sh600000",
  );
}
const bar = {
  date: "2020-01-01",
  open: 96,
  close: 97,
  low: 95,
  high: 98,
  volume: 151,
  amount: 10000,
};
const context: VsaContext = {
  b: bar,
  meanVolume: 100,
  meanSpread: 4,
  ma60: 100,
  support: 94,
  resistance: 105,
  low5: 96,
  high5: 103,
};
it("source strict volume/spread/close-position thresholds and TR context are observable", () => {
  expect(patterns(context)).toContain("stopping");
  expect(patterns({ ...context, b: { ...bar, volume: 150 } })).not.toContain(
    "stopping",
  );
  const ns = { ...context, b: { ...bar, open: 97, close: 96, volume: 49 } };
  expect(patterns(ns)).toContain("no-supply");
  expect(patterns({ ...ns, b: { ...ns.b, volume: 50 } })).not.toContain(
    "no-supply",
  );
  expect(patterns({ ...ns, support: null })).not.toContain("no-supply");
  const nd = { ...context, b: { ...bar, volume: 49 } };
  expect(patterns(nd)).toContain("no-demand");
  expect(patterns({ ...nd, meanSpread: 3 })).not.toContain("no-demand");
  const churn = {
    ...context,
    ma60: 90,
    meanSpread: 10,
    b: { ...bar, open: 96.5, close: 96.5, high: 98, low: 95.1, volume: 201 },
  };
  expect(patterns(churn)).toContain("churning");
  expect(patterns({ ...churn, b: { ...churn.b, volume: 200 } })).not.toContain(
    "churning",
  );
  expect(patterns({ ...churn, ma60: 110 })).not.toContain("churning");
  expect(
    patterns({ ...context, meanSpread: 1, b: { ...bar, volume: 301 } }),
  ).toContain("sc");
  expect(
    patterns({ ...context, meanSpread: 1, b: { ...bar, volume: 300 } }),
  ).not.toContain("sc");
  const bc = {
    ...context,
    meanSpread: 1,
    b: { ...bar, open: 104, high: 105, low: 102, close: 103, volume: 301 },
  };
  expect(patterns(bc)).toContain("bc");
  expect(patterns({ ...bc, b: { ...bc.b, close: 104 } })).not.toContain("bc");
});
it("WY12/13 share the stopping-to-No-Supply sequence but confirm on distinct days", () => {
  const bars = fixture();
  add(bars, { open: 96, low: 95.5, high: 98, close: 97, volume: 400 });
  add(bars, { open: 96.4, low: 95.5, high: 96.5, close: 95.8, volume: 20 });
  add(bars, { open: 96, low: 95.8, high: 97.5, close: 97, volume: 100 });
  expect(run("wy-stopping-volume", bars)[91]!.entry).toBe(true);
  expect(run("wy-no-supply", bars)[91]!.entry).toBe(false);
  expect(run("wy-no-supply", bars)[92]!.entry).toBe(true);
  bars[90]!.volume = 200;
  expect(run("wy-stopping-volume", bars)[91]!.entry).toBe(false);
});
it("WY14 No Demand needs preceding stall, then closes below candidate to exit", () => {
  const bars = fixture(false);
  add(bars, { open: 104, high: 105, low: 102, close: 103, volume: 400 });
  add(bars, { open: 103.6, high: 104.5, low: 103.5, close: 104.2, volume: 20 });
  add(bars, { open: 104, high: 104.4, low: 102.8, close: 103, volume: 100 });
  expect(run("wy-no-demand", bars)[92]).toMatchObject({
    entry: false,
    exit: true,
  });
  expect(run("wy-no-demand", bars)[92]!.events).toContainEqual(
    expect.objectContaining({ kind: "no-demand", state: "confirmed" }),
  );
  bars[90]!.volume = 100;
  expect(
    run("wy-no-demand", bars)[92]!.events.some(
      (e) => e.kind === "no-demand" && e.state === "confirmed",
    ),
  ).toBe(false);
});
it("WY15 absorption requires three expanded narrow bars in low TR and contracted declines", () => {
  const bars = fixture();
  bars.forEach((b, i) => {
    if (i > 60 && b.close < bars[i - 1]!.close) b.volume = 20;
  });
  for (let i = 0; i < 3; i++)
    add(bars, { open: 98.1, high: 98.4, low: 98, close: 98.2, volume: 200 });
  add(bars, { open: 98.3, high: 99.2, low: 98, close: 99, volume: 100 });
  expect(run("wy-absorption", bars)[93]!.entry).toBe(true);
  bars[91]!.volume = 10;
  expect(run("wy-absorption", bars)[93]!.entry).toBe(false);
});
it("WY16 high TR churn followed by lower close exits; one missing up-volume context does not confirm", () => {
  const bars = fixture(false);
  bars.forEach((b, i) => {
    if (i > 60 && b.close > bars[i - 1]!.close) b.volume = 20;
  });
  add(bars, { open: 104.1, high: 104.2, low: 104, close: 104.1, volume: 400 });
  add(bars, { open: 104, high: 104.1, low: 103, close: 103.5, volume: 100 });
  expect(run("wy-churning", bars)[91]!.events).toContainEqual(
    expect.objectContaining({ kind: "churning", state: "confirmed" }),
  );
  expect(run("wy-churning", bars)[91]).toMatchObject({
    entry: false,
    exit: true,
  });
  bars[90]!.volume = 20;
  expect(
    run("wy-churning", bars)[91]!.events.some((e) => e.kind === "churning"),
  ).toBe(false);
});
it.each(["sc", "bc"])(
  "WY17 %s requires three later bars plus distinct AR then contracted ST",
  (kind) => {
    const bars = fixture(kind === "sc");
    const sc = kind === "sc";
    add(
      bars,
      sc
        ? { open: 98, low: 90, high: 102, close: 100, volume: 400 }
        : { open: 103, low: 98, high: 110, close: 100, volume: 400 },
    );
    add(
      bars,
      sc
        ? { low: 96, high: 102, open: 99, close: 100 }
        : { low: 99, high: 105, open: 102, close: 101 },
    );
    add(
      bars,
      sc
        ? { low: 94, high: 99, open: 98, close: 98 }
        : { low: 102, high: 106, open: 103, close: 104 },
    );
    add(
      bars,
      sc
        ? { low: 90.5, high: 94, open: 93, close: 92 }
        : { low: 106, high: 109.5, open: 107, close: 108 },
    );
    const p = run("wy-climax", bars);
    expect(
      p[92]!.events.some((e) => e.kind === kind && e.state === "confirmed"),
    ).toBe(false);
    expect(p[93]!.events).toContainEqual(
      expect.objectContaining({
        kind,
        state: "confirmed",
        candidateAt: bars[90]!.date,
        confirmedAt: bars[93]!.date,
      }),
    );
    expect(sc ? p[93]!.entry : p[93]!.exit).toBe(true);
    if (sc) bars[92]!.low = 89;
    else bars[92]!.high = 111;
    expect(
      run("wy-climax", bars)[93]!.events.some(
        (e) => e.kind === kind && e.state === "confirmed",
      ),
    ).toBe(false);
  },
);
it("missing, late, duplicate, small-cap and flagged historical evidence are unavailable", () => {
  const bars = fixture();
  add(bars, { volume: 400 });
  expect(run("wy-stopping-volume", bars, []).at(-1)!.reason).toContain("缺少");
  for (const patch of [
    { availableAt: `${bars.at(-1)!.date}T15:00:01+08:00` },
    { limit: true },
    { corporateAction: true },
    { openingCrash: true },
    { specialDate: true },
    { marketCapYuan: 4999999999 },
  ]) {
    const e = inputs(bars);
    Object.assign(e.at(-1)!, patch);
    expect(run("wy-stopping-volume", bars, e).at(-1)).toMatchObject({
      entry: false,
      exit: false,
      events: [],
      reason: expect.any(String),
    });
  }
  const e = inputs(bars);
  e.push(e.at(-1)!);
  expect(wyckoffInputsSchema.safeParse(e).success).toBe(false);
  expect(run("wy-stopping-volume", bars, e).at(-1)!.reason).toContain("缺少");
});
it("VSA evidence survives spec/snapshot, is removed on strategy switch, and live signals retain endpoint/observation dates", async () => {
  const bars = fixture();
  add(bars, { open: 96, low: 95.5, high: 98, close: 97, volume: 400 });
  add(bars, { open: 96.4, low: 95.5, high: 96.5, close: 95.8, volume: 20 });
  const spec = researchSpecSchema.parse({
    strategy: "wy-stopping-volume",
    start: bars[90]!.date,
    end: bars[91]!.date,
    validationStart: bars[91]!.date,
    wyckoffInputs: inputs(bars),
  });
  expect(researchMethodSnapshot(spec).wyckoffInputs).toEqual(
    spec.wyckoffInputs,
  );
  expect(
    selectResearchStrategy(spec, "ma-cross").wyckoffInputs,
  ).toBeUndefined();
  const events = await researchSignals("sh600000", bars, spec, async () => {
    throw new Error("must not use DLL");
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    endpointDate: bars[90]!.date,
    observedDate: bars[91]!.date,
  });
  for (const id of wyckoffVsaIds)
    expect(
      researchSpecSchema.safeParse({ ...spec, strategy: id }).success,
    ).toBe(true);
});
