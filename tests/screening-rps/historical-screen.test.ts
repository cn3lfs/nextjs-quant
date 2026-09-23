import { expect, it, vi } from "vitest";
import { validateHistoricalScreen } from "../../src/lib/screening/historical-screen";
it("requires an explicit historical universe and provenance and rejects impossible/future dates", () => {
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-09-08T10:00:00+08:00"));
  try {
    expect(validateHistoricalScreen({})).toEqual({});
    expect(validateHistoricalScreen({ requireCurrent: true })).toEqual({
      requireCurrent: true,
    });
    expect(() =>
      validateHistoricalScreen(
        { requireCurrent: true, asOf: "2026-09-07", universeSource: "fixture" },
        ["sh600519"],
      ),
    ).toThrow("不能同时");
    expect(() =>
      validateHistoricalScreen(
        { asOf: "2026-02-30", universeSource: "fixture" },
        ["sh600519"],
      ),
    ).toThrow();
    expect(() =>
      validateHistoricalScreen(
        { asOf: "2026-09-08", universeSource: "fixture" },
        ["sh600519"],
      ),
    ).toThrow("之前");
    expect(() =>
      validateHistoricalScreen({
        asOf: "2026-09-07",
        universeSource: "fixture",
      }),
    ).toThrow("证券池");
    expect(() =>
      validateHistoricalScreen({ asOf: "2026-09-07" }, ["sh600519"]),
    ).toThrow("来源");
    expect(
      validateHistoricalScreen(
        { asOf: "2026-09-07", universeSource: "当时成分股存档" },
        ["sh600519"],
      ),
    ).toEqual({ asOf: "2026-09-07", universeSource: "当时成分股存档" });
  } finally {
    clock.mockRestore();
  }
});
