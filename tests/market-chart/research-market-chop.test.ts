import { expect, it } from "vitest";
import { researchMarketChop } from "trading-strategies/research/risk/research-market-chop";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../src/server/research/research-method";

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

it("binds the market-chop version only when its configuration is enabled", () => {
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
});
