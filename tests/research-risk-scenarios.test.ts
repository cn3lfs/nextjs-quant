import { expect, it } from "vitest";
import {
  crowdedStop,
  scriptSlipSizing,
  chopFrequency,
} from "../src/lib/research-risk-scenarios";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";
import {
  researchPortfolio,
  type ResearchTrade,
} from "../src/server/backtest/research-portfolio";
import { riskPresetTemplate } from "../src/lib/research-risk-presets";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
const bars = Array.from({ length: 100 }, (_, i) => ({
  date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 100000,
  amount: 10000000,
}));
const dates = bars.map((b) => b.date);
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
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
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[60],
  end: dates[95],
  validationStart: dates[90],
  costs,
  initialCapital: 1000000,
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[65]!,
  endpointDate: dates[65]!,
  key: "fixed",
  strategyVersion: "fixture",
  partition: "development",
  evidence: "synthetic event",
};
it("source script reports the excess slippage without silently resizing shares", () => {
  expect(scriptSlipSizing(1000000, 0.01, 80, 76, 100, 0.5, 0.3)).toMatchObject({
    quantity: 2500,
    budget: 10000,
    riskWithoutSlippage: 10000,
    riskWithSlippage: 11250,
    quantityResizedForSlippage: false,
    feesIncluded: false,
  });
  expect(scriptSlipSizing(1000000, 0.01, 80, 76, 100, 0, 0.2)!.quantity).toBe(
    2500,
  );
  expect(scriptSlipSizing(10000, 0.001, 80, 76, 100, 0.5, 0.3)!.quantity).toBe(
    0,
  );
  expect(scriptSlipSizing(1000000, 0.01, 80, 80, 100, 0.5, 0.3)).toBeNull();
  const result = researchPortfolio(
    applyResearchManagement(base, riskPresetTemplate("rk-slip-report")),
    [event],
    dates,
    new Map([[event.symbol, bars]]),
    () => rules,
  );
  expect(result.trades[0]!.scriptSlipComparison).toMatchObject({
    quantity: 2000,
    riskWithoutSlippage: 10000,
    riskWithSlippage: 10000,
  });
});
it.each(["round", "swing-low", "trend"] as const)(
  "%s preserves raw, .3 and .5 ATR cases and rejects future confirmation",
  (anchor) => {
    const point = analyzeBreakout(bars.slice(0, 66)).latest!;
    point.levels = [
      { price: 98, source: "round", index: 64, confirmedAt: dates[64]! },
      { price: 97, source: "swing-low", index: 60, confirmedAt: dates[63]! },
    ];
    const a = {
      index: 40,
      date: dates[40]!,
      confirmedAt: dates[43]!,
      price: 98,
      kind: "high" as const,
    };
    point.long.line = {
      direction: "long",
      anchors: [a, { ...a, index: 50, date: dates[50]! }],
      touches: 3,
      slope: 0,
      value: 96,
      confirmedAt: dates[53]!,
    };
    const raw = anchor === "round" ? 98 : anchor === "swing-low" ? 97 : 96;
    for (const multiple of [0, 0.3, 0.5] as const)
      expect(crowdedStop(point, anchor, 2, multiple)!.price).toBe(
        raw - 2 * multiple,
      );
    point.levels.forEach((l) => (l.confirmedAt = dates[99]!));
    point.long.line.confirmedAt = dates[99]!;
    expect(crowdedStop(point, anchor, 2, 0.3)).toBeNull();
  },
);
const loss = (index: number): ResearchTrade => ({
  event,
  entryDate: dates[index - 2]!,
  entryIndex: index - 2,
  entryPrice: 100,
  quantity: 100,
  entryCost: 10000,
  exitDate: dates[index]!,
  exitPrice: 95,
  profit: -500,
  netReturn: -0.05,
  lastPrice: 95,
  initialStop: 95,
  exitReason: "收盘止损",
});
it("chop requires both frequent closed stop losses and observable alternating prices", () => {
  const alternating = bars.map((b, i) => ({
    ...b,
    close: 100 + (i % 2 ? 0.5 : -0.5),
  }));
  const trades = [loss(72), loss(75), loss(79)];
  const run = (
    at: number,
    mode: "pause" | "spacing",
    ts = trades,
    bs = alternating,
  ) => chopFrequency(mode, dates[at]!, dates, bs, ts);
  expect(run(80, "pause")).toMatchObject({
    allow: false,
    choppy: true,
    losses: 3,
    turns: 19,
  });
  expect(run(84, "pause").allow).toBe(false);
  expect(run(85, "pause").allow).toBe(true);
  expect(run(80, "spacing").allow).toBe(false);
  expect(run(82, "spacing").allow).toBe(true);
  expect(run(80, "pause", trades.slice(0, 2)).allow).toBe(true);
  expect(run(80, "pause", trades, bars).allow).toBe(true);
  expect(run(80, "pause", [...trades, loss(90)])).toEqual(run(80, "pause"));
  expect(
    run(
      80,
      "pause",
      trades,
      alternating.filter((_, i) => i !== 70),
    ).reason,
  ).toContain("missing");
});
it("no-single-stop control keeps the same mean-reversion entry but does not execute the sizing reference line", () => {
  const input = bars.map((b, i) =>
    i >= 67
      ? { ...b, open: 90, close: 90, low: 89, high: 91 }
      : { ...b, close: 100 + Math.sin(i) * 0.3 },
  );
  const run = (id: "rk-mean-stop" | "rk-mean-no-stop") => {
    const spec = researchSpecSchema.parse(
      applyResearchManagement(base, riskPresetTemplate(id)),
    );
    expect(spec.strategy).toBe("boll-band-recovery");
    return researchPortfolio(
      spec,
      [event],
      dates,
      new Map([[event.symbol, input]]),
      () => rules,
    );
  };
  const withStop = run("rk-mean-stop"),
    without = run("rk-mean-no-stop");
  expect(withStop.trades[0]!.entryDate).toBe(without.trades[0]!.entryDate);
  expect(withStop.trades[0]!.exitReason).toContain("止损");
  expect(without.trades[0]!.exitDate).toBeNull();
  expect(without.trades[0]!.quantity).toBe(1000);
  expect(without.accountRisk).toBeDefined();
});
