import { describe, expect, it } from "vitest";
import type { AlertEvent } from "~/lib/strategy-facts/alerts";
import {
  alertChartHref,
  formatAlertReason,
  sleeveDisplayName,
  strategyDisplayName,
} from "~/lib/strategy-facts/strategy-display";

describe("strategyDisplayName", () => {
  it.each([
    [
      "r2a-cn-equity-historical-low-trailing-neighbor-entry-90",
      "历史低位 · 移动止损（入场参数-10%）",
    ],
    [
      "r2a-crypto-dual-ma-4h-atr-sizing-volatility-neighbor-entry-110",
      "双均线 4小时 · ATR止损 · 波动率（入场参数+10%）",
    ],
    [
      "r2a-cn-equity-historical-low-trailing-neighbor-110",
      "历史低位 · 移动止损（参数+10%）",
    ],
    [
      "r2a-crypto-dual-ma-4h-atr-sizing-volatility-neighbor-90",
      "双均线 4小时 · ATR止损 · 波动率（参数-10%）",
    ],
    ["r2a-cn-equity-chan-third-buy-atr", "缠论三买 · ATR止损"],
    ["r2a-cn-equity-double-breakout-time", "双突破 · 定时退出"],
    ["r2a-cn-equity-double-breakout-atr", "双突破 · ATR止损"],
    ["r2a-cn-equity-formula-ma-trailing", "均线公式 · 移动止损"],
    ["r2a-cn-equity-formula-pullback-atr", "回踩公式 · ATR止损"],
    ["r2a-cn-equity-formula-range-trailing", "区间公式 · 移动止损"],
    ["r2a-cn-equity-rps-multi-atr", "多周期RPS · ATR止损"],
    [
      "r2a-crypto-range-15m-time-sizing-equal",
      "区间突破 15分 · 定时退出 · 等权",
    ],
    ["r2-crypto-range-day-time", "区间突破 日线 · 定时退出"],
    ["r2-crypto-dual-ma-1h-atr", "双均线 1小时 · ATR止损"],
    ["historical-low", "历史低位"],
    ["double-breakout", "双突破"],
    ["dual-ma", "双均线"],
    ["chan-third-buy", "缠论三买"],
    ["rps-multi", "多周期RPS"],
    ["formula-ma", "均线公式"],
    ["formula-pullback", "回踩公式"],
    ["formula-range", "区间公式"],
    ["range", "区间突破"],
  ])("labels %s", (id, expected) => {
    expect(strategyDisplayName(id)).toBe(expected);
  });

  it("prefers supplied names and ignores blank catalog entries", () => {
    const id = "r2a-cn-equity-double-breakout-time";
    const names = new Map([
      [id, "我的突破策略"],
      ["custom", "自选策略"],
      ["range", "  "],
      ["dual-ma", ""],
    ]);
    expect(strategyDisplayName(id, names)).toBe("我的突破策略");
    expect(strategyDisplayName("custom", names)).toBe("自选策略");
    expect(strategyDisplayName("range", names)).toBe("区间突破");
    expect(strategyDisplayName("dual-ma", names)).toBe("双均线");
  });

  it.each([
    "p0-r2b-alert",
    "QA-r3b-decay",
    "toString",
    "r2a-cn-equity-custom-atr",
    "r2a-crypto-range-1h-atr-sizing-custom",
    "r2a-crypto-dual-ma-1h-atr-neighbor-120",
  ])("retains the entire unknown ID %s", (id) => {
    expect(strategyDisplayName(id)).toBe(id);
  });
});

describe("sleeveDisplayName", () => {
  it.each([
    ["swing", "波段"],
    ["low-zone", "低位区间"],
    ["breakout", "突破"],
    ["自选", "自选"],
    ["constructor", "constructor"],
  ])("labels %s", (sleeve, expected) => {
    expect(sleeveDisplayName(sleeve)).toBe(expected);
  });
});

describe("alertChartHref", () => {
  it.each(["sh600000", "sz000001", "bj920001"])(
    "opens %s with raw prices",
    (symbol) => {
      expect(alertChartHref({ symbol })).toBe(
        `/scan?symbol=${symbol}&adjustment=none`,
      );
    },
  );

  it("encodes symbols and routes crypto by either the prefix or the explicit market", () => {
    expect(alertChartHref({ symbol: "sh1&2", market: "cn-equity" })).toBe(
      "/scan?symbol=sh1%262&adjustment=none",
    );
    expect(alertChartHref({ symbol: "cxbtcusdt" })).toBe(
      "/scan?tab=crypto&pair=BTCUSDT",
    );
    expect(alertChartHref({ symbol: "cxethusdt", market: "cn-equity" })).toBe(
      "/scan?tab=crypto&pair=ETHUSDT",
    );
    expect(alertChartHref({ symbol: "eth/usdt", market: "crypto" })).toBe(
      "/scan?tab=crypto&pair=ETH%2FUSDT",
    );
  });
});

const event = {
  type: "entry",
  bar: "2026-11-19",
  price: null,
  stop: null,
  target: null,
  reason: "",
} satisfies Pick<
  AlertEvent,
  "type" | "bar" | "price" | "stop" | "target" | "reason"
>;

describe("formatAlertReason", () => {
  it("summarizes a historical-low exit without entry noise or duplicated prices", () => {
    expect(
      formatAlertReason({
        ...event,
        type: "exit",
        price: 58.2,
        reason:
          "收盘扫描：明日计划候选；策略复权条件：入场条件未通过；信号收盘 58.2000；低位深度 0 / 价格分位 81.1% / 回撤 -44.9%；完成bar 2026-11-19，原价58.2，止损=无，目标=无",
      }),
    ).toBe("收盘触发退出 · 触发价 58.20 · 价格分位 81.1% · 回撤 -44.9%");
  });

  it("shows entry levels once and retains warnings following the raw price record", () => {
    expect(
      formatAlertReason({
        ...event,
        price: 10,
        stop: 9.5,
        target: 12,
        reason:
          "收盘扫描：明日计划候选；策略复权条件：入场条件通过；RPS20 85.1 / RPS60 90.0；完成bar 2026-11-19，原价10.00，止损=9.5，目标=12；交易状态未知，请核验；仅影子记录",
      }),
    ).toBe(
      "收盘候选 · 触发价 10.00 · 止损 9.50 · 目标 12.00 · RPS20 85.1 · RPS60 90.0 · 交易状态未知，请核验 · 仅影子记录",
    );
  });

  it("keeps a distinct adjusted signal close alongside the raw event price", () => {
    expect(
      formatAlertReason({
        ...event,
        price: 10,
        reason:
          "已完成bar策略触发；策略复权条件：入场条件通过；信号收盘 9.2500；均线上穿",
      }),
    ).toBe("收盘触发 · 触发价 10.00 · 信号收盘 9.25 · 均线上穿");
  });

  it("keeps tiny crypto prices distinct and nonzero", () => {
    expect(
      formatAlertReason({
        ...event,
        price: 0.00001234,
        stop: 0.00001231,
        target: 0.00001239,
        reason: "信号收盘 0.0000123400",
      }),
    ).toBe("触发价 0.00001234 · 止损 0.00001231 · 目标 0.00001239");
  });

  it("keeps recorded evidence when structured prices are missing", () => {
    expect(
      formatAlertReason({
        ...event,
        reason: "信号收盘 5.1000；入场条件未知；低位深度 0；止损=无；目标=无",
      }),
    ).toBe("信号收盘 5.10 · 入场条件未知 · 低位深度 0");
  });

  it("retains nonzero exit depth and warnings appended inside the price clause", () => {
    expect(
      formatAlertReason({
        ...event,
        type: "exit",
        price: 5,
        reason:
          "已完成bar策略触发；低位深度 2 / 价格分位 10%；完成bar 2026-11-19，原价5，止损=无，目标=无，交易状态未知，请核验",
      }),
    ).toBe(
      "收盘触发退出 · 触发价 5.00 · 低位深度 2 · 价格分位 10% · 交易状态未知，请核验",
    );
  });

  it("preserves custom text, formula division, and checks involving a completed bar", () => {
    const manual = "人工复核 A / B，交易状态未知，请核验";
    expect(formatAlertReason({ ...event, reason: manual })).toBe(manual);
    expect(
      formatAlertReason({
        ...event,
        type: "stop",
        reason: "完成bar收盘穿越保护价",
      }),
    ).toBe("收盘K线收盘穿越保护价");
    expect(formatAlertReason({ ...event, reason: "入场条件未通过" })).toBe(
      "入场条件未通过",
    );
  });

  it("does not turn absent observations into zero or erase a recorded zero", () => {
    expect(formatAlertReason(event)).toBe("");
    expect(formatAlertReason({ ...event, price: 0, target: NaN })).toBe(
      "触发价 0.00",
    );
  });
});
