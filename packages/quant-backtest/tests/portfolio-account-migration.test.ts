import { expect, it } from "vitest";
import { PortfolioAccount } from "../src/portfolio-account.js";

function trajectory(account: PortfolioAccount) {
  const symbol = "sh600000";
  const trace: unknown[] = [];
  function step(label: string, day: string, operation: () => unknown) {
    let result;
    try {
      result = operation() ?? null;
    } catch (e) {
      result = (e as Error).message;
    }
    trace.push(
      structuredClone({
        label,
        result,
        cash: account.cash,
        equity: account.equity,
        sellable: account.sellable(symbol, day, 1),
        positions: [...account.positions],
      }),
    );
  }
  const buy = (day: string, qty: number, price: number, net?: number) =>
    account.fill(symbol, day, "buy", qty, price, 0.123, 1, net);
  const sell = (day: string, qty: number) =>
    account.fill(symbol, day, "sell", qty, 12, 0.02, 1);
  const a = "2026-01-05",
    b = "2026-01-06",
    c = "2026-01-07",
    d = "2026-01-08";
  step("买入及分以下结算", a, () => buy(a, 101, 10, -1010.123000001));
  step("同日锁定", a, () => sell(a, 1));
  step("资金不足", b, () => buy(b, 10000, 10));
  step("结算不符", b, () => buy(b, 1, 10, -10));
  step("第二批买入", b, () => buy(b, 50, 9));
  step("现金及持仓标记", b, () => {
    account.cash += 2.01;
    account.positions.get(symbol)!.mark = 13;
  });
  step("部分卖出", b, () => sell(b, 51));
  const action = {
    date: c,
    availableAt: c,
    sharesSellableAt: d,
    dividend: 0.2,
    rightsRatio: 0.1,
    rightsPrice: 6,
    bonus: 0.25,
    evidence: "fixture",
  };
  step("分红送转配股除权", c, () =>
    account.corporateAction(symbol, action, true, 1000),
  );
  step("category 11 缩股", c, () =>
    account.corporateAction(
      symbol,
      {
        date: c,
        availableAt: c,
        dividend: 0,
        bonus: 0,
        shareFactor: 0.5,
        evidence: "category 11",
      },
      true,
    ),
  );
  step("送股尚未解锁", c, () => sell(c, 51));
  step("解锁后第二笔卖出", d, () => sell(d, 55));
  step("terminal", d, () => account.terminalValue(symbol, 4.23));
  return trace;
}

// Frozen before the migration, including each rejected operation's full state.
it("preserves every receipt, cash balance, mark, lot and entitlement from the original account", () => {
  const expected = [
    {
      label: "买入及分以下结算",
      result: null,
      cash: 2989.876999999,
      equity: 3999.876999999,
      sellable: 0,
      positions: [
        [
          "sh600000",
          {
            quantity: 101,
            cost: 10.001217821782179,
            mark: 10,
            bought: "2026-01-05",
            lots: [{ quantity: 101, bought: "2026-01-05" }],
          },
        ],
      ],
    },
    {
      label: "同日锁定",
      result: "T+1 / insufficient inventory",
      cash: 2989.876999999,
      equity: 3999.876999999,
      sellable: 0,
      positions: [
        [
          "sh600000",
          {
            quantity: 101,
            cost: 10.001217821782179,
            mark: 10,
            bought: "2026-01-05",
            lots: [{ quantity: 101, bought: "2026-01-05" }],
          },
        ],
      ],
    },
    {
      label: "资金不足",
      result: "Insufficient cash",
      cash: 2989.876999999,
      equity: 3999.876999999,
      sellable: 101,
      positions: [
        [
          "sh600000",
          {
            quantity: 101,
            cost: 10.001217821782179,
            mark: 10,
            bought: "2026-01-05",
            lots: [{ quantity: 101, bought: "2026-01-05" }],
          },
        ],
      ],
    },
    {
      label: "结算不符",
      result: "Settlement does not reconcile to fill",
      cash: 2989.876999999,
      equity: 3999.876999999,
      sellable: 101,
      positions: [
        [
          "sh600000",
          {
            quantity: 101,
            cost: 10.001217821782179,
            mark: 10,
            bought: "2026-01-05",
            lots: [{ quantity: 101, bought: "2026-01-05" }],
          },
        ],
      ],
    },
    {
      label: "第二批买入",
      result: null,
      cash: 2539.753999999,
      equity: 3898.753999999,
      sellable: 101,
      positions: [
        [
          "sh600000",
          {
            quantity: 151,
            cost: 9.670503311258278,
            mark: 9,
            bought: "2026-01-06",
            lots: [
              { quantity: 101, bought: "2026-01-05" },
              { quantity: 50, bought: "2026-01-06" },
            ],
          },
        ],
      ],
    },
    {
      label: "现金及持仓标记",
      result: null,
      cash: 2541.763999999,
      equity: 4504.763999999,
      sellable: 101,
      positions: [
        [
          "sh600000",
          {
            quantity: 151,
            cost: 9.670503311258278,
            mark: 13,
            bought: "2026-01-06",
            lots: [
              { quantity: 101, bought: "2026-01-05" },
              { quantity: 50, bought: "2026-01-06" },
            ],
          },
        ],
      ],
    },
    {
      label: "部分卖出",
      result: null,
      cash: 3153.743999999,
      equity: 4353.743999999,
      sellable: 50,
      positions: [
        [
          "sh600000",
          {
            quantity: 100,
            cost: 9.670503311258278,
            mark: 12,
            bought: "2026-01-06",
            lots: [
              { quantity: 50, bought: "2026-01-05" },
              { quantity: 50, bought: "2026-01-06" },
            ],
          },
        ],
      ],
    },
    {
      label: "分红送转配股除权",
      result: {
        before: 100,
        quantity: 125,
        cash: 18,
        costBefore: 9.670503311258278,
        costAfter: 7.5924026490066225,
        markAfter: 9.185185185185185,
        fractionalShares: 0,
        rightsParticipation: "none",
      },
      cash: 3171.743999999,
      equity: 4319.892148147148,
      sellable: 100,
      positions: [
        [
          "sh600000",
          {
            quantity: 125,
            cost: 7.5924026490066225,
            mark: 9.185185185185185,
            bought: "2026-01-06",
            lots: [
              { quantity: 50, bought: "2026-01-05" },
              { quantity: 50, bought: "2026-01-06" },
              { quantity: 25, bought: "2026-01-07", availableOn: "2026-01-08" },
            ],
          },
        ],
      ],
    },
    {
      label: "category 11 缩股",
      result: {
        before: 125,
        quantity: 62,
        cash: 0,
        costBefore: 7.5924026490066225,
        costAfter: 15.307263405255288,
        markAfter: 18.37037037037037,
        fractionalShares: 0.5,
        rightsParticipation: "none",
      },
      cash: 3171.743999999,
      equity: 4310.706962961963,
      sellable: 50,
      positions: [
        [
          "sh600000",
          {
            quantity: 62,
            cost: 15.307263405255288,
            mark: 18.37037037037037,
            bought: "2026-01-06",
            lots: [
              { quantity: 25, bought: "2026-01-05" },
              { quantity: 25, bought: "2026-01-06" },
              { quantity: 12, bought: "2026-01-07", availableOn: "2026-01-08" },
            ],
          },
        ],
      ],
    },
    {
      label: "送股尚未解锁",
      result: "T+1 / insufficient inventory",
      cash: 3171.743999999,
      equity: 4310.706962961963,
      sellable: 50,
      positions: [
        [
          "sh600000",
          {
            quantity: 62,
            cost: 15.307263405255288,
            mark: 18.37037037037037,
            bought: "2026-01-06",
            lots: [
              { quantity: 25, bought: "2026-01-05" },
              { quantity: 25, bought: "2026-01-06" },
              { quantity: 12, bought: "2026-01-07", availableOn: "2026-01-08" },
            ],
          },
        ],
      ],
    },
    {
      label: "解锁后第二笔卖出",
      result: null,
      cash: 3831.723999999,
      equity: 3915.723999999,
      sellable: 7,
      positions: [
        [
          "sh600000",
          {
            quantity: 7,
            cost: 15.307263405255288,
            mark: 12,
            bought: "2026-01-06",
            lots: [
              { quantity: 7, bought: "2026-01-07", availableOn: "2026-01-08" },
            ],
          },
        ],
      ],
    },
    {
      label: "terminal",
      result: 29.61,
      cash: 3861.333999999,
      equity: 3861.333999999,
      sellable: 0,
      positions: [],
    },
  ];
  expect(trajectory(new PortfolioAccount(4000))).toEqual(expected);
});
