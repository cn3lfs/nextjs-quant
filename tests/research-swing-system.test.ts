import { expect, it } from "vitest";
import {
  swingSystemDecision,
  researchSwingSystemSeries,
} from "../src/lib/research-swing-system";
import {
  swingMarketIds,
  type SwingMarketEvidence,
} from "../src/lib/research-swing-market";
import { analyzeBreakout } from "../src/server/breakout";
const market = Object.fromEntries(
  swingMarketIds.map((id) => [id, "bull" as const]),
);
it("requires every market input and gives adverse/blocked states precedence without voting them away", () => {
  const input = {
    core: true,
    fraction: 0.5,
    market,
    aboveRisingMa: true,
    choppy: false,
  };
  expect(swingSystemDecision(input)).toMatchObject({
    entry: true,
    exit: false,
  });
  for (const id of swingMarketIds) {
    expect(
      swingSystemDecision({ ...input, market: { ...market, [id]: "unknown" } })
        .reason,
    ).not.toBeNull();
    expect(
      swingSystemDecision({ ...input, market: { ...market, [id]: "bear" } }),
    ).toMatchObject({ entry: false, exit: true });
    expect(
      swingSystemDecision({ ...input, market: { ...market, [id]: "blocked" } })
        .entry,
    ).toBe(false);
  }
  expect(swingSystemDecision({ ...input, fraction: 0 }).entry).toBe(false);
  expect(swingSystemDecision({ ...input, choppy: true }).exit).toBe(true);
});
it("allows neutral BOLL/volume but never neutral MACD/breadth, or invalid index MA", () => {
  const input = {
    core: true,
    fraction: 1,
    market,
    aboveRisingMa: true,
    choppy: false,
  };
  expect(
    swingSystemDecision({
      ...input,
      market: {
        ...market,
        "sw-market-boll": "neutral",
        "sw-market-volume": "neutral",
      },
    }).entry,
  ).toBe(true);
  expect(
    swingSystemDecision({
      ...input,
      market: { ...market, "sw-market-macd": "neutral" },
    }).entry,
  ).toBe(false);
  expect(
    swingSystemDecision({ ...input, aboveRisingMa: null }).reason,
  ).not.toBeNull();
});
it("actual adapter keeps all eight component evidence and fails closed on missing market", () => {
  const b = Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i,
    close: 101 + i,
    high: 102 + i,
    low: 99 + i,
    volume: 1000,
    amount: 100000,
  }));
  const p = analyzeBreakout(b, 0).points;
  const out = researchSwingSystemSeries(b, p);
  expect(Object.keys(out.at(-1)!.system.states)).toEqual([...swingMarketIds]);
  expect(out.at(-1)!.entry).toBe(false);
  expect(out.at(-1)!.reason).toContain("待数据");
});
