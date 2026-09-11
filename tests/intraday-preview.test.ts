import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  previewBars,
  previewConfirmation,
  previewSlots,
} from "../src/lib/intraday-preview";

const price = {
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
  amount: 1000,
};
function sample() {
  const daily: Bar[] = Array.from({ length: 61 }, (_, i) => ({
    ...price,
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
  }));
  return {
    date: "2024-03-04",
    previousTradingDay: daily.at(-1)!.date,
    cutoff: "14:40",
    observedAt: Date.parse("2024-03-04T14:40:01+08:00"),
    daily,
    minutes: previewSlots("14:40").map((time) => ({
      ...price,
      date: `2024-03-04T${time}:00+08:00`,
    })),
  };
}

it("uses the captured prefix, excludes lunch, and never reads today's completed daily bar", () => {
  const input = sample();
  expect(previewSlots("11:30")).toHaveLength(24);
  expect(previewSlots("15:00")).toHaveLength(48);
  const result = previewBars(input);
  expect(result.at(-1)).toEqual({
    ...price,
    date: input.date,
    volume: 4400,
    amount: 44000,
  });
  input.daily.push({ ...price, date: input.date, high: 900 });
  input.minutes.push({
    ...price,
    date: `${input.date}T14:45:00+08:00`,
    high: 999,
  });
  expect(previewBars(input)).toEqual(result);
  expect(input.daily[0]).not.toBe(result[0]);
});

it("rejects stale, incomplete, duplicated and invalid inputs rather than filling gaps", () => {
  const missing = sample();
  missing.minutes.splice(5, 1);
  expect(() => previewBars(missing)).toThrow("不连续");
  const duplicate = sample();
  duplicate.minutes[5] = duplicate.minutes[4]!;
  expect(() => previewBars(duplicate)).toThrow("不连续");
  const stale = sample();
  stale.daily.pop();
  expect(() => previewBars(stale)).toThrow("历史日线");
  const invalid = sample();
  invalid.minutes[0]!.volume = NaN;
  expect(() => previewBars(invalid)).toThrow("不连续");
  const future = sample();
  future.observedAt -= 60000;
  expect(() => previewBars(future)).toThrow("时点");
  expect(() => previewSlots("12:00")).toThrow();
  expect(() => previewSlots("14:43")).toThrow();
});

it("keeps unavailable close data distinct from a withdrawn preview", () => {
  expect(previewConfirmation("buy:1", null)).toBe("unavailable");
  expect(previewConfirmation("buy:1", [])).toBe("withdrawn");
  expect(previewConfirmation("buy:1", ["buy:1"])).toBe("confirmed");
});
