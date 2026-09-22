import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseTdxDailyIncrement } from "../src/server/data-sources/tdx/tdx-daily-increment";
const cod = readFileSync("tests/fixtures/tdx-daily-increment/sample.cod");
const md1 = readFileSync("tests/fixtures/tdx-daily-increment/sample.md1");
const parse = (c = cod, m = md1) =>
  parseTdxDailyIncrement("sh", "2026-09-10", c, m, ["sh600519", "sh600000"]);
it("uses the code sequence offset and reports missing securities without fabricating bars", () => {
  const result = parse();
  expect(result.records).toEqual([
    {
      symbol: "sh600519",
      volumeUnit: "tdx-raw",
      bar: {
        date: "2026-09-10",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 12345,
        amount: 123456.25,
      },
    },
  ]);
  expect(result.unavailable).toEqual([
    { symbol: "sh600000", reason: "absent-code" },
  ]);
  const revised = Buffer.from(md1);
  revised.writeDoubleLE(10.5, 512 + 36);
  expect(parse(cod, revised).hash).not.toBe(result.hash);
  expect(result.records[0]!.bar.close).toBe(11);
});
it("rejects truncation, duplicate codes, out-of-range offsets and invalid prices", () => {
  const invalidCode = Buffer.from(cod);
  invalidCode[0] = 0xb6;
  expect(() => parse(invalidCode)).toThrow("代码非法");
  expect(() => parse(cod.subarray(1))).toThrow("长度");
  expect(() => parse(cod, md1.subarray(1))).toThrow("长度");
  expect(() => parse(Buffer.concat([cod, cod]))).toThrow("重复");
  const out = Buffer.from(cod);
  out.writeUInt16LE(2, 32);
  expect(() => parse(out)).toThrow("越界");
  const bad = Buffer.from(md1);
  bad.writeDoubleLE(NaN, 524);
  expect(() => parse(cod, bad)).toThrow("非有限");
  bad.writeDoubleLE(100, 524);
  expect(() => parse(cod, bad)).toThrow("价格关系");
  const huge = Buffer.from(md1);
  huge.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), 568);
  expect(() => parse(cod, huge)).toThrow("安全精度");
});
it("distinguishes an empty vendor record from a missing mapping", () => {
  const result = parse(cod, Buffer.alloc(1024));
  expect(result.records).toEqual([]);
  expect(result.unavailable).toEqual([
    { symbol: "sh600519", reason: "empty-vendor-record" },
    { symbol: "sh600000", reason: "absent-code" },
  ]);
});
