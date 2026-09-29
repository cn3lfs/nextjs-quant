import { expect, it } from "vitest";
import {
  isTypingTarget,
  nextPeriod,
  periodFromCode,
} from "../../../src/components/market/chart-hotkeys";
import {
  keyboardCursor,
  keyboardPage,
} from "../../../src/lib/chart/chart-view";

it("TDX sprite period codes match exactly and case-insensitively", () => {
  expect(periodFromCode("d")).toBe("day");
  expect(periodFromCode(" W ")).toBe("week");
  expect(periodFromCode("mo")).toBe("month");
  expect(periodFromCode("M5")).toBe("5m");
  expect(periodFromCode("m15")).toBe("15m");
  expect(periodFromCode("M3")).toBe("30m");
  expect(periodFromCode("M6")).toBe("60m");
  // Securities and pinyin prefixes are not period commands.
  expect(periodFromCode("mou")).toBeNull();
  expect(periodFromCode("600519")).toBeNull();
  expect(periodFromCode("M1")).toBeNull();
});

it("F8 cycles every chart period and wraps", () => {
  const seen = ["day"];
  for (let i = 0; i < 7; i++) seen.push(nextPeriod(seen.at(-1) as never));
  expect(seen).toEqual([
    "day",
    "week",
    "month",
    "5m",
    "15m",
    "30m",
    "60m",
    "day",
  ]);
});

it("page keys only fire outside text fields and popups", () => {
  const within = (selector: string) => ({
    closest: (s: string) => (s.includes(selector) ? {} : null),
  });
  expect(isTypingTarget(within("input") as never)).toBe(true);
  expect(isTypingTarget(within("[role=listbox]") as never)).toBe(true);
  expect(isTypingTarget({ closest: () => null } as never)).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
});

it("cursor steps within loaded bars and scrolls only when leaving the view", () => {
  const range = { from: 10, to: 50 };
  // Fresh cursor lands on the last visible bar (logical 50 → index 250).
  expect(keyboardCursor(range, -1, null, 200, 399)).toEqual({
    index: 250,
    range: null,
  });
  expect(keyboardCursor(range, 1, 250, 200, 399)).toEqual({
    index: 251,
    range: { from: 11, to: 51 },
  });
  expect(keyboardCursor(range, -1, 210, 200, 399)).toEqual({
    index: 209,
    range: { from: 9, to: 49 },
  });
  // Clamped at both ends of the loaded bars.
  expect(keyboardCursor(range, -1, 200, 200, 399).index).toBe(200);
  expect(keyboardCursor({ from: 150, to: 199 }, 1, 399, 200, 399).index).toBe(
    399,
  );
});

it("PageUp/PageDown shift one screen; Home/End pin to the loaded ends", () => {
  const range = { from: 100, to: 150 };
  expect(keyboardPage(range, "PageUp", 180)).toEqual({ from: 50, to: 100 });
  expect(keyboardPage(range, "PageDown", 180)).toEqual({ from: 150, to: 200 });
  expect(keyboardPage(range, "Home", 180)).toEqual({ from: 0, to: 50 });
  expect(keyboardPage(range, "End", 180)).toEqual({ from: 129, to: 179 });
  expect(keyboardPage(range, "Enter", 180)).toBeNull();
});
