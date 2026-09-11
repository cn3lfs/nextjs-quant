import { beforeEach, expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  snapshot: vi.fn(),
  increments: vi.fn(() => [] as unknown[]),
}));
vi.mock("../src/server/tdx-daily-cache", () => ({
  readDailyIncrementRange: mocks.increments,
}));
vi.mock("../src/server/tdx-quotes", () => ({ barPage: mocks.page }));
vi.mock("../src/server/tdx", () => ({ readSnapshot: mocks.snapshot }));
vi.mock("../src/server/settings", () => ({
  settings: () => ({ tdxRoot: "isolated-root" }),
}));
import { intradayHistory } from "../src/server/intraday-data";

beforeEach(() => {
  mocks.page.mockReset();
  mocks.snapshot.mockReset();
  mocks.increments.mockReset().mockReturnValue([]);
});

it("uses published daily increments with version evidence while retaining minute inputs", async () => {
  const revised = { ...bars.at(-1)!, close: 12, high: 12 };
  mocks.increments.mockReturnValue([
    { snapshot: { id: "increment-version" }, record: { bar: revised } },
  ]);
  mocks.snapshot
    .mockResolvedValueOnce({
      symbol: "sh600000",
      source: "tdx-local",
      period: "day",
      adjustment: "none",
      hash: "base",
      bars,
      createdAt: 10,
    })
    .mockResolvedValueOnce({ bars: [], createdAt: 11 });
  const history = await intradayHistory("tdx-local", "sh600000");
  expect(history.daily.at(-1)?.close).toBe(12);
  expect(history.sourceVersions).toEqual(["increment-version"]);
  expect(history.minutes).toEqual([]);
  expect(bars.at(-1)?.close).toBe(10);
});
const bars: Bar[] = Array.from({ length: 801 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  high: 10,
  low: 10,
  close: 10,
  volume: 1,
  amount: 10,
}));

it("reads all online daily pages without mixing local history", async () => {
  mocks.page
    .mockResolvedValueOnce(bars.slice(1))
    .mockResolvedValueOnce(bars.slice(0, 1))
    .mockResolvedValueOnce([]);
  const result = await intradayHistory("tdx-7709", "sh600000");
  expect(result.daily).toEqual(bars);
  expect(mocks.page.mock.calls).toEqual([
    ["sh600000", "day", 0, 800],
    ["sh600000", "day", 800, 800],
    ["sh600000", "5m", 0, 800],
  ]);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

it("rejects overlapping online pages instead of accepting a repeating server page", async () => {
  mocks.page.mockResolvedValue(bars.slice(1));
  await expect(intradayHistory("tdx-7709", "sh600000")).rejects.toThrow(
    "分页重叠",
  );
  expect(mocks.page).toHaveBeenCalledTimes(2);
});

it("keeps local data local and propagates missing intraday files", async () => {
  mocks.snapshot
    .mockResolvedValueOnce({ bars, createdAt: 10 })
    .mockRejectedValueOnce(new Error("missing lc5"));
  await expect(intradayHistory("tdx-local", "sh600000")).rejects.toThrow(
    "missing lc5",
  );
  expect(mocks.page).not.toHaveBeenCalled();
  await expect(intradayHistory("tdx-local", "bj920748")).rejects.toThrow(
    "沪深",
  );
});
