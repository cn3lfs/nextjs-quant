import { expect, it } from "vitest";
import { rsMembershipAudit } from "../src/server/rs-membership";
import { priceRsSnapshot } from "../src/server/price-rs";
const raw = {
  status_code: 0,
  code_count: 2,
  datas: [{ 股票代码: "600519.SH" }, { 股票代码: "000001.SZ" }],
};
const prices = priceRsSnapshot(
  {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        "收盘价_不复权[20250101]": 100,
        "收盘价_不复权[20250201]": 110,
      },
    ],
    columns: ["20250101", "20250201"].map((timestamp) => ({
      key: `收盘价_不复权[${timestamp}]`,
      timestamp,
      unit: "元",
      type: "DOUBLE",
    })),
  },
  "20250101",
  "20250201",
);
it("identifies codes silently absent from an otherwise complete price response", () => {
  expect(rsMembershipAudit(raw, prices)).toMatchObject({
    membershipCount: 2,
    priceDeclaredCount: 1,
    missingFromPrices: ["000001.SZ"],
    extraInPrices: [],
  });
});
it("rejects partial or duplicate membership lists", () => {
  expect(() => rsMembershipAudit({ ...raw, code_count: 3 }, prices)).toThrow(
    "完整",
  );
  expect(() =>
    rsMembershipAudit({ ...raw, datas: [raw.datas[0], raw.datas[0]] }, prices),
  ).toThrow("重复");
});
it("classifies only validated listing dates without guessing suspensions", () => {
  const audit = (date: string) =>
    rsMembershipAudit(
      {
        ...raw,
        columns: [{ key: "上市日期", type: "DATE" }],
        datas: raw.datas.map((r) => ({ ...r, 上市日期: date })),
      },
      prices,
    ).unavailable[0];
  expect(audit("20250102")?.reason).toContain("起始日之后");
  expect(audit("20250202")?.reason).toContain("截止日之后");
  expect(audit("20250201")?.reason).toContain("起始日之后");
  expect(audit("20250101")?.reason).toContain("原因待核验");
  expect(audit("20250230")?.listingDate).toBeNull();
  expect(rsMembershipAudit(raw, prices).unavailable[0]?.reason).toContain(
    "缺失",
  );
});
it("does not trust listing dates with ambiguous column metadata", () => {
  for (const columns of [
    [{ key: "上市日期", type: "STRING" }],
    [
      { key: "上市日期", type: "DATE" },
      { key: "上市日期", type: "STRING" },
    ],
    [
      { key: "上市日期", type: "DATE" },
      { key: "上市日期", type: "DATE" },
    ],
  ]) {
    const result = rsMembershipAudit(
      {
        ...raw,
        columns,
        datas: raw.datas.map((row) => ({ ...row, 上市日期: "20250102" })),
      },
      prices,
    );
    expect(result.unavailable[0]).toMatchObject({
      listingDate: null,
      reason: "上市日期缺失或非法",
    });
  }
});
