import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  importDeliveryTable,
  type ParsedCashFlow,
  type ParsedFill,
} from "../src/lib/delivery-import";
import { parseDeliveryTable } from "../src/lib/delivery-table";
import { pageTradeReviewDrawdowns } from "../src/server/portfolio/trade-review-service";
import { dailyPerformance } from "../src/lib/daily-performance";
import {
  reviewTradeNav,
  type TradeReviewNavInput,
} from "../src/lib/trade-review-nav";

const d = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;
const fill = (
  date: string,
  kind: "buy" | "sell",
  price: number,
  quantity = 1,
  extra: Partial<ParsedFill> = {},
): ParsedFill => ({
  kind,
  rowIndex: 0,
  tradeDate: date,
  tradeTime: "10:00:00",
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price,
  quantity,
  amount: price * quantity,
  fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
  netAmount: (kind === "buy" ? -1 : 1) * price * quantity,
  balanceShares: null,
  balanceCash: null,
  orderId: null,
  dealId: null,
  businessFlag: null,
  summary: "",
  fingerprintSource: "",
  anomalies: [],
  ...extra,
});
const flow = (
  date: string,
  amount: number,
  extra: Partial<ParsedCashFlow> = {},
): ParsedCashFlow => ({
  kind: amount > 0 ? "transferIn" : "transferOut",
  rowIndex: 0,
  flowDate: date,
  flowTime: "09:00:00",
  code: null,
  name: null,
  amount,
  balanceCash: null,
  summary: "",
  fingerprintSource: "",
  ...extra,
});
const run = (extra: Partial<TradeReviewNavInput> = {}) =>
  reviewTradeNav({
    fills: [],
    cashFlows: [],
    tradingDays: [d(1), d(2), d(3)],
    bars: {},
    openingCash: 100,
    ...extra,
  });
const curve = (prices: number[], extra: Partial<TradeReviewNavInput> = {}) =>
  run({
    fills: [fill(d(1), "buy", prices[0]!)],
    openingCash: prices[0],
    tradingDays: prices.map((_, i) => d(i + 1)),
    bars: { sz000001: prices.map((close, i) => ({ date: d(i + 1), close })) },
    ...extra,
  });

describe("每日账户净值与风险", () => {
  it("U11 追加每标的市值前冻结既有合成 fixture 的聚合数值", () => {
    expect(
      curve([100, 90, 108]).days.map(({ marketValue, nav }) => ({
        marketValue,
        nav,
      })),
    ).toEqual([
      {
        marketValue: { value: 100, reason: null },
        nav: { value: 100, reason: null },
      },
      {
        marketValue: { value: 90, reason: null },
        nav: { value: 90, reason: null },
      },
      {
        marketValue: { value: 108, reason: null },
        nav: { value: 108, reason: null },
      },
    ]);
  });
  it("U1 首日亏损在旧回撤及追加新核中都计入期初本金", () => {
    // 买入100，当日收盘90：期初100至90亏10%，不能从首日收盘才计算回撤。
    const result = run({
      fills: [fill(d(1), "buy", 100)],
      bars: { sz000001: [{ date: d(1), close: 90 }] },
      tradingDays: [d(1)],
    });
    const segment = result.segments[0]!;
    expect(segment.maxDrawdown.value).toBeCloseTo(0.1, 14);
    expect(segment.wbtStats.maxDrawdown).toEqual(segment.maxDrawdown);
    expect(segment.wbtStats.coverage.availableDays).toBe(1);
    expect(
      dailyPerformance({
        returns: result.days.map((day) => day.dailyReturn.value),
        basis: "simple",
      }).maxDrawdown.value,
    ).toBeCloseTo(0.1, 14);
  });
  it("U1 追加指标不改变既有六项的特征化数值", () => {
    // 修改生产代码前运行既有 R9 curve 合成 fixture 记录；用完全相等冻结旧口径。
    const snapshot = {
      totalReturn: 0.08000000000000007,
      maxDrawdown: 0.09999999999999998,
      sharpe: 3.4559348284041187,
      sortino: 9.13636147992859,
      annualReturn: 641.0893416360549,
      calmar: 6410.89341636055,
    };
    const result = curve([100, 90, 108]).segments[0]!;
    for (const key of Object.keys(snapshot) as (keyof typeof snapshot)[])
      expect(result[key]).toEqual({ value: snapshot[key], reason: null });
  });
  it("R9 有时点估值的持仓出入金不改变任一风险指标或月度收益", () => {
    const baseline = curve([100, 90, 108], { annualRiskFreeRate: 0 });
    const funded = curve([100, 90, 108], {
      annualRiskFreeRate: 0,
      cashFlows: [
        flow(d(2), 1000000),
        flow(d(2), -1000000, { flowTime: "12:00:00" }),
      ],
      flowValuations: { 0: 90, 1: 1000090 },
    });
    expect(funded.days.map((day) => day.nav.value)).toEqual([100, 90, 108]);
    for (const key of [
      "totalReturn",
      "maxDrawdown",
      "sharpe",
      "sortino",
      "annualReturn",
      "calmar",
    ] as const)
      expect(funded.segments[0]![key].value).toBeCloseTo(
        baseline.segments[0]![key].value!,
        10,
      );
    expect(funded.segments[0]!.drawdowns).toEqual(
      baseline.segments[0]!.drawdowns,
    );
    expect(funded.monthlyReturns[0]!.return.value).toBeCloseTo(0.08);
  });
  it("R9 首日真实亏损进入回撤，单日基准缺少区间则留空", () => {
    const r = run({
      tradingDays: [d(1)],
      cashFlows: [flow(d(1), -20, { kind: "interest" })],
      benchmark: [{ date: d(1), close: 100 }],
    });
    expect(r.segments[0]!.totalReturn.value).toBeCloseTo(-0.2);
    expect(r.segments[0]!.maxDrawdown.value).toBeCloseTo(0.2);
    expect(r.segments[0]!.benchmark.totalReturn.value).toBeNull();
    expect(r.segments[0]!.benchmark.relativeDrawdown.value).toBeNull();
  });
  it("R9 月度缺失精确列出日期与流水；补充真实估值后恢复且净值不变", () => {
    const cashFlows = [flow(d(2), 1000), flow(d(3), -500)];
    const missing = curve([100, 110, 110], { cashFlows });
    expect(missing.days.map((day) => day.nav.value)).toEqual([100, 1110, 610]);
    expect(missing.monthlyReturns[0]!.return.value).toBeNull();
    expect(JSON.stringify(missing.monthlyReturns[0]!.return.reasons)).toContain(
      `${d(2)} 资金流水 0 缺少出入金前账户估值`,
    );
    expect(JSON.stringify(missing.monthlyReturns[0]!.return.reasons)).toContain(
      `${d(3)} 资金流水 1 缺少出入金前账户估值`,
    );
    const exact = curve([100, 110, 110], {
      cashFlows,
      flowValuations: { 0: 110, 1: 1110 },
    });
    expect(exact.days.map((day) => day.nav.value)).toEqual(
      missing.days.map((day) => day.nav.value),
    );
    expect(exact.monthlyReturns[0]!.return.value).toBeCloseTo(0.1);
    expect(exact.segments[0]!.totalReturn.value).toBeCloseTo(0.1);
    expect(exact.segments[0]!.maxDrawdown.value).toBe(0);
    expect(exact.basis.returns).toContain("日度TWR = Π");
    expect(exact.basis.monthly).toContain("任一天不可得则整月留空");
  });
  it("R9 首日收益也进入分段，十万出金五万不产生回撤", () => {
    const withdrawal = run({
      openingCash: 100000,
      cashFlows: [flow(d(2), -50000)],
    });
    expect(withdrawal.segments[0]!.totalReturn.value).toBe(0);
    expect(withdrawal.segments[0]!.maxDrawdown.value).toBe(0);
    expect(withdrawal.segments[0]!.drawdowns).toEqual([]);
    const profit = run({
      openingCash: 10000,
      cashFlows: [flow(d(1), 1000, { kind: "interest" }), flow(d(2), 1000000)],
    });
    expect(profit.twr.value).toBeCloseTo(0.1);
    expect(profit.segments[0]!.totalReturn.value).toBeCloseTo(0.1);
    expect(profit.monthlyReturns[0]!.return.value).toBeCloseTo(0.1);
    expect(profit.segments[0]!.returnObservations).toBe(3);
  });
  it.each([0, -100])(
    "R9 非正期初 %s 留空并说明原因，净值仍可得",
    (openingCash) => {
      const r = run({
        openingCash,
        tradingDays: [d(1)],
        cashFlows: [flow(d(1), 1000)],
      });
      expect(r.days[0]!.nav.value).toBe(openingCash + 1000);
      expect(r.days[0]!.dailyReturn.value).toBeNull();
      for (const key of [
        "totalReturn",
        "maxDrawdown",
        "sharpe",
        "sortino",
        "calmar",
      ] as const) {
        expect(r.segments[0]![key].value).toBeNull();
        expect(r.segments[0]![key].reason).toContain("期初净值非正");
      }
    },
  );
  it("纯现金出入金不构成收益或回撤", () => {
    const r = run({
      openingCash: 0,
      cashFlows: [flow(d(1), 100), flow(d(2), 1000), flow(d(3), -500)],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([100, 1100, 600]);
    expect(r.days.map((p) => p.cash.value)).toEqual([100, 1100, 600]);
    expect(r.twr.value).toBeNull();
    expect(JSON.stringify(r.twr.reasons)).toContain("期初净值非正");
    expect(r.segments[0]!.maxDrawdown.value).toBe(0);
    expect(r.segments[0]!.calmar.reason).toContain("回撤为零");
  });
  it("一买一卖逐日净值与20%回撤", () => {
    const r = curve([100, 80, 110], {
      fills: [fill(d(1), "buy", 100), fill(d(3), "sell", 110)],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([100, 80, 110]);
    expect(r.days.map((p) => p.cash.value)).toEqual([0, 0, 110]);
    expect(r.days[2]!.positions).toEqual({});
    expect(r.segments[0]!.maxDrawdown.value).toBeCloseTo(1 - 80 / 100);
    expect(r.twr.value).toBeCloseTo(0.1);
  });
  it("日期排序产生负现金；先卖后买时间排序消除假负数", () => {
    const fills = [
      fill(d(1), "buy", 100),
      fill(d(2), "buy", 100, 1, { tradeTime: "11:00:00" }),
      fill(d(2), "sell", 100),
    ];
    let cash = 100;
    const dateOnly = fills.map((f) => (cash += f.netAmount!));
    expect(Math.min(...dateOnly)).toBe(-100);
    const r = curve([100, 100, 100], { fills });
    expect(r.replay.map((p) => p.cash)).toEqual([0, 100, 0]);
    expect(r.minimumCash.value).toBe(0);
  });
  it("缺时间在已知时间之后；同时间按数组顺序而非跨文件行号", () => {
    const r = run({
      cashFlows: [
        flow(d(1), -50, { flowTime: null }),
        flow(d(1), 20, { rowIndex: 99 }),
        flow(d(1), 30, { rowIndex: 1 }),
      ],
    });
    expect(r.replay.map((e) => e.originalOrder)).toEqual([1, 2, 0]);
    expect(r.missingTimeCount).toBe(1);
    expect(r.warnings[0]).toContain("1 个事件缺少时间");
  });
  it("解析委托时间并把缺时间输出为null", () => {
    const data =
      "发生日期,委托时间,业务名称,发生金额,成交数量,成交价格\n20260101,093000,银行转证券,100,0,0\n20260102,,银行转证券,200,0,0";
    const parsed = importDeliveryTable(parseDeliveryTable(Buffer.from(data)));
    expect(parsed.cashFlows.map((f) => f.flowTime)).toEqual(["09:30:00", null]);
  });
  it("缺价中断；不在两个孤立净值间算夏普", () => {
    const r = curve([100, 80, 120], {
      bars: {
        sz000001: [
          { date: d(1), close: 100 },
          { date: d(3), close: 120 },
        ],
      },
    });
    expect(r.days[1]!.nav.value).toBeNull();
    expect(r.days[1]!.nav.reason).toContain(`${d(2)} sz000001`);
    expect(r.segments.map((s) => s.sharpe.value)).toEqual([null, null]);
    expect(r.usedTradingDays).toBe(1);
    expect(r.usedReturnObservations).toBe(1);
    expect(r.twr.value).toBeNull();
    expect(r.skippedIntervals.map((s) => s.start)).toEqual([d(2), d(3)]);
  });
  it("恢复数据后独立计算连续段并报告观察数", () => {
    const r = curve([100, 90, 80, 100, 110, 121], {
      bars: {
        sz000001: [100, 90, null, 100, 110, 121].flatMap((close, i) =>
          close === null ? [] : [{ date: d(i + 1), close }],
        ),
      },
    });
    expect(r.segments.map((s) => s.tradingDays)).toEqual([2, 3]);
    expect(r.usedTradingDays).toBe(5);
    expect(r.usedReturnObservations).toBe(4);
    expect(r.segments[1]!.totalReturn.value).toBeCloseTo(0.21);
  });
  it("一万元赚一千再入金一百万，TWR=10%", () => {
    const r = run({
      openingCash: 10000,
      cashFlows: [flow(d(2), 1000, { kind: "interest" }), flow(d(3), 1000000)],
    });
    expect(r.days.at(-1)!.nav.value).toBe(1011000);
    expect(r.twr.value).toBeCloseTo(0.1);
    expect(1011000 / 10000 - 1).toBe(100.1);
  });
  it("每次外部现金流分别切段，内部收益不剔除", () => {
    const r = run({
      cashFlows: [
        flow(d(2), 10, { kind: "interest", flowTime: "09:00:00" }),
        flow(d(2), 100, { flowTime: "10:00:00" }),
        flow(d(2), 21, { kind: "dividend", flowTime: "11:00:00" }),
        flow(d(2), -100, { flowTime: "12:00:00" }),
      ],
    });
    // 110/100 * 231/210 * 131/131 - 1 = 21%.
    expect(r.days[1]!.nav.value).toBe(131);
    expect(r.twr.value).toBeCloseTo(0.21);
  });
  it("持仓期间出入金必须有时点估值，日线不能冒充", () => {
    const cashFlows = [flow(d(2), 1000)];
    const missing = curve([100, 110, 110], { cashFlows });
    expect(missing.days[1]!.nav.value).toBe(1110);
    expect(missing.twr.value).toBeNull();
    expect(missing.days[1]!.dailyReturn.reason).toContain(
      "缺少出入金前账户估值",
    );
    const exact = curve([100, 110, 110], {
      cashFlows,
      flowValuations: { 0: 110 },
    });
    expect(exact.twr.value).toBeCloseTo(0.1);
  });
  it("Sortino、Calmar、夏普按声明分母手算", () => {
    const r = curve([100, 90, 108], { annualRiskFreeRate: 0 });
    const s = r.segments[0]!;
    // Include opening-to-first-close: returns 0, -0.1, +0.2; mean 1/30.
    const mean = 0.1 / 3;
    expect(s.sortino.value).toBeCloseTo(
      (mean / Math.sqrt(0.01 / 3)) * Math.sqrt(252),
    );
    expect(s.sharpe.value).toBeCloseTo(
      (mean /
        Math.sqrt((mean ** 2 + (-0.1 - mean) ** 2 + (0.2 - mean) ** 2) / 2)) *
        Math.sqrt(252),
    );
    expect(s.calmar.value).toBeCloseTo((1.08 ** (252 / 3) - 1) / 0.1);
    const rf = 1.02 ** (1 / 252) - 1;
    expect(curve([100, 90, 108]).segments[0]!.sortino.value).toBeCloseTo(
      ((mean - rf) / Math.sqrt((rf ** 2 + (-0.1 - rf) ** 2) / 3)) *
        Math.sqrt(252),
    );
  });
  it("回撤峰谷恢复及未恢复区间", () => {
    const result = curve([100, 90, 80, 100, 95, 90]).segments[0]!.drawdowns;
    expect(result).toEqual([
      {
        peakDate: d(4),
        troughDate: d(6),
        recoveryDate: null,
        recovered: false,
        underwaterTradingDays: 2,
        drawdownTradingDays: 2,
        recoveryTradingDays: null,
        drawdown: expect.closeTo(0.1),
      },
      {
        peakDate: d(1),
        troughDate: d(3),
        recoveryDate: d(4),
        recovered: true,
        underwaterTradingDays: 2,
        drawdownTradingDays: 2,
        recoveryTradingDays: 1,
        drawdown: expect.closeTo(0.2),
      },
    ]);
  });
  it("U3 交易日位置差、相同谷底与单次持平修复，不按自然日计数", () => {
    const dates = [
      "2026-01-02",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-12",
    ];
    const prices = [100, 80, 80, 90, 100, 70, 100];
    const result = curve(prices, {
      fills: [fill(dates[0]!, "buy", 100)],
      tradingDays: dates,
      bars: {
        sz000001: prices.map((close, i) => ({ date: dates[i]!, close })),
      },
    }).segments[0]!.drawdowns;
    expect(result).toEqual([
      {
        peakDate: dates[4],
        troughDate: dates[5],
        recoveryDate: dates[6],
        recovered: true,
        underwaterTradingDays: 1,
        drawdownTradingDays: 1,
        recoveryTradingDays: 1,
        drawdown: expect.closeTo(0.3),
      },
      {
        peakDate: dates[0],
        troughDate: dates[1],
        recoveryDate: dates[4],
        recovered: true,
        underwaterTradingDays: 3,
        drawdownTradingDays: 1,
        recoveryTradingDays: 3,
        drawdown: expect.closeTo(0.2),
      },
    ]);
  });
  it.each([
    [100, 90, 80, 100, 95, 90],
    [100, 69.84, 100, 99],
    [100, 101, 102],
    [100, 90, 100, 90, 100],
  ])("U3 最深段与 U1 wbtStats 及现有 maxDrawdown 一致：%j", (...prices) => {
    const segment = curve(prices).segments[0]!;
    const deepest = Math.max(
      0,
      ...segment.drawdowns.map((row) => row.drawdown),
    );
    expect(deepest).toBe(segment.wbtStats.maxDrawdown.value);
    expect(deepest).toBe(segment.maxDrawdown.value);
    // 独立 underwater 谷底：迭代剥离的第一轮即全局最深段。
    let peak = prices[0]!;
    const underwater = prices.map((value) => {
      peak = Math.max(peak, value);
      return 1 - value / peak;
    });
    expect(deepest).toBeCloseTo(Math.max(...underwater), 14);
  });
  it("U3 单调上涨零段，超过 Top 10 的全量数据不截断", () => {
    expect(curve([100, 101, 102]).segments[0]!.drawdowns).toEqual([]);
    const prices = [100, ...Array.from({ length: 12 }, () => [90, 100]).flat()];
    const result = curve(prices).segments[0]!.drawdowns;
    expect(result).toHaveLength(12);
    expect(result.map((row) => row.peakDate)).toEqual(
      Array.from({ length: 12 }, (_, i) => d(i * 2 + 1)),
    );
  });

  it("月度收益包含跨月首日对前月末的收益", () => {
    const dates = ["2026-01-30", "2026-02-02", "2026-02-03"];
    const r = run({
      tradingDays: dates,
      cashFlows: [
        flow(dates[1]!, 10, { kind: "interest" }),
        flow(dates[2]!, 11, { kind: "interest" }),
      ],
    });
    expect(r.monthlyReturns.map((m) => m.return.value)).toEqual([
      0,
      expect.closeTo(0.21),
    ]);
  });
  it("月内缺口使整月收益不可得", () => {
    const r = curve([100, 100], { bars: {} });
    expect(r.monthlyReturns[0]!.return.value).toBeNull();
    expect(JSON.stringify(r.monthlyReturns[0]!.return.reasons)).toContain(
      "sz000001",
    );
  });
  it("基准收益、超额与相对回撤手算，缺基准不污染主指标", () => {
    const r = curve([100, 90, 108], {
      benchmark: [100, 100, 120].map((close, i) => ({ date: d(i + 1), close })),
    });
    const b = r.segments[0]!.benchmark;
    expect(b.totalReturn.value).toBeCloseTo(0.2);
    expect(b.excessReturn.value).toBeCloseTo(0.08 - 0.2);
    expect(b.relativeDrawdown.value).toBeCloseTo(1 - 0.9 / 1);
    const missing = curve([100, 90, 108], {
      benchmark: [{ date: d(1), close: 100 }],
    });
    expect(missing.segments[0]!.benchmark.totalReturn.value).toBeNull();
    expect(missing.segments[0]!.benchmark.totalReturn.reason).toContain(d(2));
    expect(missing.segments[0]!.maxDrawdown.value).toBeCloseTo(0.1);
  });
  it("实际发生额优先，缺失才退回费用合计，费用未知不补零", () => {
    const fills = [fill(d(1), "buy", 10, 1, { netAmount: -12 })];
    expect(run({ fills }).days[0]!.cash.value).toBe(88);
    const f = fill(d(1), "buy", 10, 1, { netAmount: null });
    f.fees.total = 2;
    const fallback = run({ fills: [f] });
    expect(fallback.days[0]!.cash.value).toBe(88);
    expect(fallback.warnings[0]).toContain("退回");
    f.fees.total = null;
    expect(run({ fills: [f] }).minimumCash.value).toBeNull();
    expect(run({ fills: [f] }).days[2]!.cash.value).toBeNull();
  });
  it("真实负现金不调整期初值并报告日内最低点", () => {
    const r = run({
      openingCash: 0,
      cashFlows: [flow(d(1), -20), flow(d(1), 100, { flowTime: "11:00:00" })],
    });
    expect(r.minimumCash.value).toBe(-20);
    expect(r.minimumDate).toBe(d(1));
    expect(r.days[0]!.cash.value).toBe(80);
    expect(r.warnings.join()).toContain("未自动调整");
  });
  it("逆回购方向为卖出融出、买入收回；排除市值但保留现金", () => {
    const r = run({
      fills: [
        fill(d(1), "sell", 100, 1, {
          instrument: "reverseRepo",
          code: "131810",
          netAmount: -100,
        }),
        fill(d(2), "buy", 100, 1, {
          instrument: "reverseRepo",
          code: "131810",
          netAmount: 101,
        }),
      ],
    });
    expect(r.days.map((p) => p.cash.value)).toEqual([0, 101, 101]);
    expect(r.days[0]!.nav.value).toBe(100);
    expect(r.days.map((p) => p.marketValue.value)).toEqual([0, 0, 0]);
    expect(r.days.map((p) => p.positions)).toEqual([{}, {}, {}]);
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      100, 0, 0,
    ]);
    expect(r.days[1]!.nav.value).toBe(101);
  });
  it("超卖不产生虚假持仓市值，申购缴款只扣现金", () => {
    expect(
      run({ fills: [fill(d(1), "sell", 100)] }).days[0]!.nav.reason,
    ).toContain("超卖");
    expect(
      run({ cashFlows: [flow(d(1), -10, { kind: "subscription" })] }).days[0]!
        .nav.value,
    ).toBe(90);
  });
  it("零金额配号与验资不打断持仓净值，按类型报告跳过笔数", () => {
    const r = curve([100, 80, 110], {
      cashFlows: [
        flow(d(2), 0, { kind: "neutral", code: "799999", summary: "验资配号" }),
        flow(d(2), 0, {
          kind: "subscription",
          code: "708162",
          summary: "申购配号",
        }),
        flow(d(3), 0, {
          kind: "subscription",
          code: "001210",
          summary: "起始配号",
        }),
        flow(d(3), 0, { kind: "transferIn", summary: "查询" }),
      ],
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([100, 80, 110]);
    expect(r.twr.value).toBeCloseTo(0.1);
    expect(r.segments[0]!.maxDrawdown.value).toBeCloseTo(0.2);
    expect(r.warnings.join()).toContain("跳过 4 笔");
    expect(r.warnings.join()).toContain(
      "neutral：1 笔、subscription：2 笔、transferIn：1 笔",
    );
  });
  it.each([
    { kind: "neutral" as const, summary: "送转到账" },
    { kind: "neutral" as const, summary: "中签入库" },
    { kind: "dividend" as const, summary: "红股到账" },
    { kind: "neutral" as const, summary: "验资", quantity: 10 },
  ])("零金额但声称股份变化仍留空：%j", (evidence) => {
    const r = curve([100, 80, 110], { cashFlows: [flow(d(2), 0, evidence)] });
    expect(r.days.map((day) => day.nav.value)).toEqual([100, null, null]);
    expect(r.days[1]!.nav.reason).toContain("股份变动");
    expect(r.warnings.join()).not.toContain("跳过");
  });
  it("空日历、非正净值与重复行情不给假风险值", () => {
    expect(run({ tradingDays: [] }).twr.value).toBeNull();
    const emptyCapital = run({ openingCash: 0 });
    expect(emptyCapital.segments).toHaveLength(3);
    expect(emptyCapital.segments.map((s) => s.totalReturn.value)).toEqual([
      null,
      null,
      null,
    ]);
    expect(emptyCapital.segments[0]!.totalReturn.reason).toContain(
      "期初净值非正",
    );
    expect(
      curve([100], {
        bars: {
          sz000001: [
            { date: d(1), close: 100 },
            { date: d(1), close: 100 },
          ],
        },
      }).days[0]!.nav.value,
    ).toBeNull();
    expect(() => run({ cashFlows: [flow(d(5), 10)] })).toThrow("未覆盖");
    expect(() => run({ annualRiskFreeRate: -1 })).toThrow("利率无效");
  });
  it("不修改调用方输入", () => {
    const input = {
      fills: [fill(d(2), "buy", 10)],
      cashFlows: [flow(d(1), 100)],
      bars: {},
      tradingDays: [d(3), d(1), d(2)],
    };
    const before = structuredClone(input);
    reviewTradeNav(input);
    expect(input).toEqual(before);
  });
});

describe("R7 持仓连续性", () => {
  it("中签缴款不猜代码映射；无买入的卖出以零余额确认清仓", () => {
    const r = run({
      openingCash: 2000,
      cashFlows: [
        flow(d(1), -1000, {
          kind: "subscription",
          code: "370409",
          summary: "中签缴款",
          quantity: 10,
        }),
      ],
      fills: [
        fill(d(2), "sell", 120, 10, {
          code: "123190",
          symbol: "sz123190",
          instrument: "convertible",
          balanceShares: 0,
        }),
      ],
    });
    expect(r.days.map((day) => day.positions)).toEqual([{}, {}, {}]);
    expect(r.days.map((day) => day.nav.value)).toEqual([1000, 2200, 2200]);
    expect(r.days[1]!.dailyReturn.value).toBeNull();
    expect(r.segments[1]!.totalReturn.value).toBe(0);
    expect(r.warnings.join()).not.toContain("370409 持仓未知");
    expect(r.warnings.join()).toContain(
      "sz123190 原始行 0 柜台股份余额 0，持仓恢复确定",
    );
  });

  it("未知股份期间留空，明确清零后恢复并独立计算TWR", () => {
    const r = run({
      tradingDays: [d(1), d(2), d(3), d(4), d(5)],
      cashFlows: [
        flow(d(2), 0, { kind: "neutral", code: "000001", summary: "股份入库" }),
        flow(d(5), 12, { kind: "interest" }),
      ],
      fills: [fill(d(3), "sell", 10, 2, { balanceShares: 0 })],
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([
      100,
      null,
      120,
      120,
      132,
    ]);
    expect(r.days[1]!.nav.reason).toContain("sz000001 neutral 流水");
    expect(r.days[2]!.dailyReturn.value).toBeNull();
    expect(r.segments.map((s) => [s.start, s.end])).toEqual([
      [d(1), d(1)],
      [d(3), d(5)],
    ]);
    expect(r.segments[1]!.totalReturn.value).toBeCloseTo(0.1);
    expect(r.skippedIntervals).toContainEqual({
      start: d(2),
      end: d(2),
      reason: r.days[1]!.nav.reason,
    });
    expect(r.twr.value).toBeNull();
  });

  it("确认数量后卖出量对齐可清零，不回填未知历史", () => {
    const r = run({
      cashFlows: [
        flow(d(1), 0, { kind: "neutral", code: "000001", summary: "股份转入" }),
      ],
      fills: [
        fill(d(2), "sell", 10, 1, { balanceShares: 2 }),
        fill(d(3), "sell", 10, 2),
      ],
      bars: { sz000001: [{ date: d(2), close: 10 }] },
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([null, 130, 130]);
    expect(r.days[2]!.positions).toEqual({});
  });

  it("未知数量不能因已记录买卖恰好抵消而恢复", () => {
    const r = run({
      fills: [fill(d(1), "buy", 10), fill(d(3), "sell", 10)],
      cashFlows: [
        flow(d(2), 0, { kind: "neutral", code: "000001", summary: "股份转入" }),
      ],
      bars: { sz000001: [1, 2, 3].map((n) => ({ date: d(n), close: 10 })) },
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([100, null, null]);
    expect(r.days[2]!.nav.reason).toContain("股份变动");
  });

  it("一个标的清零不能清除其他标的或未识别证券的未知状态", () => {
    const r = run({
      cashFlows: [
        flow(d(1), 0, { kind: "neutral", code: "000001", summary: "股份入库" }),
        flow(d(1), 0, { kind: "neutral", code: "000002", summary: "股份入库" }),
        flow(d(1), 0, { kind: "neutral", summary: "股份入库" }),
      ],
      fills: [fill(d(2), "sell", 10, 1, { balanceShares: 0 })],
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([null, null, null]);
    expect(r.days[2]!.nav.reason).not.toContain("sz000001");
    expect(r.days[2]!.nav.reason).toContain("000002");
    expect(r.days[2]!.nav.reason).toContain("未识别证券");
  });

  it("超卖后无余额证据不能因后续买入抵消负数而恢复", () => {
    const r = run({ fills: [fill(d(1), "sell", 10), fill(d(2), "buy", 10)] });
    expect(r.days.map((day) => day.nav.value)).toEqual([null, null, null]);
    expect(r.days[2]!.nav.reason).toContain("超卖");
  });

  it("柜台负现金保留原值并解释未记录入金而非透支", () => {
    const r = run({
      openingCash: 1288.42,
      fills: [fill(d(1), "buy", 167094.38, 1, { balanceCash: -165805.96 })],
    });
    expect(r.minimumCash.value).toBe(-165805.96);
    expect(r.days[0]!.cash.value).toBe(-165805.96);
    expect(r.warnings.join()).toContain("该负值来自柜台余额序列");
    expect(r.warnings.join()).toContain(
      "交割单之外的资金流入未被记录，不是账户透支",
    );
  });
});

describe("R4b 柜台余额重放", () => {
  it("余额一致时采用，冲突时采用余额但报告差额且不计算假收益", () => {
    const fills = [
      fill(d(1), "buy", 10, 1, { balanceCash: 90 }),
      fill(d(2), "sell", 12, 1, { balanceCash: 102 }),
    ];
    const consistent = run({ fills });
    expect(consistent.replay.map((e) => e.cash)).toEqual([90, 102]);
    expect(consistent.warnings).toEqual([]);
    fills[1]!.balanceCash = 152;
    const conflict = run({ fills });
    expect(conflict.days[1]!.cash.value).toBe(152);
    expect(conflict.warnings.join()).toContain("差异 50.00");
    expect(conflict.days[1]!.dailyReturn.value).toBeNull();
  });
  it("首笔反推期初，调用方冲突不覆盖；缺实际发生额不反推", () => {
    const fills = [fill(d(1), "buy", 10, 1, { balanceCash: 90 })];
    expect(run({ fills, openingCash: undefined })).toMatchObject({
      openingCash: 100,
      inferredOpeningCash: 100,
    });
    const conflict = run({ fills, openingCash: 50 });
    expect(conflict.openingCash).toBe(50);
    expect(conflict.warnings.join()).toContain("期初现金冲突");
    expect(conflict.days[0]!.cash.value).toBe(90);
    fills[0]!.netAmount = null;
    expect(
      run({ fills, openingCash: undefined }).inferredOpeningCash,
    ).toBeNull();
  });
  it("倒序日期同日正序按原始行重放；整表反转产生三处余额跳变", () => {
    const fills = [
      fill(d(2), "buy", 20, 1, {
        rowIndex: 1,
        tradeTime: null,
        balanceCash: 85,
      }),
      fill(d(2), "sell", 25, 1, {
        rowIndex: 2,
        tradeTime: null,
        balanceCash: 110,
      }),
      fill(d(1), "buy", 10, 1, {
        rowIndex: 3,
        tradeTime: null,
        balanceCash: 90,
      }),
      fill(d(1), "sell", 15, 1, {
        rowIndex: 4,
        tradeTime: null,
        balanceCash: 105,
      }),
    ];
    const jumps = (rows: ParsedFill[]) =>
      rows
        .slice(1)
        .filter(
          (f, i) =>
            Math.abs(f.balanceCash! - rows[i]!.balanceCash! - f.netAmount!) >
            0.005,
        ).length;
    expect(jumps([...fills].reverse())).toBe(3);
    const sorted = [...fills].sort(
      (a, b) =>
        a.tradeDate.localeCompare(b.tradeDate) || a.rowIndex - b.rowIndex,
    );
    expect(jumps(sorted)).toBe(0);
    const r = run({
      fills: [fills[1]!, fills[3]!, fills[0]!, fills[2]!],
      openingCash: undefined,
    });
    expect(r.openingCash).toBe(100);
    expect(r.replay.map((e) => e.cash)).toEqual([90, 105, 85, 110]);
    expect(r.warnings.join()).not.toContain("差异");
  });
  it("合成交割单反推10000，十笔成交排序自洽并保留62元待核对缺口", () => {
    const parsed = importDeliveryTable(
      parseDeliveryTable(
        readFileSync("tests/fixtures/delivery/ths-settlement.txt"),
      ),
    );
    const r = reviewTradeNav({
      fills: parsed.fills,
      cashFlows: parsed.cashFlows,
      tradingDays: [...parsed.fills.map((f) => f.tradeDate), "2024-04-02"],
      bars: {},
    });
    expect(r.inferredOpeningCash).toBe(10000);
    expect(r.replay).toHaveLength(10);
    expect(r.replay.at(-1)!.cash).toBe(10717.5);
    expect(r.warnings.join()).not.toContain("差异");
    expect(10779.5 - r.replay.at(-1)!.cash!).toBe(62);
  });
  it("有更早资金事件时不把首笔成交前余额误当账户期初", () => {
    const r = run({
      openingCash: undefined,
      cashFlows: [flow(d(1), 100)],
      fills: [fill(d(2), "buy", 10, 1, { balanceCash: 90 })],
    });
    expect(r.openingCash).toBe(0);
    expect(r.inferredOpeningCash).toBeNull();
    expect(r.days[1]!.cash.value).toBe(90);
  });
});

describe("R10 逆回购本金债权", () => {
  const repo = (
    day: number,
    kind: "buy" | "sell",
    amount = 99000,
    netAmount = kind === "sell" ? -amount : amount + 16.71,
    code = "204001",
    quantity = amount / (code.startsWith("131") ? 100 : 1000),
  ) =>
    fill(d(day), kind, 1.5, quantity, {
      instrument: "reverseRepo",
      code,
      symbol: null,
      amount,
      netAmount,
    });

  it("两条腿都记为卖出时，按发生金额符号判定融出与回款", () => {
    // 真实交割单里逆回购的融出与回款都写「卖出」，只有发生金额的符号不同。
    // 若按 buy/sell 判方向，回款会被当成又一次融出，本金只增不减、净值虚增。
    const r = run({
      openingCash: 100000,
      fills: [
        repo(1, "sell", 32000, -32000.32),
        repo(2, "sell", 32000, 32001.68),
      ],
    });
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      32000, 0, 0,
    ]);
    for (const [index, expected] of [99999.68, 100001.36, 100001.36].entries())
      expect(r.days[index]!.nav.value).toBeCloseTo(expected, 2);
  });

  it.each(["204001", "131801"])("%s 融出不损失本金，回款只增加利息", (code) => {
    const r = run({
      openingCash: 100000,
      fills: [
        repo(1, "sell", 99000, -99000, code),
        repo(2, "buy", 99000, 99016.71, code),
      ],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([
      100000, 100016.71, 100016.71,
    ]);
    expect(r.days.map((p) => p.cash.value)).toEqual([
      1000, 100016.71, 100016.71,
    ]);
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      99000, 0, 0,
    ]);
    expect(r.days.map((p) => p.marketValue.value)).toEqual([0, 0, 0]);
    expect(r.days.map((p) => p.positions)).toEqual([{}, {}, {}]);
    expect(r.days[0]!.dailyReturn.value).toBe(0);
    expect(r.twr.value).toBeCloseTo(16.71 / 100000);
    expect(r.basis.reverseRepo).toContain("利息在回款日确认为收益");
  });

  it("费用是当期成本，本金跨无成交日持续计入", () => {
    const r = run({
      openingCash: 100000,
      tradingDays: [1, 2, 3, 4, 5].map(d),
      fills: [repo(1, "sell", 99000, -99000.99), repo(5, "buy")],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([
      99999.01, 99999.01, 99999.01, 99999.01, 100015.72,
    ]);
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      99000, 99000, 99000, 99000, 0,
    ]);
    expect(r.twr.value).toBeCloseTo(15.72 / 100000);
  });

  it("同代码多笔本金支持部分回款", () => {
    const r = run({
      openingCash: 100000,
      fills: [
        repo(1, "sell", 30000),
        repo(1, "sell", 20000),
        repo(2, "buy", 30000),
        repo(3, "buy", 20000),
      ],
    });
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      50000, 20000, 0,
    ]);
    expect(r.days[2]!.nav.value).toBeCloseTo(100033.42);
  });

  it("不同代码不抵消负本金，后续融出不恢复未知状态", () => {
    const r = run({
      openingCash: 200000,
      fills: [
        repo(1, "sell"),
        repo(2, "buy", 99000, 99016.71, "131801"),
        repo(3, "sell", 99000, -99000, "131801"),
      ],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([200000, null, null]);
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      99000,
      null,
      null,
    ]);
    expect(r.warnings.join()).toContain("131801 原始行 0 未到期逆回购本金为负");
    expect(r.days[1]!.dailyReturn.value).toBeNull();
    expect(r.twr.value).toBeNull();
  });

  it("仅有回款的缺失期初本金留空", () => {
    const r = run({ fills: [repo(1, "buy")] });
    expect(r.days.map((p) => p.nav.value)).toEqual([null, null, null]);
    expect(r.days[0]!.nav.reason).toContain("回款多于融出或记录不全");
  });

  it.each([0, -1, NaN, Infinity])(
    "非法数量 %s 不从成交金额或净额猜本金",
    (quantity) => {
      const r = run({
        fills: [repo(1, "sell", 99000, -99, "204001", quantity)],
      });
      expect(r.days[0]!.cash.value).toBe(1);
      expect(r.days[0]!.reverseRepoPrincipal.value).toBeNull();
      expect(r.days[0]!.nav.reason).toContain("数量无效");
    },
  );

  it("逆回购持有期的出入金用现金加本金计算流前净值", () => {
    const r = run({
      openingCash: 100000,
      fills: [repo(1, "sell"), repo(3, "buy")],
      cashFlows: [flow(d(2), 100000)],
    });
    expect(r.days.map((p) => p.nav.value)).toEqual([
      100000,
      200000,
      expect.closeTo(200016.71, 8),
    ]);
    expect(r.days[1]!.dailyReturn.value).toBe(0);
    expect(r.twr.value).toBeCloseTo(16.71 / 200000);
  });
});

describe("R11 逆回购面值本金", () => {
  it.each([
    { code: "204001", quantity: 99, principal: 99000, interest: 16.71 },
    { code: "131810", quantity: 1260, principal: 126000, interest: 65.81 },
  ])(
    "$code 回款成交金额含利息，本金精确归零",
    ({ code, quantity, principal, interest }) => {
      const r = run({
        openingCash: principal,
        fills: [
          fill(d(1), "sell", 1.5, quantity, {
            instrument: "reverseRepo",
            code,
            amount: principal,
            netAmount: -principal,
          }),
          fill(d(2), "buy", 1.5, quantity, {
            instrument: "reverseRepo",
            code,
            amount: principal + interest,
            netAmount: principal + interest,
          }),
        ],
      });
      expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
        principal,
        0,
        0,
      ]);
      expect(r.days.map((p) => p.nav.value)).toEqual([
        principal,
        principal + interest,
        principal + interest,
      ]);
      expect(r.days.map((p) => p.cash.value)).toEqual([
        0,
        principal + interest,
        principal + interest,
      ]);
      expect(r.days[0]!.dailyReturn.value).toBe(0);
      expect(r.days[1]!.dailyReturn.value).toBeCloseTo(interest / principal);
      expect(r.twr.value).toBeCloseTo(interest / principal);
      expect(r.warnings).toEqual([]);
      expect(r.basis.reverseRepo).toContain("本金按面值计价");
      expect(r.basis.reverseRepo).toContain("利息在回款日确认为收益");
    },
  );

  it.each([0, -1, 126065.81, NaN, Infinity])(
    "成交金额 %s 不影响数量确定的本金",
    (amount) => {
      const r = run({
        openingCash: 126000,
        fills: [
          fill(d(1), "sell", 1.5, 1260, {
            instrument: "reverseRepo",
            code: "131810",
            amount,
            netAmount: -126000,
          }),
          fill(d(2), "buy", 1.5, 1260, {
            instrument: "reverseRepo",
            code: "131810",
            amount,
            netAmount: 126065.81,
          }),
        ],
      });
      expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
        126000, 0, 0,
      ]);
      expect(r.days.map((p) => p.nav.value)).toEqual([
        126000, 126065.81, 126065.81,
      ]);
    },
  );

  it("未知前缀报告无法确定面值，本金与净值持续留空", () => {
    const r = run({
      fills: [
        fill(d(1), "sell", 1.5, 1, {
          instrument: "reverseRepo",
          code: "999001",
          amount: 100,
          netAmount: -100,
        }),
      ],
    });
    expect(r.days.map((p) => p.cash.value)).toEqual([0, 0, 0]);
    expect(r.days.map((p) => p.reverseRepoPrincipal.value)).toEqual([
      null,
      null,
      null,
    ]);
    expect(r.days.map((p) => p.nav.value)).toEqual([null, null, null]);
    expect(r.days[0]!.reverseRepoPrincipal.reason).toContain(
      "999001 原始行 0 逆回购无法确定面值",
    );
    expect(r.warnings.join()).toContain("无法确定面值");
  });
});

it("U3 服务端跨页排序、未修复优先、全量导出与响应剥离", () => {
  const segment = curve([
    100,
    ...Array.from({ length: 11 }, (_, i) => [70 + i, 100]).flat(),
    99,
  ]).segments[0]!;
  const before = structuredClone(segment);
  const input = {
    pageIndex: 0,
    pageSize: 10,
    sort: "drawdown" as const,
    desc: true,
  };
  const first = pageTradeReviewDrawdowns([segment], input);
  const second = pageTradeReviewDrawdowns([segment], {
    ...input,
    pageIndex: 1,
  });
  expect(first.drawdownCount).toBe(12);
  expect(first.drawdowns).toHaveLength(10);
  expect(second.drawdowns).toHaveLength(2);
  expect(
    [...first.drawdowns, ...second.drawdowns].map((r) => r.peakDate),
  ).toEqual(segment.drawdowns.map((r) => r.peakDate));
  expect(first.drawdowns[0]!.recovered).toBe(false);
  expect(first.segments[0]).not.toHaveProperty("drawdowns");
  expect(
    pageTradeReviewDrawdowns([segment], { ...input, pageIndex: 2 }).drawdowns,
  ).toEqual([]);
  const ascending = pageTradeReviewDrawdowns([segment], {
    ...input,
    desc: false,
  });
  expect(ascending.drawdowns[0]!.recovered).toBe(false);
  expect(ascending.drawdowns[1]!.drawdown).toBeCloseTo(0.2);
  const dates = pageTradeReviewDrawdowns([segment], {
    ...input,
    sort: "peakDate",
    desc: false,
  });
  expect(dates.drawdowns.slice(0, 3).map((r) => r.peakDate)).toEqual([
    d(23),
    d(1),
    d(3),
  ]);
  expect(segment).toEqual(before);
  expect(JSON.parse(JSON.stringify(segment)).drawdowns).toHaveLength(12);
});

describe("W4 出入金估值模式", () => {
  it("冻结既有 fixture 默认模式的完整输出", () => {
    const cases = [
      curve([100, 90, 108]),
      curve([100, 110, 110], { cashFlows: [flow(d(2), 1000)] }),
      curve([100, 110, 110], {
        cashFlows: [flow(d(2), 1000)],
        flowValuations: { 0: 110 },
      }),
      run({ cashFlows: [flow(d(2), 100)] }),
    ];
    // Frozen before W4 implementation; exclude only the two new metadata fields.
    expect(
      cases.map(({ flowValuation, flowValuationNote, ...legacy }) => {
        expect(flowValuation).toBe("explicit");
        expect(flowValuationNote).toBeNull();
        return legacy;
      }),
    ).toMatchSnapshot();
    expect(
      curve([100, 110, 110], {
        cashFlows: [flow(d(2), 1000)],
        flowValuation: "explicit",
      }),
    ).toEqual(cases[1]);
  });
});

describe("W4 previousClose", () => {
  const sample = (extra: Partial<TradeReviewNavInput> = {}) =>
    curve([100, 110, 121], {
      cashFlows: [flow(d(2), 100)],
      flowValuation: "previousClose",
      ...extra,
    });
  it("三交易日手算：前收100作before，当日波动在流后", () => {
    const r = sample();
    expect(r.days.map((day) => day.nav.value)).toEqual([100, 210, 221]);
    // before=100: (100/100)*(210/(100+100))-1 = 5%; next day 221/210-1.
    expect(r.days[1]!.dailyReturn.value).toBeCloseTo(0.05);
    expect(r.twr.value).toBeCloseTo(221 / 200 - 1);
    expect(r).toEqual(sample({ flowValuations: { 0: 100 } }));
    expect(r.flowValuation).toBe("previousClose");
    expect(r.flowValuationNote).toBe(
      "缺失的出入金前估值以前一交易日收盘估值替代；单笔出入金时，当日市场波动计入出入金后一期；不是精确时点估值。",
    );
  });
  it("调用方110优先，非法显式值不能被补成有效值", () => {
    expect(
      sample({ flowValuations: { 0: 110 } }).days[1]!.dailyReturn.value,
    ).toBeCloseTo(0.1);
    for (const value of [NaN, Infinity, 0, -1])
      expect(
        sample({ flowValuations: { 0: value } }).days[1]!.dailyReturn.value,
      ).toBeNull();
  });
  it("前日缺行情不向更早追溯，首日也不以期初现金替代", () => {
    const r = sample({
      bars: {
        sz000001: [
          { date: d(1), close: 100 },
          { date: d(3), close: 121 },
        ],
      },
      cashFlows: [flow(d(3), 100)],
    });
    expect(r.days.map((day) => day.nav.value)).toEqual([100, null, 221]);
    expect(r.days[2]!.dailyReturn.value).toBeNull();
    expect(r.days[2]!.dailyReturn.reason).toContain("缺少出入金前账户估值");
    const first = sample({
      cashFlows: [flow(d(1), 100, { flowTime: "11:00:00" })],
    });
    expect(first.days[0]!.dailyReturn.value).toBeNull();
    expect(first.days[0]!.dailyReturn.reason).toContain("缺少出入金前账户估值");
  });
  it("前收包含现金、证券市值和逆回购本金", () => {
    const r = sample({
      openingCash: 1300,
      fills: [
        fill(d(1), "buy", 100),
        fill(d(1), "sell", 1, 1, {
          instrument: "reverseRepo",
          code: "204001",
          netAmount: -1000,
        }),
      ],
    });
    expect(r.days[0]!.cash.value).toBe(200);
    expect(r.days[0]!.reverseRepoPrincipal.value).toBe(1000);
    expect(r.days[0]!.nav.value).toBe(1300);
    // before=200+100+1000=1300; 1410/(1300+100)-1.
    expect(r.days[1]!.dailyReturn.value).toBeCloseTo(1410 / 1400 - 1);
  });
  it("空仓仍用事件时现金加本金，不使用显式值或前收", () => {
    const extra = {
      cashFlows: [
        flow(d(2), 10, { kind: "interest", flowTime: "08:00:00" }),
        flow(d(2), 100),
      ],
      flowValuations: { 1: 999 },
    };
    const explicit = run(extra);
    const proxy = run({ ...extra, flowValuation: "previousClose" });
    expect(proxy.days).toEqual(explicit.days);
    expect(proxy.twr.value).toBeCloseTo(0.1);
  });
  it.each(["explicit", "previousClose"] as const)(
    "%s 不绕过逆回购未知本金",
    (flowValuation) => {
      const r = sample({
        flowValuation,
        flowValuations: { 0: 100 },
        fills: [
          fill(d(1), "buy", 100),
          fill(d(2), "sell", 1, 1, {
            instrument: "reverseRepo",
            code: "999999",
            netAmount: -1,
            tradeTime: "08:00:00",
          }),
        ],
      });
      expect(r.days[1]!.nav.value).toBeNull();
      expect(r.days[1]!.dailyReturn.value).toBeNull();
      expect(r.days[1]!.dailyReturn.reason).toContain("缺少出入金前账户估值");
    },
  );
  it("同日多笔各用同一前收，不声称具有单笔波动归属", () => {
    const r = sample({ cashFlows: [flow(d(2), 100), flow(d(2), 100)] });
    // (100/100)*(100/200)*(310/200)-1 = -22.5%; known proxy limitation.
    expect(r.days[1]!.dailyReturn.value).toBeCloseTo(-0.225);
    expect(r.flowValuationNote).toContain("单笔出入金时");
  });
});
