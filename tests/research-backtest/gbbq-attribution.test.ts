import { expect, it } from "vitest";
import { GBBQ_RECORD_SIZE, parseGbbqRecords } from "tstdx/local";

function record(
  market: number,
  code: string | readonly number[],
  date: number,
  category: number,
) {
  const bytes = Buffer.alloc(GBBQ_RECORD_SIZE);
  bytes.writeUInt8(market, 0);
  if (typeof code === "string") bytes.write(code, 1, 6, "ascii");
  else code.forEach((byte, index) => bytes.writeUInt8(byte, 1 + index));
  bytes.writeUInt32LE(date, 8);
  bytes.writeUInt8(category, 12);
  bytes.writeFloatLE(5, 13);
  return bytes;
}

it("attributes rejected records with a decoded security and retains valid dividends", () => {
  const records = [
    record(1, "600000", 20250108, 1),
    record(0, "000001", 20250108, 255),
    record(0, "000001", 20250230, 1),
    record(0, "??????", 20250108, 1),
    // 0xB6 decodes to "6" under ASCII masking; the raw byte is not a digit.
    record(1, [0xb6, 0x30, 0x30, 0x30, 0x30, 0x30], 20250108, 255),
  ];
  const header = Buffer.alloc(4);
  header.writeUInt32LE(records.length);
  const parsed = parseGbbqRecords(
    Buffer.concat([header, ...records]),
    (plain) => plain,
  );
  expect(parsed.recordCount).toBe(5);
  expect([...parsed.events.keys()]).toEqual(["sh600000"]);
  expect(parsed.events.get("sh600000")).toMatchObject([
    { date: "2025-01-08", dividend: 0.5 },
  ]);
  expect(parsed.issues).toMatchObject([
    { symbol: "sz000001", reason: "证券代码、市场或事件类别未识别" },
    { symbol: "sz000001", reason: "事件日期非法" },
    { reason: "证券代码、市场或事件类别未识别" },
    { reason: "证券代码、市场或事件类别未识别" },
  ]);
  expect(parsed.issues[2]).not.toHaveProperty("symbol");
  expect(parsed.issues[3]).not.toHaveProperty("symbol");
});
