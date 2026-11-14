import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import {
  technicalDecision,
  type TechnicalValues,
  type LegacyTechnicalStrategyId,
} from "trading-strategies/research/technical/research-legacy-technical";
import {
  technicalStrategyIds,
  researchTechnicalSeries,
} from "trading-strategies/research/technical/research-technical";
import { ma, macd, kdj, rsi, boll } from "../../../src/lib/indicators";

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
    const whole = researchTechnicalSeries(
      id,
      oscillating,
      undefined,
      researchFormulaRuntime,
    );
    for (const end of [62, 80, 101])
      expect(
        researchTechnicalSeries(
          id,
          oscillating.slice(0, end),
          undefined,
          researchFormulaRuntime,
        ),
      ).toEqual(whole.slice(0, end));
    const future = bars([...oscillating.map((bar) => bar.close), 10000]);
    expect(
      researchTechnicalSeries(
        id,
        future,
        undefined,
        researchFormulaRuntime,
      ).slice(0, 160),
    ).toEqual(whole);
  }
  const at = 80,
    point = researchTechnicalSeries(
      "ma-golden-5-10",
      oscillating,
      undefined,
      researchFormulaRuntime,
    )[at]!.values;
  expect(point.ma5).toBe(ma(oscillating, 5)[at]);
  expect(point.dif).toBe(macd(oscillating)[at]!.dif);
  expect("k" in point ? point.k : undefined).toBe(kdj(oscillating)[at]!.k);
  expect(point.rsi6).toBe(rsi(oscillating)[at]!.rsi6);
  expect("upper" in point ? point.upper : undefined).toBe(
    boll(oscillating)[at]!.upper,
  );
});

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
it("rejects unavailable evidence rather than treating it as an indicator crossing", () => {
  const invalid = input.map((bar, i) =>
    i === 61 ? { ...bar, volume: 0 } : bar,
  );
  const rows = researchTechnicalSeries(
    "ma-golden-5-10",
    invalid,
    undefined,
    researchFormulaRuntime,
  );
  expect(rows[61]!.reason).toContain("停牌");
  expect(rows[62]!.reason).toContain("停牌");
  expect(rows[61]!.entry).toBe(false);
});
