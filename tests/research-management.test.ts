import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { atr } from "../src/lib/indicators";
import {
  researchManagementSchema,
  researchInitialStop,
} from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { maParamsSchema } from "../src/lib/domain";
import { researchParamsFingerprint } from "../src/server/backtest/research-store";
import {
  researchMethodSnapshot,
  validateResearchMethod,
} from "../src/server/research/research-method";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";

const dates = Array.from(
  { length: 8 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[7],
  validationStart: dates[5],
  initialCapital: 10000,
  holdingDays: 60,
  maxPositions: 1,
  risk: { fraction: 0.05, maxWeight: 1 },
  management: { stop: { kind: "percent", fraction: 0.1 } },
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
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
function bars(closes: number[], opens = closes): Bar[] {
  return closes.map((close, i) => ({
    date: dates[i]!,
    close,
    open: opens[i]!,
    high: Math.max(close, opens[i]!) + 0.1,
    low: Math.min(close, opens[i]!) - 0.1,
    volume: 100,
    amount: 1000,
  }));
}
function run(
  input: Bar[],
  management: unknown = spec.management,
  signal = event,
  blocked: string[] = [],
) {
  return researchPortfolio(
    researchSpecSchema.parse({ ...spec, management }),
    [signal],
    input.map((bar) => bar.date),
    new Map([[event.symbol, input]]),
    (_, date) => ({ ...rules, tradable: !blocked.includes(date) }),
  );
}

it("ATR uses N full true ranges including gaps and rejects broken OHLC without seeding", () => {
  const input = bars([10, 12, 11, 12]);
  input[0]!.high = 11;
  input[0]!.low = 9;
  input[1]!.high = 13;
  input[1]!.low = 11;
  input[2]!.high = 12;
  input[2]!.low = 10;
  expect(atr(input, 2).slice(0, 3)).toEqual([null, null, 2.5]);
  expect(atr([...input, { ...input[3]!, high: 10000 }], 2).slice(0, 4)).toEqual(
    atr(input, 2),
  );
  input[1]!.close = NaN;
  expect(atr(input, 2)).toEqual([null, null, null, null]);
  expect(() => atr(input, 0)).toThrow(RangeError);
});

it("keeps configuration combinations explicit and versions source-backed management independently", () => {
  const fixed = selectResearchStrategy(spec, "dual-breakout-structure");
  expect(fixed.management).toBeUndefined();
  expect(researchSpecSchema.safeParse(fixed).success).toBe(true);
  expect(
    researchSpecSchema.safeParse({
      ...spec,
      strategy: "czsc",
      management: { stop: { kind: "structure", buffer: 0 } },
    }).success,
  ).toBe(false);
  expect(
    researchSpecSchema.safeParse({ ...spec, risk: undefined }).success,
  ).toBe(false);
  const changed = researchSpecSchema.parse({
    ...spec,
    management: { ...spec.management, stressBuffer: 0.1 },
  });
  expect(researchParamsFingerprint(changed)).not.toBe(
    researchParamsFingerprint(spec),
  );
  const saved = researchMethodSnapshot("dual-breakout", true);
  expect(
    saved.sources.some(
      (source) => source.path === "stop-loss/references/volatility-family.md",
    ),
  ).toBe(true);
  expect(() =>
    validateResearchMethod("dual-breakout", saved, true),
  ).not.toThrow();
  expect(() => validateResearchMethod("dual-breakout", saved)).toThrow(
    "方法版本",
  );
});

it("two closes trigger next-open sale; blocked sale survives recovery and stress reduces quantity", () => {
  const input = bars([10, 8.8, 8.7, 11, 11.2], [10, 10, 9, 7, 11]);
  const management = { ...spec.management, confirmations: 2 };
  const result = run(input, management, event, [dates[3]!]);
  expect(result.trades[0]).toMatchObject({
    quantity: 500,
    initialStop: 9,
    plannedRiskStop: 9,
    exitDate: dates[4],
    exitPrice: 11,
  });
  expect(
    result.attempts.some((row) => row.date === dates[3] && row.side === "sell"),
  ).toBe(true);
  const stressed = run(input, { ...management, stressBuffer: 0.1 });
  expect(stressed.trades[0]).toMatchObject({
    quantity: 200,
    initialStop: 9,
    plannedRiskStop: 8.1,
    exitDate: dates[3],
    exitPrice: 7,
  });
  expect(stressed.trades[0]!.profit).toBe(-600);
});

it("suspension breaks consecutive close confirmation, while missing ATR excludes instead of falling back", () => {
  const input = bars([10, 8.8, 8.7, 8.6, 8.5, 8.4], [10, 10, 9, 9, 9, 9]);
  input[2]!.volume = 0;
  const result = run(input, { ...spec.management, confirmations: 2 });
  expect(result.trades[0]!.exitDate).toBe(dates[5]);
  const atrStop = {
    ...spec.management,
    stop: { kind: "atr", period: 14, multiple: 2 },
  };
  expect(run(input, atrStop).excluded[0]!.reason).toContain("输入缺失");
  expect(
    run(input, atrStop, { ...event, stopAtr: 0.5 }).trades[0]!.initialStop,
  ).toBe(9);
  expect(
    researchInitialStop(
      researchManagementSchema.parse({
        stop: { kind: "structure", buffer: 0.01 },
      }),
      10,
      { initialStop: 9 },
    ),
  ).toBeCloseTo(8.91);
});

it("trailing lines become effective next session and never loosen; time exit respects T+1", () => {
  const input = bars([10, 10, 10, 9], [10, 10, 10, 9]);
  input[1]!.high = 14;
  const trailing = run(input, {
    ...spec.management,
    trail: { kind: "percent", fraction: 0.1 },
  });
  expect(trailing.trades[0]!.exitDate).toBe(dates[3]);
  expect(trailing.trades[0]!.stopHistory).toEqual([
    { date: dates[1], stop: 9, reason: "入场冻结" },
    { date: dates[1], stop: 12.6, reason: "收盘更新，下一交易日起生效" },
  ]);
  const timed = run(input, {
    ...spec.management,
    timeExit: { days: 1, minR: 0.5 },
  });
  expect(timed.trades[0]!.exitDate).toBe(dates[2]);
  expect(timed.trades[0]!.exitReason).toContain("进展不足");
});

it("ATR signal evidence is prefix-stable and uses the configured signal-day period", async () => {
  const input: Bar[] = Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i,
    close: 10 + i,
    high: 11 + i,
    low: 9 + i,
    volume: 100,
    amount: 1000,
  }));
  const ma = researchSpecSchema.parse({
    ...spec,
    strategy: "ma-cross",
    maParams: maParamsSchema.parse({}),
    start: input[61]!.date,
    end: input[69]!.date,
    validationStart: input[66]!.date,
    management: { stop: { kind: "atr", period: 14, multiple: 2 } },
  });
  const native = vi.fn(async () => {
    throw new Error("unexpected DLL");
  });
  const events = await researchSignals(event.symbol, input, ma, native);
  expect(events).toHaveLength(9);
  expect(events.every((row) => row.stopAtr === 2)).toBe(true);
  input[70]!.high = 10000;
  expect(await researchSignals(event.symbol, input, ma, native)).toEqual(
    events,
  );
  expect(native).not.toHaveBeenCalled();
});

it("chandelier uses holding highs and known ATR, records missing warmup, and never widens on a volatility jump", () => {
  const input = bars([10, 11, 11, 19, 18, 15], [10, 10, 11, 11, 18, 15]);
  [
    [12, 9],
    [12, 10],
    [20, 10],
    [20, 5],
    [19, 14],
  ].forEach(([high, low], i) => {
    input[i + 1]!.high = high!;
    input[i + 1]!.low = low!;
  });
  const result = run(input, {
    ...spec.management,
    stop: { kind: "percent", fraction: 0.2 },
    trail: { kind: "chandelier", period: 2, multiple: 1 },
  });
  const trade = result.trades[0]!;
  expect(trade.stopHistory!.map((row) => row.stop)).toEqual([8, 9.5, 14]);
  expect(trade.managementWarnings).toEqual([
    { date: dates[1], reason: "移动ATR缺失，保留上一有效止损线" },
  ]);
  expect(trade.exitDate).toBeNull();
});
