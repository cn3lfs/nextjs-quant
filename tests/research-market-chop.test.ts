import { expect, it } from "vitest";
import { researchMarketChop } from "../src/lib/research-market-chop";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";

const calendar = Array.from({ length: 45 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
const bars = (price: (i: number) => number) =>
  calendar.map((date, i) => ({
    date,
    open: price(i),
    close: price(i),
    high: price(i) + 0.1,
    low: price(i) - 0.1,
    volume: 10000,
    amount: 1000000,
  }));
const benchmark = {
  symbol: "sh000001",
  bars: bars((i) => (i >= 30 && i <= 35 ? (i % 2 ? 101 : 99) : 100)),
};
const config = { window: 4, minCrosses: 3, nearBand: 0.03 };

it("uses only four completed observations and counts adjacent crosses", () => {
  const rows = researchMarketChop(benchmark, calendar, config);
  expect(rows[33]!.state).toBe("clear");
  expect(rows[34]).toMatchObject({
    state: "choppy",
    crosses: 3,
    observedDate: calendar[33],
    windowStart: calendar[30],
  });
  expect(rows[38]!.state).toBe("clear");
  const future = {
    ...benchmark,
    bars: benchmark.bars.map((b, i) =>
      i >= 34 ? { ...b, close: b.close * 2, high: b.high * 2 } : b,
    ),
  };
  expect(researchMarketChop(future, calendar, config).slice(0, 35)).toEqual(
    rows.slice(0, 35),
  );
  expect(
    researchMarketChop(benchmark, calendar, { ...config, nearBand: 0.001 })[34]!
      .state,
  ).toBe("clear");
});

it("does not call exact MA touches crossings and rejects incomplete history", () => {
  const flat = { ...benchmark, bars: bars(() => 100) };
  expect(researchMarketChop(flat, calendar, config)[34]).toMatchObject({
    state: "clear",
    crosses: 0,
    near: true,
  });
  expect(researchMarketChop(benchmark, calendar, config)[23]!.state).toBe(
    "unknown",
  );
  const missing = {
    ...benchmark,
    bars: benchmark.bars.filter((b) => b.date !== calendar[20]),
  };
  expect(researchMarketChop(missing, calendar, config)[34]!.state).toBe(
    "unknown",
  );
  expect(
    researchMarketChop(undefined, calendar, config).every(
      (r) => r.state === "unknown",
    ),
  ).toBe(true);
});

const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[25],
  end: calendar[44],
  validationStart: calendar[43],
  initialCapital: 100000,
  maxPositions: 3,
  holdingDays: 60,
  entryMaxWait: 10,
  risk: { fraction: 0.1, maxWeight: 0.2 },
  management: { marketChop: config, stop: { kind: "percent", fraction: 0.5 } },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const event = (symbol: string, index: number): ResearchEvent => ({
  symbol,
  observedDate: calendar[index]!,
  endpointDate: calendar[index]!,
  strategyVersion: "fixture",
  key: symbol,
  evidence: "{}",
  partition: "development",
});
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  tradable: true,
  limitUp: null,
  limitDown: null,
};

it("exits held positions, retains blocked sells after regime recovery, and waits before new entry", () => {
  const events = [event("sh600000", 29), event("sh600001", 33)];
  const result = researchPortfolio(
    spec,
    events,
    calendar,
    new Map(events.map((e) => [e.symbol, bars(() => 10)])),
    (symbol, date) => ({
      ...rules,
      tradable: !(
        symbol === "sh600000" &&
        date >= calendar[34]! &&
        date <= calendar[37]!
      ),
    }),
    benchmark,
  );
  expect(result.trades[0]!.entryDate).toBe(calendar[30]);
  expect(result.trades[0]!.exitDate).toBe(calendar[38]);
  expect(result.trades[0]!.exitReason).toContain("反复穿越");
  const eligible = result.marketChop!.find(
    (r) => r.date >= calendar[34]! && r.state === "clear",
  )!.date;
  expect(result.trades[1]!.entryDate).toBe(eligible);
  expect(
    result.attempts.some(
      (a) => a.side === "buy" && a.reason?.includes("反复穿越"),
    ),
  ).toBe(true);
  expect(
    result.attempts.some((a) => a.side === "sell" && a.date === calendar[37]),
  ).toBe(true);
});

it("preserves disabled shape and binds the new method version only when enabled", () => {
  expect(researchManagementSchema.parse({})).not.toHaveProperty("marketChop");
  expect(
    researchManagementSchema.safeParse({
      marketChop: { ...config, minCrosses: 4 },
    }).success,
  ).toBe(false);
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "marketChop.version",
    "research-market-chop-1",
  );
  const disabled = researchSpecSchema.parse({ ...spec, management: {} });
  expect(researchMethodSnapshot(disabled)).not.toHaveProperty("marketChop");
  expect(
    researchPortfolio(disabled, [], calendar, new Map(), () => rules),
  ).not.toHaveProperty("marketChop");
});
