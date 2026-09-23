import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import fixture from "../../fixtures/eastmoney-index-day.json";
import {
  onlineChartSnapshot,
  parseOnlineChart,
} from "../../../src/server/charts/online-chart-data";
import { parseBars } from "../../../src/server/data-sources/tdx/tdx-wire";

afterEach(() => vi.unstubAllGlobals());
it("validates online symbol and OHLC fields, retaining amounts and original volume units", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(fixture))),
  );
  const snapshot = await onlineChartSnapshot("sh000001", "day");
  expect(snapshot.bars).toHaveLength(3);
  expect(snapshot.bars[0]!.amount).toBeGreaterThan(0);
  expect(snapshot.volumeUnit).toBe("手");
  expect(snapshot.source).toBe("eastmoney-online");
  expect(snapshot.sourceUrl).toContain("fqt=0");
  expect(snapshot.dataRoot).toBeUndefined();
  expect(() => parseOnlineChart(fixture, "sz000001", "day")).toThrow(
    "市场不匹配",
  );
});
it("rejects malformed, missing, inverted and duplicate remote records", () => {
  for (const klines of [
    ["2026-02-30,1,2,3,1,1,1"],
    ["2026-09-11,1,2,1,1,1,1"],
    [fixture.data.klines[0], fixture.data.klines[0]],
    ["2026-09-11,1,2,3,1,,1"],
  ]) {
    expect(() =>
      parseOnlineChart(
        { ...fixture, data: { ...fixture.data, klines } },
        "sh000001",
        "day",
      ),
    ).toThrow();
  }
  expect(() =>
    parseOnlineChart({ ...fixture, data: null }, "sh000001", "day"),
  ).toThrow();
});
it("rejects the real truncated TDX index response instead of inventing bars", () => {
  expect(() =>
    parseBars(
      readFileSync("tests/fixtures/tdx-index-day-real.bin"),
      "day",
      true,
    ),
  ).toThrow();
});
