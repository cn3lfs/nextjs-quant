import { expect, it } from "vitest";
import {
  accountReviewSettingsSchema,
  checkExposureCaps,
  effectiveExposureCaps,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";

const review = accountReviewSettingsSchema.parse({ caps: [] });
const caps = effectiveExposureCaps(review, "cn-equity");
const proposed = {
  market: "cn-equity" as const,
  symbol: "sh600003",
  sleeve: "swing",
  industry: "银行",
  value: 10000,
  openRisk: 100,
  maxPositions: 3,
};
const capital = { "cn-equity": 100000, crypto: 100000 };
const holding = (
  symbol: string,
  extra: Partial<AccountPosition> = {},
): AccountPosition => ({
  id: symbol,
  account: "broker",
  kind: "real",
  market: "cn-equity",
  currency: "CNY",
  symbol,
  sleeve: "swing",
  industry: "银行",
  quantity: 1000,
  cost: 10,
  price: 10,
  value: 10000,
  stop: 9.9,
  at: "2026-11-16",
  strategyId: "test",
  strategyVersion: 1,
  reasons: [],
  ...extra,
});

it("enables user-approved 15/6/30 limits even with an existing empty custom-cap array; edits and explicit disable take effect", () => {
  expect(review.portfolioLimits).toEqual({
    enabled: true,
    symbolWeight: 0.15,
    heat: 0.06,
    industryWeight: 0.3,
  });
  expect(caps.map((c) => [c.dimension, c.key, c.fraction])).toEqual([
    ["symbol", "*", 0.15],
    ["industry", "*", 0.3],
    ["heat", "cn-equity", 0.06],
  ]);
  const changed = accountReviewSettingsSchema.parse({
    caps: [],
    portfolioLimits: { symbolWeight: 0.1, heat: 0.03, industryWeight: 0.2 },
  });
  expect(
    effectiveExposureCaps(changed, "crypto").map((c) => c.fraction),
  ).toEqual([0.1, 0.03]);
  expect(
    effectiveExposureCaps(
      {
        ...review,
        portfolioLimits: { ...review.portfolioLimits, enabled: false },
      },
      "cn-equity",
    ),
  ).toEqual([]);
});
it("wildcard weights check each name and industry separately before comparing to market capital", () => {
  const positions = [holding("sh600001"), holding("sh600002")];
  expect(
    checkExposureCaps({ positions, reserved: [], proposed, capital, caps }),
  ).toEqual([]);
  const violations = checkExposureCaps({
    positions,
    reserved: [],
    proposed: { ...proposed, value: 20000 },
    capital,
    caps,
  });
  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        dimension: "symbol",
        key: "sh600003",
        used: 20000,
        limit: 15000,
      }),
      expect.objectContaining({
        dimension: "industry",
        key: "银行",
        used: 40000,
        limit: 30000,
      }),
    ]),
  );
});
it("crypto asset class is not an industry cap; user-defined crypto caps still apply", () => {
  const cryptoCaps = effectiveExposureCaps(
    {
      ...review,
      portfolioLimits: { ...review.portfolioLimits, symbolWeight: 0.25 },
    },
    "crypto",
  );
  const positions = [
    holding("BTCUSDT", {
      market: "crypto",
      currency: "USDT",
      industry: "数字货币",
      value: 20000,
      price: 20,
      stop: 19.9,
    }),
  ];
  const entry = {
    ...proposed,
    market: "crypto" as const,
    symbol: "ETHUSDT",
    industry: "数字货币",
    value: 20000,
  };
  expect(
    checkExposureCaps({
      positions,
      reserved: [],
      proposed: entry,
      capital,
      caps: cryptoCaps,
    }),
  ).toEqual([]);
  const custom = accountReviewSettingsSchema.parse({
    caps: [
      {
        market: "crypto",
        dimension: "industry",
        key: "数字货币",
        fraction: 0.2,
      },
    ],
  });
  expect(
    checkExposureCaps({
      positions,
      reserved: [],
      proposed: entry,
      capital,
      caps: effectiveExposureCaps(custom, "crypto"),
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        dimension: "industry",
        used: 40000,
        limit: 20000,
      }),
    ]),
  );
});
it("heat includes holdings and pending tranches; missing stop evidence is unknown, never zero", () => {
  const positions = [holding("sh600001", { stop: 7 })];
  const reserved = [{ ...proposed, symbol: "sh600002", openRisk: 2000 }];
  expect(
    checkExposureCaps({
      positions,
      reserved,
      proposed: { ...proposed, openRisk: 1500 },
      capital,
      caps,
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ dimension: "heat", used: 6500, limit: 6000 }),
    ]),
  );
  expect(
    checkExposureCaps({
      positions: [holding("sh600001", { stop: null })],
      reserved: [],
      proposed,
      capital,
      caps,
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ dimension: "heat", used: null }),
    ]),
  );
});
it("strategy slots count distinct names across real holdings and pending plans within the market and sleeve", () => {
  const positions = [
    holding("sh600001"),
    holding("sh600001"),
    holding("sh600009", { sleeve: "low-zone" }),
    holding("sh600008", { kind: "paper" }),
  ];
  const reserved = [{ ...proposed, symbol: "sh600002" }];
  const violations = checkExposureCaps({
    positions,
    reserved,
    proposed: { ...proposed, maxPositions: 2 },
    capital,
    caps: [],
  });
  expect(violations).toEqual([
    expect.objectContaining({
      dimension: "positions",
      key: "cn-equity:swing",
      used: 3,
      limit: 2,
    }),
  ]);
  expect(
    checkExposureCaps({
      positions,
      reserved,
      proposed: { ...proposed, symbol: "sh600001", maxPositions: 2 },
      capital,
      caps: [],
    }),
  ).toEqual([]);
});
it("unknown industry remains explicit while paper and other-market inventory do not consume real-market limits", () => {
  expect(
    checkExposureCaps({
      positions: [holding("sh600001", { industry: "未知" })],
      reserved: [],
      proposed,
      capital,
      caps,
    }),
  ).toEqual([
    {
      dimension: "industry",
      key: "银行",
      used: null,
      limit: 30000,
      reason: expect.stringContaining("依据不足"),
    },
  ]);
  expect(
    checkExposureCaps({
      positions: [
        holding("sh600001", { kind: "paper", value: 900000, stop: null }),
        holding("cxBTCUSDT", {
          market: "crypto",
          currency: "USDT",
          value: 900000,
          stop: null,
        }),
      ],
      reserved: [],
      proposed,
      capital,
      caps,
    }),
  ).toEqual([]);
});
