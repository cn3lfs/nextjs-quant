import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchSepaElite } from "trading-strategies/research/canslim/research-sepa-elite";
it("retains exact 21-day/20-percent boundaries, no late activation, no missing calendar repair", () => {
  const { bars, dates, input } = eliteInput();
  const entry = { entryDate: dates[1]!, entryPrice: 100 };
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toMatchObject({
    elapsed: 21,
    holdUntil: dates[57],
  });
  expect(researchSepaElite(entry, dates[23]!, dates, input)).toBeNull();
  bars[22]!.close = 119.999;
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toBeNull();
  bars[22]!.close = 120;
  input.delete(dates[10]!);
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toBeNull();
});

function eliteInput() {
  const bars: Bar[] = Array.from({ length: 65 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: i < 3 ? 100 : 120,
    close: i < 2 ? 100 : 120,
    high: 121,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
  const dates = bars.map((b) => b.date),
    input = new Map(bars.map((b) => [b.date, b]));
  return { bars, dates, input };
}
