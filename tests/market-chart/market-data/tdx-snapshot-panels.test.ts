import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TdxQuoteBook } from "../../../src/components/market/tdx-quote-book";
import { QuoteBook } from "../../../src/components/market/quote-book";
import { TdxFundamentalSummary } from "../../../src/components/market/tdx-fundamental-summary";
import {
  thsdkOrderBookToDisplayModel,
  tdxQuoteToDisplayModel,
} from "../../../src/lib/market/quote-book-view";
import type {
  ThsdkOrderBookItem,
  ThsdkOrderBookLevel,
} from "../../../src/lib/market/thsdk-reference";
import type { QuoteSnapshot } from "../../../src/lib/market/tdx-quote-view";
import type {
  ReportFields,
  SnapshotOverlay,
} from "../../../src/lib/market/tdx-fundamentals";

vi.mock("../../../src/trpc/react", () => ({ api: {} }));

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
const report: ReportFields = {
  totalAssets: 309_050_784_000,
  currentAssets: 260_724_656_000,
  fixedAssets: 22_220_890_000,
  intangibleAssets: 8_578_744_000,
  inventory: 61_317_208_000,
  receivables: 570_895.0625,
  currentLiabilities: 46_645_076_000,
  nonCurrentLiabilities: 309_358_720,
  totalLiabilities: 46_954_434_720,
  reportedEps: 35.57,
  capitalReserve: 1_577_000,
  parentEquity: 251_253_600_000,
  mainRevenue: 90_703_264_000,
  operatingCost: 9_473_762_000,
  operatingProfit: 61_411_288_000,
  investmentIncome: 1_013_800,
  totalProfit: 61_438_420_000,
  afterTaxProfit: 46_033_328_000,
  netProfit: 44_516_880_000,
  undistributedProfit: 199_683_216_000,
  operatingCashFlow: 70_690_752_000,
  shareholders: 296_404,
  totalShares: 1_250_081_562.5,
  bookValuePerShare: 200.99,
};
const overlay: SnapshotOverlay = {
  totalShares: 1_250_081_562.5,
  floatShares: 1_250_081_562.5,
  stateShares: 1215,
  founderShares: 45_402_960,
  legalPersonShares: 89_389_352,
  bShares: 0,
  hShares: 0,
  employeeShares: 35.57,
  updatedDate: 20260815,
  ipoDate: 20010827,
  province: 22,
  industry: 471,
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

describe("来源无关盘口展示模型", () => {
  const renderModel = (
    model: Parameters<typeof QuoteBook>[0]["model"],
    testId = "quote-book",
  ) => renderToStaticMarkup(createElement(QuoteBook, { model, testId }));
  const thsdkLevel = (
    level: number,
    price: number | null,
    volume: number | null,
    state: ThsdkOrderBookLevel["state"] = price === null ? "empty" : "quoted",
  ): ThsdkOrderBookLevel => ({ level, price, volume, state });
  const thsdkItem = (
    overrides: Partial<ThsdkOrderBookItem> = {},
  ): ThsdkOrderBookItem => ({
    symbol: "sh510300",
    status: "ok",
    bids: [
      thsdkLevel(1, 3.951, 400),
      thsdkLevel(2, 3.95, 300),
      thsdkLevel(3, null, null, "unknown"),
    ],
    asks: [
      thsdkLevel(1, 3.952, 100),
      thsdkLevel(2, 3.953, 100),
      thsdkLevel(3, null, null, "empty"),
    ],
    volumeUnit: "份",
    fetchedAt: 1_700_000_000_000,
    dataAsOf: "2026-11-19",
    delayed: "unverified",
    ...overrides,
  });

  it("ETF 按 3 位小数展示，且缺失档位不补 0", () => {
    const model = tdxQuoteToDisplayModel(
      {
        ...quote,
        price: 1.234,
        preClose: 1.2,
        bids: [
          { price: 1.233, volume: 100 },
          { price: 0, volume: 0 },
        ],
        asks: [{ price: 1.235, volume: 200 }],
      },
      3,
      { hasOrderBook: true, session: "continuous" },
    );
    const html = renderModel(model, "quote-book-etf");
    expect(html).toContain('data-testid="quote-book-etf"');
    expect(html).toContain("1.234");
    expect(html).toContain("1.233");
    expect(html).toContain("1.235");
    expect(html).toContain("买1");
    expect(html).toContain("卖1");
  });

  it("可空模型保留 quoted / empty / unknown 三态", () => {
    const tdxEmpty = tdxQuoteToDisplayModel(
      { ...quote, bids: [], asks: [] },
      2,
      { hasOrderBook: false, session: "post" },
    );
    expect(tdxEmpty.state).toBe("empty");
    expect(renderModel(tdxEmpty)).toContain("不可得：五档无挂单");

    const thsdkQuoted = thsdkOrderBookToDisplayModel(thsdkItem(), 3);
    expect(thsdkQuoted.state).toBe("quoted");
    expect(thsdkQuoted.volumeUnit).toBe("份");
    expect(thsdkQuoted.asks.map((level) => level.level)).toEqual([3, 2, 1]);
    expect(thsdkQuoted.bids.map((level) => level.level)).toEqual([1, 2, 3]);
    // 买 700 / 卖 200 → 委差 +500，委比 +500/900
    expect(thsdkQuoted.imbalance.difference.value).toBe(500);
    expect(thsdkQuoted.imbalance.ratio.value).toBeCloseTo(5 / 9, 6);

    const thsdkEmpty = thsdkOrderBookToDisplayModel(
      thsdkItem({
        status: "empty",
        bids: [thsdkLevel(1, null, null, "empty")],
        asks: [thsdkLevel(1, null, null, "empty")],
      }),
      3,
    );
    expect(thsdkEmpty.state).toBe("empty");
    expect(thsdkEmpty.imbalance.ratio.value).toBeNull();
    expect(thsdkEmpty.imbalance.ratio.reason).toBe("五档无挂单");

    const thsdkUnknown = thsdkOrderBookToDisplayModel(
      thsdkItem({ status: "unavailable", message: "hq.dll 未就绪" }),
      3,
    );
    expect(thsdkUnknown.state).toBe("unknown");
    const html = renderModel(thsdkUnknown);
    expect(html).toContain("盘口不可得：hq.dll 未就绪");
    expect(html).not.toContain("卖1");
    expect(html).not.toContain("0.00");
  });

  it("两侧未知时委比/委差不可得，而不是 0", () => {
    const model = thsdkOrderBookToDisplayModel(
      thsdkItem({
        bids: [thsdkLevel(1, null, null, "unknown")],
        asks: [thsdkLevel(1, null, null, "unknown")],
      }),
      2,
    );
    expect(model.imbalance.difference.value).toBeNull();
    expect(model.imbalance.ratio.value).toBeNull();
    expect(model.imbalance.ratio.reason).toBe("两侧挂单未知");
    const html = renderModel(model);
    expect(html).toContain("不可得：两侧挂单未知");
  });
});

describe("基本面快照面板", () => {
  const render = (
    props: Partial<Parameters<typeof TdxFundamentalSummary>[0]> = {},
  ) =>
    renderToStaticMarkup(
      createElement(TdxFundamentalSummary, {
        report,
        reportDate: "2026-06-30",
        sourceFilename: "gpcw20260630.dat",
        price: 1272.75,
        overlay,
        overlayPending: false,
        ...props,
      }),
    );
  it("首屏用本地财务包出数并标明报告期与来源文件", () => {
    const html = render();
    expect(html).toContain("2026-06-30");
    expect(html).toContain("gpcw20260630.dat");
    expect(html).toContain("15910.41 亿"); // 总市值
    expect(html).toContain("6.33"); // PB
    expect(html).toContain("17.89"); // 年化 PE
    expect(html).toContain("50.75%"); // 报告期净利率
    expect(html).toContain("15.19%"); // 资产负债率
    expect(html).toContain("200.990"); // 由净资产自算的每股净资产
    expect(html).toContain("读盘即得、不依赖公共服务器");
    expect(html).toContain("不是 TTM");
  });
  it("协议快照到达前后都能用，口径标注随之变化", () => {
    const pending = render({ overlay: null, overlayPending: true });
    expect(pending).toContain("市值暂按报告期末股本计算");
    expect(pending).toContain("不可得：流通占比要等实时快照");
    // 不依赖快照的口径首屏就有
    expect(pending).toContain("6.33");
    expect(pending).toContain("50.75%");
    // 语义未确认的协议槽位只在快照到达后出现
    expect(pending).not.toContain("语义未确认的协议槽位");
    const ready = render();
    expect(ready).toContain("使用实时快照的最新股本");
    expect(ready).toContain("语义未确认的协议槽位");
    expect(ready).toContain("法人股");
    expect(ready).toContain("2001-08-27"); // 上市日期来自快照
  });
  it("快照失败与本地落后都显示原因，不影响本地数字", () => {
    const failed = render({
      overlay: null,
      overlayPending: false,
      overlayError: "连接超时",
    });
    expect(failed).toContain("实时快照读取失败：连接超时");
    expect(failed).toContain("50.75%");
    const lagged = render({ lag: "本地财务包最新一期是 2026-03-31" });
    expect(lagged).toContain("本地财务包最新一期是 2026-03-31");
  });
  it("没有实时价时市值与估值留空并说明，报表口径仍展示", () => {
    const html = render({ price: null });
    expect(html).toContain("不可得：实时价或总股本不可得");
    expect(html).toContain("50.75%");
    expect(html).not.toContain("15910.41 亿");
  });
  it("报表明细按元展示，且不含本地没有的字段", () => {
    const html = render();
    expect(html).toContain("金额（元）");
    expect(html).toContain("3090.51 亿"); // 总资产
    expect(html).toContain("445.17 亿"); // 净利润
    expect(html).toContain("经营现金流");
    expect(html).not.toContain("现金流合计");
  });
});
