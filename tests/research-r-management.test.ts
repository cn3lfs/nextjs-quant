import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchRManagementTemplate,
  isResearchRManagementTemplate,
} from "../src/lib/research-r-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { atr, rollingHigh } from "../src/lib/indicators";

const dates = Array.from(
  { length: 30 },
  (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`,
);
const management = researchRManagementTemplate(
  researchManagementSchema.parse({ stop: { kind: "percent", fraction: 0.1 } }),
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[20],
  end: dates[29],
  validationStart: dates[29],
  initialCapital: 100000,
  holdingDays: 60,
  risk: { fraction: 0.1, maxWeight: 1 },
  management,
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[20]!,
  endpointDate: dates[20]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
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
    const open = i < 22 ? 100 : i === 22 ? 110 : 122;
    const close = i < 21 ? 100 : i === 21 ? 110 : i === 22 ? 120 : 122;
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
function run(input = bars(), config = spec, maxSell = 100000) {
  return researchPortfolio(
    config,
    [event],
    dates,
    new Map([[event.symbol, input]]),
    () => ({ ...rules, maximumSell: maxSell }),
  );
}
it("raises at the first 1R close without structural confirmation and preserves the old structural mode", () => {
  const trade = run().trades[0]!;
  expect(trade.stopHistory).toContainEqual({
    date: dates[21],
    stop: 100,
    reason: "收盘浮盈达到1R，下一交易日起移至首仓成交价",
  });
  expect(trade).not.toHaveProperty("protectionEvidence");
  const old = run(
    bars(),
    researchSpecSchema.parse({
      ...spec,
      management: { ...management, breakeven: { atR: 1 } },
    }),
  ).trades[0]!;
  expect(
    old.protectionEvidence!.some(
      (e) => e.date === dates[21] && e.structure.status !== "confirmed",
    ),
  ).toBe(true);
  expect(
    old.stopHistory!.some((s) => s.date === dates[21] && s.stop === 100),
  ).toBe(false);
});
it("does not use intraday highs or cancel an already queued exit to manufacture breakeven", () => {
  const input = bars();
  input[21] = { ...input[21]!, high: 150, close: 105 };
  input[22] = { ...input[22]!, open: 105, close: 99, high: 106, low: 98 };
  const early = run(input, { ...spec, end: dates[22]! }).trades[0]!;
  expect(early.exitDate).toBeNull();
  expect(early.stopHistory!.some((s) => s.stop === 100)).toBe(false);
  const timed = run(
    bars(),
    researchSpecSchema.parse({
      ...spec,
      management: { ...management, timeExit: { days: 1, minR: 2 } },
    }),
  ).trades[0]!;
  expect(timed.exitDate).toBe(dates[22]);
  expect(timed.stopHistory!.some((s) => s.stop === 100)).toBe(false);
});
it("finishes the 2R half sale before raising to 1R and activating the 22/3 tail", () => {
  const input = bars(),
    trade = run(input, spec, 100).trades[0]!;
  expect(trade.quantity).toBe(1000);
  expect(trade.sales!.map((s) => [s.date, s.quantity])).toEqual(
    dates.slice(23, 28).map((d) => [d, 100]),
  );
  expect(
    trade.stopHistory!.filter((s) => s.date < dates[27]! && s.stop > 100),
  ).toEqual([]);
  expect(trade.stopHistory).toContainEqual({
    date: dates[27],
    stop: 110,
    reason: "第1档实际成交后抬升",
  });
  const expected = rollingHigh(input, 22)[27]! - 3 * atr(input, 22)[27]!;
  expect(expected).toBeGreaterThan(110);
  expect(
    trade.stopHistory!.some((s) => s.date === dates[27] && s.stop === expected),
  ).toBe(true);
  expect(trade.remainingQuantity).toBe(500);
});
it("keeps the half target rounded and accounts for actual gap exits and per-order fees", () => {
  const input = bars();
  input[24] = { ...input[24]!, open: 122, close: 105, low: 104 };
  for (let i = 25; i < input.length; i++)
    input[i] = { ...input[i]!, open: 102, close: 103, high: 104, low: 101 };
  const config = researchSpecSchema.parse({
    ...spec,
    costs: { ...spec.costs, minimumCommission: 5 },
  });
  const trade = run(input, config).trades[0]!;
  expect(trade.quantity).toBe(900);
  expect(trade.sales!.map((s) => [s.date, s.quantity, s.price])).toEqual([
    [dates[23], 400, 122],
    [dates[25], 500, 102],
  ]);
  expect(trade.profit).toBe(9785);
  expect(trade.netReturn).toBeCloseTo(9785 / 90005);
});
it("recognizes the named parameters, versions R-only behavior, and preserves independent limits", () => {
  const next = researchRManagementTemplate(
    researchManagementSchema.parse({
      ...management,
      liquidityCap: true,
      timeExit: { days: 10, minR: 0.5 },
    }),
  );
  expect(isResearchRManagementTemplate(next)).toBe(true);
  expect(next.liquidityCap).toBe(true);
  expect(next.timeExit).toEqual({ days: 10, minR: 0.5 });
  const edited = researchManagementSchema.parse({
    ...next,
    breakeven: { atR: 1.5, mode: "r-only" },
  });
  expect(isResearchRManagementTemplate(edited)).toBe(false);
  expect(researchMethodSnapshot({ ...spec, management: next })).toHaveProperty(
    "rManagement.version",
    "research-r-management-1",
  );
  expect(
    researchMethodSnapshot({ ...spec, management: edited }),
  ).not.toHaveProperty("rManagement");
  expect(
    researchMethodSnapshot({ ...spec, management: edited }),
  ).toHaveProperty("rBreakeven.version", "research-r-breakeven-1");
  const old = researchManagementSchema.parse({ breakeven: { atR: 1 } });
  expect(old.breakeven).toEqual({ atR: 1 });
  expect(
    researchMethodSnapshot({ ...spec, management: old }),
  ).not.toHaveProperty("rBreakeven");
  expect(
    researchManagementSchema.safeParse({
      ...management,
      breakeven: { atR: 0, mode: "r-only" },
    }).success,
  ).toBe(false);
});
