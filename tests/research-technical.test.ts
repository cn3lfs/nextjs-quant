import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  technicalDecision,
  technicalStrategyIds,
  researchTechnicalSeries,
  type TechnicalValues,
  type LegacyTechnicalStrategyId,
} from "../src/lib/research-technical";
import { ma, macd, kdj, rsi, boll } from "../src/lib/indicators";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import type { ResearchExecutionRules } from "../src/lib/research-execution";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

const values = (input: Partial<TechnicalValues>): TechnicalValues => ({
  close: null,
  ma5: null,
  ma10: null,
  ma20: null,
  ma60: null,
  dif: null,
  dea: null,
  histogram: null,
  k: null,
  d: null,
  rsi6: null,
  middle: null,
  upper: null,
  lower: null,
  ...input,
});
const examples: [
  LegacyTechnicalStrategyId,
  Partial<TechnicalValues>,
  Partial<TechnicalValues>,
  Partial<TechnicalValues>,
  Partial<TechnicalValues>,
][] = [
  [
    "ma-golden-5-10",
    { ma5: 10, ma10: 10 },
    { ma5: 11, ma10: 10 },
    { ma5: 10, ma10: 10 },
    { ma5: 9, ma10: 10 },
  ],
  [
    "ma-golden-10-20",
    { ma10: 10, ma20: 10 },
    { ma10: 11, ma20: 10 },
    { ma10: 10, ma20: 10 },
    { ma10: 9, ma20: 10 },
  ],
  [
    "ma-golden-20-60",
    { ma20: 10, ma60: 10 },
    { ma20: 11, ma60: 10 },
    { ma20: 10, ma60: 10 },
    { ma20: 9, ma60: 10 },
  ],
  [
    "ma-alignment",
    { ma5: 10, ma10: 10, ma20: 10, ma60: 10 },
    { ma5: 13, ma10: 12, ma20: 11, ma60: 10 },
    { ma5: 13, ma10: 12, ma20: 11, ma60: 10 },
    { ma5: 12, ma10: 12, ma20: 11, ma60: 10 },
  ],
  [
    "macd-golden",
    { dif: 1, dea: 1 },
    { dif: 2, dea: 1 },
    { dif: 1, dea: 1 },
    { dif: 0, dea: 1 },
  ],
  [
    "macd-golden-positive",
    { dif: 1, dea: 1 },
    { dif: 2, dea: 1 },
    { dif: 1, dea: 1 },
    { dif: 0, dea: 1 },
  ],
  [
    "kdj-golden",
    { k: 50, d: 50 },
    { k: 51, d: 50 },
    { k: 50, d: 50 },
    { k: 49, d: 50 },
  ],
  [
    "kdj-extreme",
    { k: 10, d: 10 },
    { k: 15, d: 10 },
    { k: 90, d: 90 },
    { k: 85, d: 90 },
  ],
  [
    "kdj-macd-confirmed",
    { k: 50, d: 50, dif: 0, dea: 1 },
    { k: 51, d: 50, dif: 2, dea: 1 },
    { k: 51, d: 50, dif: 2, dea: 1 },
    { k: 52, d: 50, dif: 0, dea: 1 },
  ],
  ["rsi-recovery", { rsi6: 30 }, { rsi6: 31 }, { rsi6: 70 }, { rsi6: 69 }],
  ["rsi-50-cross", { rsi6: 50 }, { rsi6: 51 }, { rsi6: 50 }, { rsi6: 49 }],
  [
    "boll-middle-cross",
    { close: 100, middle: 100 },
    { close: 101, middle: 100 },
    { close: 100, middle: 100 },
    { close: 99, middle: 100 },
  ],
  [
    "boll-band-recovery",
    { close: 90, lower: 90, upper: 110 },
    { close: 95, lower: 90, upper: 110 },
    { close: 110, lower: 90, upper: 110 },
    { close: 105, lower: 90, upper: 110 },
  ],
];
it.each(examples)(
  "%s enters/exits on hand-worked crossings, without unrelated indicator requirements",
  (id, beforeBuy, buy, beforeSell, sell) => {
    expect(technicalDecision(id, values(buy), values(beforeBuy))).toMatchObject(
      { entry: true, exit: false, reason: null },
    );
    expect(
      technicalDecision(id, values(sell), values(beforeSell)),
    ).toMatchObject({ entry: false, exit: true, reason: null });
    expect(technicalDecision(id, values(buy), values(buy))).toMatchObject({
      entry: false,
      exit: false,
    });
    expect(technicalDecision(id, values(buy), undefined).reason).not.toBeNull();
  },
);
it("requires strict current zones and MACD direction, and does not call every shrinking histogram a fresh turn", () => {
  expect(
    technicalDecision(
      "macd-golden-positive",
      values({ dif: 0, dea: -1 }),
      values({ dif: -2, dea: -1 }),
    ).entry,
  ).toBe(false);
  expect(
    technicalDecision(
      "macd-golden",
      values({ dif: 0, dea: -1 }),
      values({ dif: -2, dea: -1 }),
    ).entry,
  ).toBe(true);
  expect(
    technicalDecision(
      "kdj-extreme",
      values({ k: 20, d: 15 }),
      values({ k: 10, d: 15 }),
    ).entry,
  ).toBe(false);
  expect(
    technicalDecision(
      "kdj-extreme",
      values({ k: 80, d: 85 }),
      values({ k: 90, d: 85 }),
    ).exit,
  ).toBe(false);
  expect(
    technicalDecision(
      "kdj-macd-confirmed",
      values({ k: 51, d: 50, dif: 0, dea: 1 }),
      values({ k: 49, d: 50, dif: 0, dea: 1 }),
    ).entry,
  ).toBe(false);
  expect(
    technicalDecision(
      "macd-histogram-turn",
      values({ histogram: -1.5 }),
      values({ histogram: -2 }),
      values({ histogram: -1 }),
    ),
  ).toMatchObject({ entry: true, exit: false });
  expect(
    technicalDecision(
      "macd-histogram-turn",
      values({ histogram: 2 }),
      values({ histogram: 3 }),
      values({ histogram: 2 }),
    ),
  ).toMatchObject({ entry: false, exit: true });
  expect(
    technicalDecision(
      "macd-histogram-turn",
      values({ histogram: -1 }),
      values({ histogram: -2 }),
      values({ histogram: -3 }),
    ).entry,
  ).toBe(false);
  expect(
    technicalDecision(
      "macd-histogram-turn",
      values({ histogram: 1 }),
      values({ histogram: 2 }),
      values({ histogram: 3 }),
    ).exit,
  ).toBe(false);
});

function bars(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: close,
    close,
    high: close + 1,
    low: close - 1,
    volume: 10000,
    amount: close * 10000,
  }));
}
const oscillating = bars(
  Array.from(
    { length: 160 },
    (_, i) => 100 + i * 0.1 + 10 * Math.sin((i * Math.PI) / 16),
  ),
);
it("uses the shared indicators and preserves every past decision under prefix replay and a future outlier", () => {
  for (const id of technicalStrategyIds) {
    const whole = researchTechnicalSeries(id, oscillating);
    for (const end of [62, 80, 101])
      expect(researchTechnicalSeries(id, oscillating.slice(0, end))).toEqual(
        whole.slice(0, end),
      );
    const future = bars([...oscillating.map((bar) => bar.close), 10000]);
    expect(researchTechnicalSeries(id, future).slice(0, 160)).toEqual(whole);
  }
  const at = 80,
    point = researchTechnicalSeries("ma-golden-5-10", oscillating)[at]!.values;
  expect(point.ma5).toBe(ma(oscillating, 5)[at]);
  expect(point.dif).toBe(macd(oscillating)[at]!.dif);
  expect("k" in point ? point.k : undefined).toBe(kdj(oscillating)[at]!.k);
  expect(point.rsi6).toBe(rsi(oscillating)[at]!.rsi6);
  expect("upper" in point ? point.upper : undefined).toBe(
    boll(oscillating)[at]!.upper,
  );
});

const native = vi.fn(async () => {
  throw new Error("native must not run");
});
const rules: ResearchExecutionRules = {
  evidence: "synthetic",
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
const input = bars([
  ...Array<number>(61).fill(100),
  110,
  111,
  110,
  110,
  110,
  80,
  80,
  70,
  90,
  90,
]);
const spec = researchSpecSchema.parse({
  strategy: "ma-golden-5-10",
  start: input[61]!.date,
  end: input[70]!.date,
  validationStart: input[69]!.date,
  holdingDays: 60,
  maxPositions: 1,
  initialCapital: 100000,
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});

it("executes actual cross events and completed-close exits on the next open, retaining reverse evidence", async () => {
  const events = await researchSignals("sh600000", input, spec, native);
  expect(events[0]!.observedDate).toBe(input[61]!.date);
  expect(JSON.parse(events[0]!.evidence).values.ma5).toBe(102);
  const result = researchPortfolio(
    spec,
    events,
    input.map((b) => b.date),
    new Map([["sh600000", input]]),
    () => rules,
  );
  const trade = result.trades[0]!;
  expect(trade.entryDate).toBe(input[62]!.date);
  expect(trade.entryPrice).toBe(111);
  expect(trade.signalExit!.date).toBe(input[67]!.date);
  const exitValues = trade.signalExit!.values;
  if (!("ma5" in exitValues)) throw new Error("wrong rule family");
  expect(exitValues.ma5).toBe(98);
  expect(trade.exitDate).toBe(input[68]!.date);
  expect(trade.exitPrice).toBe(70);
  expect(trade.exitReason).toContain("技术指标退出");
  expect(trade.profit).toBe(-36900);
  expect(native).not.toHaveBeenCalled();
  expect(researchMethodSnapshot(spec).sources[0]!.path).toBe(
    "swing-trader/references/technical-indicators.md",
  );
});

it("keeps an unfilled exit despite later recovery and cancels a blocked buy after a reverse signal", async () => {
  const events = await researchSignals("sh600000", input, spec, native);
  const pending = researchPortfolio(
    { ...spec, end: input[68]!.date },
    events,
    input.map((b) => b.date),
    new Map([["sh600000", input]]),
    (_, date) =>
      date === input[68]!.date ? { ...rules, limitDown: 70 } : rules,
  );
  expect(pending.trades[0]!.exitDate).toBeNull();
  expect(pending.pendingSales).toHaveLength(1);
  const later = researchPortfolio(
    spec,
    events,
    input.map((b) => b.date),
    new Map([["sh600000", input]]),
    (_, date) =>
      date === input[68]!.date ? { ...rules, limitDown: 70 } : rules,
  );
  expect(later.trades[0]!.exitDate).toBe(input[69]!.date);
  expect(later.trades[0]!.signalExit!.date).toBe(input[67]!.date);
  const blocked = researchPortfolio(
    { ...spec, entryMaxWait: 20 },
    events,
    input.map((b) => b.date),
    new Map([["sh600000", input]]),
    (_, date) => (date < input[68]!.date ? { ...rules, limitUp: 10 } : rules),
  );
  expect(blocked.trades).toEqual([]);
  expect(
    blocked.excluded.some((row) => row.reason.includes("反向指标信号")),
  ).toBe(true);
});

it("rejects unavailable evidence rather than treating it as an indicator crossing", async () => {
  const invalid = input.map((bar, i) =>
    i === 61 ? { ...bar, volume: 0 } : bar,
  );
  const rows = researchTechnicalSeries("ma-golden-5-10", invalid);
  expect(rows[61]!.reason).toContain("停牌");
  expect(rows[62]!.reason).toContain("停牌");
  expect(rows[61]!.entry).toBe(false);
  const result = researchPortfolio(
    spec,
    [],
    input.map((b) => b.date),
    new Map([["sh600000", invalid]]),
    () => rules,
  );
  expect(result.signalGaps).toHaveLength(2);
  await expect(
    researchSignals(
      "sh600000",
      bars(Array<number>(71).fill(100)),
      { ...spec, strategy: "rsi-recovery" },
      native,
    ),
  ).rejects.toThrow("没有可用技术指标");
});

it("runs technical entries and exits through independent research partitions, isolating a bad stock", async () => {
  const fullSpec = researchSpecSchema.parse({
    ...spec,
    start: oscillating[61]!.date,
    validationStart: oscillating[110]!.date,
    end: oscillating[159]!.date,
    symbols: ["sh600000", "sh600001"],
    management: { stop: { kind: "percent", fraction: 0.5 } },
    risk: { fraction: 0.1, maxWeight: 1 },
  });
  const invalid = oscillating.map((bar, i) =>
    i === 90 ? { ...bar, date: oscillating[89]!.date } : bar,
  );
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: fullSpec.symbols!,
      source: null,
      warning: "synthetic",
    },
    benchmark: { symbol: "sh000001", bars: oscillating },
    calendar: oscillating.map((bar) => bar.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars: oscillating,
        hash: researchHash(oscillating),
        actions: [],
      },
      {
        symbol: "sh600001",
        name: "invalid fixture",
        bars: invalid,
        hash: researchHash(invalid),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(fullSpec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: fullSpec.symbols!.map((symbol) => ({
      symbol,
      start: fullSpec.start,
      end: fullSpec.end,
      evidenceId: "fixture",
    })),
    rows: fullSpec.symbols!.flatMap((symbol) =>
      oscillating.map((bar) => ({
        symbol,
        date: bar.date,
        ...rules,
        evidenceId: "fixture",
      })),
    ),
  });
  const result = await runStrategyResearch(fullSpec, dataset, evidence, native);
  expect(
    result.exclusions.some(
      (row) => row.symbol === "sh600001" && row.reason.includes("日期"),
    ),
  ).toBe(true);
  for (const partition of result.partitions) {
    expect(
      partition.simulation!.trades.some(
        (trade) => trade.signalExit && trade.exitDate,
      ),
    ).toBe(true);
    expect(
      partition.simulation!.trades.every(
        (trade) => trade.event.symbol === "sh600000",
      ),
    ).toBe(true);
    expect(partition.simulation!.nav[0]!.cash).toBe(fullSpec.initialCapital);
  }
  expect(result.method).toEqual(dataset.method);
  expect(native).not.toHaveBeenCalled();
});

it("respects independent sell limits across days and rejects absent sell evidence before entry", async () => {
  const events = await researchSignals("sh600000", input, spec, native);
  const limited = researchPortfolio(
    spec,
    events,
    input.map((bar) => bar.date),
    new Map([["sh600000", input]]),
    () => ({ ...rules, maximumSell: 100 }),
  );
  expect(limited.trades[0]!.sales!.map((sale) => sale.quantity)).toEqual([
    100, 100, 100,
  ]);
  expect(limited.trades[0]!.remainingQuantity).toBe(600);
  expect(limited.trades[0]!.exitDate).toBeNull();
  expect(limited.pendingSales![0]!.remainingQuantity).toBe(600);
  const missing = researchPortfolio(
    spec,
    events,
    input.map((bar) => bar.date),
    new Map([["sh600000", input]]),
    () => ({ ...rules, minimumSell: undefined }),
  );
  expect(missing.trades).toEqual([]);
  expect(missing.excluded[0]!.reason).toContain("卖出数量规则");
});
