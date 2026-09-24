import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  parseChinabondHtml,
  parseRepoCsv,
} from "../../src/server/data-sources/macro/macro-rates";

it("中债页面解析：8 档期限，表头变化拒绝", () => {
  const html = readFileSync("tests/fixtures/chinabond-treasury.html", "utf8");
  const rows = parseChinabondHtml(html);
  expect(rows[0]).toEqual({
    date: "2026-09-23",
    "3m": 1.1865, "6m": 1.2002, "1y": 1.2347, "3y": 1.2894,
    "5y": 1.4073, "7y": 1.5046, "10y": 1.6807, "30y": 2.11,
  });
  expect(() => parseChinabondHtml(html.replaceAll("曲线名称", "名称"))).toThrow("表头改变");
});

it("货币网 CSV：去 BOM、升序、整行空值跳过、格式变化拒绝", () => {
  const csv = "\uFEFF2026-09-23,,,,,,1.4,1.5,1.6\n2026-09-18,,,,,,,,\n2026-09-22,,,,,,1.3,1.45,1.55\n";
  expect(parseRepoCsv(csv)).toEqual([
    { date: "2026-09-22", fr001: 1.3, fr007: 1.45, fr014: 1.55 },
    { date: "2026-09-23", fr001: 1.4, fr007: 1.5, fr014: 1.6 },
  ]);
  expect(() => parseRepoCsv("2026-09-23,x,,,,,1,2,3")).toThrow("格式改变");
});
