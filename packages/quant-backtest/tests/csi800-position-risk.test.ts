import type { Csi800Stock } from "trading-strategies";
import { describe, expect, it } from "vitest";
import {
  createPositionRisk,
  positionRiskBuy,
  positionRiskSell,
  positionRiskAction,
  positionRiskPlannedLoss,
  evaluatePositionClose,
  type PositionRiskStage,
} from "trading-strategies";
import { replayAllocationStudy } from "../src/allocation-profile.js";
import type { Csi800Allocation } from "trading-strategies";

function book(quantity = 1000, equity = 1_000_000) {
  const s = createPositionRisk("2025-01-02", equity);
  positionRiskBuy(s, 0, quantity, 100, 0);
  return s;
}
function close(
  s: ReturnType<typeof book>,
  price: number,
  extra: Partial<Parameters<typeof evaluatePositionClose>[1]> = {},
) {
  return evaluatePositionClose(s, {
    date: "2025-01-03",
    close: price,
    quantity: 1000,
    exitFee: 0,
    ema50: null,
    stage: "full",
    sellStep: 100,
    minimumPartial: 100,
    ...extra,
  });
}
function fixture(
  closes: number[],
  schedule?: (dates: string[]) => Csi800Allocation[],
) {
  const dates: string[] = [];
  for (let day = 0; dates.length < 280 + closes.length; day++) {
    const d = new Date(Date.UTC(2024, 0, 1 + day));
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
  }
  const bars = dates.map((date, i) => {
    const c = i < 280 ? 100 : closes[i - 280]!;
    const open = i === 280 ? 100 : i > 280 ? closes[i - 281]! : 100;
    return {
      date,
      open,
      close: c,
      high: Math.max(open, c) * 1.005,
      low: Math.min(open, c) * 0.995,
      amount: 1e9,
      volume: 1e7,
    };
  });
  const stocks: Csi800Stock[] = [{ symbol: "sh600000", bars, actions: [] }];
  const allocations = schedule?.(dates) ?? [
    { date: dates[279]!, weights: { sh600000: 0.15 } },
  ];
  const run = (stage: PositionRiskStage = "full") =>
    replayAllocationStudy(
      stocks,
      bars,
      {
        mode: "scheduled",
        start: dates[280]!,
        end: dates.at(-1)!,
        slippageBps: 0,
        positionRisk: { execution: "assumed-close-auction", stage },
      },
      allocations,
    );
  return { dates, stocks, bars, allocations, run };
}

describe("CSI800 per-trade position risk", () => {
  it("uses 8% at ordinary sizing and 2% of frozen entry equity at larger sizing", () => {
    const s = book();
    expect(close(s, 92).action).toBe("exit");
    expect(s.budget).toBe(20000);
    const large = book(10000);
    expect(close(large, 98, { quantity: 10000 }).reasons).toContain(
      "account-risk-2pct",
    );
    expect(large.hardStop).toBe(98);
    expect(positionRiskPlannedLoss(undefined, 0, 10000, 100, 0, 0)).toBe(80000);
    expect(positionRiskPlannedLoss(undefined, 0, 1500, 100, 0, 200)).toBe(
      12200,
    );
  });
  it("includes purchase and exit fees and preserves actual gap losses", () => {
    const s = book();
    positionRiskBuy(s, 1000, 1000, 120, 20);
    expect(s.cost).toBeCloseTo(110.01);
    const gap = close(s, 70, { quantity: 2000, exitFee: 20 });
    expect(gap.pnl).toBeCloseTo(-80040);
    expect(gap.reasons).toContain("account-risk-2pct");
    expect(s.budget).toBe(20000);
  });
  it("arms break-even at 5% and cannot loosen after an added purchase", () => {
    const s = book();
    expect(close(s, 105).action).toBe("hold");
    expect(s.breakEvenStop).toBe(100);
    positionRiskBuy(s, 1000, 1000, 90, 0);
    expect(close(s, 100, { quantity: 2000 }).reasons).toContain(
      "breakeven-stop",
    );
    expect(s.breakEvenStop).toBe(100);
    const higher = book();
    close(higher, 105);
    positionRiskBuy(higher, 1000, 1000, 110, 0);
    close(higher, 106, { quantity: 2000 });
    expect(higher.breakEvenStop).toBe(105);
    expect(close(higher, 104, { quantity: 2000 }).reasons).toContain(
      "breakeven-stop",
    );
  });
  it("uses current EMA from entry, allows the EMA to fall, and exits strictly below", () => {
    const s = book();
    expect(close(s, 100, { ema50: 99 }).action).toBe("hold");
    expect(close(s, 99, { ema50: 95 }).action).toBe("hold");
    expect(close(s, 98, { ema50: 95 }).action).toBe("hold");
    expect(close(s, 94.99, { ema50: 95 }).reasons).toContain("ema50-stop");
    expect(close(book(), 100, { ema50: null }).action).toBe("hold");
    expect(close(book(), 99, { ema50: 99 }).action).toBe("hold");
  });
  it("trims one rounded third exactly once and prioritizes full protection", () => {
    const s = book();
    expect(close(s, 130).requested).toBe(300);
    positionRiskSell(s, 300, 130, 5);
    expect(close(s, 140, { quantity: 700 }).requested).toBe(0);
    expect(s.realized).toBe(8995);
    const simultaneous = close(book(), 130, { ema50: 131 });
    expect(simultaneous.action).toBe("exit");
    expect(simultaneous.requested).toBe(1000);
    const small = close(book(200), 130, { quantity: 200 });
    expect(small.insufficientLot).toBe(true);
    expect(small.requested).toBe(0);
  });
  it("counts realized profits in the whole-cycle risk budget", () => {
    const s = book();
    positionRiskSell(s, 300, 130, 0);
    const decision = close(s, 60, { quantity: 700, stage: "initial" });
    expect(decision.pnl).toBe(-19000);
    expect(decision.reasons).not.toContain("account-risk-2pct");
    expect(decision.reasons).toContain("initial-or-account-stop");
  });
  it("adjusts cost, protection and pending trim for dividend, bonus and rights", () => {
    const s = book();
    close(s, 130, { ema50: 120 });
    positionRiskAction(s, {
      dividend: 10,
      bonus: 0.1,
      rights: 0.1,
      rightsPrice: 50,
    });
    expect(s.cost).toBeCloseTo(95 / 1.2);
    expect(s.capitalPerShare).toBeCloseTo(105 / 1.2);
    expect(s.breakEvenStop).toBeCloseTo(95 / 1.2);
    expect(s.trimRemaining).toBeCloseTo(360);
    // Very large accumulated dividends can make economic cost nonpositive.
    positionRiskAction(s, { dividend: 100, bonus: 0 });
    expect(Number.isFinite(close(s, 10, { quantity: 1200 }).gain)).toBe(true);
  });
  it("disables later stages in fixed ablations", () => {
    const initial = book();
    close(initial, 140, { stage: "initial", ema50: 150 });
    expect(initial.breakEvenStop).toBeNull();
    expect(initial.trimArmed).toBe(false);
    const breakeven = book();
    close(breakeven, 140, { stage: "breakeven", ema50: 150 });
    expect(breakeven.breakEvenStop).toBe(100);
    expect(breakeven.trimArmed).toBe(false);
    expect(
      close(breakeven, 140, { stage: "breakeven", ema50: 150 }).action,
    ).toBe("hold");
  });
});

describe("CSI800 assumed closing-auction integration", () => {
  it("ignores historical HIGH/LOW changes when computing EMA protection", () => {
    const f = fixture([100, 97, 97]),
      before = f.run();
    for (const b of f.stocks[0]!.bars.slice(250, 280)) {
      b.high *= 1.5;
      b.low *= 0.5;
    }
    const after = f.run();
    expect(after.riskEvents).toEqual(before.riskEvents);
    expect(after.fills).toEqual(before.fills);
  });
  it("requires 50 observed closes without fabricating warm-up values", () => {
    const f = fixture(Array<number>(22).fill(100));
    f.stocks[0]!.bars = f.stocks[0]!.bars.slice(251);
    const blocked = f.run();
    expect(blocked.fills).toHaveLength(0);
    expect(blocked.entryChecks![0]!.reason).toContain("预热不足");
    const r = f.run("partial");
    expect(r.riskEvents![0]!.ema50).toBeNull();
    expect(r.riskEvents![19]!.ema50).toBeNull();
    expect(r.riskEvents![20]!.ema50).toBeCloseTo(100, 8);
  });
  it("rejects an already-below-EMA signal even if the following open recovers", () => {
    const f = fixture([101, 102]);
    f.stocks[0]!.bars[279]!.close = 99;
    f.stocks[0]!.bars[279]!.low = 98;
    const r = f.run();
    expect(r.fills).toHaveLength(0);
    expect(r.entryChecks![0]!.reason).toBe("EMA50入场：信号收盘低于均线");
    expect(r.curve.at(-1)!.cash).toBe(1e6);
  });
  it("rejects a gap below the known EMA, then accepts a later independent eligible target", () => {
    const f = fixture([99, 101, 101], (dates) => [
      { date: dates[279]!, weights: { sh600000: 0.15 } },
      { date: dates[281]!, weights: { sh600000: 0.15 } },
    ]);
    f.stocks[0]!.bars[280]!.open = 99;
    const r = f.run();
    expect(r.entryChecks![0]!.reason).toBe("EMA50入场：开盘低于已知均线");
    expect(r.fills.filter((p) => p.side === "buy").map((p) => p.date)).toEqual([
      f.dates[282],
    ]);
  });
  it("rechecks the latest completed close when a signal has delayed execution", () => {
    const f = fixture([99, 101, 101]);
    f.stocks[0]!.bars[281]!.open = 101;
    const r = replayAllocationStudy(
      f.stocks,
      f.bars,
      {
        mode: "scheduled",
        start: f.dates[280]!,
        end: f.dates.at(-1)!,
        delay: 2,
        positionRisk: { execution: "assumed-close-auction", stage: "full" },
      },
      f.allocations,
    );
    expect(r.fills).toHaveLength(0);
    expect(r.entryChecks![0]!.reason).toBe("EMA50入场：最新收盘低于均线");
  });
  it("uses corporate actions known at the opening to compare EMA on the raw scale", () => {
    const f = fixture([100, 100]);
    const date = f.dates[280]!;
    f.stocks[0]!.actions.push({
      date,
      dividend: 10,
      bonus: 0.1,
      unsupported: false,
    });
    for (const b of f.stocks[0]!.bars)
      if (b.date >= date)
        for (const key of ["open", "high", "low", "close"] as const)
          b[key] = (b[key] - 10) / 1.1;
    const r = f.run();
    expect(r.entryChecks![0]!.eligible).toBe(true);
    expect(r.entryChecks![0]!.openingEma50).toBeCloseTo(90 / 1.1, 8);
    expect(r.fills.filter((p) => p.side === "buy")).toHaveLength(1);
  });
  it("does not inspect purchase-day close/high/low when deciding EMA eligibility", () => {
    const f = fixture([99, 101]);
    const before = f.run();
    f.stocks[0]!.bars[280]!.close = 140;
    f.stocks[0]!.bars[280]!.high = 141;
    const after = f.run();
    expect(after.entryChecks).toEqual(before.entryChecks);
    expect(after.fills.filter((p) => p.side === "buy")).toEqual(
      before.fills.filter((p) => p.side === "buy"),
    );
  });
  it("also rejects an addition below the opening EMA while allowing the existing exit", () => {
    const f = fixture([101, 99.5, 99.5], (dates) => [
      { date: dates[279]!, weights: { sh600000: 0.05 } },
      { date: dates[280]!, weights: { sh600000: 0.15 } },
    ]);
    f.stocks[0]!.bars[281]!.open = 99.5;
    const r = f.run();
    expect(r.fills.filter((p) => p.side === "buy")).toHaveLength(1);
    expect(r.entryChecks!.find((p) => p.date === f.dates[281])!.reason).toBe(
      "EMA50入场：开盘低于已知均线",
    );
    expect(r.fills.find((p) => p.side === "sell")!.date).toBe(f.dates[281]);
  });
  it("latches a first-purchase EMA breach until T+1 even if the price recovers", () => {
    const f = fixture([99, 101, 101]);
    const r = f.run(),
      sale = r.fills.find((p) => p.side === "sell")!;
    expect(r.riskEvents![0]!.reasons).toContain("ema50-stop");
    expect(r.riskEvents![0]!.t1Blocked).toBe(true);
    expect(sale.signalDate).toBe(f.dates[280]);
    expect(sale.date).toBe(f.dates[281]);
    expect(sale.price).toBe(101);
    expect(r.riskTrades![0]!.exitTriggerReasons).toContain("ema50-stop");
  });
  it("uses causal close EMA50 from purchase and gives an exit before the 8% stop", () => {
    const f = fixture([100, 97, 97]);
    const r = f.run();
    expect(r.riskEvents![0]!.ema50).toBeCloseTo(100, 8);
    expect(r.riskEvents![0]!.protection).toBeCloseTo(100, 8);
    expect(r.riskEvents![1]!.ema50).toBeCloseTo(100 - (3 * 2) / 51, 8);
    expect(r.fills.find((p) => p.side === "sell")!.price).toBe(97);
    expect(r.riskTrades![0]!.reason).toContain("ema50-stop");
  });
  it("requires a new signal strictly after the closing exit before buying again", () => {
    const f = fixture([100, 90, 90, 90], (dates) => [
      { date: dates[279]!, weights: { sh600000: 0.15 } },
      { date: dates[281]!, weights: { sh600000: 0.15 } },
      { date: dates[282]!, weights: { sh600000: 0.15 } },
    ]);
    const r = f.run("initial");
    const buys = r.fills.filter((p) => p.side === "buy");
    expect(buys.map((p) => p.date)).toEqual([f.dates[280], f.dates[283]]);
    expect(r.rejected.some((p) => p.reason === "退出后需后续独立信号")).toBe(
      true,
    );
  });
  it("retains T+1, latches an exit and fills at the next sellable actual close", () => {
    const f = fixture([90, 80, 80]);
    const r = f.run("initial"),
      sale = r.fills.find((p) => p.side === "sell")!;
    expect(r.riskEvents![0]!.t1Blocked).toBe(true);
    expect(sale.date).toBe(f.dates[281]);
    expect(sale.price).toBe(80);
    expect(sale.signalDate).toBe(f.dates[280]);
    expect(r.riskTrades![0]!.exitTriggeredAt).toBe(f.dates[280]);
    expect(r.riskTrades![0]!.budgetBreached).toBe(true);
    expect(r.curve.at(-1)!.cash).toBeCloseTo(
      1e6 +
        r.fills.reduce(
          (v, p) =>
            v + (p.side === "sell" ? 1 : -1) * p.price * p.quantity - p.fee,
          0,
        ),
    );
  });
  it("keeps the request across a missing/suspended observation without inventing a fill", () => {
    const f = fixture([90, 90, 95, 95]);
    f.stocks[0]!.bars = f.stocks[0]!.bars.filter(
      (b) => b.date !== f.dates[281],
    );
    const r = f.run("initial"),
      sale = r.fills.find((p) => p.side === "sell")!;
    expect(sale.date).toBe(f.dates[282]);
    expect(sale.price).toBe(95);
    expect(r.riskTrades![0]!.reason).toContain("pending-risk-exit");
    expect(r.riskEvents!.some((p) => p.date === f.dates[281])).toBe(false);
  });
  it("can sell prior inventory even after an opening addition, without selling new shares", () => {
    const f = fixture([100, 90, 89], (dates) => [
      { date: dates[279]!, weights: { sh600000: 0.05 } },
      { date: dates[280]!, weights: { sh600000: 0.15 } },
    ]);
    const r = f.run("initial"),
      buys = r.fills.filter((p) => p.side === "buy"),
      sales = r.fills.filter((p) => p.side === "sell");
    expect(buys).toHaveLength(2);
    expect(sales).toHaveLength(2);
    expect(sales[0]!.quantity).toBe(buys[0]!.quantity);
    expect(sales[0]!.date).toBe(buys[1]!.date);
    expect(sales[1]!.quantity).toBe(buys[1]!.quantity);
  });
  it("does not replenish a profit trim on a later ordinary weekly target", () => {
    const f = fixture([110, 120, 131, 132, 133, 134], (dates) => [
      { date: dates[279]!, weights: { sh600000: 0.15 } },
      { date: dates[283]!, weights: { sh600000: 0.15 } },
    ]);
    const r = f.run("partial");
    expect(r.fills.filter((p) => p.side === "buy")).toHaveLength(1);
    expect(
      r.fills.filter((p) => p.reason === "profit-30pct-trim"),
    ).toHaveLength(1);
    expect(r.rejected.some((p) => p.reason === "部分止盈后只减不加")).toBe(
      true,
    );
  });
  it("does not sell because of an economic-neutral dividend and bonus", () => {
    const f = fixture([100, 100, 100]);
    const date = f.dates[281]!;
    f.stocks[0]!.actions.push({
      date,
      dividend: 10,
      bonus: 0.1,
      unsupported: false,
    });
    for (const b of f.stocks[0]!.bars)
      if (b.date >= date)
        for (const key of ["open", "high", "low", "close"] as const)
          b[key] = (b[key] - 10) / 1.1;
    const r = f.run();
    expect(r.fills.filter((p) => p.side === "sell")).toHaveLength(0);
    expect(r.riskEvents!.at(-1)!.cost).toBeCloseTo((100.031 - 10) / 1.1, 8);
  });
  it("preserves earlier fills, risk states and curve when future prices and actions change", () => {
    const f = fixture([100, 110, 120, 131, 132, 133]);
    const before = f.run(),
      cutoff = f.dates[283]!;
    f.stocks[0]!.actions.push({
      date: f.dates[284]!,
      dividend: 1,
      bonus: 0.1,
      unsupported: false,
    });
    for (const b of f.stocks[0]!.bars)
      if (b.date > cutoff)
        for (const key of ["open", "high", "low", "close"] as const)
          b[key] *= 1.2;
    const after = f.run();
    for (const key of ["fills", "riskEvents", "curve"] as const)
      expect(after[key]!.filter((p) => p.date <= cutoff)).toEqual(
        before[key]!.filter((p) => p.date <= cutoff),
      );
  });
});
