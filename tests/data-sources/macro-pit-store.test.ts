import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MacroObservation } from "trading-strategies";
import {
  parseEastmoneyCpiRows,
  parseEastmoneyGdpRows,
  parseEastmoneyPmiRows,
  parseEastmoneyPpiRows,
  syncMacroHistory,
} from "../../src/server/data-sources/macro/macro-history-adapter";
import { put, sqlite } from "../../src/server/db";
import {
  macroStoreSummary,
  readMacroObservations,
  upsertMacroSeries,
} from "../../src/server/db/macro-store";

const dayMs = 86400000;
const fetchedAt = Date.parse("2026-11-24T16:30:00Z"); // Nov 25 in Shanghai.
const meta = { source: "fixture", fetchedAt };
const cpi: MacroObservation = {
  seriesId: "cpi-yoy",
  reportPeriod: "2026-01-31",
  availableAt: "2026-02-16",
  publicationBasis: "conservative-lag",
  value: 0.2,
};
const unmockedFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("Tests must inject the data fetcher");
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(fetchedAt);
  unmockedFetch.mockClear();
  vi.stubGlobal("fetch", unmockedFetch);
  sqlite()
    .prepare("DELETE FROM records WHERE kind = ?")
    .run("macro-pit-series");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unmockedFetch).not.toHaveBeenCalled();
});

it.each([
  {
    parse: parseEastmoneyPmiRows,
    seriesId: "pmi-mfg",
    row: { REPORT_DATE: "2026-01-01 00:00:00", MAKE_INDEX: 49.3 },
    period: "2026-01-31",
    availableAt: "2026-02-01",
    value: 49.3,
  },
  {
    parse: parseEastmoneyCpiRows,
    seriesId: "cpi-yoy",
    row: { REPORT_DATE: "2026-01-01", NATIONAL_SAME: "0.2" },
    period: "2026-01-31",
    availableAt: "2026-02-16",
    value: 0.2,
  },
  {
    parse: parseEastmoneyPpiRows,
    seriesId: "ppi-yoy",
    row: { REPORT_DATE: "2024-02-01", BASE_SAME: "-2.7" },
    period: "2024-02-29",
    availableAt: "2024-03-16",
    value: -2.7,
  },
  {
    parse: parseEastmoneyGdpRows,
    seriesId: "gdp-yoy",
    row: { REPORT_DATE: "2025-12-01 00:00:00", SUM_SAME: 5 },
    period: "2025-12-31",
    availableAt: "2026-01-20",
    value: 5,
  },
])("normalizes $seriesId and applies its publication lag", (fixture) => {
  const { parse, seriesId, row, period, availableAt, value } = fixture;
  expect(parse([row, { ...row, REPORT_DATE: "2026-02-30" }])).toEqual([
    {
      seriesId,
      reportPeriod: period,
      availableAt,
      publicationBasis: "conservative-lag",
      value,
    },
  ]);
});

it("uses a valid official date and rejects malformed, early, and blank data", () => {
  const jan = { REPORT_DATE: "2026-01-01", NATIONAL_SAME: "0" };
  expect(
    parseEastmoneyCpiRows([
      {
        ...jan,
        PUBLISH_DATE: "2026-02-11 09:30:00",
        NOTICE_DATE: "2026-02-12",
      },
      { ...jan, PUBLISH_DATE: "2026-01-30", NOTICE_DATE: "2026-02-14" },
      { ...jan, PUBLISH_DATE: "2026-02-01invalid", NOTICE_DATE: "2026-02-30" },
      { ...jan, NATIONAL_SAME: " " },
      { ...jan, NATIONAL_SAME: "1e999" },
    ]),
  ).toEqual([
    {
      ...cpi,
      value: 0,
      availableAt: "2026-02-11",
      publicationBasis: "official",
    },
    {
      ...cpi,
      value: 0,
      availableAt: "2026-02-14",
      publicationBasis: "official",
    },
    { ...cpi, value: 0 },
  ]);
});

it("isolates a stored CPI value until the exact publication day on schema v26", () => {
  expect(sqlite().pragma("user_version", { simple: true })).toBe(26);
  upsertMacroSeries("cpi-yoy", [cpi], meta);
  const cpiOnly = { seriesIds: ["cpi-yoy"] as const };
  expect(readMacroObservations({ ...cpiOnly, asOf: "2026-01-31" })).toEqual([]);
  expect(readMacroObservations({ ...cpiOnly, asOf: "2026-02-15" })).toEqual([]);
  expect(readMacroObservations({ ...cpiOnly, asOf: "2026-02-16" })).toEqual([
    cpi,
  ]);
  expect(readMacroObservations({ seriesIds: ["pmi-mfg"] })).toEqual([]);
  expect(sqlite().pragma("user_version", { simple: true })).toBe(26);
  expect(
    sqlite()
      .prepare("SELECT kind FROM records WHERE id = ?")
      .pluck()
      .get("macro-pit-series-v1:cpi-yoy"),
  ).toBe("macro-pit-series");
});

it.each([
  ["PUBLISH_DATE", "2026-02-10 18:00:00", "2026-02-11"],
  ["PUBLISH_DATE", "2026-02-10 09:30:00", "2026-02-10"],
  ["NOTICE_DATE", "2026-02-10T15:00:00", "2026-02-11"],
  ["NOTICE_DATE", "2026-02-10T07:00:00Z", "2026-02-11"],
])("uses Shanghai close for %s %s", (field, timestamp, availableAt) => {
  expect(
    parseEastmoneyCpiRows([
      { REPORT_DATE: "2026-01-01", NATIONAL_SAME: 0.2, [field]: timestamp },
    ]),
  ).toEqual([{ ...cpi, availableAt, publicationBasis: "official" }]);
});

it("dates a revision carrying the old publication date to its Shanghai fetch day", () => {
  const feb = { ...cpi, reportPeriod: "2026-02-28", availableAt: "2026-03-16" };
  const revision = { ...cpi, availableAt: "2026-04-02", value: 0.4 };
  const replacement = { ...cpi, value: 0.3 };
  upsertMacroSeries("cpi-yoy", [feb, cpi], {
    ...meta,
    fetchedAt: Date.parse("2026-03-16T10:00:00+08:00"),
  });
  upsertMacroSeries("cpi-yoy", [revision], {
    ...meta,
    fetchedAt: Date.parse("2026-04-02T14:00:00+08:00"),
  });
  upsertMacroSeries("cpi-yoy", [replacement], meta);

  expect(readMacroObservations({ asOf: cpi.availableAt })).toEqual([cpi]);
  expect(readMacroObservations({ asOf: "2026-04-01" })).toEqual([cpi, feb]);
  expect(readMacroObservations({ asOf: "2026-11-24" })).toEqual([
    cpi,
    revision,
    feb,
  ]);
  const all = [
    cpi,
    revision,
    { ...replacement, availableAt: "2026-11-25" },
    feb,
  ];
  expect(readMacroObservations({ asOf: "2026-11-25" })).toEqual(all);
  expect(
    macroStoreSummary().series.find((s) => s.seriesId === "cpi-yoy"),
  ).toEqual({
    seriesId: "cpi-yoy",
    count: 4,
    firstReportPeriod: cpi.reportPeriod,
    lastReportPeriod: feb.reportPeriod,
    lastAvailableAt: "2026-11-25",
    fetchedAt,
    source: "fixture",
  });
  upsertMacroSeries("cpi-yoy", [replacement], {
    ...meta,
    fetchedAt: fetchedAt + dayMs,
  });
  expect(readMacroObservations()).toEqual(all);
});

it("preserves an original and each distinct revision received on its publication day", () => {
  const onPublication = {
    ...meta,
    fetchedAt: Date.parse(`${cpi.availableAt}T14:00:00+08:00`),
  };
  upsertMacroSeries("cpi-yoy", [cpi], onPublication);
  upsertMacroSeries(
    "cpi-yoy",
    [{ ...cpi, publicationBasis: "official" }],
    onPublication,
  );
  for (const value of [0.3, 0.4, 0.4])
    upsertMacroSeries("cpi-yoy", [{ ...cpi, value }], onPublication);
  expect(readMacroObservations({ asOf: cpi.availableAt })).toEqual([cpi]);
  expect(readMacroObservations()).toEqual([
    cpi,
    { ...cpi, value: 0.3, availableAt: "2026-02-17" },
    { ...cpi, value: 0.4, availableAt: "2026-02-18" },
  ]);
});

it("records a revision that returns to the original value", () => {
  upsertMacroSeries("cpi-yoy", [cpi], meta);
  upsertMacroSeries("cpi-yoy", [{ ...cpi, value: 0.3 }], meta);
  upsertMacroSeries("cpi-yoy", [cpi], {
    ...meta,
    fetchedAt: fetchedAt + dayMs,
  });

  expect(readMacroObservations({ asOf: "2026-11-25" }).at(-1)?.value).toBe(0.3);
  expect(readMacroObservations()).toEqual([
    cpi,
    { ...cpi, value: 0.3, availableAt: "2026-11-25" },
    { ...cpi, availableAt: "2026-11-26" },
  ]);
});

it.each([
  ["14:59:59", "2026-11-25"],
  ["15:00:00", "2026-11-26"],
  ["15:00:01", "2026-11-26"],
])("dates a Shanghai revision fetched at %s to %s", (time, availableAt) => {
  upsertMacroSeries("cpi-yoy", [cpi], meta);
  const revision = { ...cpi, value: 0.3 };
  upsertMacroSeries("cpi-yoy", [revision], {
    ...meta,
    fetchedAt: Date.parse(`2026-11-25T${time}+08:00`),
  });

  expect(readMacroObservations({ asOf: "2026-11-25" })).toHaveLength(
    availableAt === "2026-11-25" ? 2 : 1,
  );
  expect(readMacroObservations().at(-1)).toEqual({ ...revision, availableAt });
});

it.each([
  ["2026-03-01", "2026-11-26"],
  ["2026-11-27", "2026-11-27"],
])(
  "clamps a changed provider publication date %s to %s for an after-close revision",
  (published, availableAt) => {
    upsertMacroSeries("cpi-yoy", [cpi], meta);
    const revision = { ...cpi, availableAt: published, value: 0.3 };
    upsertMacroSeries("cpi-yoy", [revision], {
      ...meta,
      fetchedAt: Date.parse("2026-11-25T15:01:00+08:00"),
    });

    expect(readMacroObservations({ asOf: "2026-11-25" })).toEqual([cpi]);
    expect(readMacroObservations()).toEqual([
      cpi,
      { ...revision, availableAt },
    ]);
  },
);

it("rejects invalid observations both on write and when reading persisted payloads", () => {
  upsertMacroSeries("cpi-yoy", [cpi], meta);
  for (const invalid of [
    { ...cpi, value: Infinity },
    { ...cpi, reportPeriod: "2026-02-30" },
    { ...cpi, availableAt: "2026-01-30" },
    { ...cpi, seriesId: "pmi-mfg" as const },
  ]) {
    expect(() => upsertMacroSeries("cpi-yoy", [invalid], meta)).toThrow();
  }
  expect(() => readMacroObservations({ asOf: "2026-2-16" })).toThrow();
  expect(readMacroObservations()).toEqual([cpi]);
  put("macro-pit-series", "macro-pit-series-v1:cpi-yoy", {
    ...meta,
    seriesId: "cpi-yoy",
    rows: [{ ...cpi, value: "0.2" }],
  });
  expect(() => readMacroObservations()).toThrow();
});

it("evaluates the Shanghai-date macro clock from visible observations only", () => {
  upsertMacroSeries(
    "pmi-mfg",
    [
      { ...cpi, seriesId: "pmi-mfg", value: 49.5 },
      {
        ...cpi,
        seriesId: "pmi-mfg",
        reportPeriod: "2026-10-31",
        availableAt: "2026-11-25",
        value: 50.5,
      },
    ],
    meta,
  );
  upsertMacroSeries(
    "cpi-yoy",
    [
      cpi,
      {
        ...cpi,
        reportPeriod: "2026-09-30",
        availableAt: "2026-10-16",
        value: 0.8,
      },
      {
        ...cpi,
        reportPeriod: "2026-10-31",
        availableAt: "2026-11-26",
        value: -1,
      },
    ],
    meta,
  );
  expect(macroStoreSummary()).toMatchObject({
    asOf: "2026-11-25",
    macroClock: { status: "ok", regime: "overheat" },
  });
});

function treasuryHtml(date: string) {
  const header = [
    "曲线名称",
    "日期",
    "3月",
    "6月",
    "1年",
    "3年",
    "5年",
    "7年",
    "10年",
    "30年",
  ];
  const row = [
    "中债国债收益率曲线",
    date,
    "",
    "",
    "1.4",
    "",
    "",
    "",
    "1.8",
    "",
  ];
  return `<table></table><table><tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr><tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr></table>`;
}

it("syncs seven series through the three public sources and retains history on failure", async () => {
  const prior = { ...cpi, seriesId: "ppi-yoy" as const, value: -2.5 };
  upsertMacroSeries("ppi-yoy", [prior], meta);
  const treasuryWindows: [string, string][] = [];
  const lprFilters: string[] = [];
  const lprStart = Date.parse("2026-11-20");
  const lprPage = Array.from({ length: 500 }, (_, offset) => ({
    TRADE_DATE: new Date(lprStart - offset * dayMs).toISOString().slice(0, 10),
    LPR1Y: 3.1,
  }));
  const eastmoneyRows = {
    RPT_ECONOMY_PMI: [{ REPORT_DATE: "2026-10-01", MAKE_INDEX: 49.3 }],
    RPT_ECONOMY_CPI: [{ REPORT_DATE: "2026-01-01", NATIONAL_SAME: 0.2 }],
    RPT_ECONOMY_GDP: [{ REPORT_DATE: "2026-09-01", SUM_SAME: 4.6 }],
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.credentials).toBe("omit");
    if (url.hostname === "yield.chinabond.com.cn") {
      const start = url.searchParams.get("startDate")!;
      const end = url.searchParams.get("endDate")!;
      treasuryWindows.push([start, end]);
      return new Response(treasuryHtml(start));
    }
    if (url.hostname === "www.chinamoney.com.cn") {
      expect(url.pathname).toMatch(/\/frr-chrt\.csv$/);
      return new Response(
        "2026-11-20,,,,,,1.4,1.51,1.6\n2016-11-24,,,,,,2,3,4",
      );
    }
    expect(url.hostname).toBe("datacenter-web.eastmoney.com");
    const report = url.searchParams.get("reportName");
    if (report === "RPT_ECONOMY_PPI") {
      return Response.json(
        { token: "private-value", error: "unavailable" },
        { status: 503 },
      );
    }
    if (report === "RPTA_WEB_RATE") {
      lprFilters.push(url.searchParams.get("filter")!);
      const data =
        lprFilters.length === 1
          ? lprPage
          : [
              { TRADE_DATE: "2020-01-20 00:00:00", LPR1Y: "4.15" },
              { TRADE_DATE: "2019-11-20 00:00:00", LPR1Y: "" },
            ];
      return Response.json({ success: true, result: { data } });
    }
    if (!report || !(report in eastmoneyRows))
      throw new Error("Unexpected report");
    return Response.json({
      success: true,
      result: { data: eastmoneyRows[report as keyof typeof eastmoneyRows] },
    });
  });

  const result = await syncMacroHistory({ years: 10, fetcher });
  expect(result.synced.map((entry) => entry.seriesId)).toEqual([
    "bond-1y",
    "bond-10y",
    "fr007",
    "pmi-mfg",
    "cpi-yoy",
    "gdp-yoy",
    "lpr-1y",
  ]);
  expect(result.failures).toEqual([
    {
      seriesId: "ppi-yoy",
      message: "东方财富 HTTP 503",
      rawResponses: [
        {
          status: 503,
          bodyPreview: '{"token":[已脱敏],"error":"unavailable"}',
        },
      ],
    },
  ]);
  expect(result.synced[0]?.rawResponses[0]?.bodyPreview).toContain("曲线名称");
  expect(treasuryWindows).toHaveLength(11);
  expect(treasuryWindows[0]?.[0]).toBe("2016-11-25");
  expect(treasuryWindows.at(-1)?.[1]).toBe("2026-11-25");
  for (const [index, [start, end]] of treasuryWindows.entries()) {
    expect(
      (Date.parse(end) - Date.parse(start)) / dayMs + 1,
    ).toBeLessThanOrEqual(350);
    if (index > 0)
      expect(
        Date.parse(start) - Date.parse(treasuryWindows[index - 1]![1]),
      ).toBe(dayMs);
  }
  expect(lprFilters).toEqual([
    "(TRADE_DATE>='2016-11-25')(TRADE_DATE<'2026-11-26')",
    `(TRADE_DATE>='2016-11-25')(TRADE_DATE<'${lprPage.at(-1)!.TRADE_DATE}')`,
  ]);
  expect(fetcher).toHaveBeenCalledTimes(18);
  for (const [seriesId, date, value] of [
    ["bond-1y", "2016-11-25", 1.4],
    ["bond-10y", "2016-11-25", 1.8],
    ["fr007", "2026-11-20", 1.51],
    ["lpr-1y", "2020-01-20", 4.15],
  ] as const) {
    expect(readMacroObservations({ seriesIds: [seriesId] })[0]).toEqual({
      seriesId,
      reportPeriod: date,
      availableAt: date,
      value,
      publicationBasis: "official",
    });
  }
  expect(readMacroObservations({ seriesIds: ["lpr-1y"] })).toHaveLength(501);
  expect(readMacroObservations({ seriesIds: ["fr007"] })).toHaveLength(1);
  expect(readMacroObservations({ seriesIds: ["cpi-yoy"] })).toEqual([cpi]);
  expect(readMacroObservations({ seriesIds: ["ppi-yoy"] })).toEqual([prior]);
  expect(
    result.summary.series.find((s) => s.seriesId === "ppi-yoy")?.source,
  ).toBe("fixture");
  expect(sqlite().pragma("user_version", { simple: true })).toBe(26);
});
