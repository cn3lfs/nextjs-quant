import { expect, it } from "vitest";
import { canslimHolderList } from "../src/server/strategies/canslim/canslim-holder-list";
const rows = () =>
  Array.from({ length: 10 }, (_, i) => ({
    股票代码: "600519.SH",
    名称: `股东${i}`,
    排名: i + 1,
    公告日期: "20260815",
    类型: ["机构"],
  }));
const cutoff = Date.parse("2026-09-08T00:00:00+08:00");
it("requires unique ranks and identities, not merely ten rows", () => {
  const datas = rows();
  expect(
    canslimHolderList("sh600519", { status_code: 0, datas }, cutoff),
  ).toMatchObject({ completeRanks: true, consistentDate: true });
  expect(() =>
    canslimHolderList(
      "sh600519",
      { status_code: 0, datas: Array(10).fill(datas[4]) },
      cutoff,
    ),
  ).toThrow("重复");
  expect(
    canslimHolderList(
      "sh600519",
      { status_code: 0, datas: datas.slice(0, 9) },
      cutoff,
    ).completeRanks,
  ).toBe(false);
});
it("rejects future and malformed dates, and separates mixed dates from a complete list", () => {
  const datas = rows();
  datas[0]!["公告日期"] = "20260814";
  expect(
    canslimHolderList("sh600519", { status_code: 0, datas }, cutoff)
      .consistentDate,
  ).toBe(false);
  for (const date of ["20260230", "20260909"]) {
    datas[0]!["公告日期"] = date;
    expect(() =>
      canslimHolderList("sh600519", { status_code: 0, datas }, cutoff),
    ).toThrow("日期");
  }
  expect(() =>
    canslimHolderList("sh600000", { status_code: 0, datas: rows() }, cutoff),
  ).toThrow("身份");
});
