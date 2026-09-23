import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { backtest } from "../src/server/backtest/quant";
import {
  actionReview,
  type BacktestActions,
} from "../src/server/backtest/backtest-actions";
import {
  bonusAdjustedSignals,
  bonusShares,
  AdjustmentUnavailableError,
} from "../src/server/backtest/bonus-adjusted-signals";
import { defaultStrategy, type Bar, type Snapshot } from "../src/lib/domain";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";
import {
  candidateTrialMatrix,
  walkForward,
} from "../src/server/backtest/walk-forward";
import { equityDailyReturns } from "../src/lib/multiple-testing";
import { walkForwardSchema } from "../src/lib/walk-forward";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AdjustmentDisclosure } from "../src/components/backtest/research-adjustment";
const strategy = {
  ...defaultStrategy,
  fast: 2,
  slow: 3,
  minChange: -30,
  maxChange: 30,
};
const costs = {
  ...defaultBacktestCosts,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const prices = (values: number[]): Bar[] =>
  values.map((p, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: p,
    high: p + 1,
    low: p - 1,
    close: p,
    volume: 10000,
    amount: p * 10000,
  }));
const event = (
  date: string,
  patch: Partial<BacktestActions["events"][number]> = {},
) => ({
  date,
  category: 1,
  name: "除权除息",
  dividend: 0,
  bonusRatio: 0,
  rightsRatio: 0,
  rightsPrice: 0,
  ...patch,
});
const review = (bars: Bar[], events: BacktestActions["events"] = []) =>
  actionReview({ symbol: "sz000001", source: "tdx-local", bars }, events, {
    file: "fixture",
    modified: 1,
    fetchedAt: 1,
  });
const run = (bars: Bar[], events: BacktestActions["events"], initial = 20000) =>
  backtest(bars, strategy, "fixture", initial, costs, 3, undefined, {
    adjustment: "backward",
    corporateActions: review(bars, events),
  });

it("10送10：1000×20 = 2000×10，策略和买入持有净值在送转时不变", () => {
  const bars = prices([16, 17, 18, 19, 20, 10]);
  const result = run(bars, [event(bars[5]!.date, { bonusRatio: 1 })]);
  expect(result.trades).toEqual([
    { date: bars[4]!.date, side: "buy", price: 20, shares: 1000, fee: 0 },
  ]);
  expect(result.shares).toBe(2000);
  expect(result.cash).toBe(0);
  expect(result.equity.slice(-2).map((e) => e.value)).toEqual([20000, 20000]);
  expect(result.benchmark!.equity.slice(-2).map((e) => e.value)).toEqual([
    21000, 21000,
  ]);
  expect(result.benchmark!.shares).toBe(2000);
  expect(result.diagnostics).toMatchObject({
    exDividendDays: 1,
    shareAdjustments: 1,
    fractionalShares: 0,
    dividendsIgnored: 0,
    rightsIssuesBlocked: 0,
    blockedEvents: { count: 0, events: [] },
  });
});
it.each([0, 1])(
  "现金不改股数或现金；送转比例=%s 的同日混合事件也只计算送转",
  (bonus) => {
    const bars = prices([16, 17, 18, 19, 20, bonus ? 10 : 20]);
    const without = run(bars, [event(bars[5]!.date, { bonusRatio: bonus })]);
    const withCash = run(bars, [
      event(bars[5]!.date, { bonusRatio: bonus, dividend: 0.5 }),
    ]);
    expect(withCash.shares).toBe(bonus ? 2000 : 1000);
    expect(withCash.cash).toBe(0);
    expect(withCash.equity).toEqual(without.equity);
    expect(withCash.benchmark).toEqual(without.benchmark);
    expect(withCash.dividends).toBeUndefined();
    expect(withCash.diagnostics.dividendsIgnored).toBe(1);
  },
);
it("纯除息仍留下价格跳空而非隐含现金再投资", () => {
  const bars = prices([16, 17, 18, 19, 20, 19]);
  const r = run(bars, [event(bars[5]!.date, { dividend: 1 })]);
  expect(r.shares).toBe(1000);
  expect(r.cash).toBe(0);
  expect(r.equity.at(-1)!.value).toBe(19000);
  expect(
    bonusAdjustedSignals(
      bars,
      review(bars, [event(bars[5]!.date, { dividend: 1 })]),
    ).changes.map((c) => c.factor),
  ).toEqual([1, 1, 1, 1, 1, 1]);
});
it("整数送转与碎股折现：100×1.003=100.3，0.3×10=3元", () => {
  expect(bonusShares(100, 0.3, 10)).toEqual({
    shares: 130,
    cash: 0,
    fractional: false,
  });
  const bars = prices([16, 17, 18, 19, 20, 10]);
  const r = run(bars, [event(bars[5]!.date, { bonusRatio: 0.003 })], 2000);
  expect(r.shares).toBe(100);
  expect(r.cash).toBeCloseTo(3, 10);
  expect(r.diagnostics.fractionalShares).toBe(1);
  expect(r.benchmark!.cash).toBeCloseTo(103, 10);
});
it.each([1, 11, 12, 13, 14])(
  "拒绝类别 %s，整段不可用且没有开始调整持仓",
  (category) => {
    const bars = prices([16, 17, 18, 19, 20, 10]);
    try {
      run(bars, [
        event(bars[5]!.date, {
          category,
          bonusRatio: 1,
          rightsRatio: category === 1 ? 0.1 : 0,
        }),
      ]);
      expect.fail("应当拒绝整段");
    } catch (error) {
      expect(error).toBeInstanceOf(AdjustmentUnavailableError);
      const e = error as AdjustmentUnavailableError;
      expect(e.status).toBe("unavailable");
      expect(e.message).toContain("整段不可用");
      expect(e.diagnostics.blockedEvents.count).toBe(1);
      expect(e.diagnostics.blockedEvents.events[0]!.category).toBe(category);
      expect(e.diagnostics.rightsIssuesBlocked).toBe(category === 1 ? 1 : 0);
      expect(e.diagnostics.shareAdjustments).toBe(0);
    }
  },
);
it("类别2至10不重复调整个人股份，判断来源可追溯", () => {
  const bars = prices([16, 17, 18, 19, 20, 21]);
  const r = run(
    bars,
    Array.from({ length: 9 }, (_, i) =>
      event(bars[5]!.date, { category: i + 2, bonusRatio: 1 }),
    ),
  );
  expect(r.shares).toBe(1000);
  expect(r.cash).toBe(0);
  expect(r.diagnostics.shareAdjustments).toBe(0);
  expect(r.assumptions.join(" ")).toContain("依据 W1 §8");
});
it("默认及显式none完整结果保持实现前特征化哈希，包括全部数值与假设", () => {
  const bars = prices([10, 11, 12, 13, 14, 15, 9, 8, 7]);
  const baseline = backtest(bars, strategy, "snapshot", 10000);
  // Captured from HEAD:src/server/backtest/quant.ts before W1, using the existing costs fixture.
  // S1 (Big.js money math) recaptured this hash: cash/fee arithmetic in
  // src/server/backtest/quant.ts now runs through src/lib/money.ts instead of plain
  // double +=/-=, which removes trailing float dust from every diffing
  // field (e.g. cash 5779.501400000001 -> 5779.5014, benchmark.cash
  // 890.4500000000007 -> 890.45, benchmark.trade.price
  // 13.006499999999999 -> 13.0065, maxDrawdown
  // 45.93594634287798 -> 45.93594634287799). No field changed by more than
  // float epsilon and no structural/shape change occurred; see
  // .codex-runs/s1-delivery.md for the full old-vs-new field diff.
  expect(
    createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
  ).toBe("5e83a0044518df442d8ab8d31cc807b3ea888b892199af57fdf3efcf1f73efda");
  const explicit = backtest(
    bars,
    strategy,
    "snapshot",
    10000,
    undefined,
    undefined,
    undefined,
    {
      adjustment: "none",
      corporateActions: review(bars, [
        event(bars[5]!.date, { rightsRatio: 1 }),
      ]),
    },
  );
  expect(explicit).toEqual(baseline);
});
it("送转信号消除假下跌卖出；原始模式是反例", () => {
  const bars = prices([16, 17, 18, 19, 20, 10.5, 11, 11.5]);
  const r = run(bars, [event(bars[5]!.date, { bonusRatio: 1 })]);
  const raw = backtest(bars, strategy, "fixture", 20000, costs);
  expect(raw.trades.map((t) => t.side)).toEqual(["buy", "sell"]);
  expect(r.trades.map((t) => t.side)).toEqual(["buy"]);
  expect(r.shares).toBe(2000);
});
it("日期逐条对齐、首因子1、未来追加不改历史；缺日事件顺延且不修改原数据", () => {
  const bars = prices([16, 17, 18, 19, 20, 10, 11]);
  const before = structuredClone(bars);
  const events = [
    event(bars[0]!.date, { bonusRatio: 2 }),
    event(bars[5]!.date, { bonusRatio: 1 }),
    event("2025-02-01", { bonusRatio: 1 }),
  ];
  const r = bonusAdjustedSignals(bars, review(bars, events));
  expect(r.changes.map((c) => c.date)).toEqual(bars.map((b) => b.date));
  expect(r.changes.map((c) => c.factor)).toEqual([1, 1, 1, 1, 1, 2, 2]);
  expect(r.bars.map((b) => b.volume)).toEqual(bars.map((b) => b.volume));
  expect(r.bars.map((b) => b.amount)).toEqual(bars.map((b) => b.amount));
  const missing = bars.filter((_, i) => i !== 5);
  expect(
    bonusAdjustedSignals(missing, review(bars, events)).changes.at(-1)!.ratios,
  ).toEqual([1]);
  expect(run(missing, events).shares).toBe(2000);
  expect(bars).toEqual(before);
  const extended = [...bars, { ...bars.at(-1)!, date: "2025-02-01" }];
  expect(
    bonusAdjustedSignals(extended, review(extended, events)).bars.slice(
      0,
      bars.length,
    ),
  ).toEqual(r.bars);
});
it("预热送转只改信号，评估首日空仓不获得送股；诊断包含预热", () => {
  const bars = prices([16, 17, 18, 19, 20, 10]);
  const r = run(bars, [event(bars[2]!.date, { bonusRatio: 1 })]);
  expect(r.diagnostics.exDividendDays).toBe(1);
  expect(r.diagnostics.shareAdjustments).toBe(0);
});
it("缺来源、覆盖不足、非法日期/比例及重复事件不能当无事件", () => {
  const bars = prices([16, 17, 18, 19, 20, 10]);
  expect(() => bonusAdjustedSignals(bars)).toThrow("来源缺失");
  expect(() =>
    bonusAdjustedSignals(bars, { ...review(bars), status: "missing" }),
  ).toThrow("来源缺失");
  expect(() =>
    bonusAdjustedSignals(bars, { ...review(bars), end: bars[4]!.date }),
  ).toThrow("未覆盖");
  expect(() => bonusAdjustedSignals([...bars].reverse(), review(bars))).toThrow(
    "严格递增",
  );
  const r = review(bars);
  r.events = [event(bars[5]!.date, { bonusRatio: -1 })];
  expect(() => bonusAdjustedSignals(bars, r)).toThrow("未通过校验");
  r.events = [event(bars[5]!.date), event(bars[5]!.date)];
  expect(() => bonusAdjustedSignals(bars, r)).toThrow("未通过校验");
});
const wfSource = (): Snapshot => ({
  id: "wf-bonus",
  symbol: "sz000001",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: prices(
    Array.from({ length: 140 }, (_, i) => (20 + i / 10) / (i >= 95 ? 2 : 1)),
  ),
});
it("候选矩阵、训练和测试fold均透传同一模式；默认schema仍兼容旧参数", () => {
  const source = wfSource(),
    options = { trainBars: 60, testBars: 20, adjustment: "backward" as const };
  const actions = review(source.bars, [
    event(source.bars[95]!.date, { bonusRatio: 1, dividend: 0.1 }),
  ]);
  const r = walkForward(
    source,
    strategy,
    20000,
    costs,
    options,
    undefined,
    actions,
  );
  const matrix = candidateTrialMatrix(
    source,
    strategy,
    20000,
    costs,
    options,
    actions,
  );
  for (const [i, candidate] of matrix.candidates.entries()) {
    const result = backtest(
      source.bars,
      candidate,
      source.id,
      20000,
      costs,
      r.warmupBars,
      undefined,
      { adjustment: "backward", corporateActions: actions },
    );
    expect(matrix.returns[i]).toEqual(equityDailyReturns(result.equity, 20000));
  }
  for (const fold of r.folds) {
    expect(fold.test.adjustment).toBe("backward");
    for (const training of fold.training) {
      const end = source.bars.findIndex((b) => b.date === fold.trainEnd) + 1;
      const start =
        source.bars.findIndex((b) => b.date === fold.trainStart) - r.warmupBars;
      const expected = backtest(
        source.bars.slice(start, end),
        training.strategy,
        source.id,
        20000,
        costs,
        r.warmupBars,
        undefined,
        { adjustment: "backward", corporateActions: actions },
      );
      expect(training.totalReturn).toBe(expected.totalReturn);
    }
  }
  expect(walkForwardSchema.parse({ trainBars: 60, testBars: 20 })).toEqual({
    trainBars: 60,
    testBars: 20,
  });
});
it.each([0, 139])("拒绝事件在预热或未满fold尾部（索引%s）也阻断全研究", (i) => {
  const source = wfSource(),
    actions = review(source.bars, [
      event(source.bars[i]!.date, { category: 13 }),
    ]);
  const options = {
    trainBars: 60,
    testBars: 20,
    adjustment: "backward" as const,
  };
  expect(() =>
    walkForward(source, strategy, 20000, costs, options, undefined, actions),
  ).toThrow("整段不可用");
  expect(() =>
    candidateTrialMatrix(source, strategy, 20000, costs, options, actions),
  ).toThrow("整段不可用");
});
it("页面回显残余跳空、未建模边界，模式输入贯通API与worker", () => {
  const html = renderToStaticMarkup(
    createElement(AdjustmentDisclosure, { mode: "backward" }),
  );
  for (const text of [
    "残余除息跳空",
    "成交量不复权",
    "历史税制",
    "退市",
    "配股不建模",
  ])
    expect(html).toContain(text);
  expect(
    renderToStaticMarkup(createElement(AdjustmentDisclosure, {})),
  ).toContain("不复权");
  expect(
    readFileSync("src/components/workbench/backtest-view.tsx", "utf8"),
  ).toContain("adjustment={adjustment}");
  expect(readFileSync("src/server/api/root.ts", "utf8")).toContain(
    "input.adjustment",
  );
  expect(readFileSync("src/server/jobs/worker.ts", "utf8")).toContain(
    "adjustment: work.adjustment",
  );
});
