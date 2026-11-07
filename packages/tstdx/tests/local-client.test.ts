import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  parseNames,
  parseBars,
  parseLocalBaseDbf,
  parseLocalBaseMap,
  readLocalClientFile,
  readLocalTradingDates,
  securityNames,
} from "../src/local/index.js";
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/local/${name}`, import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tstdx-local-"));
  roots.push(root);
  return root;
}
it("客户端TNF的50字节头/360字节记录/GB18030名称有真实fixture证据", () => {
  expect(parseNames(fixture("shs.tnf"), "sh").get("sh600519")).toBe("贵州茅台");
  expect(parseNames(fixture("shs.tnf").subarray(0, -1), "sh").size).toBe(0);
});
it("基础DBF按自描述字段解析，原列和值保留，绝不据旧列名认证GO映射", () => {
  const bytes = fixture("base.dbf"),
    report = parseLocalBaseDbf(bytes);
  expect(report.recordCount).toBe(2);
  expect(report.fields).toHaveLength(40);
  expect(report.headerBytes).toBe(1313);
  expect(report.recordBytes).toBe(481);
  const row = report.rows.find((row) =>
    row.cells.some((c) => c.name === "GPDM" && c.value === "600519"),
  )!;
  expect(row.cells.find((c) => c.name === "ZZC")?.value).toBe(318304896);
  expect(report.mappingStatus).toBe("raw-columns-only");
  expect(() => parseLocalBaseDbf(bytes.subarray(0, -2))).toThrow("截断");
  const invalid = Buffer.from(bytes);
  invalid.writeUInt16LE(480, 10);
  expect(() => parseLocalBaseDbf(invalid)).toThrow();
  const badNumber = Buffer.from(bytes),
    field = report.fields.find((f) => f.name === "ZZC")!;
  badNumber.write("NaN", row.offset + field.offset, "ascii");
  expect(() => parseLocalBaseDbf(badNumber)).toThrow("数字非法");
  const badVersion = Buffer.from(bytes);
  badVersion[0] = 0x83;
  expect(() => parseLocalBaseDbf(badVersion)).toThrow("版本");
  expect(parseLocalBaseMap(fixture("base.map")).rows[0]).toMatchObject({
    code: "000001",
    mappingNumber: 13011,
  });
  expect(() => parseLocalBaseMap(Buffer.from("../bad"))).toThrow("记录非法");
});
it("目录读与交易日期同属包内，路径越界拒绝且同大小替换不能复用旧缓存", async () => {
  const root = await setup();
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  const bytes = Buffer.alloc(64);
  [20261030, 20261102].forEach((date, index) =>
    bytes.writeUInt32LE(date, index * 32),
  );
  const path = join(root, "vipdoc/sh/lday/sh000001.day");
  await writeFile(path, bytes);
  expect((await readLocalTradingDates(root)).days).toEqual([
    "2026-10-30",
    "2026-11-02",
  ]);
  const replacement = Buffer.from(bytes);
  replacement.writeUInt32LE(20261103, 32);
  await writeFile(`${path}.new`, replacement);
  await rename(`${path}.new`, path);
  expect((await readLocalTradingDates(root)).days.at(-1)).toBe("2026-11-03");
  await expect(readLocalClientFile(root, "../outside")).rejects.toThrow("越界");
  const invalid = Buffer.from(bytes);
  invalid.writeUInt32LE(20260230, 32);
  await writeFile(path, invalid);
  await expect(readLocalTradingDates(root)).rejects.toThrow("日期非法");
});
it("行情结构和输入限制由包内保持：残缺记录拒绝，修正证据显式返回", () => {
  expect(() => parseBars(Buffer.alloc(31), "day")).toThrow("32");
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(20261105);
  [1000, 1000, 900, 1001].forEach((v, i) => bytes.writeUInt32LE(v, 4 + 4 * i));
  bytes.writeFloatLE(100000, 20);
  bytes.writeUInt32LE(1000, 24);
  const repairs = { fixed: 0, dropped: 0 };
  expect(parseBars(bytes, "day", 2026, 2, repairs)[0]?.high).toBe(10.01);
  expect(repairs.fixed).toBe(1);
});
