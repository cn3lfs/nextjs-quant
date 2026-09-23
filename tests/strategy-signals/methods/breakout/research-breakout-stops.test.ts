import { expect, it } from "vitest";
import { researchBreakoutStopLocation } from "../../../../src/lib/research/technical/research-breakout-stops";
import {
  researchInitialStop,
  researchManagementSchema,
} from "../../../../src/lib/research/workflow/research-management";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../../src/server/backtest/research-portfolio";
import { selectResearchStrategy } from "../../../../src/components/research/research-strategy-fields";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import type { Level } from "../../../../src/server/strategies/breakout/breakout";
const candle = {
  date: "2024-05-20",
  open: 99,
  close: 105,
  low: 98,
  high: 106,
  volume: 30000,
  amount: 3000000,
};
const previous = { ...candle, date: "2024-05-19", close: 99 };
const level = (
  price: number,
  index: number,
  source: Level["source"] = "platform-high",
  confirmedAt = "2024-05-18",
): Level => ({ price, index, source, confirmedAt });
it("selects only a previously confirmed platform crossed today, preferring recent then higher", () => {
  const levels = [
    level(100, 10),
    level(102, 11),
    level(103, 11),
    level(97, 13),
    level(105, 14),
    level(104, 15, "swing-high"),
    level(104, 16, "platform-high", candle.date),
  ];
  expect(
    researchBreakoutStopLocation("platform-upper", candle, previous, levels),
  ).toEqual({ price: 103, source: "platform-high", confirmedAt: "2024-05-18" });
  expect(
    researchBreakoutStopLocation("platform-upper", candle, previous, [
      level(98, 10, "platform-low"),
      level(104, 10, "swing-high"),
    ]),
  ).toBeNull();
  expect(
    researchBreakoutStopLocation("breakout-candle", candle, previous, levels),
  ).toEqual({ price: 98, source: "breakout-candle", confirmedAt: candle.date });
});
it.each(["breakout-candle", "platform-upper"] as const)(
  "validates %s and preserves legacy methods",
  (kind) => {
    const management = researchManagementSchema.parse({
      stop: { kind, buffer: 0.005 },
    });
    expect(researchInitialStop(management, 100, { initialStop: 98 })).toBe(
      97.51,
    );
    expect(researchInitialStop(management, 97, { initialStop: 98 })).toBeNull();
    expect(researchInitialStop(management, 100, {})).toBeNull();
    const spec = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2024-01-01",
      end: "2024-12-31",
      validationStart: "2024-10-01",
      risk: { fraction: 0.01, maxWeight: 0.2 },
      management,
    });
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "breakoutStop.kind",
      kind,
    );
    expect(selectResearchStrategy(spec, "ma-cross").management!.stop.kind).toBe(
      "percent",
    );
    expect(
      researchSpecSchema.safeParse({ ...spec, strategy: "ma-cross" }).success,
    ).toBe(false);
    expect(
      researchManagementSchema.safeParse({ stop: { kind, buffer: -0.1 } })
        .success,
    ).toBe(false);
  },
);
it.each(["breakout-candle", "platform-upper"] as const)(
  "freezes real %s evidence and sizes at the next opening",
  async (kind) => {
    const bars = Array.from({ length: 145 }, (_, i) => {
      const high =
        160 - 0.1 * i - 5 * (1 - Math.cos((2 * Math.PI * (i - 85)) / 25));
      return {
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
        open: high - 2,
        close: high - 1,
        high,
        low: high - 3,
        volume: 10000,
        amount: 1000000,
      };
    });
    if (kind === "platform-upper")
      for (let i = 112; i <= 121; i++)
        Object.assign(bars[i]!, {
          open: 144,
          close: 144,
          high: 145,
          low: 142,
          volume: 5000,
        });
    Object.assign(bars[140]!, {
      open: 140,
      close: 151,
      high: 152,
      low: 139,
      volume: 30000,
    });
    for (let i = 141; i < 145; i++)
      Object.assign(bars[i]!, { open: 151, close: 151, high: 152, low: 150 });
    const spec = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: bars[140]!.date,
      end: bars[144]!.date,
      validationStart: bars[143]!.date,
      initialCapital: 1000000,
      risk: { fraction: 0.01, maxWeight: 1 },
      management: {
        stop: { kind, buffer: kind === "platform-upper" ? 0.005 : 0 },
      },
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    });
    const native = async (): Promise<never> => {
      throw Error("unexpected native");
    };
    const event = (await researchSignals("sh600000", bars, spec, native))[0]!;
    expect(event).toBeDefined();
    expect(event.initialStop).toBe(kind === "breakout-candle" ? 139 : 145);
    const evidence = JSON.parse(event.evidence).stopLocation;
    expect(evidence.source).toBe(
      kind === "breakout-candle" ? kind : "platform-high",
    );
    expect(evidence.confirmedAt <= event.observedDate).toBe(true);
    const changed = bars.map((b, i) =>
      i > 140 ? { ...b, high: b.high * 2 } : b,
    );
    expect(
      (await researchSignals("sh600000", changed, spec, native))[0],
    ).toEqual(event);
    const trade = researchPortfolio(
      spec,
      [event],
      bars.map((b) => b.date),
      new Map([[event.symbol, bars]]),
      () => ({
        evidence: "fixture",
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        tradable: true,
        limitUp: null,
        limitDown: null,
      }),
    ).trades[0]!;
    const stop = kind === "breakout-candle" ? 139 : 145 * 0.995;
    expect(trade.initialStop).toBe(stop);
    expect(trade.quantity).toBe(Math.floor(10000 / (151 - stop) / 100) * 100);
    expect(trade.entryDate).toBe(bars[141]!.date);
  },
);
