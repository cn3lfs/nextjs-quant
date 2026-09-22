import { expect, it, vi, afterEach } from "vitest";
import fixture from "./fixtures/hithink-dividends.json";
vi.mock("../src/server/data-sources/hithink/hithink-context", () => ({
  request: vi.fn(),
}));
import { request } from "../src/server/data-sources/hithink/hithink-context";
import {
  dividendSchedule,
  queryDividendSchedule,
} from "../src/server/data-sources/hithink/hithink-dividends";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("replays actual event amounts and separates report period, announcement, record and payment dates", () => {
  const d = dividendSchedule("sh600519", fixture.raw, fixture.fetchedAt);
  expect(d.events).toHaveLength(2);
  expect(d.events[1]).toMatchObject({
    period: "20251231",
    announcement: "20260622",
    record: "20260625",
    ex: "20260626",
    pay: "20260626",
    dividend: 28.02423,
    listing: null,
  });
  expect(d.events[0]).toMatchObject({ dividend: 23.957, ex: "20251219" });
  expect(dividendSchedule("sh600519", d.raw, d.fetchedAt)).toEqual(d);
});
it("rejects the observed annual total schema even when its key matches the event amount", () => {
  const raw = structuredClone(fixture.raw);
  raw.columns.find((c) => c.key === "税前每股股利[20251231]")!.index_name =
    "税前每股股利";
  raw.datas[0]!["税前每股股利[20251231]"] = 51.98123;
  expect(() => dividendSchedule("sh600519", raw, fixture.fetchedAt)).toThrow(
    "年度汇总",
  );
});
it("rejects wrong identity, date order, units, duplicate columns and unverified pagination", () => {
  for (const mutate of [
    (r: typeof fixture.raw) => {
      r.datas[0]!["股票代码"] = "000001.SZ";
    },
    (r: typeof fixture.raw) => {
      r.datas[0]!["派息日[20251231]"] = "20260624";
    },
    (r: typeof fixture.raw) => {
      r.datas[0]!["股权登记日[20251231]"] = "20260230";
    },
    (r: typeof fixture.raw) => {
      r.columns.find((c) => c.key === "税前每股股利[20251231]")!.unit = "万元";
    },
    (r: typeof fixture.raw) => {
      r.columns.push(r.columns[0]!);
    },
    (r: typeof fixture.raw) => {
      r.row_count = 2;
    },
  ]) {
    const raw = structuredClone(fixture.raw);
    mutate(raw);
    expect(() =>
      dividendSchedule("sh600519", raw, fixture.fetchedAt),
    ).toThrow();
  }
});
it("shares concurrent source reads without invoking an LLM", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-only");
  vi.mocked(request).mockResolvedValue(fixture.raw);
  const [a, b] = await Promise.all([
    queryDividendSchedule("sh600519"),
    queryDividendSchedule("sh600519"),
  ]);
  expect(a).toEqual(b);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.mocked(request).mock.calls[0]![0]).toBe("hithink-event-query");
});
