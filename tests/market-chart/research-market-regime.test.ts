import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchMarketEnvironment } from "trading-strategies/research/risk/research-market-regime";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";

const config = {
  kind: "ma20" as const,
  neutralBand: 0.01,
  weakWeight: 0 as const,
};
const calendar = Array.from({ length: 72 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
function bars(price: (i: number) => number): Bar[] {
  return calendar.map((date, i) => ({
    date,
    open: price(i),
    close: price(i),
    high: price(i) + 1,
    low: price(i) - 0.5,
    volume: 10000,
    amount: price(i) * 10000,
  }));
}
const benchmark = (kind: "strong" | "neutral" | "weak") => ({
  symbol: "sh000001",
  bars: bars((i) =>
    kind === "strong" ? 100 + i : kind === "weak" ? 500 - i : 100,
  ),
});
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[61],
  end: calendar[70],
  validationStart: calendar[68],
  holdingDays: 60,
  initialCapital: 100000,
  maxPositions: 1,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: {
    stop: { kind: "percent", fraction: 0.03 },
    marketRegime: config,
  },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
it("uses hand-computable prior-day MA20 and keeps future prices out of earlier decisions", () => {
  const source = benchmark("strong"),
    full = researchMarketEnvironment(source, calendar, config);
  expect(full[62]).toMatchObject({
    date: calendar[62],
    observedDate: calendar[61],
    regime: "strong",
    close: 161,
    ma20: 151.5,
    previousMa20: 150.5,
    maxWeight: 0.6,
    reason: null,
  });
  expect(
    researchMarketEnvironment(
      { ...source, bars: source.bars.slice(0, 63) },
      calendar.slice(0, 63),
      config,
    ),
  ).toEqual(full.slice(0, 63));
  const changed = structuredClone(source);
  for (let i = 62; i < 72; i++) changed.bars[i]!.close = 100000;
  expect(researchMarketEnvironment(changed, calendar, config)[62]).toEqual(
    full[62],
  );
  expect(full[20]!.reason).toContain("21根");
});
it("validates the neutral band and distinguishes a neutral market from a strong one", () => {
  const near = { symbol: "sh000001", bars: bars((i) => 100 + 0.01 * i) };
  expect(researchMarketEnvironment(near, calendar, config)[62]!.regime).toBe(
    "neutral",
  );
  expect(
    researchMarketEnvironment(near, calendar, {
      ...config,
      neutralBand: 0,
    })[62]!.regime,
  ).toBe("strong");
  expect(
    researchManagementSchema.safeParse({
      ...base.management,
      marketRegime: { ...config, neutralBand: 0.06 },
    }).success,
  ).toBe(false);
});
it("rejects invalid benchmark volume and unordered history", () => {
  const invalid = benchmark("strong");
  invalid.bars[60]!.volume = 0;
  expect(researchMarketEnvironment(invalid, calendar, config)[62]!.regime).toBe(
    "unknown",
  );
  expect(() =>
    researchMarketEnvironment(
      { ...invalid, bars: [invalid.bars[1]!, invalid.bars[0]!] },
      calendar,
      config,
    ),
  ).toThrow("严格递增");
});
