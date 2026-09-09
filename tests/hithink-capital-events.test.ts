import { afterEach, expect, it, vi } from "vitest";
import {
  capitalEventsEvidence,
  queryCapitalEvents,
} from "~/server/hithink-capital-events";
const now = Date.parse("2026-09-09T10:00:00+08:00");
export function capitalFixture(profile: "placement" | "rights" = "placement") {
  const specs =
    profile === "placement"
      ? [
          ["预案公告日", "增发预案日", "DATE", "", "20241201"],
          ["进度", "增发进度", "STR", "", "已实施"],
          ["发行数量", "增发发行数量", "LONG", "股", 100],
          ["上市日", "增发上市日", "DATE", "", "20250601"],
          ["最新公告日", "增发最新公告日期", "DATE", "", "20250520"],
        ]
      : [
          ["预案公告日", "历史配股预案公告日", "DATE", "", "20241201"],
          ["进度", "历史配股进度", "STR", "", "已实施"],
          ["每股配股数量", "历史每股配股数", "DOUBLE", "股", 0.15],
          ["股权登记日", "历史配股股权登记日", "DATE", "", "20250501"],
          ["上市日", "历史配股上市日", "DATE", "", "20250601"],
          ["除权日", "历史配股除权日", "DATE", "", "20250510"],
        ];
  const row: Record<string, unknown> = {
    股票代码: "600519.SH",
    secret: "hidden",
    最新价: 100,
  };
  const columns = specs.map(([key, index_name, type, unit, value]) => {
    row[String(key)] = value;
    return {
      key: String(key),
      index_name: String(index_name),
      type: String(type),
      unit: String(unit),
    };
  });
  return { status_code: 0, code_count: 1, row_count: 1, columns, datas: [row] };
}
const parse = (
  pages = [capitalFixture()],
  profile: "placement" | "rights" = "placement",
) => capitalEventsEvidence("sh600519", 2025, profile, "q", pages, now);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("distinguishes plan year and listing year and replays source evidence without quotes", () => {
  const e = parse(),
    p = JSON.parse(e.text);
  expect(p.facts.events[0]).toMatchObject({
    planDate: "20241201",
    listingDate: "20250601",
    issuedShares: 100,
    rightsPerShare: null,
    listedInYear: true,
    sourceImplemented: true,
  });
  expect(p.facts.listedInYearCount).toBe(1);
  expect(p.facts.noEquityOffering).toBeNull();
  expect(p.facts.absenceVerified).toBe(false);
  expect(e.text).not.toContain("hidden");
  expect(e.text).not.toContain("最新价");
  expect(
    capitalEventsEvidence("sh600519", 2025, "placement", "q", p.pages, now),
  ).toEqual(e);
});
it("does not treat a per-share rights ratio as issued shares", () => {
  const p = JSON.parse(parse([capitalFixture("rights")], "rights").text);
  expect(p.facts.events[0].issuedShares).toBeNull();
  expect(p.facts.events[0].rightsPerShare).toBe(0.15);
  expect(() => parse([capitalFixture("rights")])).toThrow(/定义/);
});
it("retains empty responses, placeholder rows, missing dates and outside-year events as incomplete coverage", () => {
  const empty = capitalFixture();
  empty.datas = [];
  empty.row_count = 0;
  expect(JSON.parse(parse([empty]).text).facts.noEquityOffering).toBeNull();
  empty.datas = [{ 股票代码: "600519.SH" }];
  empty.row_count = 1;
  const p = JSON.parse(parse([empty]).text);
  expect(p.facts.events).toEqual([]);
  expect(p.facts.emptyRows).toBe(1);
  expect(p.facts.missing.join()).toContain("零事件");
  const missing = capitalFixture();
  missing.datas[0]!["上市日"] = "--";
  expect(
    JSON.parse(parse([missing]).text).facts.events[0].listedInYear,
  ).toBeNull();
  const outside = capitalFixture();
  outside.datas[0]!["上市日"] = "20260101";
  expect(JSON.parse(parse([outside]).text).facts.listedInYearCount).toBe(0);
  expect(JSON.parse(parse([outside]).text).facts.events).toHaveLength(1);
});
it("rejects identity, impossible dates, IPO definition substitution, units and unsafe shares", () => {
  for (const mutate of [
    (p: ReturnType<typeof capitalFixture>) => {
      p.datas[0]!.股票代码 = "000001.SZ";
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.datas[0]!["上市日"] = "20250230";
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.datas[0]!["预案公告日"] = "20270101";
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.columns[3]!.index_name = "新股上市日期";
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.columns[2]!.unit = "万股";
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.datas[0]!["发行数量"] = 0.1;
    },
    (p: ReturnType<typeof capitalFixture>) => {
      p.datas[0]!["发行数量"] = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const p = capitalFixture();
    mutate(p);
    expect(() => parse([p])).toThrow();
  }
});
it("rejects truncated pagination and duplicate events independent of quote changes", () => {
  const p = capitalFixture();
  p.datas = Array.from({ length: 10 }, (_, i) => ({
    ...p.datas[0],
    发行数量: i + 1,
  }));
  expect(() => parse([p])).toThrow(/分页/);
  const end = capitalFixture();
  end.datas = [];
  p.row_count = 10;
  end.row_count = 10;
  expect(JSON.parse(parse([p, end]).text).facts.events).toHaveLength(10);
  p.datas[1] = { ...p.datas[0], 最新价: 200 };
  expect(() => parse([p, end])).toThrow(/重复/);
});
it("paginates despite code_count=1, shares requests and stops on repeated pages", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const p = capitalFixture();
  p.datas = Array.from({ length: 10 }, (_, i) => ({
    ...p.datas[0],
    发行数量: i + 1,
  }));
  p.row_count = 11;
  const end = capitalFixture();
  end.datas[0]!["发行数量"] = 11;
  end.row_count = 11;
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
      "hithink-event-query",
    );
    return Response.json(
      JSON.parse(init.body as string).page === "1" ? p : end,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryCapitalEvents("sh600519", 2025, "placement"),
    queryCapitalEvents("sh600519", 2025, "placement"),
  ]);
  expect(a).toEqual(b);
  expect(JSON.parse(a.text).facts.events).toHaveLength(11);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockImplementation(async () => Response.json(p));
  await expect(
    queryCapitalEvents("sh600519", 2025, "placement"),
  ).rejects.toThrow(/重复/);
});
it("rejects source totals that exceed a short page and impossible event chronology", () => {
  const p = capitalFixture();
  p.row_count = 2;
  expect(() => parse([p])).toThrow(/记录数/);
  p.row_count = 1;
  p.datas[0]!["上市日"] = "20240101";
  expect(() => parse([p])).toThrow(/早于/);
});
it("does not start requests when cancelled", () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const c = new AbortController();
  c.abort();
  expect(() =>
    queryCapitalEvents("sh600519", 2025, "rights", c.signal),
  ).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
