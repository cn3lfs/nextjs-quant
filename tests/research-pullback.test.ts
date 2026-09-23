import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { researchPullbackConfirmation } from "../src/lib/research-pullback";
import { researchBookSellable } from "../src/lib/research-position-book";
import { projectResearchWeights } from "../src/lib/weight-backtest";
import { selectResearchStrategy } from "../src/components/research/research-strategy-fields";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import breakoutFixture from "./fixtures/breakout-valid.json";

const dates = Array.from({ length: 9 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 2)).toISOString().slice(0, 10),
);
const config = {
  kind: "pullback-50-50" as const,
  maxTotalWeight: 0.6,
  waitBars: 1,
  tolerance: 0.005,
  requireProfit: false,
};
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[8],
  validationStart: dates[7],
  initialCapital: 200000,
  holdingDays: 60,
  risk: { fraction: 0.025, maxWeight: 0.8 },
  management: { pyramid: config },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
  pullbackLevel: 99.8,
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
function bars(): Bar[] {
  const opens = [100, 100, 99.9, 100.1, 99],
    closes = [100, 99.9, 100.2, 99.7, 99.1];
  return opens.map((open, i) => ({
    date: dates[i]!,
    open,
    close: closes[i]!,
    high: Math.max(open, closes[i]!) + 0.2,
    low: i === 1 ? 99.8 : Math.min(open, closes[i]!) - 0.05,
    volume: 10000,
    amount: 1000000,
  }));
}
function run(
  input = bars(),
  settings = spec,
  blocked: number[] = [],
  signal = event,
) {
  return researchPortfolio(
    settings,
    [signal],
    input.map((b) => b.date),
    new Map([[event.symbol, input]]),
    (_symbol, date) => ({
      ...rules,
      tradable: !blocked.some((i) => input[i]!.date === date),
    }),
  );
}
it("executes equal planned tranches after a closed retest, permits a lower second price, and preserves FIFO costs", () => {
  const input = bars(),
    result = run(input),
    trade = result.trades[0]!;
  expect(trade.plannedQuantity).toBe(1000);
  expect(
    trade.entries!.map((e) => [e.date, e.triggerDate, e.quantity, e.price]),
  ).toEqual([
    [dates[1], dates[0], 500, 100],
    [dates[2], dates[1], 500, 99.9],
  ]);
  expect(trade.entries![1]!.stop).toBe(99.8);
  expect(trade.entries![1]!.plannedRisk).toBeCloseTo(150);
  expect(trade.entryCost).toBe(99950);
  expect(trade.profit).toBe(-950);
  expect(trade.exitDate).toBe(dates[4]);
  expect(trade.netReturn).toBeCloseTo(-950 / 99950);
  expect(trade.book!.remainingCost).toBe(0);
  expect(result.nav[1]!.value).toBe(199950);
  const weights = projectResearchWeights(
    result,
    new Map([[event.symbol, input]]),
  );
  expect(weights.rows.find((r) => r.dt === dates[1])!.weight).toBeCloseTo(
    (500 * 99.9) / 199950,
  );
  const open = run(input.slice(0, 3)).trades[0]!;
  expect(researchBookSellable(open.book!, dates[2]!)).toBe(500);
  expect(researchBookSellable(open.book!, dates[3]!)).toBe(1000);
});
it("requires profitability at both confirmation and execution for the independent profit-only preset", () => {
  const settings = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      pyramid: { ...config, requireProfit: true },
    },
  });
  expect(run(bars(), settings).trades[0]!.entries).toHaveLength(1);
  const input = bars();
  Object.assign(input[1]!, { close: 100.1, high: 100.3 });
  Object.assign(input[2]!, {
    open: 100.2,
    close: 100.3,
    high: 100.5,
    low: 100.1,
  });
  expect(run(input, settings).trades[0]!.entries).toHaveLength(2);
  input[2]!.open = 99.9;
  input[2]!.low = 99.85;
  expect(run(input.slice(0, 3), settings).trades[0]!.entries).toHaveLength(1);
});
it("expires from the signal date, cancels missing or broken retests, and rejects an absent frozen level", () => {
  const input = bars();
  Object.assign(input[1]!, { close: 100.8, high: 101, low: 100.4 });
  Object.assign(input[2]!, {
    open: 100.2,
    close: 100.1,
    high: 100.4,
    low: 99.8,
  });
  expect(run(input).trades[0]!.entries).toHaveLength(1);
  const delayed = run(input, spec, [1]);
  expect(delayed.trades[0]!.entryDate).toBe(dates[2]);
  expect(delayed.trades[0]!.entries).toHaveLength(1);
  for (const mutation of [{ low: 99.79 }, { volume: 0 }, { high: NaN }]) {
    const broken = bars();
    Object.assign(broken[1]!, mutation);
    const result = run(broken);
    if (result.trades[0]) expect(result.trades[0]!.entries).toHaveLength(1);
  }
  expect(
    run(bars(), spec, [], { ...event, pullbackLevel: null }).trades,
  ).toEqual([]);
  const gap = bars();
  Object.assign(gap[2]!, { open: 99.7, low: 99.6 });
  const result = run(gap);
  expect(result.trades[0]!.entries).toHaveLength(1);
  expect(
    result.trades[0]!.managementWarnings!.some((w) =>
      w.reason.includes("第二笔开盘失守"),
    ),
  ).toBe(true);
});
it("retains a confirmed order through a tradability block but gives reduction and full exit priority", () => {
  const input = bars();
  Object.assign(input[3]!, {
    open: 100.1,
    close: 100.2,
    high: 100.4,
    low: 100,
  });
  const delayed = run(input, spec, [2]);
  expect(delayed.trades[0]!.entries![1]!.date).toBe(dates[3]);
  expect(delayed.trades[0]!.entries![1]!.triggerDate).toBe(dates[1]);
  const profitable = bars();
  Object.assign(profitable[1]!, { close: 106, high: 106.2 });
  const settings = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      scaleOut: [{ atR: 1, fraction: 0.2, raiseStopR: null }],
    },
  });
  expect(run(profitable, settings).trades[0]!.entries).toHaveLength(1);
  expect(
    run(bars(), { ...spec, holdingDays: 1 }).trades[0]!.entries,
  ).toHaveLength(1);
});
it("discloses method conflicts and drops incompatible pullback settings when changing strategies", () => {
  const method = researchMethodSnapshot(spec);
  expect(method.pullback!.version).toBe("research-pullback-1");
  expect(method.pyramid).toBeUndefined();
  expect(method.sources.map((s) => s.path)).toContain(
    "swing-trader/references/trading-system.md",
  );
  expect(method.sources.map((s) => s.path)).toContain(
    "swing-trader/references/position-management.md",
  );
  const moved = selectResearchStrategy(spec, "ma-cross");
  expect(moved.management?.pyramid).toBeUndefined();
  expect(researchSpecSchema.safeParse(moved).success).toBe(true);
  expect(
    researchSpecSchema.safeParse({ ...spec, strategy: "vp-center-5" }).success,
  ).toBe(false);
  expect(
    researchSpecSchema.safeParse({
      ...spec,
      management: { pyramid: { ...config, waitBars: 0 } },
    }).success,
  ).toBe(false);
  const check = researchPullbackConfirmation({
    bar: bars()[1],
    level: 99.8,
    age: 1,
    waitBars: 1,
    tolerance: 0,
    requireProfit: false,
    quantity: 500,
    cost: 50000,
    alreadyConfirmed: false,
  });
  expect(check.status).toBe("confirmed");
});

it("cancels a confirmed second tranche when the blocked session has no valid data", () => {
  for (const mutation of [{ volume: 0 }, { high: NaN }, { close: NaN }]) {
    const input = bars();
    Object.assign(input[2]!, mutation);
    Object.assign(input[3]!, {
      open: 100.1,
      close: 100.2,
      high: 100.4,
      low: 100,
    });
    const trade = run(input, spec, [2]).trades[0]!;
    expect(trade.pullbackEvidence![0]!.status).toBe("confirmed");
    expect(trade.entries).toHaveLength(1);
  }
});

it("freezes the actual breakout barrier causally and uses it for subsequent split entries", async () => {
  // Existing BJ price fixture, synthetic SH identity and future bars: this
  // checks rule plumbing, not historical Shanghai execution or performance.
  const history: Bar[] = breakoutFixture.bars;
  const tail: Bar[] = [
    {
      date: "2025-03-10",
      open: 28,
      close: 27.75,
      high: 28.1,
      low: 27.66,
      volume: 100000,
      amount: 2780000,
    },
    {
      date: "2025-03-11",
      open: 27.8,
      close: 27.9,
      high: 28,
      low: 27.7,
      volume: 100000,
      amount: 2780000,
    },
  ];
  const settings = researchSpecSchema.parse({
    ...spec,
    start: "2025-03-07",
    end: "2025-03-14",
    validationStart: "2025-03-13",
  });
  const native = async (): Promise<never> => {
    throw new Error("native must not run");
  };
  const prefix = await researchSignals(event.symbol, history, settings, native);
  const input = [...history, ...tail];
  const signals = await researchSignals(event.symbol, input, settings, native);
  expect(prefix).toHaveLength(1);
  expect(signals[0]).toEqual(prefix[0]);
  expect(prefix[0]!.pullbackLevel).toBe(27.66);
  const result = researchPortfolio(
    settings,
    [signals[0]!],
    input.map((b) => b.date),
    new Map([[event.symbol, input]]),
    () => rules,
  );
  expect(result.trades[0]!.entries!.map((e) => e.date)).toEqual([
    "2025-03-10",
    "2025-03-11",
  ]);
  expect(result.trades[0]!.entries![1]!.stop).toBe(27.66);
  const legacy = await researchSignals(
    event.symbol,
    history,
    { ...settings, management: undefined },
    native,
  );
  expect(legacy[0]!.pullbackLevel).toBeUndefined();
});
