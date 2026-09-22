import { expect, it } from "vitest";
import {
  verifiedRank,
  fullRsSnapshot,
  rankInSnapshot,
} from "../src/server/data-sources/hithink/hithink-rs";
const range = "20260616-20260908",
  key = `涨跌幅[${range}]`,
  rankKey = `涨跌幅排名[${range}]`;
const columns = [
  { key, timestamp: range, unit: "%", type: "DOUBLE", sort_info: "desc" },
];
const target = {
  status_code: 0,
  code_count: 1,
  columns: [...columns, { key: rankKey, timestamp: range, type: "LONG" }],
  datas: [{ 股票代码: "600519.SH", [key]: 20, [rankKey]: 2 }],
};
const universe = {
  status_code: 0,
  code_count: 3,
  columns,
  datas: [
    { 股票代码: "000001.SZ", [key]: 30 },
    { 股票代码: "600519.SH", [key]: 20 },
    { 股票代码: "600000.SH", [key]: 10 },
  ],
};
it("uses the global count only after validating the exact descending-list position", () => {
  const result = verifiedRank("sh600519", target, universe, universe);
  expect(result).toMatchObject({
    verified: true,
    rank: 2,
    universeCount: 3,
    percentile: 50,
  });
});
it("computes tie-aware ranks from the complete list and refuses partial or malformed universes", () => {
  const snapshot = fullRsSnapshot(universe);
  expect(rankInSnapshot("sh600519", snapshot)).toMatchObject({
    rankStart: 2,
    rankEnd: 2,
    midRank: 2,
    percentile: 50,
    universeCount: 3,
  });
  const tied = {
    ...universe,
    datas: universe.datas.map((r) => ({ ...r, [key]: 20 })),
  };
  expect(rankInSnapshot("sh600519", fullRsSnapshot(tied))).toMatchObject({
    rankStart: 1,
    rankEnd: 3,
    midRank: 2,
    percentile: 50,
  });
  expect(() => fullRsSnapshot({ ...universe, code_count: 4 })).toThrow("完整");
  expect(() =>
    fullRsSnapshot({
      ...universe,
      datas: [universe.datas[0], universe.datas[0], universe.datas[2]],
    }),
  ).toThrow();
  expect(() =>
    fullRsSnapshot({
      ...universe,
      datas: [universe.datas[2], universe.datas[1], universe.datas[0]],
    }),
  ).toThrow("顺序");
  expect(() =>
    fullRsSnapshot({
      ...universe,
      datas: universe.datas.map((r) => ({ ...r, [key]: null })),
    }),
  ).toThrow();
  expect(() => rankInSnapshot("sz300750", snapshot)).toThrow("不在");
});
it("withholds percentiles when rank and list position, count, interval or ordering disagree", () => {
  for (const page of [
    { ...universe, code_count: 4 },
    {
      ...universe,
      datas: [universe.datas[1], universe.datas[0], universe.datas[2]],
    },
    { ...universe, columns: [{ ...columns[0], sort_info: "asc" }] },
    {
      ...universe,
      columns: [
        {
          ...columns[0],
          key: "涨跌幅[20260615-20260908]",
          timestamp: "20260615-20260908",
        },
      ],
    },
  ])
    expect(verifiedRank("sh600519", target, universe, page)).toMatchObject({
      verified: false,
      percentile: null,
    });
});
it("rejects fractional ranks and mismatched security identity", () => {
  expect(() => verifiedRank("sz600519", target, universe, universe)).toThrow();
  expect(() =>
    verifiedRank(
      "sh600519",
      { ...target, datas: [{ ...target.datas[0], [rankKey]: 1.5 }] },
      universe,
      universe,
    ),
  ).toThrow();
});
