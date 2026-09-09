import { expect, it } from "vitest";
import { canslimFinanceFacts } from "../src/server/canslim-finance";
it("keeps per-share periods and ROE identities separate", () => {
  const names = [
    "单季度_基本每股收益",
    "基本每股收益",
    "每股经营活动产生的现金流量净额",
    "净资产收益率",
    "加权净资产收益率",
    "单季度_归母净利润",
  ];
  const columns = names.map((name) => ({
    key: `${name}[20251231]`,
    timestamp: "20251231",
    unit: name.includes("收益率") ? "%" : "元",
  }));
  const row = Object.fromEntries(columns.map((c, i) => [c.key, i + 1]));
  const { series } = canslimFinanceFacts(row, columns);
  expect(series.quarterlyEps?.[0]?.value).toBe(1);
  expect(series.annualEps?.[0]?.value).toBe(2);
  expect(series.annualCashPerShare?.[0]?.value).toBe(3);
  expect(series.annualRoe?.[0]?.value).toBe(4);
  expect(series.annualWeightedRoe?.[0]?.value).toBe(5);
});
it("rejects coercible nonnumbers, wrong units, periods and duplicate fields", () => {
  const key = "基本每股收益[20251231]";
  const valid = { key, timestamp: "20251231", unit: "元" };
  for (const raw of [
    null,
    undefined,
    "",
    " ",
    false,
    [],
    "--",
    "2元",
    Infinity,
  ])
    expect(
      canslimFinanceFacts({ [key]: raw }, [valid]).series.annualEps?.[0]?.value,
    ).toBeNull();
  for (const columns of [
    [{ ...valid, unit: "万元" }],
    [{ ...valid, timestamp: "20241231" }],
    [valid, valid],
  ])
    expect(
      canslimFinanceFacts({ [key]: 2 }, columns).series.annualEps?.[0]?.value,
    ).toBeNull();
  const interim = "基本每股收益[20250630]";
  expect(
    canslimFinanceFacts({ [interim]: 2 }, [
      { key: interim, timestamp: "20250630", unit: "元" },
    ]).series.annualEps?.[0]?.value,
  ).toBeNull();
  expect(
    canslimFinanceFacts({ [key]: "-1.25" }, [valid]).series.annualEps?.[0]
      ?.value,
  ).toBe(-1.25);
});
