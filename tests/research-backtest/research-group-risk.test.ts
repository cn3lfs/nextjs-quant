import { researchCostQuote } from "~/lib/backtest/research-executor";
import { expect, it } from "vitest";

import { researchGroupRisk } from "trading-strategies/research/risk/research-group-risk";
import { type ContextRiskInput } from "trading-strategies/research/risk/research-context-risk";
const bars = Array.from({ length: 100 }, (_, i) => ({
  date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 100000,
  amount: 10000000,
}));
const calendar = bars.map((b) => b.date),
  symbols = ["sh600000", "sh600001", "sz000001", "sz000002"];
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const inputs: ContextRiskInput[] = symbols.flatMap((symbol) =>
  calendar.map((date) => ({
    symbol,
    date,
    source: "fixed",
    version: "1",
    effectiveAt: `${date}T14:00:00+08:00`,
    availableAt: `${date}T14:00:00+08:00`,
    capturedAt: `${date}T14:00:00+08:00`,
    sector: "shared",
    marketStage: {
      stage: "bull",
      predicateVersion: "fixed",
      evidence: "fixture",
    },
    scheduledEvent: {
      coverageComplete: true,
      id: "E1",
      eventDate: calendar[72]!,
      announcedAt: "2021-01-01T13:00:00+08:00",
      evidence: "announced",
    },
  })),
);
const series = new Map(symbols.map((s) => [s, bars]));
it("sector sums nonnegative risk, caps equality at 3%, includes fees and does not net protected profits", () => {
  const held = symbols
    .slice(1)
    .map((symbol) => ({ symbol, quantity: 2000, entry: 100, stop: 95 }));
  const check = researchGroupRisk(
    symbols[0]!,
    calendar[65]!,
    calendar,
    series,
    inputs,
    held,
    1000000,
    researchCostQuote(costs),
  );
  expect(check).toMatchObject({
    used: 30000,
    fraction: 0,
    members: [...symbols].sort(),
    reason: null,
  });
  held[0]!.stop = 110;
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      inputs,
      held,
      1000000,
      researchCostQuote(costs),
    ).used,
  ).toBe(20000);
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      [],
      held,
      1000000,
      researchCostQuote(costs),
    ).fraction,
  ).toBeNull();
});
it("different sectors still connect on 60-return correlation; future data cannot change grouping", () => {
  const varying = bars.map((b, i) => {
    const close = 100 + Math.sin(i);
    return { ...b, open: close, close, low: close - 1, high: close + 1 };
  });
  const map = new Map(symbols.map((s) => [s, varying]));
  const rows = inputs.map((r) => ({ ...r, sector: r.symbol }));
  const held = [{ symbol: symbols[1]!, quantity: 2000, entry: 100, stop: 95 }];
  const run = (m: typeof map) =>
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      m,
      rows,
      held,
      1000000,
      researchCostQuote(costs),
    );
  expect(run(map).members).toEqual(symbols.slice(0, 2));
  const future = new Map(
    [...map].map(([s, bs]) => [
      s,
      bs.map((b, i) => (i > 65 ? { ...b, close: 900 } : b)),
    ]),
  );
  expect(run(future)).toEqual(run(map));
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      rows,
      held,
      1000000,
      researchCostQuote(costs),
    ).reason,
  ).toContain("零方差");
});
