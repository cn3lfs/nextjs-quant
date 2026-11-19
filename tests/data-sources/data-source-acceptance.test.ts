import { expect, it } from "vitest";
import { chartSymbolSchema } from "~/lib/chart/chart-symbol";
import { chartPeriodSchema, isMinutePeriod } from "~/lib/chart/chart-view";
import {
  sourceAcceptanceSamples,
  sourceAcceptancePeriods,
  validateWestockBatch,
} from "../helpers/data-source-acceptance";
const rows = ["2026-09-10", "2026-09-11", "2026-09-14"].map((date) => ({
  symbol: "sh000001",
  date,
  open: 10,
  last: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
}));
it("covers at least the required representative assets and periods", () => {
  const requiredAssets = {
    "sh-main": /^sh60\d{4}$/,
    "sz-main": /^sz00\d{4}$/,
    chinext: /^sz30\d{4}$/,
    star: /^sh68\d{4}$/,
    beijing: /^bj(?:43|83|87|88|92)\d{4}$/,
    index: /^(?:sh000|sz399)\d{3}$/,
    sector: /^(?:pt|emBK)/,
    etf: /^(?:sh(?:51|56|58)\d{4}|sz159\d{3})$/,
  };
  for (const [kind, symbolPattern] of Object.entries(requiredAssets))
    expect(
      sourceAcceptanceSamples.some(
        (sample) => sample.kind === kind && symbolPattern.test(sample.symbol),
      ),
      kind,
    ).toBe(true);

  const symbols = sourceAcceptanceSamples.map(({ symbol }) => symbol);
  expect(new Set(symbols).size).toBe(symbols.length);
  for (const sample of sourceAcceptanceSamples) {
    expect(
      chartSymbolSchema.safeParse(sample.symbol).success,
      sample.symbol,
    ).toBe(true);
    expect(sample.name.trim()).not.toBe("");
  }
  expect(sourceAcceptancePeriods).toEqual(
    expect.arrayContaining(["day", "week", "5m"]),
  );
  for (const period of sourceAcceptancePeriods)
    expect(chartPeriodSchema.safeParse(period).success, period).toBe(true);
});

it.each(sourceAcceptancePeriods)(
  "matches each requested security to its %s bars",
  (period) => {
    const symbols = sourceAcceptanceSamples.map(({ symbol }) => symbol);
    const batch = symbols.flatMap((symbol, index) =>
      rows.map((row) => ({
        ...row,
        symbol,
        date: isMinutePeriod(period) ? `${row.date} 09:35` : row.date,
        volume: index + 1,
      })),
    );
    const result = validateWestockBatch(batch.reverse(), symbols, period);
    expect(result).toHaveLength(symbols.length);
    for (const [index, symbol] of symbols.entries()) {
      expect(result[index]).toMatchObject({
        symbol,
        ok: true,
        count: rows.length,
        latest: {
          date: isMinutePeriod(period)
            ? "2026-09-14T09:35:00+08:00"
            : "2026-09-14",
          volume: index + 1,
        },
      });
    }
  },
);
it("detects the observed mixed-batch ETF omission despite other successful rows", () => {
  const result = validateWestockBatch(rows, ["sh000001", "sh510300"], "day");
  expect(result[0]?.ok).toBe(true);
  expect(result[1]).toEqual({
    symbol: "sh510300",
    ok: false,
    reason: "批量响应遗漏品种",
  });
});
it("rejects wrong identities, duplicated dates and invalid OHLC", () => {
  expect(() => validateWestockBatch(rows, ["sh510300"], "day")).toThrow("身份");
  expect(
    validateWestockBatch([rows[0], rows[0], rows[1]], ["sh000001"], "day")[0]
      ?.ok,
  ).toBe(false);
  expect(
    validateWestockBatch(
      rows.map((r) => ({ ...r, high: 1 })),
      ["sh000001"],
      "day",
    )[0]?.ok,
  ).toBe(false);
});
