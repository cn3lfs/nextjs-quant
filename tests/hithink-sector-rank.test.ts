import { expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import {
  sectorMembershipAudit,
  sectorRankEvidence,
  sectorRankFromEvidence,
} from "../src/server/data-sources/hithink/hithink-sector-rank";
it("audits price-filter omissions without assuming all returned rows form the full membership", () => {
  const row = (code: string) => ({
    股票代码: code,
    所属同花顺二级行业: "白酒",
  });
  const all = {
    status_code: 0,
    code_count: 2,
    datas: [row("600519.SH"), row("000001.SZ")],
  };
  const price = { status_code: 0, code_count: 1, datas: [row("600519.SH")] };
  expect(sectorMembershipAudit(all, price, "白酒")).toMatchObject({
    membershipCount: 2,
    priceCount: 1,
    missingFromPrices: ["000001.SZ"],
    extraInPrices: [],
  });
  expect(() =>
    sectorMembershipAudit(
      { ...all, datas: [row("600519.SH"), row("600519.SH")] },
      price,
      "白酒",
    ),
  ).toThrow("重复");
});
const stock: Snapshot = {
  id: "s",
  hash: "h",
  symbol: "sh600519",
  period: "day",
  adjustment: "none",
  source: "fixture",
  createdAt: 1,
  bars: Array.from({ length: 61 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 100,
    close: i === 60 ? 110 : 100,
    volume: 100,
    amount: 10000,
  })),
};
const start = stock.bars[0]!.date.replaceAll("-", ""),
  end = stock.bars.at(-1)!.date.replaceAll("-", "");
const basic = {
  status_code: 0,
  datas: [{ 股票代码: "600519.SH", 所属同花顺二级行业: "白酒" }],
};
function response(index: boolean) {
  const prefix = index ? "收盘价" : "收盘价_不复权";
  return {
    status_code: 0,
    code_count: 1,
    columns: [start, end].map((timestamp) => ({
      key: `${prefix}[${timestamp}]`,
      unit: index ? "点" : "元",
      timestamp,
      type: "DOUBLE",
      index_name: "收盘价:不复权",
    })),
    datas: [
      {
        ...(index
          ? {
              指数代码: "881273.TI",
              指数简称: "白酒",
              指数类型: "同花顺二级行业指数",
              成分领域: "A股指数",
            }
          : { 股票代码: "600519.SH", 所属同花顺二级行业: "白酒" }),
        [`${prefix}[${start}]`]: 100,
        [`${prefix}[${end}]`]: 110,
      },
    ],
  };
}
it("recomputes matching evidence and rejects another snapshot or modified payload", () => {
  const evidence = sectorRankEvidence(
    stock,
    basic,
    response(true),
    response(false),
    "881273.TI",
    1,
  );
  expect(sectorRankFromEvidence(stock, evidence)).toMatchObject({
    stockRank: 1,
    sectorRank: 1,
    status: "missing",
    points: 0,
  });
  expect(sectorRankFromEvidence(stock, evidence).warnings).toContain(
    "独立行业成分名单未取得，价格列表覆盖范围尚未对照。",
  );
  expect(() =>
    sectorRankFromEvidence({ ...stock, hash: "other" }, evidence),
  ).toThrow();
  expect(() =>
    sectorRankFromEvidence(stock, { ...evidence, text: evidence.text + " " }),
  ).toThrow("指纹");
});
it("rejects mismatched local endpoint and industry identity", () => {
  expect(() =>
    sectorRankEvidence(
      {
        ...stock,
        bars: stock.bars.map((b, i) => ({
          ...b,
          close: i === 60 ? NaN : b.close,
        })),
      },
      basic,
      response(true),
      response(false),
      "881273.TI",
      1,
    ),
  ).toThrow("端点非法");
  const changed = {
    ...stock,
    bars: stock.bars.map((b, i) => ({ ...b, close: i === 60 ? 109 : b.close })),
  };
  expect(() =>
    sectorRankEvidence(
      changed,
      basic,
      response(true),
      response(false),
      "881273.TI",
      1,
    ),
  ).toThrow("端点");
  expect(() =>
    sectorRankEvidence(
      stock,
      {
        ...basic,
        datas: [{ 股票代码: "600519.SH", 所属同花顺二级行业: "其他" }],
      },
      response(true),
      response(false),
      "881273.TI",
      1,
    ),
  ).toThrow("归属");
});
