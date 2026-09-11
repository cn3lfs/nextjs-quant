import { beforeEach, expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";

const mocks = vi.hoisted(() => ({ page: vi.fn(), snapshot: vi.fn() }));
vi.mock("../src/server/tdx-quotes", () => ({ barPage: mocks.page }));
vi.mock("../src/server/tdx", () => ({ readSnapshot: mocks.snapshot }));
vi.mock("../src/server/settings", () => ({
  settings: () => ({ tdxRoot: "isolated-root" }),
}));
import { intradayHistory } from "../src/server/intraday-data";

beforeEach(() => {
  mocks.page.mockReset();
  mocks.snapshot.mockReset();
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
