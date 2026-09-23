import { expect, it, vi } from "vitest";
import { researchPortfolio } from "../../src/server/backtest/research-portfolio";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../../src/lib/research/strategy-research";
import type { Bar } from "../../src/lib/domain";
const state = vi.hoisted(() => ({ fraction: 1, reduce: true }));
vi.mock(
  "../../src/server/strategies/shared/research-rule-series",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/server/strategies/shared/research-rule-series")
      >();
    return {
      ...actual,
      researchRuleSeries: (_id: string, bars: readonly Bar[]) =>
        bars.map((b, i) => ({
          date: b.date,
          reason: null,
          entry: i === 0,
          exit: false,
          entryFraction: i === 0 ? state.fraction : 1,
          reduction:
            state.reduce && i === 2
              ? { fraction: 0.5, reason: "天量形态首次确认减剩余持仓一半" }
              : undefined,
        })),
    };
  },
);
const bars: Bar[] = Array.from({ length: 7 }, (_, i) => ({
  date: `2020-01-${String(i + 1).padStart(2, "0")}`,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 10000,
  amount: 100000,
}));
const rules = {
  evidence: "fixed",
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 300,
  sellOddLotAll: true,
};
function run(fraction: number, reduce: boolean) {
  state.fraction = fraction;
  state.reduce = reduce;
  const spec = researchSpecSchema.parse({
    strategy: reduce ? "vp-huge-half" : "sw-confluence",
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars[5]!.date,
    holdingDays: 60,
    initialCapital: 10000,
    maxPositions: 1,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: "synthetic-confirmed",
    strategyVersion: "fixed",
    partition: "development",
    evidence: "执行适配合成已确认信号，不冒充行情算法",
  };
  return researchPortfolio(
    spec,
    [event],
    bars.map((b) => b.date),
    new Map([[event.symbol, bars]]),
    (_symbol, date) => ({ ...rules, tradable: date !== bars[3]!.date }),
  );
}
it("天量减半固定目标接既有卖出队列，不因受阻或单笔限额重新减半", () => {
  const result = run(1, true);
  const trade = result.trades[0]!;
  expect(trade.quantity).toBe(1000);
  expect(trade.sales?.map((b) => [b.date, b.quantity])).toEqual([
    [bars[4]!.date, 300],
    [bars[5]!.date, 200],
  ]);
  expect(result.nav.at(-1)).toMatchObject({ cash: 5000, value: 10000 });
});
it("两票半仓冻结在信号日，后续全额状态不改变已确认数量", () => {
  const half = run(0.5, false),
    whole = run(1, false);
  expect(half.trades[0]!.quantity).toBe(500);
  expect(whole.trades[0]!.quantity).toBe(1000);
});
