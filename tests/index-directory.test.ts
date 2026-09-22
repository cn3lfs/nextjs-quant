import { expect, it, vi } from "vitest";
import { indexDirectory } from "../src/server/market/index-directory";

vi.mock("../src/server/data-sources/tdx/tdx", () => ({
  securityNames: async (_root: string, market: string) =>
    new Map(
      market === "sh"
        ? [
            ["sh000510", "中证A500"],
            ["sh600000", "浦发银行"],
          ]
        : [["sz399005", "中小100"]],
    ),
}));

it("lists indices beyond the shortcuts without requiring local daily files", async () => {
  const rows = await indexDirectory("Z:/nonexistent-tdx-data");
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ symbol: "sh000510", name: "中证A500" }),
      expect.objectContaining({ symbol: "sz399005", name: "中小100" }),
      expect.objectContaining({ symbol: "sh000001", name: "上证指数" }),
    ]),
  );
  expect(rows.some((row) => row.symbol === "sh600000")).toBe(false);
  expect(rows.length).toBeGreaterThan(7);
});
