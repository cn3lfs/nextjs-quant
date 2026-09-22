import { expect, it } from "vitest";
import { canslimInstitutions } from "../src/lib/strategy-facts/canslim-institutions";
function fixture(shares = [121, 110, 100]) {
  const row: Record<string, unknown> = { 股票代码: "600519.SH" };
  const columns: { key: string; unit: string; timestamp: string }[] = [];
  ["20260630", "20260331", "20251231"].forEach((period, i) => {
    for (const [field, unit, value] of [
      ["机构持股数量", "股", shares[i]],
      ["机构持股占流通股比例", "%", 20],
      ["持股机构家数", "家", 10],
    ] as const) {
      const key = `${field}[${period}]`;
      row[key] = value;
      columns.push({ key, unit, timestamp: period });
    }
  });
  return { status_code: 0, datas: [row], columns };
}
it("distinguishes strict growth tiers using shares rather than holder counts", () => {
  expect(canslimInstitutions("sh600519", fixture()).points).toBe(4);
  expect(canslimInstitutions("sh600519", fixture([124, 112, 100])).points).toBe(
    5,
  );
  expect(canslimInstitutions("sh600519", fixture([120, 100, 110])).points).toBe(
    2,
  );
  expect(canslimInstitutions("sh600519", fixture([90, 100, 110])).points).toBe(
    0,
  );
});
it("preserves turnover exception, invalid units and absent quarters", () => {
  const raw = fixture([124, 112, 100]);
  raw.datas[0]!["持股机构家数[20260630]"] = 11;
  raw.datas[0]!["机构持股占流通股比例[20260630]"] = 19;
  expect(canslimInstitutions("sh600519", raw)).toMatchObject({
    points: 2,
    turnover: true,
  });
  raw.columns[0]!.unit = "家";
  expect(canslimInstitutions("sh600519", raw).status).toBe("missing");
  expect(canslimInstitutions("sh600519", fixture([10, 0, 0])).status).toBe(
    "conflict",
  );
  expect(() => canslimInstitutions("sh600000", fixture())).toThrow("身份");
});
