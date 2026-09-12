import { describe, expect, it } from "vitest";
import type { ParsedCashFlow, ParsedFill } from "../src/lib/delivery-import";
import type { Bar } from "../src/lib/domain";
import { reviewTrades } from "../src/lib/trade-review";

const fill = (
  kind: "buy" | "sell",
  date: string,
  price: number,
  quantity: number,
  fee: number | null = 1,
  extra: Partial<ParsedFill> = {},
): ParsedFill => ({
  kind,
  tradeDate: date,
  tradeTime: null,
  rowIndex: 0,
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price,
  quantity,
  amount: price * quantity,
  fees: {
    commission: fee,
    stampTax: 0,
    transferFee: 0,
    otherFee: 0,
    total: fee,
  },
  netAmount:
    fee === null
      ? null
      : kind === "buy"
        ? -price * quantity - fee
        : price * quantity - fee,
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
const cash = (extra: Partial<ParsedCashFlow> = {}): ParsedCashFlow => ({
  kind: "subscription",
  rowIndex: 0,
  flowDate: "2026-01-01",
  code: "000001",
  name: null,
  amount: -1000,
  balanceCash: null,
  summary: "中签扣款",
  fingerprintSource: "",
  ...extra,
});
const bar = (date: string, high = 12, low = 8, close = 10): Bar => ({
  date,
  high,
  low,
  close,
  open: close,
  volume: 100,
  amount: 1000,
});
const d = (i: number) =>
  new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);

describe("trade review", () => {
  it("excess sale is unknown, later independent purchases cannot repair its history", () => {
    const r = reviewTrades({
      fills: [
        fill("buy", d(0), 10, 10),
        fill("sell", d(1), 20, 20),
        fill("buy", d(2), 10, 10),
        fill("sell", d(3), 12, 10),
      ],
    });
    expect(r.movingAverage.closedRounds[0]!.openingUnknown).toBe(true);
    expect(r.movingAverage.closedRounds[0]!.totalFees.value).toBeNull();
    expect(r.movingAverage.statistics.count).toBe(1);
    expect(r.movingAverage.closedRounds[1]!.netProfit.value).toBe(18);
  });
  it("invalid fills are retained separately and invalid bar order is not repaired", () => {
    const r = reviewTrades({
      fills: [fill("buy", d(0), 10, 0)],
      bars: { sz000001: [bar(d(1)), bar(d(0))] },
    });
    expect(r.exceptions[0]!.reason).toBe("成交数值无效");
    expect(r.movingAverage.closedRounds).toEqual([]);
    expect(r.tradePoints[0]!.intradayPosition.value).toBeNull();
    expect(r.tradePoints[0]!.dataReason).toBe("日线顺序或价格无效");
  });
  it("single round uses actual fees and calendar elapsed trading days", () => {
    const input = {
      fills: [
        fill("sell", "2026-01-05", 12, 100, 3),
        fill("buy", "2026-01-02", 10, 100, 2),
      ],
      tradingDays: ["2026-01-02", "2026-01-05"],
      exRightsEvents: [],
    };
    const r = reviewTrades(input);
    for (const result of [r.movingAverage, r.fifo]) {
      const round = result.closedRounds[0]!;
      // 1200 - 3 - (1000 + 2) = 195; denominator 1002.
      expect(round.netProfit.value).toBe(195);
      expect(round.netReturn.value).toBeCloseTo(195 / 1002);
      expect(round.totalFees.value).toBe(5);
      expect(round.holdingCalendarDays.value).toBe(3);
      expect(round.holdingTradingDays.value).toBe(1);
      expect(round.crossesExRights).toBe(false);
      expect(result.statistics.count).toBe(1);
      expect(result.statistics.feesToGrossProfit.value).toBeCloseTo(5 / 200);
      expect(result.statistics.profitFactor).toEqual({
        value: null,
        reason: "无亏损样本",
      });
    }
  });
  it("one buy multiple sales conserves costs and completes one round", () => {
    const r = reviewTrades({
      fills: [
        fill("buy", d(0), 10, 100, 2),
        fill("sell", d(1), 12, 40, 1),
        fill("sell", d(2), 11, 60, 1),
      ],
    });
    for (const result of [r.movingAverage, r.fifo]) {
      expect(result.closedRounds).toHaveLength(1);
      const round = result.closedRounds[0]!;
      expect(round.realizations[0]!.netProfit.value).toBeCloseTo(
        480 - 1 - 400 - 0.8,
      );
      expect(round.realizations[1]!.netProfit.value).toBeCloseTo(
        660 - 1 - 600 - 1.2,
      );
      expect(round.netProfit.value).toBeCloseTo(136);
      expect(round.remainingCost.value).toBe(0);
    }
  });
  it("multiple buys partial sell separates moving average and FIFO; final totals agree", () => {
    const fills = [
      fill("buy", d(0), 10, 100, 2),
      fill("buy", d(1), 20, 100, 4),
      fill("sell", d(2), 18, 100, 3),
    ];
    const r = reviewTrades({ fills });
    expect(r.movingAverage.statistics.count).toBe(0);
    expect(r.fifo.statistics.count).toBe(0);
    // MA cost 1503 vs FIFO 1002; proceeds 1797.
    expect(
      r.movingAverage.openPositions[0]!.realizations[0]!.netProfit.value,
    ).toBe(294);
    expect(r.fifo.openPositions[0]!.realizations[0]!.netProfit.value).toBe(795);
    expect(r.movingAverage.openPositions[0]!.remainingCost.value).toBe(1503);
    expect(r.fifo.openPositions[0]!.remainingCost.value).toBe(2004);
    const complete = reviewTrades({
      fills: [...fills, fill("sell", d(3), 22, 100, 3)],
    });
    for (const result of [complete.movingAverage, complete.fifo]) {
      expect(result.closedRounds[0]!.netProfit.value).toBe(988);
      expect(result.closedRounds[0]!.netReturn.value).toBeCloseTo(988 / 3006);
    }
  });
  it("multiple buys one sale weights actual purchase amounts", () => {
    const r = reviewTrades({
      fills: [
        fill("buy", d(0), 10, 100, 2),
        fill("buy", d(1), 20, 50, 1),
        fill("sell", d(2), 16, 150, 3),
      ],
    });
    for (const result of [r.movingAverage, r.fifo]) {
      expect(result.closedRounds[0]!.buyAveragePrice.value).toBeCloseTo(
        2000 / 150,
      );
      expect(result.closedRounds[0]!.netProfit.value).toBe(394);
    }
  });
  it("open positions never become flat-return observations", () => {
    const r = reviewTrades({ fills: [fill("buy", d(0), 10, 100)] });
    expect(r.movingAverage.openPositions[0]!.netReturn).toEqual({
      value: null,
      reason: "未平仓",
    });
    expect(r.movingAverage.statistics.winRate).toBeNull();
    expect(r.movingAverage.closedRounds).toEqual([]);
  });
  it("subscription cost is actual payment; missing or ambiguous evidence stays unknown", () => {
    const sell = fill("sell", "2026-01-05", 120, 10);
    const r = reviewTrades({ fills: [sell], cashFlows: [cash()] });
    expect(r.movingAverage.closedRounds[0]!.netProfit.value).toBe(199);
    expect(r.movingAverage.closedRounds[0]!.netReturn.value).toBeCloseTo(
      199 / 1000,
    );
    for (const flows of [
      [],
      [cash({ amount: 1000 })],
      [cash(), cash()],
      [cash({ code: null })],
    ]) {
      const unknown = reviewTrades({ fills: [sell], cashFlows: flows });
      expect(unknown.movingAverage.closedRounds[0]!.openingUnknown).toBe(true);
      expect(unknown.movingAverage.closedRounds[0]!.netReturn.value).toBeNull();
      expect(unknown.movingAverage.statistics.count).toBe(0);
    }
  });
  it("confirmed issuance mapping supports partial subscription sales without double spending", () => {
    const r = reviewTrades({
      fills: [
        fill("sell", "2026-01-05", 120, 4),
        fill("sell", "2026-01-06", 130, 6),
      ],
      cashFlows: [cash({ code: "370409" })],
      subscriptions: [
        {
          cashFlowIndex: 0,
          security: "sz000001",
          quantity: 10,
          evidence: "发行对应关系已核对",
        },
      ],
    });
    expect(r.movingAverage.closedRounds).toHaveLength(1);
    expect(r.movingAverage.closedRounds[0]!.netProfit.value).toBe(258);
    expect(r.movingAverage.unmatchedCashFlows).toEqual([]);
  });
  it("reverse repo uses cash movement, not quoted annual yield times quantity", () => {
    const r = reviewTrades({
      fills: [
        fill("sell", d(0), 2, 100, 1, {
          instrument: "reverseRepo",
          netAmount: -100001,
        }),
        fill("buy", d(1), 2, 100, 0, {
          instrument: "reverseRepo",
          netAmount: 100010,
        }),
      ],
    });
    expect(r.movingAverage.closedRounds).toEqual([]);
    expect(r.tradePoints).toEqual([]);
    expect(r.reverseRepo.capitalCommitted.value).toBe(100001);
    expect(r.reverseRepo.interestIncome.value).toBe(9);
    expect(
      reviewTrades({
        fills: [
          fill("sell", d(0), 2, 100, 1, {
            instrument: "reverseRepo",
            netAmount: -100001,
          }),
        ],
      }).reverseRepo.interestIncome.value,
    ).toBeNull();
  });
  it("ex-rights events mark raw returns and unknown coverage remains explicit", () => {
    const r = reviewTrades({
      fills: [fill("buy", d(0), 10, 100), fill("sell", d(2), 6, 100)],
      exRightsEvents: [{ security: "sz000001", date: d(1) }],
    });
    expect(r.movingAverage.closedRounds[0]!.crossesExRights).toBe(true);
    expect(r.movingAverage.closedRounds[0]!.warnings).toContain(
      "未复权，不代表经济收益",
    );
    expect(r.movingAverage.closedRounds[0]!.netReturn.value).toBeCloseTo(
      -402 / 1001,
    );
  });
  it("uses high/low after buy through close, excludes buy-day extremes", () => {
    const r = reviewTrades({
      fills: [fill("buy", d(0), 10, 100), fill("sell", d(2), 12, 100)],
      bars: {
        sz000001: [
          bar(d(0), 100, 1),
          bar(d(1), 15, 7),
          bar(d(2), 13, 8, 12),
          bar(d(3), 100, 1, 9),
        ],
      },
    });
    expect(r.tradePoints[0]!.mfe.value).toBeCloseTo(0.5);
    expect(r.tradePoints[0]!.mae.value).toBeCloseTo(-0.3);
    expect(r.tradePoints[1]!.afterSale[1]!.value).toBeCloseTo(-0.25);
    expect(r.tradePoints[1]!.afterSale[5]!.value).toBeNull();
  });
  it("flat day, short history, and missing bars retain null reasons", () => {
    const r = reviewTrades({
      fills: [fill("buy", d(0), 10, 100)],
      bars: { sz000001: [bar(d(0), 10, 10), bar(d(1), 12, 9)] },
    });
    expect(r.tradePoints[0]!.intradayPosition.value).toBeNull();
    expect(r.tradePoints[0]!.intervalPositions[20]!.value).toBeNull();
    expect(r.tradePoints[0]!.mfe.value).toBeCloseTo(0.2);
    const missing = reviewTrades({ fills: [fill("buy", d(0), 10, 100)] })
      .tradePoints[0]!;
    expect(missing.dataReason).toBe("数据不可得：缺日线");
    expect(missing.mae.value).toBeNull();
  });
  it("history excludes current day and all forward horizons use exact indices", () => {
    const bars = Array.from({ length: 272 }, (_, i) =>
      bar(d(i), 20, 5, 10 + i / 100),
    );
    bars[250] = bar(d(250), 100, 1, 10);
    const r = reviewTrades({
      fills: [fill("sell", d(250), 10, 100)],
      bars: { sz000001: bars },
    }).tradePoints[0]!;
    for (const n of [20, 60, 250])
      expect(r.intervalPositions[n]!.value).toBeCloseTo(1 / 3);
    for (const n of [1, 5, 10, 20])
      expect(r.afterSale[n]!.value).toBeCloseTo(
        (10 + (250 + n) / 100) / 10 - 1,
      );
  });
  it("missing fees do not fabricate zero cost and anomalous rows remain visible", () => {
    const r = reviewTrades({
      fills: [
        fill("buy", d(0), 10, 100, null, { anomalies: ["费用缺失"] }),
        fill("sell", d(1), 12, 100),
      ],
    });
    expect(r.exceptions).toHaveLength(1);
    expect(r.movingAverage.closedRounds[0]!.netProfit.value).toBeNull();
    expect(r.movingAverage.statistics.count).toBe(0);
  });
  it("statistics groups and consecutive streaks count closed valid rounds", () => {
    const fills = [2, 3, -1, -2, 0, 1].flatMap((change, i) => [
      fill("buy", d(i * 2), 10, 10, 0),
      fill("sell", d(i * 2 + 1), 10 + change, 10, 0),
    ]);
    const r = reviewTrades({ fills }).movingAverage;
    expect(r.statistics.profitFactor.value).toBe(2);
    expect(r.statistics.maxConsecutiveWins).toBe(2);
    expect(r.statistics.maxConsecutiveLosses).toBe(2);
    expect(r.statistics.largestWin.value).toBe(30);
    expect(r.statistics.largestLoss.value).toBe(-20);
    expect(r.statistics.winRate).toBe(0.5);
    expect(r.groups.bySecurity.sz000001!.count).toBe(6);
    expect(r.groups.byHoldingPeriod.unknown!.count).toBe(6);
  });
  it("time then source order controls replay, without mutating input", () => {
    const fills = [
      fill("sell", d(0), 12, 100, 0, { tradeTime: "10:00:00", rowIndex: 2 }),
      fill("buy", d(0), 10, 100, 0, { tradeTime: "09:00:00", rowIndex: 1 }),
    ];
    const before = JSON.stringify(fills);
    expect(
      reviewTrades({ fills }).movingAverage.closedRounds[0]!.netProfit.value,
    ).toBe(200);
    expect(JSON.stringify(fills)).toBe(before);
  });
});

describe("R3b correctness regressions", () => {
  it("keeps integer inventory exact across repeated partial sales and purchases", () => {
    const fills = Array.from({ length: 8 }, (_, i) => [
      fill("buy", d(i * 7), 10, 3700),
      fill("sell", d(i * 7 + 1), 11, 1100),
      fill("sell", d(i * 7 + 2), 12, 1300),
      fill("buy", d(i * 7 + 3), 13, 900),
      fill("sell", d(i * 7 + 4), 14, 700),
      fill("sell", d(i * 7 + 5), 15, 1500),
    ]).flat();
    for (let n = 1; n <= fills.length; n++) {
      const r = reviewTrades({ fills: fills.slice(0, n) });
      const expected = fills
        .slice(0, n)
        .reduce((s, f) => s + (f.kind === "buy" ? f.quantity : -f.quantity), 0);
      for (const result of [r.movingAverage, r.fifo]) {
        expect(
          result.openPositions.reduce(
            (s, round) => s + round.remainingQuantity,
            0,
          ),
        ).toBe(expected);
        for (const round of [...result.closedRounds, ...result.openPositions])
          expect(round.openingUnknown).toBe(false);
        for (const round of result.closedRounds) {
          expect(round.remainingQuantity).toBe(0);
          expect(round.remainingCost.value).toBe(0);
          expect(
            round.realizations.reduce(
              (s, sale) => s + sale.netProfit.value!,
              0,
            ),
          ).toBeCloseTo(round.netProfit.value!);
        }
      }
      expect(r.movingAverage.statistics.count).toBe(r.fifo.statistics.count);
    }
    const r = reviewTrades({ fills });
    expect(r.movingAverage.statistics.count).toBe(8);
    const total = (rounds: typeof r.fifo.closedRounds) =>
      rounds.reduce((s, round) => s + round.netProfit.value!, 0);
    expect(total(r.movingAverage.closedRounds)).toBeCloseTo(
      total(r.fifo.closedRounds),
    );
    expect(total(r.fifo.closedRounds)).toBeCloseTo(
      fills.reduce((s, f) => s + f.netAmount!, 0),
    );
  });

  it("prefers cash-derived buy and sell fees and exposes each source", () => {
    const r = reviewTrades({
      fills: [
        fill("buy", d(0), 12, 100, 0.1, { netAmount: -1200.15 }),
        fill("sell", d(1), 16.58, 100, 1.82, {
          amount: 1658,
          netAmount: 1656.13,
        }),
      ],
    });
    for (const result of [r.movingAverage, r.fifo]) {
      const round = result.closedRounds[0]!;
      // 1656.13 - 1200.15 = 455.98; actual fees 0.15 + 1.87 = 2.02.
      expect(round.netProfit.value).toBeCloseTo(455.98);
      expect(round.totalFees.value).toBeCloseTo(2.02);
      expect(round.realizations[0]!.netProfit.value).toBeCloseTo(455.98);
      expect(round.feeSources.map((f) => f.source)).toEqual([
        "netAmount",
        "netAmount",
      ]);
    }
  });

  it("rejects negative inferred fees, falls back to components and warns", () => {
    for (const kind of ["buy", "sell"] as const) {
      const fills = [
        fill("buy", d(0), 10, 100, 2),
        fill("sell", d(1), 12, 100, 3),
      ];
      const index = kind === "buy" ? 0 : 1;
      fills[index]!.netAmount = kind === "buy" ? -999 : 1201;
      const r = reviewTrades({ fills });
      for (const result of [r.movingAverage, r.fifo]) {
        const round = result.closedRounds[0]!;
        expect(round.netProfit.value).toBe(195);
        expect(round.feeSources[index]!.source).toBe("components");
        expect(round.warnings.join("；")).toContain("反推费用为负");
      }
    }
  });

  it("retains component fallback, missing fees and cash-only fee evidence", () => {
    for (const [fee, netAmount, source, profit] of [
      [2, null, "components", 195],
      [null, null, "missing", null],
      [null, -1002, "netAmount", 195],
    ] as const) {
      const r = reviewTrades({
        fills: [
          fill("buy", d(0), 10, 100, fee, { netAmount }),
          fill("sell", d(1), 12, 100, 3),
        ],
      });
      expect(r.movingAverage.closedRounds[0]!.netProfit.value).toBe(profit);
      expect(r.movingAverage.closedRounds[0]!.feeSources[0]!.source).toBe(
        source,
      );
    }
  });

  it("uses reverse repo cash direction for fee reconciliation", () => {
    const r = reviewTrades({
      fills: [
        fill("sell", d(0), 2, 100, 0.5, {
          instrument: "reverseRepo",
          amount: 100000,
          netAmount: -100001,
        }),
        fill("buy", d(1), 2, 100, 0, {
          instrument: "reverseRepo",
          amount: 100010,
          netAmount: 100009.5,
        }),
      ],
    });
    expect(r.reverseRepo.totalFees.value).toBe(1.5);
    expect(r.reverseRepo.feeSources.map((f) => f.source)).toEqual([
      "netAmount",
      "netAmount",
    ]);
    expect(r.reverseRepo.interestIncome.value).toBe(8.5);
    expect(r.reverseRepo.capitalCommitted.value).toBe(100001);
  });
});
