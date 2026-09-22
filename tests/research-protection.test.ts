import { riskPresetTemplate } from "../src/lib/research-risk-presets";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import {
  researchManagementSchema,
  researchScaleOutPreset,
} from "../src/lib/research-management";
import { researchHigherLow } from "../src/server/strategies/shared/research-protection";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import {
  researchMethodSnapshot,
  validateResearchMethod,
} from "../src/server/research/research-method";

const date = (i: number) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10);
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
};
const event = (i: number): ResearchEvent => ({
  symbol: "sh600000",
  observedDate: date(i),
  endpointDate: date(i),
  key: "fixture",
  strategyVersion: "fixture",
  partition: "development",
  evidence: "{}",
});
function spec(start: number, end: number, management: unknown) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: date(start),
    end: date(end),
    validationStart: date(end - 1),
    initialCapital: 40000,
    holdingDays: 60,
    maxPositions: 1,
    risk: { fraction: 0.04, maxWeight: 1 },
    management,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
function structureBars(): Bar[] {
  const input = Array.from({ length: 76 }, (_, i) => ({
    date: date(i),
    open: 110,
    close: 110,
    high: 111,
    low: 109,
    volume: 1000,
    amount: 110000,
  }));
  input[50]!.low = 95;
  Object.assign(input[61]!, { open: 100, close: 108, low: 99 });
  input[65]!.low = 105;
  Object.assign(input[69]!, { close: 99, low: 98 });
  Object.assign(input[70]!, { open: 90, close: 91, high: 92, low: 89 });
  return input;
}

it("higher lows are unavailable before right-side confirmation and cannot cross ambiguity or suspension", () => {
  const input = structureBars();
  expect(researchHigherLow(input.slice(0, 68), date(61), 100).status).toBe(
    "not-confirmed",
  );
  expect(researchHigherLow(input.slice(0, 69), date(61), 100)).toMatchObject({
    status: "confirmed",
    latest: { date: date(65), confirmedAt: date(68), price: 105 },
  });
  expect(researchHigherLow(input.slice(0, 59), date(61), 100).status).toBe(
    "unavailable",
  );
  const suspended = structuredClone(input);
  suspended[64]!.volume = 0;
  expect(researchHigherLow(suspended.slice(0, 69), date(61), 100).status).toBe(
    "not-confirmed",
  );
  const ambiguous = structuredClone(input);
  ambiguous[63]!.high = 500;
  ambiguous[63]!.low = 1;
  expect(researchHigherLow(ambiguous.slice(0, 69), date(61), 100).status).toBe(
    "not-confirmed",
  );
});

it("breakeven requires profit AND confirmed post-entry structure and acts only from the next session", () => {
  const input = structureBars();
  const config = spec(60, 75, { breakeven: { atR: 1 } });
  const run = (rows: Bar[], settings = config) =>
    researchPortfolio(
      settings,
      [event(60)],
      rows.map((row) => row.date),
      new Map([["sh600000", rows]]),
      () => rules,
    );
  const result = run(input);
  const trade = result.trades[0]!;
  expect(trade.stopHistory!.map((row) => [row.date, row.stop])).toEqual([
    [date(61), 95],
    [date(68), 100],
  ]);
  expect(trade.exitDate).toBe(date(70));
  expect(trade.protectionEvidence!.at(-1)!.structure.status).toBe("confirmed");
  expect(trade.profit).toBe(-3000); // A price-based breakeven is not a gap guarantee.
  const insufficientProfit = run(
    input,
    spec(60, 75, { breakeven: { atR: 3 } }),
  );
  expect(insufficientProfit.trades[0]!.stopHistory).toHaveLength(1);
  const changed = structuredClone(input);
  changed[72]!.low = 1;
  expect(run(changed).trades[0]!.stopHistory).toEqual(trade.stopHistory);
});

function tailBars() {
  const opens = [100, 100, 110, 120, 121, 130, 125, 110];
  const closes = [100, 110, 120, 121, 130, 125, 115, 111];
  return opens.map((open, i): Bar => ({
    date: date(i),
    open,
    close: closes[i]!,
    high: Math.max(open, closes[i]!) + 1,
    low: Math.min(open, closes[i]!) - 1,
    volume: 1000,
    amount: 100000,
  }));
}
it("close-ATR uses current close, only tightens, and activates after actual completion of every stage", () => {
  const input = tailBars();
  const config = spec(0, 7, {
    scaleOut: researchScaleOutPreset,
    trail: { kind: "close-atr", period: 2, multiple: 2 },
    trailAfterScaleOut: true,
  });
  const run = (settings = config, blocked = "") =>
    researchPortfolio(
      settings,
      [event(0)],
      input.map((bar) => bar.date),
      new Map([["sh600000", input]]),
      (_, day) => ({ ...rules, tradable: day !== blocked }),
    );
  const result = run();
  expect(
    result.trades[0]!.stopHistory!.map((row) => [row.date, row.stop]),
  ).toEqual([
    [date(1), 95],
    [date(2), 100],
    [date(3), 115],
    [date(4), 116],
  ]);
  expect(result.trades[0]!.exitDate).toBe(date(7));
  const tight = spec(0, 7, {
    ...config.management,
    trail: { kind: "close-atr", period: 2, multiple: 0.5 },
  });
  const stoppedStage = run(tight, date(3));
  expect(
    stoppedStage.trades[0]!.stopHistory!.filter(
      (row) => row.date <= date(3),
    ).map((row) => row.stop),
  ).toEqual([95, 100]);
  expect(
    stoppedStage.trades[0]!.stopHistory!.some(
      (row) => row.date === date(4) && row.stop > 115,
    ),
  ).toBe(true);
});

it("skipped small-quantity stages cannot activate a supposedly completed tail template", () => {
  const input = tailBars();
  const config = {
    ...spec(0, 7, {
      scaleOut: researchScaleOutPreset,
      trail: { kind: "close-atr", period: 2, multiple: 0.5 },
      trailAfterScaleOut: true,
    }),
    risk: { fraction: 0.015, maxWeight: 1 },
  };
  const result = researchPortfolio(
    config,
    [event(0)],
    input.map((bar) => bar.date),
    new Map([["sh600000", input]]),
    () => rules,
  );
  expect(result.trades[0]!.stopHistory).toHaveLength(1);
  expect(
    result.trades[0]!.managementWarnings!.some((row) =>
      row.reason.includes("尚未激活"),
    ),
  ).toBe(true);
});

it("optional protections preserve old shapes and freeze their source version independently", () => {
  const old = spec(0, 7, {});
  expect(old.management).not.toHaveProperty("breakeven");
  expect(old.management).not.toHaveProperty("trailAfterScaleOut");
  expect(researchMethodSnapshot(old)).toEqual(
    researchMethodSnapshot(old.strategy, true),
  );
  const active = spec(0, 7, { breakeven: { atR: 1 } });
  const method = researchMethodSnapshot(active);
  expect(method.protection!.version).toBe("research-protection-1");
  expect(() => validateResearchMethod(active, method)).not.toThrow();
  expect(() => validateResearchMethod(old, method)).toThrow("方法版本");
  expect(
    researchManagementSchema.safeParse({ trailAfterScaleOut: true }).success,
  ).toBe(false);
});

it("structure trail waits for causal right-side confirmation, then uses actual higher low rather than cost", () => {
  const input = structureBars();
  const config = applyResearchManagement(
    { ...spec(60, 75, {}), initialCapital: 100000 },
    riskPresetTemplate("rk-structure-trail"),
  );
  const result = researchPortfolio(
    config,
    [event(60)],
    input.map((b) => b.date),
    new Map([["sh600000", input]]),
    () => rules,
  );
  expect(result.trades[0]!.stopHistory!.map((r) => [r.date, r.stop])).toEqual([
    [date(61), 95],
    [date(68), 105],
  ]);
  expect(result.trades[0]!.exitDate).toBe(date(70));
});
