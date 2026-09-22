import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { summarizeTdxSnapshot } from "../src/server/data-sources/tdx/tdx-data-baseline";

const make = (times: string[]): Snapshot => ({
  id: "sample",
  symbol: "sh600000",
  period: "5m",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 0,
  hash: "fixed",
  dataRoot: "fixture",
  bars: times.map((time) => ({
    date: `2026-09-11T${time}:00+08:00`,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  })),
});
describe("read-only TDX baseline", () => {
  it("reports a missing internal bar rather than treating the latest timestamp as complete", () => {
    const report = summarizeTdxSnapshot(
      make(["09:35", "09:45", "15:00"]),
      "2026-09-11",
    );
    expect(report.targetCount).toBe(3);
    expect(report.missingRegularSessionTimes).toContain("09:40");
    expect(report.missingRegularSessionTimes).toHaveLength(45);
    expect(report.missingRegularSessionTimes).not.toContain("12:00");
    expect(report.tradingStatus).toBe("unknown");
  });
  it("distinguishes stale files and unexpected timestamps", () => {
    expect(
      summarizeTdxSnapshot(make(["12:00"]), "2026-09-11").unexpectedTimes,
    ).toEqual(["12:00"]);
    const report = summarizeTdxSnapshot(make(["15:00"]), "2026-09-14");
    expect(report.targetCount).toBe(0);
    expect(report.missingRegularSessionTimes).toHaveLength(48);
    expect(report.last).toContain("2026-09-11");
  });
  it("rejects invalid calendar dates", () => {
    expect(() => summarizeTdxSnapshot(make([]), "2026-02-30")).toThrow(
      "目标日期非法",
    );
  });
});
