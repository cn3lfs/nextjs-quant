import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withoutTdxSnapshotPanel } from "./tdx-snapshot-contract";
import { TdxQuoteBook } from "../src/components/tdx-quote-book";
import { TdxFundamentalSummary } from "../src/components/tdx-fundamental-summary";
import type { QuoteSnapshot } from "../src/lib/tdx-quote-view";
import type { FinanceSnapshot } from "../src/lib/tdx-fundamentals";

vi.mock("../src/trpc/react", () => ({ api: {} }));

const empty = { price: 0, volume: 0 };
const quote: QuoteSnapshot = {
  symbol: "sh600519",
  quoteTime: "10:31:02.500",
  price: 12.34,
  preClose: 12,
  open: 12.1,
  high: 12.5,
  low: 11.9,
  volume: 1234567,
  amount: 15000000,
  innerVolume: 400000,
  outerVolume: 600000,
  riseSpeed: 0.15,
  bids: [
    { price: 12.33, volume: 100 },
    { price: 12.32, volume: 200 },
    { price: 12.31, volume: 300 },
    { price: 12.3, volume: 400 },
    empty,
  ],
  asks: [
    { price: 12.35, volume: 500 },
    { price: 12.36, volume: 600 },
    empty,
    empty,
    empty,
  ],
};
const finance: FinanceSnapshot = {
  totalShares: 1_250_081_562.5,
  floatShares: 1_250_081_562.5,
  stateShares: 1215,
  founderShares: 45_402_960,
  legalPersonShares: 89_389_352,
  bShares: 0,
  hShares: 0,
  employeeShares: 35.57,
  totalAssets: 309_050_784_000,
  currentAssets: 260_724_656_000,
  fixedAssets: 22_220_890_000,
  intangibleAssets: 8_578_744_000,
  inventory: 61_317_208_000,
  receivables: 570_800,
  currentLiabilities: 46_645_076_000,
  longTermLiabilities: 10_842_758_000,
  capitalReserve: 1_577_000,
  netAssets: 251_253_600_000,
  mainRevenue: 90_703_264_000,
  mainProfit: 9_473_762_000,
  operatingProfit: 61_411_288_000,
  investmentIncome: 1_013_800,
  totalProfit: 61_438_420_000,
  afterTaxProfit: 46_033_328_000,
  netProfit: 44_516_880_000,
  undistributedProfit: 199_683_216_000,
  operatingCashFlow: 70_690_752_000,
  totalCashFlow: 58_387_000_000,
  shareholders: 296_404,
  bookValuePerShare: 200.99,
  province: 22,
  industry: 471,
  updatedDate: 20260815,
  ipoDate: 20010827,
};
const period = {
  reportDate: "2026-06-30",
  sourceFilename: "gpcw20260630.dat",
};
const book = (props: Partial<Parameters<typeof TdxQuoteBook>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TdxQuoteBook, {
      quote,
      precision: 2,
      session: "continuous",
      hasOrderBook: true,
      ...props,
    }),
  );

describe("五档盘口面板", () => {
  it("展示十档、涨跌方向与源单位披露", () => {
    const html = book();
    expect(html).toContain("12.34");
    expect(html).toContain("+0.34");
    expect(html).toContain("+2.83%");
    expect(html).toContain("卖1");
    expect(html).toContain("买5");
    expect(html).toContain("12.36");
    expect(html).toContain("10:31:02.500");
    expect(html).toContain("连续竞价");
    expect(html).toContain("源单位");
    expect(html).toContain("不代表成交可得性");
    // 上涨使用既有 .up 配色类，不写死颜色值
    expect(html).toContain('class="text-2xl font-semibold tabular-nums up"');
    expect(html).not.toContain("#c95162");
  });
  it("下跌走 .down，空档显示破折号而不是 0", () => {
    const html = book({
      quote: { ...quote, price: 11.5 },
    });
    expect(html).toContain('class="text-2xl font-semibold tabular-nums down"');
    expect(html).toContain("-4.17%");
    expect(html).toContain("—");
  });
  it("指数无盘口时说明原因且不渲染任何档位", () => {
    const html = book({
      quote: { ...quote, bids: [], asks: [] },
      hasOrderBook: false,
    });
    expect(html).toContain("没有可交易的五档盘口");
    expect(html).not.toContain("卖1");
    expect(html).toContain("不可得：五档无挂单");
  });
  it("昨收不可得时涨跌留空并给出原因", () => {
    const html = book({ quote: { ...quote, preClose: 0 } });
    expect(html).toContain("不可得：昨收价或最新价不可得");
    expect(html).not.toContain("+2.83%");
  });
});

describe("基本面快照面板", () => {
  const render = (
    price: number | null,
    resolved: typeof period | null = period,
    periodReason?: string,
  ) =>
    renderToStaticMarkup(
      createElement(TdxFundamentalSummary, {
        finance,
        price,
        period: resolved,
        periodReason,
      }),
    );
  it("展示由本地财务包确定的报告期与按修正口径算出的估值", () => {
    const html = render(1272.75);
    expect(html).toContain("2026-06-30");
    expect(html).toContain("gpcw20260630.dat");
    expect(html).toContain("2026-08-15"); // 快照更新日与报告期分开呈现
    expect(html).toContain("2001-08-27");
    expect(html).toContain("15910.41 亿"); // 总市值，与真实市值同量级
    expect(html).toContain("6.33"); // PB
    expect(html).toContain("17.87"); // 年化 PE
    expect(html).toContain("49.08%"); // 报告期净利率
    expect(html).toContain("18.60%"); // 资产负债率
    expect(html).toContain("17.72%"); // 报告期 ROE
    expect(html).toContain("159.7362"); // 每股未分配利润，与财务包一致
    expect(html).toContain("不是 TTM");
  });
  it("报告期无法判定时不给任何年化口径并说明原因", () => {
    const html = render(
      1272.75,
      null,
      "最近 8 期本地财务包都没有与该快照一致的记录",
    );
    expect(html).toContain("报告期 未确定");
    expect(html).toContain("最近 8 期本地财务包都没有与该快照一致的记录");
    expect(html).toContain("不可得：报告期未确定或每股收益不可得");
    // 不依赖报告期的口径仍然展示
    expect(html).toContain("6.33");
    expect(html).toContain("17.72%");
  });
  it("没有实时价时市值与估值留空并说明，其余口径仍展示", () => {
    const html = render(null);
    expect(html).toContain("不可得：实时价或总股本不可得");
    expect(html).toContain("不可得：实时价或每股净资产不可得");
    expect(html).toContain("49.08%");
    expect(html).not.toContain("15910.41 亿");
  });
  it("语义未确认的槽位单独隔离，报表明细按元展示", () => {
    const html = render(1272.75);
    expect(html).toContain("语义未确认的协议字段");
    expect(html).toContain("不换算单位、不当作股本使用");
    expect(html).toContain("法人股");
    expect(html).toContain("金额（元）");
    expect(html).toContain("3090.51 亿"); // 总资产按元展示
    expect(html).toContain("445.17 亿"); // 净利润按元展示
  });
});

describe("图表工作区挂载契约", () => {
  const file = "src/components/chart-workspace.tsx";
  const source = readFileSync(file, "utf8");
  it("按当前图表快照的证券唯一挂载，并从既有渲染指纹中摘除", () => {
    expect(source).toContain(
      "<TdxSnapshotContainer symbol={snapshot.symbol} />",
    );
    expect(withoutTdxSnapshotPanel(source)).not.toContain(
      "<TdxSnapshotContainer",
    );
  });
  it("换成写死代码、重复挂载或删除挂载都会被拒绝", () => {
    expect(() =>
      withoutTdxSnapshotPanel(
        source.replace(
          "<TdxSnapshotContainer symbol={snapshot.symbol} />",
          '<TdxSnapshotContainer symbol="sh600519" />',
        ),
      ),
    ).toThrow("唯一挂载");
    expect(() =>
      withoutTdxSnapshotPanel(
        source.replace(
          "<TdxSnapshotContainer symbol={snapshot.symbol} />",
          "<TdxSnapshotContainer symbol={snapshot.symbol} /><TdxSnapshotContainer symbol={snapshot.symbol} />",
        ),
      ),
    ).toThrow("唯一挂载");
    expect(() =>
      withoutTdxSnapshotPanel(
        source.replace("<TdxSnapshotContainer symbol={snapshot.symbol} />", ""),
      ),
    ).toThrow("唯一挂载");
  });
});
