import { expect, it } from "vitest";
import { canslimSectorRank } from "../../../../src/lib/strategy-facts/canslim-sector-rank";
const columns = [
  {
    key: "涨跌幅[20260908]",
    unit: "%",
    timestamp: "20260908",
    index_name: "涨跌幅:前复权",
    type: "DOUBLE",
  },
];
const sectors = {
  status_code: 0,
  code_count: 2,
  columns,
  datas: [
    {
      指数代码: "881273.TI",
      指数简称: "白酒",
      指数类型: "同花顺二级行业指数",
      成分领域: "A股指数",
      "涨跌幅[20260908]": 0,
    },
    {
      指数代码: "881274.TI",
      指数简称: "其他",
      指数类型: "同花顺二级行业指数",
      成分领域: "A股指数",
      "涨跌幅[20260908]": 1,
    },
  ],
};
const members = {
  status_code: 0,
  code_count: 2,
  columns,
  datas: [
    {
      股票代码: "600519.SH",
      所属同花顺二级行业: "白酒",
      "涨跌幅[20260908]": 2,
    },
    {
      股票代码: "000001.SZ",
      所属同花顺二级行业: "白酒",
      "涨跌幅[20260908]": 2,
    },
  ],
};
it("computes interval returns from positive unadjusted endpoints instead of reported daily changes", () => {
  const endpointTable = (
    data: typeof sectors | typeof members,
    index: boolean,
  ) => ({
    ...data,
    columns: ["20260615", "20260908"].map((stamp) => ({
      key: `${index ? "收盘价" : "收盘价_不复权"}[${stamp}]`,
      unit: index ? "点" : "元",
      timestamp: stamp,
      type: "DOUBLE",
      index_name: "收盘价:不复权",
    })),
    datas: data.datas.map((row, i): Record<string, unknown> => ({
      ...row,
      [`${index ? "收盘价" : "收盘价_不复权"}[20260615]`]: 100,
      [`${index ? "收盘价" : "收盘价_不复权"}[20260908]`]: i ? 90 : 110,
    })),
  });
  const a = endpointTable(sectors, true),
    b = endpointTable(members, false);
  const result = canslimSectorRank(
    a,
    b,
    "600519.SH",
    "881273.TI",
    "2026-09-08",
    "2026-06-15",
  );
  expect(result).toMatchObject({
    sectorRank: 1,
    stockRank: 1,
    observationPoints: 6,
    points: 0,
    adjustment: "none",
    window: "2026-06-15/2026-09-08",
  });
  expect(result.stockReturn.changePercent).toBeCloseTo(10);
  expect(result.stockReturn.endpoints).toEqual({ start: 100, end: 110 });
  b.datas[0]!["收盘价_不复权[20260615]"] = 0;
  expect(() =>
    canslimSectorRank(
      a,
      b,
      "600519.SH",
      "881273.TI",
      "2026-09-08",
      "2026-06-15",
    ),
  ).toThrow("价格");
  expect(() =>
    canslimSectorRank(
      a,
      b,
      "600519.SH",
      "881273.TI",
      "2026-09-08",
      "2026-09-08",
    ),
  ).toThrow("起始");
});
it("retains tied leader observation with weak-sector cap without claiming full L2", () => {
  expect(
    canslimSectorRank(sectors, members, "600519.SH", "881273.TI", "2026-09-08"),
  ).toMatchObject({
    stockRank: 1,
    sectorRank: 2,
    observationPoints: 3,
    status: "missing",
    points: 0,
  });
});
it("rejects incomplete, duplicated and incomparable observations", () => {
  for (const value of [
    { ...sectors, code_count: 3 },
    { ...sectors, datas: [sectors.datas[0], sectors.datas[0]] },
    { ...sectors, columns: [{ ...columns[0], unit: "元" }] },
    { ...sectors, columns: [{ ...columns[0], index_name: "涨跌幅:不复权" }] },
  ])
    expect(() =>
      canslimSectorRank(value, members, "600519.SH", "881273.TI", "2026-09-08"),
    ).toThrow();
  expect(() =>
    canslimSectorRank(
      sectors,
      {
        ...members,
        datas: members.datas.map((r) => ({ ...r, 所属同花顺二级行业: "其他" })),
      },
      "600519.SH",
      "881273.TI",
      "2026-09-08",
    ),
  ).toThrow("归属");
});
