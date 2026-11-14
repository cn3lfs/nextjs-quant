import {
  canslimProgressPresetIds,
  researchExitPresetTemplate,
} from "../../../src/lib/research/specs/research-exit-presets";
import { researchManagementSchema } from "../../../src/lib/research/workflow/research-management";
import { researchProgressCheck } from "trading-strategies/research/technical/research-progress-exit";
import { expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
function setup(
  kind: (typeof canslimProgressPresetIds)[number] = "canslim-time4-calendar",
) {
  const dates = Array.from(
    { length: 190 },
    (_, i) => new Date(Date.UTC(2024, 0, i + 1)),
  )
    .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
    .map((d) => d.toISOString().slice(0, 10))
    .filter((_, i) => i < 80 || i > 84)
    .slice(0, 120);
  const bars: Bar[] = Array.from({ length: 120 }, (_, i) => ({
    date: dates[i]!,
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "canslim-priority",
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[119]!.date,
    validationStart: bars[118]!.date,
    holdingDays: 60,
    entryMaxWait: 5,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  spec.management = researchExitPresetTemplate(
    researchManagementSchema.parse({}),
    kind,
  );
  spec.risk = { fraction: 0.015, maxWeight: 0.25 };
  const calendar = bars.map((b) => b.date);
  return { bars, spec, calendar };
}

function dueIndex(
  bars: Bar[],
  kind: (typeof canslimProgressPresetIds)[number],
  entry = 70,
) {
  const deadline = new Date(Date.parse(bars[entry]!.date) + 28 * 86400000)
    .toISOString()
    .slice(0, 10);
  return kind.endsWith("calendar")
    ? bars.findIndex((b) => b.date >= deadline)
    : entry + 19;
}
function price(bars: Bar[], index: number, close: number) {
  Object.assign(bars[index]!, {
    open: close,
    close,
    high: close + 1,
    low: close - 1,
  });
}

it("keeps the two clocks distinct and compares the five-percent boundary directly", () => {
  const { bars, calendar, spec } = setup();
  const entry = { entryDate: bars[70]!.date, entryIndex: 70, entryPrice: 102 };
  const rule = spec.management!.progressExit!;
  const due = dueIndex(bars, "canslim-time4-calendar");
  expect(due).not.toBe(89);
  expect(
    researchProgressCheck(rule, entry, bars[due - 1]!, due - 1, calendar),
  ).toBeNull();
  price(bars, due, 107.1);
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar),
  ).toMatchObject({
    triggered: false,
    checkedDate: bars[due]!.date,
    thresholdPrice: 102 * 1.05,
  });
  bars[due]!.close -= 0.001;
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar)!.triggered,
  ).toBe(true);
  bars[due]!.volume = 0;
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar),
  ).toBeNull();
});
