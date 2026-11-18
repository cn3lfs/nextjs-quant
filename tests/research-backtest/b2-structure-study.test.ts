import { describe, expect, it } from "vitest";
import {
  createStudyDecision,
  studyWarmup,
  type StudyDecisionState,
} from "trading-strategies";
import {
  b2BreakoutSignals,
  b2StructureRegistration,
  b2StructureStrategy,
} from "../../scripts/lib/research/b2-structure-study";

function fixture() {
  const bars = Array.from({ length: 220 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
  for (const i of [150, 170]) bars[i]!.low = 90;
  for (const i of [160, 180]) bars[i]!.high = 110;
  Object.assign(bars[185]!, { open: 110, close: 112, high: 113, low: 109 });
  Object.assign(bars[186]!, { open: 108, close: 108, high: 110, low: 107 });
  for (let i = 187; i <= 193; i++)
    Object.assign(bars[i]!, { open: 107, close: 107, high: 109, low: 105 });
  bars[190]!.high = 112;
  Object.assign(bars[194]!, { open: 104, close: 104, high: 106, low: 103 });
  return bars;
}
const state: StudyDecisionState = {
  cash: 100000,
  shares: 0,
  entry: 99,
  entryIndex: 150,
  anchor: 90,
  core: 0,
  sleeveCap: 100,
  initialized: true,
  lastAllocationMonth: "",
  installments: 0,
};
describe("B2 structure fixed research contract", () => {
  it("projects the existing breakout branch exactly for every warmed bar, independent of entry state", () => {
    const bars = fixture();
    const signals = b2BreakoutSignals(bars, false);
    const original = createStudyDecision(
      "breakout",
      bars,
      bars,
      100000,
      studyWarmup("breakout"),
    );
    for (let i = 0; i < bars.length; i++) {
      expect(signals[i]!.entry).toBe(
        i >= studyWarmup("breakout") && original(i, state)?.side === "buy",
      );
      expect(signals[i]!.exit).toBe(
        i >= studyWarmup("breakout") &&
          original(i, { ...state, shares: 100, entry: 100000, entryIndex: i })
            ?.side === "sell",
      );
    }
    expect(signals[185]!.entry).toBe(true);
  });
  it("changes only exit OR and retains all original exits without creating a short strategy", () => {
    const bars = fixture(),
      base = b2BreakoutSignals(bars, false),
      added = b2BreakoutSignals(bars, true);
    expect(base.map((s) => s.entry)).toEqual(added.map((s) => s.entry));
    expect(base[194]!.exit).toBe(false);
    expect(added[194]!.exit).toBe(true);
    expect(base.every((s, i) => !s.exit || added[i]!.exit)).toBe(true);
    expect(
      b2StructureStrategy("breakout-failed-upthrust", "crypto", ["BTCUSDT"])
        .entry,
    ).toEqual(b2StructureStrategy("breakout", "crypto", ["BTCUSDT"]).entry);
  });
  it("never uses future bars for projection or the added component", () => {
    const bars = fixture();
    for (const component of [false, true]) {
      const full = b2BreakoutSignals(bars, component);
      for (let i = 180; i <= 200; i++)
        expect(
          b2BreakoutSignals(bars.slice(0, i + 1), component).at(-1),
        ).toEqual(full[i]);
    }
  });
  it("freezes 32 scenarios, full prior pool and reused development windows", () => {
    expect(b2StructureRegistration.cnLimit).toBe(799);
    expect(
      b2StructureRegistration.candidates.length *
        b2StructureRegistration.windows.length *
        b2StructureRegistration.scenarios.length *
        2,
    ).toBe(32);
    expect(b2StructureRegistration.windows.map((w) => w.label)).toEqual([
      "development",
      "reused-history-validation",
    ]);
  });
});
