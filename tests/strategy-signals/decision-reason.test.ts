import { expect, it } from "vitest";
import { prepareStrategy, type StrategyObjectInput } from "trading-strategies";
import { strategyDecisionReason } from "~/lib/strategy-facts/decision-reason";

const common = { close: 12, volume: 150, entry: true, inputs: {} };
it("shows actual current and prior moving averages and the observed crossover", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "dual-ma",
    inputs: {
      fast: 10,
      slow: 40,
      short: 11,
      long: 10,
      previousShort: 9,
      previousLong: 10,
      signal: "BUY",
    },
  });
  expect(reason).toContain(
    "MA10 11.0000（前值 9.0000） / MA40 10.0000（前值 10.0000）",
  );
  expect(reason).toContain("均线上穿");
});
it("shows recorded range/volume inputs and parameters without dumping the formula object", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "formula",
    inputs: {
      source: "PRIVATE_IMPLEMENTATION_TEXT",
      parameters: { N1: 20 },
      dependencies: [
        { expression: "REF(HHV(H,N1),1)", value: 11 },
        { expression: "MA(V,20)", value: 100 },
      ],
      outputs: [{ name: "选股", value: 1 }],
    },
  });
  expect(reason).toContain("N1=20.0000");
  expect(reason).toContain("REF(HHV(H,N1),1)=11.0000 / MA(V,20)=100.0000");
  expect(reason).toContain("成交量 150");
  expect(reason).not.toContain("PRIVATE_IMPLEMENTATION_TEXT");
  expect(reason).not.toContain("{");
});
it("distinguishes breakout check failures and unknowns from actual thresholds", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "double-breakout",
    inputs: {
      line: { value: 10.2 },
      keyLevel: { price: 11 },
      volume20: 100,
      volumeRatio: 1.5,
      checks: {
        trend: "是",
        level: "是",
        volume: "否",
        indicators: "未知",
        candle: true,
      },
    },
  });
  expect(reason).toContain("趋势线 10.2000 / 关键位 11.0000 / 量比 1.50");
  expect(reason).toContain(
    "趋势通过 / 关键位通过 / 量能未通过 / 指标未知 / K线通过",
  );
  expect(reason).not.toMatch(/方向|止损|目标/);
});
it("includes the matched double-breakout direction and recorded risk levels", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "double-breakout",
    inputs: { direction: "short", stopPrice: 13, targetPrice: 9 },
  });
  expect(reason).toContain("方向 向下；止损 13.0000；目标 9.0000");
});
it("shows pattern names, scores and price levels from recorded matches", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "pattern-breakout",
    inputs: {
      matches: [
        {
          label: "箱体突破↑",
          score: 4,
          pivotPrice: 11,
          stopPrice: 9,
          targetPrice: 16,
        },
        { label: "上升三角形↑", score: 3, pivotPrice: 10.5 },
      ],
    },
  });
  expect(reason).toContain(
    "箱体突破↑ / 评分 4/5 / 突破位 11.0000 / 止损 9.0000 / 目标 16.0000",
  );
  expect(reason).toContain("上升三角形↑ / 评分 3/5 / 突破位 10.5000");
});
it("shows classified and legacy CZSC observations with their recorded endpoint dates", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "czsc-monitor",
    inputs: {
      config: 1100,
      fresh: [
        {
          shortLabel: "区间套卖",
          endpointDate: "2026-11-18",
          quality: 2,
          stopPrice: 13,
        },
        { kind: 3, endpointDate: "2026-11-19", quality: 1 },
      ],
    },
  });
  expect(reason).toContain(
    "区间套卖 / 端点 2026-11-18 / 质量 2 / 止损 13.0000",
  );
  expect(reason).toContain("段3买 / 端点 2026-11-19 / 质量 1");
});
it("formats the three-buy rule's recorded start index without inventing a signal", () => {
  const reason = strategyDecisionReason({
    ...common,
    kind: "chan-third-buy",
    entry: null,
    inputs: { rule: { kind: "chan-third-buy", firstIndex: 140 } },
  });
  expect(reason).toContain("入场条件未知");
  expect(reason).toContain("缠论三买 / 首个评估K线索引 140");
});
it("includes actual RPS components, rank, market gate and rebalance difference", () => {
  const reason = strategyDecisionReason(
    {
      ...common,
      kind: "constant",
      rps: [
        { period: 20, actual: { rps: 88 } },
        { period: 50, actual: null },
      ],
    },
    {
      rankScore: 0.88,
      regime: { trend: true, breadth: 0.6, coverage: 0.9 },
      targetWeight: 0.15,
      currentWeight: 0.08,
      deltaWeight: 0.07,
    },
  );
  expect(reason).toContain("RPS20 88.0 / RPS50 —");
  expect(reason).toContain("排序分 0.880");
  expect(reason).toContain("趋势通过 / 广度 60.0% / 覆盖 90.0%");
  expect(reason).toContain("目标 15.0% / 现有 8.0% / 变动 7.0%");
});
it("never turns missing or nonfinite inputs into zero or passing conditions", () => {
  expect(strategyDecisionReason(null)).toBe("规则输入缺失，入选依据待核验");
  const reason = strategyDecisionReason({
    ...common,
    kind: "dual-ma",
    entry: null,
    inputs: { fast: 10, slow: 40, short: NaN, long: Infinity },
  });
  expect(reason).toContain("入场条件未知");
  expect(reason).toContain("MA10 —（前值 —） / MA40 —（前值 —）");
  expect(reason).not.toContain("0.0000");
  expect(reason).not.toContain("通过");
});
it("shows market-level low-zone evidence and its current-membership limitation", () => {
  const reason = strategyDecisionReason(
    { ...common, kind: "external" },
    {
      marketLowZone: {
        index: "sh000300",
        depth: 3,
        breadth: 0.3,
        coverage: { prices: 0.9, pe: 0.7, pb: 0.8 },
        synthetic: { pe: 15, pb: 1.5, pePercentile: 0.2, pbPercentile: 0.1 },
        confidence: "current-labelled-diagnostic",
      },
    },
  );
  expect(reason).toContain("sh000300 低位深度 3 / 低位广度 30.0%");
  expect(reason).toContain(
    "合成PE 15.00（分位 20.0%，覆盖 70.0%） / PB 1.50（分位 10.0%，覆盖 80.0%）",
  );
  expect(reason).toContain("含前视偏差");
  expect(reason).not.toContain("明细未记录");
});
it("formats the actual compiled MA decision with hand-calculated inputs", () => {
  const strategy: StrategyObjectInput = {
    id: "why-ma",
    version: 1,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "dual-ma", fast: 10, slow: 40, side: "entry" },
    exit: {},
    sizing: { kind: "equal", positions: 2 },
  };
  const bars = Array.from({ length: 42 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    close: i === 41 ? 12 : 10,
    high: 12,
    low: 10,
    volume: 100,
    amount: 1000,
  }));
  const prepared = prepareStrategy(strategy, bars);
  expect(prepared.evaluate(41).entry).toBe(true);
  const reason = strategyDecisionReason(prepared.explain(41));
  expect(reason).toContain(
    "MA10 10.2000（前值 10.0000） / MA40 10.0500（前值 10.0000）",
  );
  expect(reason).toContain("均线上穿");
});
it("formats range and volume dependencies from the actual formula evaluator", () => {
  const strategy: StrategyObjectInput = {
    id: "why-range",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: {
      kind: "formula",
      source: "选股:C>REF(HHV(H,20),1) AND V>MA(V,20);",
    },
    exit: {},
    sizing: { kind: "equal", positions: 10 },
  };
  const bars = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    close: i === 29 ? 12 : 10,
    high: i === 29 ? 13 : 11,
    low: 9,
    volume: i === 29 ? 200 : 100,
    amount: 1000,
  }));
  const prepared = prepareStrategy(strategy, bars);
  expect(prepared.evaluate(29).entry).toBe(true);
  const reason = strategyDecisionReason(prepared.explain(29));
  expect(reason).toContain("REF(HHV(H,20),1)=11.0000 / MA(V,20)=105.0000");
  expect(reason).toContain("成交量 200");
});
