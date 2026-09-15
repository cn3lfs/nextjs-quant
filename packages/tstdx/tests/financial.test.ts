import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { parseFinancialFileList, parseFinancialReport } from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/financial-report.json", import.meta.url),
    "utf8",
  ),
) as { filename: string; payloadBase64: string };
const dat = Buffer.from(fixture.payloadBase64, "base64");

function crc32(body: Buffer) {
  let value = 0xffffffff;
  for (const byte of body) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipDat(name: string, body: Buffer) {
  const nameBytes = Buffer.from(name, "utf8"),
    compressed = deflateRawSync(body),
    crc = crc32(body),
    local = Buffer.alloc(30 + nameBytes.length),
    central = Buffer.alloc(46 + nameBytes.length),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

it("解析真实 gpcw 结构的 DAT fixture，保留代码、标记和原始字段", () => {
  const result = parseFinancialReport(dat, fixture.filename);
  expect(result).toMatchObject({
    sourceFilename: "gpcw20251231.dat",
    formatVersion: 1,
    reportDate: 20251231,
    recordCount: 2,
    fieldCount: 3,
  });
  expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    result.records.map(({ code, marker, dataOffset }) => [
      code,
      marker,
      dataOffset,
    ]),
  ).toEqual([
    ["000001", 0, 42],
    ["000002", 1, 54],
  ]);
  expect(result.records[0]!.values[0]).toBeCloseTo(2.07, 5);
  expect(result.records[0]!.values[2]).toBeCloseTo(13.9538, 5);
  expect(result.records[1]!.values[0]).toBeCloseTo(-7.4453, 5);
  expect(result.records[1]!.values[1]).toBeCloseTo(-7.22, 5);
  expect(result.records[1]!.values[2]).toBeCloseTo(-3.723, 5);
});

it("解析只含一个 DAT 的压缩财务 ZIP", () => {
  const result = parseFinancialReport(
    zipDat("gpcw20251231.dat", dat),
    "gpcw20251231.zip",
  );
  expect(result.reportDate).toBe(20251231);
  expect(result.records).toHaveLength(2);
  expect(result.sourceFilename).toBe("gpcw20251231.zip");
  expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
});

it("解析 gpcw.txt 清单并规范 MD5", () => {
  expect(
    parseFinancialFileList(
      Buffer.from(
        "\uFEFFgpcw20251231.zip,82E869DAAA298EF9A02BA7EDC68A4424,5804688\r\n",
      ),
    ),
  ).toEqual([
    {
      filename: "gpcw20251231.zip",
      md5: "82e869daaa298ef9a02ba7edc68a4424",
      filesize: 5804688,
    },
  ]);
});

it("拒绝截断、非法数值和损坏清单，但保留源文件重复代码", () => {
  expect(() => parseFinancialReport(dat.subarray(0, 65))).toThrow("数据截断");
  const duplicate = Buffer.from(dat);
  dat.subarray(20, 26).copy(duplicate, 31);
  expect(
    parseFinancialReport(duplicate).records.map((row) => row.code),
  ).toEqual(["000001", "000001"]);
  const invalidNumber = Buffer.from(dat);
  invalidNumber.writeFloatLE(Number.NaN, 42);
  expect(() => parseFinancialReport(invalidNumber)).toThrow("数值非法");
  expect(() =>
    parseFinancialFileList(Buffer.from("gpcw20251331.zip,abc,1")),
  ).toThrow("日期非法");
  expect(() =>
    parseFinancialFileList(
      Buffer.from(
        "gpcw20251231.zip,82e869daaa298ef9a02ba7edc68a4424,1\ngpcw20251231.zip,82e869daaa298ef9a02ba7edc68a4424,1",
      ),
    ),
  ).toThrow("清单重复");
});

it("拒绝不完整或错误 CRC 的 ZIP", () => {
  expect(() =>
    parseFinancialReport(Buffer.from("PK\x03\x04"), "x.zip"),
  ).toThrow("结束目录");
  const broken = zipDat("gpcw20251231.dat", dat);
  const centralOffset = broken.length - 22 - (46 + "gpcw20251231.dat".length);
  broken[centralOffset + 16]! ^= 1;
  expect(() => parseFinancialReport(broken, "gpcw20251231.zip")).toThrow("CRC");
});
