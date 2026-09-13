import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParsedFill, ParsedCashFlow } from "../src/lib/delivery-import";
import {
  disciplineCounterfactual,
  runDisciplineGrid,
  disciplineGrid,
  disciplineNotice,
  disciplineScope,
  type DisciplineInput,
} from "../src/lib/discipline-counterfactual";
import * as navSource from "../src/lib/trade-review-nav";
import { reviewTradeNav } from "../src/lib/trade-review-nav";
import { DisciplineResults } from "../src/components/discipline-results";

const d = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;
const fill = (
  day: number,
  kind: "buy" | "sell",
  price: number,
  quantity = 100,
  patch: Partial<ParsedFill> = {},
): ParsedFill => ({
  kind,
  rowIndex: day,
  tradeDate: d(day),
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
  balanceCash: null,
  balanceShares: null,
  orderId: null,
  dealId: null,
  businessFlag: null,
  summary: "",
  fingerprintSource: "",
  anomalies: [],
  ...patch,
});
const input = (patch: Partial<DisciplineInput> = {}): DisciplineInput => ({
  fills: [fill(1, "buy", 10), fill(6, "sell", 11)],
  cashFlows: [],
  tradingDays: [1, 2, 3, 4, 5, 6].map(d),
  bars: {
    sz000001: [10, 9.8, 9, 8, 10, 11].map((close, i) => ({
      date: d(i + 1),
      open: close,
      close,
      high: close,
      low: close,
      volume: 100,
      amount: 100 * close,
    })),
  },
  openingCash: 5000,
  coverageEnd: d(6),
  exRightsEvents: [],
  stopCosts: { commissionBps: 0, minimumCommission: 0, sellTaxBps: 0 },
  ...patch,
});
const off = { maxAddOns: null, stopLossPct: null };
describe("W3 纪律反事实", () => {
  it("双关闭基线与 reviewTradeNav 逐项相等；A、B 分别校验", () => {
    const source = input();
    const point = disciplineCounterfactual(source, off);
    expect(point.nav).toEqual(reviewTradeNav(source));
    expect(point.netProfit).toBe(100);
    const grid = runDisciplineGrid(source);
    expect(grid.checks).toEqual({
      a: { count: 1, netProfit: 100, passed: true },
      b: { count: 1, netProfit: 100, passed: true },
    });
  });
  it("重放输入丢失卖出时 A 失败，诊断包含两侧实际金额和回合数", () => {
    const source = input();
    const nav = reviewTradeNav(source);
    const spy = vi.spyOn(navSource, "reviewTradeNav").mockReturnValueOnce({
      ...nav,
      replay: nav.replay.filter((e) => e.originalOrder !== 1),
    });
    try {
      expect(() => runDisciplineGrid(source)).toThrow(
        /双自校验失败.*"replayed":\{"a":\{"count":0,"netProfit":-1000\}.*"review":\{"a":\{"count":1,"netProfit":100\}/,
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("金额同为零也不能放过 A 回合数不一致", () => {
    const source = input({ fills: [fill(1, "buy", 10), fill(6, "sell", 10)] });
    const nav = reviewTradeNav(source);
    const spy = vi
      .spyOn(navSource, "reviewTradeNav")
      .mockReturnValueOnce({ ...nav, replay: [] });
    try {
      expect(() => runDisciplineGrid(source)).toThrow(
        /双自校验失败.*"replayed":\{"a":\{"count":0,"netProfit":0\}.*"review":\{"a":\{"count":1,"netProfit":0\}/,
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("三次买入限制一次加仓：第三笔资金留存，卖出按持仓缩减", () => {
    // 100*10 + 100*8 = 1800; block 100*6; sell 200*9=1800; profit=0.
    const source = input({
      fills: [
        fill(1, "buy", 10),
        fill(2, "buy", 8),
        fill(3, "buy", 6),
        fill(6, "sell", 9, 300),
      ],
    });
    const result = disciplineCounterfactual(source, {
      maxAddOns: 1,
      stopLossPct: null,
    });
    expect(result.execution.map((e) => e.originalIndex)).toEqual([0, 1, 3]);
    expect(result.execution.at(-1)!.fill.quantity).toBe(200);
    expect(result.nav.days[2]!.cash.value).toBe(3200);
    expect(result.netProfit).toBe(0);
    expect(result.nav.days.at(-1)!.cash.value).toBe(5000);
  });
  it("部分卖出后再加仓按剩余原持仓比例，费用同比分摊", () => {
    const source = input({
      fills: [
        fill(1, "buy", 10),
        fill(2, "buy", 10),
        fill(3, "sell", 12),
        fill(4, "buy", 10),
        fill(6, "sell", 12, 200, {
          fees: {
            commission: 2,
            stampTax: 0,
            transferFee: 0,
            otherFee: 0,
            total: 2,
          },
          netAmount: 2398,
        }),
      ],
    });
    const result = disciplineCounterfactual(source, {
      maxAddOns: 0,
      stopLossPct: null,
    });
    expect(result.execution.map((e) => e.fill.quantity)).toEqual([100, 50, 50]);
    // Sales 600 + (2398*1/4)=1199.5; buy1000; net199.5.
    expect(result.netProfit).toBe(199.5);
    expect(result.nav.days.at(-1)!.positions).toEqual({});
  });
  it("防前视锚点：第三日收盘判定，第四日开盘成交，绝非第三日收盘", () => {
    const result = disciplineCounterfactual(input(), {
      maxAddOns: null,
      stopLossPct: 0.05,
    });
    const stop = result.execution.find((e) => e.triggerDate)!;
    expect(stop.triggerDate).toBe(d(3));
    expect(stop.fill.tradeDate).toBe(d(4));
    expect(stop.fill.price).toBe(8);
    expect(stop.fill.price).not.toBe(9);
    expect(result.netProfit).toBe(-200);
    const future = input();
    future.bars = {
      sz000001: future.bars.sz000001!.map((b) =>
        b.date > d(4) ? { ...b, close: 900, open: 900 } : b,
      ),
    };
    expect(
      disciplineCounterfactual(future, { maxAddOns: null, stopLossPct: 0.05 })
        .execution,
    ).toEqual(result.execution);
  });
  it("开仓当天不判定；等于阈值不触发，次日收盘才检查", () => {
    const source = input({ fills: [fill(1, "buy", 10), fill(6, "sell", 11)] });
    source.bars = {
      sz000001: source.bars.sz000001!.map((b, i) => ({
        ...b,
        close: i === 0 ? 1 : i < 3 ? 9.5 : 10,
      })),
    };
    expect(
      disciplineCounterfactual(source, { maxAddOns: null, stopLossPct: 0.05 })
        .stoppedRounds,
    ).toBe(0);
  });
  it("缺判定日行情顺延，不以缺价猜止损", () => {
    const source = input();
    source.bars = {
      sz000001: source.bars.sz000001!.filter((b) => b.date !== d(3)),
    };
    const stop = disciplineCounterfactual(source, {
      maxAddOns: null,
      stopLossPct: 0.05,
    }).execution.find((e) => e.triggerDate)!;
    expect(stop.triggerDate).toBe(d(4));
    expect(stop.fill.tradeDate).toBe(d(5));
    expect(stop.fill.price).toBe(10);
  });
  it("止损成交日停牌顺延下一有成交量的开盘", () => {
    const source = input();
    source.bars = {
      sz000001: source.bars.sz000001!.map((b) =>
        b.date === d(4) ? { ...b, volume: 0 } : b,
      ),
    };
    const stop = disciplineCounterfactual(source, {
      maxAddOns: null,
      stopLossPct: 0.05,
    }).execution.find((e) => e.triggerDate)!;
    expect(stop.triggerDate).toBe(d(3));
    expect(stop.fill.tradeDate).toBe(d(5));
    expect(stop.fill.price).toBe(10);
  });
  it("止损后同回合剩余买卖全部作废，不影响后续独立回合", () => {
    const source = input({
      fills: [
        fill(1, "buy", 10),
        fill(4, "buy", 8),
        fill(5, "sell", 10, 200),
        fill(6, "buy", 11),
        fill(6, "sell", 12, 100, { tradeTime: "14:00:00" }),
      ],
    });
    const result = disciplineCounterfactual(source, {
      maxAddOns: null,
      stopLossPct: 0.05,
    });
    expect(result.execution.map((e) => e.originalIndex)).toEqual([
      0,
      null,
      3,
      4,
    ]);
    expect(result.roundCount).toBe(2);
    expect(result.stoppedRounds).toBe(1);
    expect(result.netProfit).toBe(-100);
  });
  it("反事实止损减少现金，不足一手时整个后续回合不发生", () => {
    const source = input({
      openingCash: 1000,
      fills: [
        fill(1, "buy", 10),
        fill(4, "sell", 12),
        fill(5, "buy", 10),
        fill(6, "sell", 11),
      ],
    });
    const result = disciplineCounterfactual(source, {
      maxAddOns: null,
      stopLossPct: 0.05,
    });
    expect(result.skippedRounds).toBe(1);
    expect(result.roundCount).toBe(1);
    expect(result.execution.map((e) => e.originalIndex)).toEqual([0, null]);
    expect(result.nav.days.at(-1)!.cash.value).toBe(800);
  });
  it("资金不足只买可用资金整手，不向上取整", () => {
    const source = input({
      openingCash: 1500,
      fills: [
        fill(1, "buy", 10),
        fill(4, "sell", 15),
        fill(5, "buy", 10, 200),
        fill(6, "sell", 11, 200),
      ],
    });
    const result = disciplineCounterfactual(source, {
      maxAddOns: null,
      stopLossPct: 0.05,
    });
    expect(
      result.execution.find((e) => e.originalIndex === 2)!.fill.quantity,
    ).toBe(100);
    expect(
      result.execution.find((e) => e.originalIndex === 3)!.fill.quantity,
    ).toBe(100);
    expect(result.nav.days.at(-1)!.cash.value).toBe(1400);
  });
  it("跨除权仅退出统计与规则，所有现金流原样保留", () => {
    const source = input({
      fills: [
        fill(1, "buy", 10),
        fill(2, "buy", 9),
        fill(5, "sell", 8, 200),
        fill(6, "buy", 10),
        fill(6, "sell", 11, 100, { tradeTime: "14:00:00" }),
      ],
      exRightsEvents: [{ security: "sz000001", date: d(3) }],
    });
    const r = runDisciplineGrid(source);
    expect(r.checks).toEqual({
      a: { count: 2, netProfit: -200, passed: true },
      b: { count: 1, netProfit: 100, passed: true },
    });
    expect(r.excludedCrossed).toBe(1);
    expect(r.excludedUnknown).toBe(0);
    for (const point of r.points) {
      expect(point.roundCount).toBe(1);
      expect(
        point.execution
          .slice(0, 3)
          .map((e) => [e.fill.quantity, e.fill.netAmount]),
      ).toEqual([
        [100, -1000],
        [100, -900],
        [200, 1600],
      ]);
      expect(point.nav.days[1]!.cash.value).toBe(3100);
    }
    expect(r.points.at(-1)!.nav).toEqual(reviewTradeNav(source));
  });
  it("覆盖截止日必须显式提供且覆盖末笔成交；未知事件证据拒绝整批", () => {
    for (const patch of [
      { coverageEnd: null },
      { coverageEnd: d(5) },
      { coverageEnd: "2026-02-30" },
      { exRightsEvents: undefined },
    ])
      expect(() => runDisciplineGrid(input(patch))).toThrow();
    expect(runDisciplineGrid(input()).coverageEnd).toBe(d(6));
  });
  it("逆回购报价不作股价，两条规则均不修改融出和回款", () => {
    const repo = {
      instrument: "reverseRepo" as const,
      code: "131810",
      symbol: "sz131810",
    };
    const source = input({
      fills: [
        fill(1, "buy", 10),
        fill(2, "sell", 2, 10, { ...repo, netAmount: -1000 }),
        fill(5, "sell", 2, 10, { ...repo, netAmount: 1001 }),
        fill(6, "sell", 11),
      ],
    });
    const r = disciplineCounterfactual(source, {
      maxAddOns: 0,
      stopLossPct: 0.05,
    });
    expect(
      r.execution
        .filter((e) => e.fill.instrument === "reverseRepo")
        .map((e) => e.fill.netAmount),
    ).toEqual([-1000, 1001]);
    expect(r.netProfit).toBe(-200);
    expect(r.nav.days.at(-1)!.cash.value).toBe(4801);
  });
  it("固定保留现金腿资金不足必须报不可用，不默许负现金", () => {
    const source = input({
      openingCash: 1000,
      fills: [
        fill(1, "buy", 10),
        fill(4, "sell", 12),
        fill(5, "sell", 2, 10, {
          instrument: "reverseRepo",
          code: "131810",
          symbol: "sz131810",
          netAmount: -1000,
        }),
      ],
    });
    expect(() =>
      disciplineCounterfactual(source, { maxAddOns: 0, stopLossPct: 0.05 }),
    ).toThrow("现金");
  });
  it("新止损使用显式实验费用，未来原卖出费用不影响止损结果", () => {
    const source = input({
      stopCosts: { commissionBps: 3, minimumCommission: 5, sellTaxBps: 5 },
    });
    const r = disciplineCounterfactual(source, {
      maxAddOns: 0,
      stopLossPct: 0.05,
    });
    expect(r.netProfit).toBeCloseTo(-205.4, 8);
    const later = source.fills.map((f) =>
      f.kind === "sell" ? { ...f, netAmount: 100 } : f,
    );
    expect(
      disciplineCounterfactual(
        { ...source, fills: later },
        { maxAddOns: 0, stopLossPct: 0.05 },
      ).execution,
    ).toEqual(r.execution);
  });
  it("现金流保持事件次序；不可观测流前估值不造整体回撤", () => {
    const flow: ParsedCashFlow = {
      kind: "transferIn",
      rowIndex: 2,
      flowDate: d(2),
      flowTime: "12:00:00",
      code: null,
      name: null,
      amount: 100,
      balanceCash: null,
      summary: "",
      fingerprintSource: "",
    };
    const r = disciplineCounterfactual(input({ cashFlows: [flow] }), {
      maxAddOns: 0,
      stopLossPct: 0.05,
    });
    expect(r.nav.days.at(-1)!.cash.value).toBe(4900);
    expect(r.maxDrawdown.value).toBeNull();
  });
  it("20 点全部同序产出；页面与导出显示 A/B/排除和固定措辞", () => {
    const result = runDisciplineGrid(input());
    expect(result.points.map((p) => p.rules)).toEqual(disciplineGrid);
    expect(result.points).toHaveLength(20);
    const html = renderToStaticMarkup(
      createElement(DisciplineResults, {
        data: {
          id: "test",
          account: "fixture",
          status: "complete",
          phase: "done",
          error: null,
          usageRecorded: true,
          warnings: [],
          result,
        },
      }),
    );
    for (const text of [
      disciplineNotice,
      disciplineScope,
      "A 口径正确性",
      "B 可比基线",
      "跨除权退出统计",
      "全部 20 点",
      "已记录 20 个候选",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("最优");
    expect(html).not.toContain("建议参数");
    const exported = JSON.stringify(result);
    expect(exported).toContain(disciplineNotice);
    expect(exported).toContain(disciplineScope);
  });
});
