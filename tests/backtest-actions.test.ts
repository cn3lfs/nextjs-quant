import { expect, it, vi } from "vitest";
vi.mock("../src/server/data-sources/tdx/tdx-gbbq", () => ({
  readGbbq: vi.fn(),
}));
import { readGbbq } from "../src/server/data-sources/tdx/tdx-gbbq";
import {
  actionReview,
  readBacktestActions,
} from "../src/server/backtest/backtest-actions";
import type { Snapshot } from "../src/lib/domain";
const source: Snapshot = {
  id: "s",
  symbol: "sh600000",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  hash: "h",
  createdAt: 1,
  bars: ["2025-01-01", "2025-01-31"].map((date) => ({
    date,
    open: 10,
    close: 10,
    high: 11,
    low: 9,
    volume: 100,
    amount: 1000,
  })),
};
const metadata = { file: "fixture/gbbq", modified: 1, fetchedAt: 2 };
const event = {
  date: "2025-01-10",
  category: 1,
  name: "除权除息",
  dividend: 0.1,
  rightsPrice: 0,
  bonusRatio: 0,
  rightsRatio: 0,
};
it("archives only the requested interval and preserves source input and per-share amounts", () => {
  const input = [
    event,
    { ...event, date: "2025-02-01" },
    { ...event, date: "2024-12-31" },
  ];
  const before = structuredClone(input),
    result = actionReview(source, input, metadata);
  expect(result.events).toEqual([event]);
  expect(input).toEqual(before);
  expect(result.status).toBe("partial");
  expect(result.warnings.join(" ")).toContain("尚未计入");
  expect(actionReview(source, [event], metadata).source!.hash).toBe(
    result.source!.hash,
  );
  expect(
    actionReview(source, [{ ...event, dividend: 0.2 }], metadata).source!.hash,
  ).not.toBe(result.source!.hash);
});
it("rejects invalid dates, missing dividend fields, duplicates and nonfinite amounts", () => {
  for (const invalid of [
    { ...event, date: "2025-02-30" },
    { ...event, dividend: undefined },
    { ...event, dividend: Infinity },
    { ...event, bonusRatio: -1 },
  ])
    expect(() => actionReview(source, [invalid], metadata)).toThrow();
  expect(() => actionReview(source, [event, event], metadata)).toThrow("重复");
});
it("never interprets missing files or empty event lists as absence proof", async () => {
  vi.mocked(readGbbq).mockRejectedValueOnce(new Error("missing"));
  expect((await readBacktestActions(source, "fixture")).status).toBe("missing");
  vi.mocked(readGbbq).mockResolvedValueOnce({
    events: new Map(),
    modified: 1,
    path: "fixture/gbbq",
  });
  const empty = await readBacktestActions(source, "fixture");
  expect(empty.status).toBe("partial");
  expect(empty.events).toEqual([]);
  expect(empty.warnings.join(" ")).toContain("不等于已证明");
});
