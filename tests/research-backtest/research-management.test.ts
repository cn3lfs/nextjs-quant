import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { atr } from "../../src/lib/indicators";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";

const dates = Array.from(
  { length: 8 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
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

it("applies the configured buffer to an explicit structure stop", () => {
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
