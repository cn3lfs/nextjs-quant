import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  clearStaleExitPreset,
  matchesResearchExitPreset,
  researchExitPresetIds,
  isCanslimExitPreset,
  researchExitPresetTemplate,
  type ResearchExitPreset,
} from "../src/lib/research-exit-presets";
import { researchRManagementTemplate } from "../src/lib/research-r-management";
import { swingExitTemplate } from "../src/lib/research-swing-exits";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { atr, rollingHigh } from "../src/lib/indicators";

const dates = Array.from({ length: 35 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[25]!,
  endpointDate: dates[25]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
const base = researchManagementSchema.parse({
  stop: { kind: "percent", fraction: 0.1 },
});
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function bars(): Bar[] {
  return dates.map((date, i) => {
    const open = i < 27 ? 50 : i === 27 ? 55 : i === 28 ? 62 : 67;
    const close =
      i < 26 ? 50 : i === 26 ? 55 : i === 27 ? 60 : i === 28 ? 65 : 67;
    return {
      date,
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      volume: 10000,
      amount: 1000000,
    };
  });
}
function spec(kind: ResearchExitPreset) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[25],
    end: dates[34],
    validationStart: dates[34],
    initialCapital: 50000,
    holdingDays: 60,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: researchExitPresetTemplate(base, kind),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
function run(kind: ResearchExitPreset, input = bars(), maxSell = 100000) {
  return researchPortfolio(
    spec(kind),
    [event],
    dates,
    new Map([[event.symbol, input]]),
    () => ({ ...rules, maximumSell: maxSell }),
  );
}

it.each([
  ["target-2r", 28, 62, 12000],
  ["target-3r", 29, 67, 17000],
] as const)(
  "fully exits %s only at the next tradable opening",
  (kind, index, price, profit) => {
    const trade = run(kind).trades[0]!;
    expect(trade.quantity).toBe(1000);
    expect(trade.initialStop).toBe(45);
    expect(trade.exitDate).toBe(dates[index]);
    expect(trade.sales!.map((s) => [s.quantity, s.price])).toEqual([
      [1000, price],
    ]);
    expect(trade.profit).toBe(profit);
    expect(trade.remainingQuantity).toBe(0);
    expect(trade.stopHistory!.some((s) => s.stop > 45)).toBe(false);
  },
);
it("keeps a full-target exit pending until every share actually sells", () => {
  const trade = run("target-2r", bars(), 300).trades[0]!;
  expect(trade.sales!.map((s) => [s.date, s.quantity])).toEqual([
    [dates[28], 300],
    [dates[29], 300],
    [dates[30], 300],
    [dates[31], 100],
  ]);
  expect(trade.exitDate).toBe(dates[31]);
  expect(trade.exitPrice).toBe(65.5);
  expect(trade.profit).toBe(15500);
});
it("does not use intraday target touches to sell before a confirming close", () => {
  const input = bars();
  input[26]!.high = 75;
  input[27]!.close = 59;
  input[28]!.close = 60;
  input[28]!.low = 59;
  const trade = run("target-2r", input).trades[0]!;
  expect(trade.exitDate).toBe(dates[29]);
  expect(trade.sales![0]!.triggerDate).toBe(dates[28]);
});
it("uses the trailing-only preset from entry without a fixed profit target", () => {
  const input = bars(),
    trade = run("trail-only", input).trades[0]!;
  expect(trade.exitDate).toBeNull();
  expect(trade).not.toHaveProperty("sales");
  const expected = rollingHigh(input, 22)[26]! - 3 * atr(input, 22)[26]!;
  expect(expected).toBeGreaterThan(45);
  expect(
    trade.stopHistory!.some((s) => s.date === dates[26] && s.stop === expected),
  ).toBe(true);
  expect(spec("trail-only").management).not.toHaveProperty("scaleOut");
});
it("half-target tail does not add 1R breakeven or force a raised line when ATR is unavailable", () => {
  const short = bars().slice(25);
  const trade = run("half-2r-tail", short).trades[0]!;
  expect(trade.sales!.map((s) => [s.date, s.quantity, s.price])).toEqual([
    [dates[28], 500, 62],
  ]);
  expect(trade.remainingQuantity).toBe(500);
  expect(trade.stopHistory!.some((s) => s.stop > 45)).toBe(false);
  expect(
    trade.managementWarnings!.some((w) => w.reason.includes("移动ATR缺失")),
  ).toBe(true);
  const input = bars(),
    withHistory = run("half-2r-tail", input).trades[0]!;
  expect(
    withHistory.stopHistory!.some((s) => s.date < dates[28]! && s.stop > 45),
  ).toBe(false);
  const expected = rollingHigh(input, 22)[28]! - 3 * atr(input, 22)[28]!;
  expect(
    withHistory.stopHistory!.some(
      (s) => s.date === dates[28] && s.stop === expected,
    ),
  ).toBe(true);
});
it("persists explicit identities, removes stale labels and keeps untagged legacy configurations unchanged", () => {
  for (const kind of researchExitPresetIds) {
    const selected = researchExitPresetTemplate(
      researchManagementSchema.parse({
        ...base,
        liquidityCap: true,
        timeExit: { days: 10, minR: 0.5 },
      }),
      kind,
    );
    expect(researchManagementSchema.safeParse(selected).success).toBe(true);
    expect(matchesResearchExitPreset(selected)).toBe(true);
    if (isCanslimExitPreset(kind)) {
      expect(selected.liquidityCap).toBeUndefined();
      expect(selected.timeExit).toBeNull();
    } else {
      expect(selected.liquidityCap).toBe(true);
      expect(selected.timeExit).toEqual({ days: 10, minR: 0.5 });
    }
    const method = researchMethodSnapshot({
      ...spec(kind),
      management: selected,
    });
    expect(method).toHaveProperty("exitPreset.kind", kind);
    expect(
      method.sources.some(
        (s) =>
          s.path ===
          (isCanslimExitPreset(kind)
            ? "canslim-analyst/references/entry-exit-rules.md"
            : "stop-loss/references/management.md"),
      ),
    ).toBe(true);
    const { exitPreset: _id, ...old } = selected;
    expect(
      researchMethodSnapshot({ ...spec(kind), management: old }),
    ).not.toHaveProperty("exitPreset");
    expect(researchRManagementTemplate(selected)).not.toHaveProperty(
      "exitPreset",
    );
    expect(swingExitTemplate(selected, false)).not.toHaveProperty("exitPreset");
  }
  const stale = {
    ...researchExitPresetTemplate(base, "target-2r"),
    breakeven: { atR: 1 },
  };
  expect(researchManagementSchema.safeParse(stale).success).toBe(false);
  const cleared = clearStaleExitPreset(stale);
  expect(cleared).not.toHaveProperty("exitPreset");
  expect(cleared.breakeven).toEqual({ atR: 1 });
  expect(researchManagementSchema.safeParse(cleared).success).toBe(true);
});
