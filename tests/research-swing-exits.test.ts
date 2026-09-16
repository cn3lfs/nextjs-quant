import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  swingExitTemplate,
  swingExitKind,
} from "../src/lib/research-swing-exits";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import {
  researchMethodSnapshot,
  validateResearchMethod,
} from "../src/server/research-method";
const dates = Array.from(
  { length: 12 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 10000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 10000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function fixture(
  opens = [50, 50, 51.5, 53, 52, 49],
  closes = [50, 51.5, 53, 52, 51.5, 50],
): Bar[] {
  return opens.map((open, i) => ({
    date: dates[i]!,
    open,
    close: closes[i]!,
    high: Math.max(open, closes[i]!) + 1,
    low: Math.min(open, closes[i]!) - 1,
    volume: 10000,
    amount: 500000,
  }));
}
function spec(tail: boolean) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[11],
    validationStart: dates[11],
    initialCapital: 45000,
    maxPositions: 1,
    holdingDays: 60,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: swingExitTemplate(
      researchManagementSchema.parse({
        stop: { kind: "percent", fraction: 0.03 },
      }),
      tail,
    ),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
function run(
  tail: boolean,
  bars = fixture(),
  lookup: Parameters<typeof researchPortfolio>[4] = () => rules,
) {
  return researchPortfolio(
    spec(tail),
    [event],
    bars.map((b) => b.date),
    new Map([[event.symbol, bars]]),
    lookup,
  );
}
it.each([false, true])(
  "implements the source 50/48.5/51.5/53 example with tail=%s",
  (tail) => {
    const result = run(tail),
      trade = result.trades[0]!;
    expect(trade.quantity).toBe(900);
    expect(trade.initialStop).toBe(48.5);
    expect(
      trade.sales!.slice(0, 2).map((s) => [s.date, s.quantity, s.price]),
    ).toEqual([
      [dates[2], 300, 51.5],
      [dates[3], 300, 53],
    ]);
    expect(trade.stopHistory!.map((s) => [s.date, s.stop])).toEqual(
      tail
        ? [
            [dates[1], 48.5],
            [dates[3], 51.5],
          ]
        : [[dates[1], 48.5]],
    );
    if (tail) {
      expect(trade.exitDate).toBe(dates[5]);
      expect(trade.sales![2]).toMatchObject({ quantity: 300, price: 49 });
      expect(trade.profit).toBe(1050);
    } else {
      expect(trade.exitDate).toBeNull();
      expect(trade.remainingQuantity).toBe(300);
    }
  },
);
it("waits for actual second-stage execution before raising and retains a blocked tail exit", () => {
  const bars = fixture(
    [50, 50, 51.5, 53, 53, 49, 52],
    [50, 51.5, 53, 53, 51.5, 50, 52],
  );
  const result = run(true, bars, (_s, date) => ({
    ...rules,
    tradable: date !== dates[3] && date !== dates[5],
  }));
  const trade = result.trades[0]!;
  expect(trade.sales!.map((s) => s.date)).toEqual([
    dates[2],
    dates[4],
    dates[6],
  ]);
  expect(trade.stopHistory!.map((s) => [s.date, s.stop])).toEqual([
    [dates[1], 48.5],
    [dates[4], 51.5],
  ]);
  expect(trade.exitDate).toBe(dates[6]);
});
it("finishes capped partial orders before moving the tail line and rejects missing sell evidence", () => {
  const bars = fixture(
    Array.from({ length: 9 }, (_, i) => (i < 2 ? 50 : 53)),
    Array.from({ length: 9 }, (_, i) => (i === 0 ? 50 : i === 1 ? 51.5 : 53)),
  );
  const trade = run(true, bars, () => ({ ...rules, maximumSell: 100 }))
    .trades[0]!;
  expect(trade.sales!.map((s) => [s.date, s.quantity])).toEqual(
    [2, 3, 4, 5, 6, 7].map((i) => [dates[i], 100]),
  );
  expect(trade.stopHistory!.map((s) => [s.date, s.stop])).toEqual([
    [dates[1], 48.5],
    [dates[7], 51.5],
  ]);
  expect(trade.remainingQuantity).toBe(300);
  expect(
    run(true, bars, () => ({
      ...rules,
      minimumSell: undefined,
      sellStep: undefined,
      maximumSell: undefined,
      sellOddLotAll: undefined,
    })).trades,
  ).toEqual([]);
});
it("preserves initial risk and time choices while removing competing lines and stale recognition", () => {
  const input = researchManagementSchema.parse({
    stop: { kind: "percent", fraction: 0.02 },
    confirmations: 2,
    trail: { kind: "close-atr", period: 14, multiple: 2 },
    trailAfterScaleOut: true,
    scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 0 }],
    breakeven: { atR: 1 },
    timeExit: { days: 5, minR: 0.5 },
  });
  const copy = structuredClone(input),
    next = swingExitTemplate(input, true);
  expect(input).toEqual(copy);
  expect(next.stop).toEqual(input.stop);
  expect(next.timeExit).toEqual(input.timeExit);
  expect(next).not.toHaveProperty("breakeven");
  expect(next).not.toHaveProperty("trailAfterScaleOut");
  expect(swingExitKind(next)).toBe("prior-target");
  expect(swingExitKind({ ...next, confirmations: 2 })).toBeNull();
  const changed = structuredClone(next);
  changed.scaleOut![1]!.atR = 4;
  expect(swingExitKind(changed)).toBeNull();
  expect(researchManagementSchema.parse(next)).toEqual(next);
});
it("pins the recognized rule and both source files without naming edited custom parameters", () => {
  for (const tail of [false, true]) {
    const input = spec(tail),
      saved = researchMethodSnapshot(input);
    expect(saved.swingExit).toMatchObject({
      version: "swing-exits-1",
      kind: tail ? "prior-target" : "r1-r2",
    });
    expect(saved.sources.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "swing-trader/references/trading-system.md",
        "swing-trader/references/position-management.md",
      ]),
    );
    expect(() => validateResearchMethod(input, saved)).not.toThrow();
    input.management!.scaleOut![1]!.atR = 3;
    expect(researchMethodSnapshot(input)).not.toHaveProperty("swingExit");
    expect(() => validateResearchMethod(input, saved)).toThrow("方法版本");
  }
});
