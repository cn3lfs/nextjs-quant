import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readMarketPoolLocation } from "~/lib/market/market-pool-location";
import { sqlite } from "~/server/db";
import { ClsReviewStore } from "~/server/db/cls-review-store";
import { saveSettings, settings } from "~/server/infra/settings";
import * as barStore from "~/server/market/bar-store/read-bars";
import { parseClsReport } from "~/server/news/cls-report-parser";
import {
  clsReportForwardReturns,
  computeForwardReturnWindows,
  extractSectionSummary,
  resolveSectionTarget,
} from "~/server/news/cls-forward-returns";

const dates = [
  "2025-06-06",
  "2025-06-09",
  "2025-06-10",
  "2025-06-11",
  "2025-06-12",
  "2025-06-13",
  "2025-06-16",
  "2025-06-17",
  "2025-06-18",
  "2025-06-19",
  "2025-06-20",
  "2025-06-23",
  "2025-06-24",
  "2025-06-25",
  "2025-06-26",
  "2025-06-27",
  "2025-06-30",
  "2025-07-01",
  "2025-07-02",
  "2025-07-03",
  "2025-07-04",
  "2025-07-07",
  "2025-07-08",
];
const closes = [
  100, 80, 81, 82, 83, 85, 90, 81, 76, 77, 70, 60, 65, 66, 67, 68, 70, 72, 74,
  76, 78, 80, 85,
];
const bars = dates.map((date, index) => ({ date, close: closes[index]! }));
const weekend = "2025-06-07";

it("aligns a Saturday report to Monday's close, then measures 5, 10 and 20 later sessions", () => {
  expect(computeForwardReturnWindows(bars, weekend)).toEqual({
    status: "ok",
    baseDate: weekend,
    baseTradeDate: "2025-06-09",
    baseClose: 80,
    t5: { date: "2025-06-16", close: 90, returnPct: 12.5 },
    t10: { date: "2025-06-23", close: 60, returnPct: -25 },
    t20: { date: "2025-07-07", close: 80, returnPct: 0 },
    latest: { date: "2025-07-08", close: 85, returnPct: 6.25, tradingDays: 21 },
    elapsedTradingDays: 21,
  });
});

it("leaves T+10 and T+20 pending after seven valid sessions", () => {
  const result = computeForwardReturnWindows(bars.slice(0, 9), weekend);
  expect(result).toMatchObject({
    elapsedTradingDays: 7,
    t5: { date: "2025-06-16", returnPct: 12.5 },
    t10: null,
    t20: null,
    latest: { date: "2025-06-18", tradingDays: 7 },
  });
});

it("counts each date once and skips zero, negative and nonfinite closes", () => {
  const input = [
    { date: "2025-06-06", close: 0 },
    { date: "2025-06-09", close: NaN },
    ...bars.slice(1, 3),
    { date: "2025-06-10", close: 300 },
    { date: "2025-06-11", close: -1 },
    { date: "2025-06-12", close: Infinity },
    ...bars.slice(5, 9),
  ];
  expect(computeForwardReturnWindows(input, "2025-06-06")).toMatchObject({
    baseTradeDate: "2025-06-09",
    baseClose: 80,
    elapsedTradingDays: 5,
    t5: { date: "2025-06-18", close: 76 },
    t10: null,
    t20: null,
  });
  expect(computeForwardReturnWindows(bars.slice(-1), weekend)).toMatchObject({
    elapsedTradingDays: 0,
    latest: null,
    status: "ok",
  });
});

it("returns explicit no-data for empty, expired or unusable history", () => {
  for (const input of [[], bars.slice(0, 1), [{ date: weekend, close: 0 }]]) {
    expect(computeForwardReturnWindows(input, weekend)).toEqual({
      status: "no-data",
      baseDate: weekend,
      baseTradeDate: null,
      baseClose: null,
      elapsedTradingDays: 0,
      t5: null,
      t10: null,
      t20: null,
      latest: null,
    });
  }
});

it("returns the report's own core reasoning ahead of news bullets and skips Markdown noise", () => {
  const text = [
    "### 半导体（方向：偏多）",
    "- **新闻要点**：",
    "  - 新闻一",
    "---",
    "- **核心逻辑**：订单回暖，[设备](https://example.com)交付提速。",
    "- **机会**：跟踪新增订单。",
  ].join("\n");
  expect(extractSectionSummary(text)).toBe("订单回暖，设备交付提速。");
  expect(extractSectionSummary("#### 观察\n> - 产能仍待验证。")).toBe(
    "产能仍待验证。",
  );
  expect(extractSectionSummary("# 标题\n---")).toBe("");
  expect(Array.from(extractSectionSummary("证".repeat(300)))).toHaveLength(240);
});

const catalog = [
  { name: "电子", category: "industry", sectorSymbol: "sh880001" },
  { name: "消费电子", category: "concept" },
  {
    name: "算力 & 网络",
    category: "concept",
    selectionName: "通达信·成分·算力 & 网络",
  },
] as const;

it("aligns suspended stock dates to the market trading calendar instead of shifting forward", () => {
  const missingT0 = bars.filter((b) => b.date !== "2025-06-09");
  expect(computeForwardReturnWindows(missingT0, weekend, dates)).toMatchObject({
    status: "no-data",
    baseTradeDate: "2025-06-09",
    baseClose: null,
    t5: null,
    t10: null,
    t20: null,
  });

  const suspendedT5 = bars.filter((b) => b.date !== "2025-06-16");
  expect(
    computeForwardReturnWindows(suspendedT5, weekend, dates),
  ).toMatchObject({
    status: "ok",
    baseTradeDate: "2025-06-09",
    baseClose: 80,
    t5: null,
    t10: { date: "2025-06-23", close: 60, returnPct: -25 },
    t20: { date: "2025-07-07", close: 80, returnPct: 0 },
  });
});

it("prefers the exact chart, resolves a unique normalized pool name and avoids substring collisions", () => {
  expect(resolveSectionTarget("电子", catalog)).toEqual({
    href: "/scan?symbol=sh880001",
    sectorSymbol: "sh880001",
    category: "industry",
    matchedName: "电子",
  });
  const pool = { category: "concept", name: "通达信·成分·算力 & 网络" };
  const target = resolveSectionTarget("算力＆网络板块", catalog);
  expect(target).toMatchObject({
    sectorSymbol: null,
    category: "concept",
    matchedName: "算力 & 网络",
  });
  const url = new URL(target.href, "https://example.com");
  expect(url.pathname).toBe("/scan");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    tab: "pool",
    ...pool,
  });
  expect(readMarketPoolLocation(url.search).query.pool).toEqual(pool);
});

it("uses the search link for ambiguous, substring and unknown names", () => {
  for (const name of ["电", "算力", "电子设备", "未知 & 方向"]) {
    const target = resolveSectionTarget(name, catalog);
    expect(target).toMatchObject({
      category: null,
      sectorSymbol: null,
      matchedName: null,
    });
    const url = new URL(target.href, "https://example.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      tab: "pool",
      search: name,
    });
    expect(readMarketPoolLocation(url.search).query.search).toBe(name);
  }
});

function importReport(markdown: string) {
  const report = parseClsReport(markdown);
  return new ClsReviewStore(sqlite()).import(
    {
      report,
      sourcePath: "cls.md",
      modifiedAt: 0,
      observedAt: 0,
      size: Buffer.byteLength(markdown),
    },
    report.hash,
  );
}

it("resolves a fixture TDX sector and reads each distinct symbol once, including a missing stock", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "tdx");
  await cp("tests/fixtures/tdx-local-blocks", join(root, "T0002", "hq_cache"), {
    recursive: true,
  });
  const folder = join(root, "vipdoc", "sh", "lday");
  await mkdir(folder, { recursive: true });
  const dayFile = Buffer.concat(
    bars.map(({ date, close }) => {
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(date.replaceAll("-", "")), 0);
      for (const offset of [4, 8, 12, 16])
        row.writeUInt32LE(close * 100, offset);
      return row;
    }),
  );
  await Promise.all(
    ["sh881001", "sh600000"].map((symbol) =>
      writeFile(join(folder, symbol + ".day"), dayFile),
    ),
  );
  saveSettings({ ...settings(), tdxRoot: root, industryBlocksRoot: "" });
  const archive = importReport(
    "# 盘后观点\n报告日期：2025-06-07\n### 研究金融（方向：偏多 ｜ 信心：高）\n- 核心逻辑：需求回暖。\nsh600000 sz000001\n### 未知主题\nsh600000",
  );
  const reads = vi.spyOn(barStore, "readBars");
  try {
    const result = await clsReportForwardReturns(archive.id);
    expect(
      reads.mock.calls.map(([input]) => input.instrument.symbol).sort(),
    ).toEqual(["sh000001", "sh600000", "sh881001", "sz000001"]);
    expect(result).toMatchObject({
      reportId: archive.id,
      title: "盘后观点",
      baseDateSource: "reportDate",
      baseDate: weekend,
    });
    expect(result?.sections[0]).toMatchObject({
      direction: "bullish",
      confidence: "high",
      summary: "需求回暖。",
      sectorSymbol: "sh881001",
      sectorHref: "/scan?symbol=sh881001",
      sectorReturns: { t5: { returnPct: 12.5 } },
      stocks: [
        {
          symbol: "sh600000",
          href: "/scan?symbol=sh600000",
          returns: { t10: { returnPct: -25 } },
        },
        { symbol: "sz000001", returns: { status: "no-data", latest: null } },
      ],
    });
    expect(result?.sections[1]?.sectorReturns).toBeNull();
  } finally {
    reads.mockRestore();
  }
});

it("uses the Beijing import date without TDX configuration and returns null for a missing archive", async () => {
  saveSettings({ ...settings(), tdxRoot: "", industryBlocksRoot: "" });
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2025-06-06T18:30:00Z"));
  try {
    const archive = importReport("# 夜间导入\n### 未知主题\nsh600000");
    expect(await clsReportForwardReturns(archive.id)).toMatchObject({
      baseDate: weekend,
      baseDateSource: "importedAt",
      sections: [
        {
          sectorReturns: null,
          stocks: [{ symbol: "sh600000", returns: { status: "no-data" } }],
        },
      ],
    });
    expect(await clsReportForwardReturns("missing")).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
