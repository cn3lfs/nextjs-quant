import { expect, it } from "vitest";
import {
  researchInitialStop,
  researchManagementSchema,
} from "../../../src/lib/research/workflow/research-management";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
import { selectResearchStrategy } from "../../../src/components/research/research-strategy-fields";
import { researchSignals } from "../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../src/server/backtest/research-portfolio";
import { analyzeBreakout } from "../../../src/server/strategies/breakout/breakout";
import { atr } from "../../../src/lib/indicators";
const management = researchManagementSchema.parse({
  stop: { kind: "structure-atr", period: 14, multiple: 0.3 },
});
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2024-01-01",
  end: "2024-12-31",
  validationStart: "2024-10-01",
  risk: { fraction: 0.01, maxWeight: 0.2 },
  management,
});
it("allows exactly 2ATR but permanently cancels the signal after a wider entry gap", () => {
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
  const selected = researchSpecSchema.parse({
    ...spec,
    start: dates[0],
    end: dates[3],
    validationStart: dates[3],
    initialCapital: 1000000,
    management: {
      ...management,
      stop: { ...management.stop, maxDistanceAtr: 2 },
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event = {
    symbol: "sh600000",
    observedDate: dates[0]!,
    endpointDate: dates[0]!,
    key: "fixture",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development" as const,
    initialStop: 96.6,
    stopAtr: 2,
  };
  const run = (entry: number, limited = true) =>
    researchPortfolio(
      limited ? selected : { ...selected, management },
      [event],
      dates,
      new Map([
        [
          event.symbol,
          dates.map((date, i) => {
            const price = i === 1 ? entry : i > 1 ? 99 : 100;
            return {
              date,
              open: price,
              close: price,
              high: price + 1,
              low: price - 1,
              volume: 10000,
              amount: 1000000,
            };
          }),
        ],
      ]),
      () => ({
        evidence: "fixture",
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        tradable: true,
        limitUp: null,
        limitDown: null,
      }),
    );
  expect(run(100).trades[0]!.initialStop).toBeCloseTo(96);
  const rejected = run(100.01);
  expect(rejected.trades).toEqual([]);
  expect(rejected.excluded[0]!.reason).toContain("超过2倍信号日ATR");
  expect(run(100.01, false).trades).toHaveLength(1);
  expect(researchMethodSnapshot(selected)).toHaveProperty(
    "structureDistance.version",
    "research-structure-distance-1",
  );
  expect(researchMethodSnapshot(spec)).not.toHaveProperty("structureDistance");
});
it.each([
  "structure-atr",
  "max-distance",
  "nearest-stop",
  "auto-atr",
  "auto-percent",
] as const)(
  "freezes actual breakout structure and signal ATR before sizing the next entry: %s",
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
    Object.assign(bars[140]!, {
      open: 140,
      close: 151,
      high: 152,
      low: 139,
      volume: 30000,
    });
    for (let i = 141; i < 145; i++)
      Object.assign(bars[i]!, { open: 151, close: 151, high: 152, low: 150 });
    const selected = researchSpecSchema.parse({
      ...spec,
      start: bars[140]!.date,
      end: bars[144]!.date,
      validationStart: bars[143]!.date,
      initialCapital: 1000000,
      risk: { fraction: 0.01, maxWeight: 1 },
      management:
        kind === "max-distance" || kind === "nearest-stop"
          ? researchManagementSchema.parse({
              stop: {
                kind,
                fraction: 0.05,
                period: 14,
                multiple: 1.5,
                structureBuffer: 0.3,
              },
            })
          : kind === "auto-atr" || kind === "auto-percent"
            ? researchManagementSchema.parse({
                stop: {
                  kind: "structure-auto",
                  ...(kind === "auto-atr" ? { atrPeriod: 14 } : {}),
                  atrMultiple: 0.3,
                  percentBuffer: 0.005,
                },
              })
            : management,
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
    const events = await researchSignals("sh600000", bars, selected, native);
    const event = events.find((e) => e.observedDate === bars[140]!.date)!;
    expect(event).toBeDefined();
    expect(event.initialStop).toBe(
      analyzeBreakout(bars.slice(0, 141), 0).points[140]!.long.risk.stop!.price,
    );
    if (kind === "auto-percent") expect(event).not.toHaveProperty("stopAtr");
    else expect(event.stopAtr).toBe(atr(bars, 14)[140]);
    const changed = bars.map((b, i) =>
      i > 140 ? { ...b, high: b.high * 2 } : b,
    );
    expect(
      (await researchSignals("sh600000", changed, selected, native)).find(
        (e) => e.observedDate === event.observedDate,
      ),
    ).toEqual(event);
    const rules = {
      evidence: "fixture",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      tradable: true,
      limitUp: null,
      limitDown: null,
    };
    const run = (input = event) =>
      researchPortfolio(
        selected,
        [input],
        bars.map((b) => b.date),
        new Map([[event.symbol, bars]]),
        () => rules,
      );
    const trade = run().trades[0]!;
    const structure =
      kind === "auto-percent"
        ? event.initialStop! * 0.995
        : event.initialStop! - 0.3 * event.stopAtr!;
    const stop =
      kind === "max-distance" || kind === "nearest-stop"
        ? (kind === "nearest-stop" ? Math.max : Math.min)(
            151 * 0.95,
            151 - 1.5 * event.stopAtr!,
            structure,
          )
        : structure;
    expect(trade.initialStop).toBe(stop);
    if (kind === "max-distance" || kind === "nearest-stop")
      expect(trade.initialStopCandidates).toEqual([
        { kind: "percent", price: 151 * 0.95 },
        { kind: "atr", price: 151 - 1.5 * event.stopAtr! },
        { kind: "structure", price: structure },
      ]);
    else expect(trade).not.toHaveProperty("initialStopCandidates");
    expect(trade.entryDate).toBe(bars[141]!.date);
    expect(trade.quantity).toBe(Math.floor(10000 / (151 - stop) / 100) * 100);
    if (kind === "auto-percent")
      expect(run({ ...event, stopAtr: null }).trades[0]!.initialStop).toBe(
        stop,
      );
    else expect(run({ ...event, stopAtr: null }).trades).toEqual([]);
  },
);
it("subtracts signal ATR from the frozen structure rather than from the entry", () => {
  expect(
    researchInitialStop(management, 100, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(
    researchInitialStop(management, 105, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(
    researchInitialStop(management, 94, { initialStop: 95, stopAtr: 2 }),
  ).toBeNull();
  for (const evidence of [
    { initialStop: 95 },
    { stopAtr: 2 },
    { initialStop: 95, stopAtr: 0 },
    { initialStop: 95, stopAtr: NaN },
    { initialStop: 0.1, stopAtr: 2 },
  ])
    expect(researchInitialStop(management, 100, evidence)).toBeNull();
});
it("restricts structure evidence to supported signals and clears it when changing family", () => {
  expect(
    researchSpecSchema.safeParse({ ...spec, strategy: "ma-cross" }).success,
  ).toBe(false);
  expect(selectResearchStrategy(spec, "ma-cross").management?.stop.kind).toBe(
    "percent",
  );
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "structureAtr.version",
    "research-structure-atr-1",
  );
  expect(
    researchMethodSnapshot({
      ...spec,
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("structureAtr");
});
