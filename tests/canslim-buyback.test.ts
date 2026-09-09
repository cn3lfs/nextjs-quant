import { expect, it } from "vitest";
import { canslimBuyback } from "../src/server/canslim-buyback";
const row = () => ({
  股票代码: "600519.SH",
  预案公告日: "20250101",
  计划起始日: "20250102",
  计划截止日: "20250501",
  最新公告日: "20250502",
  进度: "全部回购股份已注销",
});
it("deduplicates rows but rejects reversed announcement dates", () => {
  const r = row();
  expect(
    canslimBuyback("sh600519", { status_code: 0, datas: [r, r] }, "2026-09-08")
      .plans,
  ).toHaveLength(1);
  r["最新公告日"] = "20240101";
  expect(
    canslimBuyback("sh600519", { status_code: 0, datas: [r] }, "2026-09-08"),
  ).toMatchObject({ status: "conflict", activeBuybackPlan: null });
});
it("keeps empty, incomplete or unrecognized plan data unknown", () => {
  expect(
    canslimBuyback("sh600519", { status_code: 0, datas: [] }, "2026-09-08")
      .activeBuybackPlan,
  ).toBeNull();
  const r = row();
  r["进度"] = "未知状态";
  expect(
    canslimBuyback("sh600519", { status_code: 0, datas: [r] }, "2026-09-08")
      .status,
  ).toBe("missing");
  expect(() =>
    canslimBuyback("sh600000", { status_code: 0, datas: [r] }, "2026-09-08"),
  ).toThrow("身份");
});
