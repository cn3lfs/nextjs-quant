import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { canslimRiskTemplate } from "../src/lib/research-canslim-management";
import {
  canslimExitPresetIds,
  canslimExitDescription,
  researchExitPresetTemplate,
  clearStaleExitPreset,
} from "../src/lib/research-exit-presets";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";

function setup(kind: (typeof canslimExitPresetIds)[number]) {
  const bars: Bar[] = Array.from({ length: 84 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const base = researchSpecSchema.parse({
    strategy: "canslim-priority",
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[83]!.date,
    validationStart: bars[82]!.date,
    holdingDays: 8,
    initialCapital: 1000000,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const spec = canslimRiskTemplate(base);
  spec.management = researchExitPresetTemplate(spec.management!, kind);
  const rules = {
    evidence: "fixture",
    tradable: true,
    limitUp: null,
    limitDown: null,
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
  };
  const run = async (maxSell = 100000, blocked = "") => {
    const events = await researchSignals("sh600000", bars, spec, async () => {
      throw Error("unexpected native");
    });
    expect(events).toHaveLength(1);
    return researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      (_, date) => ({
        ...rules,
        maximumSell: maxSell,
        tradable: date !== blocked,
      }),
    );
  };
  const price = (index: number, open: number, close = open) =>
    Object.assign(bars[index]!, {
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
    });
  return { bars, spec, run, price };
}

it("resets unrelated controls, records source/configuration, and rejects stale percentage identities", () => {
  for (const kind of canslimExitPresetIds) {
    const { spec } = setup(kind);
    expect(researchSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.risk).toEqual({ fraction: 0.015, maxWeight: 0.25 });
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "exitPreset.kind",
      kind,
    );
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "exitPreset.interpretation",
      canslimExitDescription,
    );
    expect(
      researchMethodSnapshot(spec).sources.some(
        (s) => s.path === "canslim-analyst/references/entry-exit-rules.md",
      ),
    ).toBe(true);
    const stale = {
      ...spec.management!,
      stop: { kind: "percent" as const, fraction: 0.05 },
    };
    expect(researchManagementSchema.safeParse(stale).success).toBe(false);
    expect(clearStaleExitPreset(stale)).not.toHaveProperty("exitPreset");
    const reset = canslimRiskTemplate({
      ...spec,
      management: researchManagementSchema.parse({
        kelly: {
          provenance: "manual-scenario",
          winRate: 0.5,
          payoff: 2,
          fraction: 0.5,
        },
      }),
    });
    expect(reset.management!.kelly).toBeUndefined();
  }
});

it("sizes from 1.5 percent risk with an 8 percent stop, then honors a gap after close confirmation", async () => {
  const { bars, spec, run, price } = setup("canslim-8-fixed");
  price(71, 100, 93.84);
  price(72, 90);
  const trade = (await run()).trades[0]!;
  expect(trade.quantity).toBe(1800);
  expect(trade.entryPrice).toBe(102);
  expect(trade.initialStop).toBeCloseTo(93.84, 10);
  expect(trade.entryCost).toBeLessThanOrEqual(spec.initialCapital * 0.25);
  expect(
    trade.quantity * (trade.entryPrice - trade.initialStop!),
  ).toBeLessThanOrEqual(15000);
  expect(trade.initialStop).toBeCloseTo(
    Math.max(trade.entryPrice * 0.92, 100 * 0.92),
    10,
  );
  expect(trade).toMatchObject({
    entryDate: bars[70]!.date,
    exitDate: bars[72]!.date,
    exitPrice: 90,
  });
});

it.each(["canslim-20-25-cost", "canslim-20-25-profit10"] as const)(
  "%s confirms at 15/20/25 percent and sells original halves",
  async (kind) => {
    const { bars, run, price } = setup(kind);
    price(71, 110, 117.3);
    price(72, 118, 122.4);
    price(73, 123);
    price(74, 124, 127.5);
    price(75, 128);
    const trade = (await run()).trades[0]!;
    expect(
      trade.stopHistory!.some(
        (s) => s.date === bars[71]!.date && s.stop === 102,
      ),
    ).toBe(true);
    expect(trade.sales!.map((s) => [s.date, s.quantity, s.price])).toEqual([
      [bars[73]!.date, 900, 123],
      [bars[75]!.date, 900, 128],
    ]);
    expect(trade.remainingQuantity).toBe(0);
    expect(trade.exitDate).toBe(bars[75]!.date);
    if (kind.endsWith("profit10"))
      expect(
        trade.stopHistory!.some(
          (s) => s.date === bars[73]!.date && Math.abs(s.stop - 112.2) < 1e-8,
        ),
      ).toBe(true);
  },
);

it("does not raise the profit10 line until the first half actually finishes selling", async () => {
  const { bars, run, price } = setup("canslim-20-25-profit10");
  for (let i = 71; i <= 77; i++) price(i, 123);
  const trade = (await run(300, bars[74]!.date)).trades[0]!;
  expect(trade.sales!.slice(0, 3).map((s) => [s.date, s.quantity])).toEqual([
    [bars[72]!.date, 300],
    [bars[73]!.date, 300],
    [bars[75]!.date, 300],
  ]);
  expect(
    trade.stopHistory!.filter((s) => s.stop > 102).map((s) => s.date),
  ).toEqual([bars[75]!.date]);
});

it("keeps the two conflicting post-target stops as distinct behaviors", async () => {
  for (const kind of [
    "canslim-20-25-cost",
    "canslim-20-25-profit10",
  ] as const) {
    const { bars, run, price } = setup(kind);
    price(71, 110, 117.3);
    price(72, 118, 122.4);
    price(73, 123);
    for (let i = 74; i < bars.length; i++) price(i, 110);
    const trade = (await run()).trades[0]!;
    expect(trade.exitDate).toBe(
      bars[kind.endsWith("profit10") ? 75 : 78]!.date,
    );
  }
});
