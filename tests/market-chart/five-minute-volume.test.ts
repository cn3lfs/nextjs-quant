import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeWdzBars,
  decodeWdzLc5Bars,
} from "../../src/server/data-sources/tdx/wdz-native";
import {
  parseFiveMinuteCsv,
  encodeFiveMinuteBar,
} from "../../src/server/data-sources/tdx/five-minute-csv";
import { importFiveMinuteBuffer } from "../../src/server/data-sources/tdx/five-minute-native";
import { repairFiveMinuteFile } from "../../src/server/data-sources/tdx/five-minute-probe";

const samples = [
  ["SZ399379", 1, 2, 50000000, 3000000000, 50000000],
  ["SH999999", 1, 2, 50000000, 3000000000, 50000000],
  ["SH204001", 2.305, 2.55, 69261340, 69261340000, 69261340],
  ["SZ131810", 2.4, 2.635, 38660870, 38660860000, 38660870],
  ["SH688469", 5.62, 6.35, 143995800, 870879000, 143995800],
  ["SH688223", 12.44, 12.73, 27872570, 354528000, 27872570],
  ["SH600000", 9, 11, 100, 100000, 10000],
  ["SH588000", 1.11, 1.14, 23764490, 2706607000, 2376449000],
  ["SH520900", 0.98, 0.98, 162100000, 1590201, 1621000],
  ["SH520660", 0.97, 0.97, 270000000, 2627100, 0],
  ["SH600000", 0.99, 1.01, 50000000, 5000000000, 0],
] as const;
function compact(low: number, high: number, volume: number, amount: number) {
  const b = Buffer.alloc(29);
  b[0] = 2;
  b.writeUInt32LE(Date.UTC(2026, 10, 4, 9, 35) / 1000, 1);
  [low, low, high, high, volume, amount].forEach((v, i) =>
    b.writeFloatLE(v, 5 + i * 4),
  );
  return b;
}
it.each(samples)(
  "%s C and CSV agree on source units and unsigned limits",
  (symbol, low, high, volume, amount, expected) => {
    const input = compact(low, high, volume, amount);
    const native = decodeWdzLc5Bars(input, symbol);
    const csv = decodeWdzBars(input).csv.toString();
    const parsed = parseFiveMinuteCsv(csv, "shares", "zero-unsigned", symbol);
    expect(native.data.readUInt32LE(24)).toBe(expected);
    expect(native.data).toEqual(Buffer.concat(parsed.map(encodeFiveMinuteBar)));
    expect(native.overflowTimes).toHaveLength(expected === 0 ? 1 : 0);
  },
);
it("auto unit inference requires exactly one price match, and supports zero amounts", () => {
  const header = "Date,Open,Low,High,Close,Volume,Amount\n2026-11-04 09:35:00,";
  // A huge price range admits both shares and lots: retain the normal lots default.
  expect(
    parseFiveMinuteCsv(
      header + "1,1,200,1,100,10000",
      "shares",
      "zero-unsigned",
      "SH600000",
    )[0]!.volume,
  ).toBe(10000);
  expect(
    parseFiveMinuteCsv(
      header + "10,9,11,10,100,0",
      "shares",
      "zero-unsigned",
      "SH688469",
    )[0]!.volume,
  ).toBe(100);
  expect(
    parseFiveMinuteCsv(
      header + "10,9,11,10,100,0",
      "shares",
      "zero-unsigned",
      "SH600000",
    )[0]!.volume,
  ).toBe(10000);
  const max = parseFiveMinuteCsv(
    header + "10,9,11,10,4294967295,0",
    "shares",
    "zero-unsigned",
    "SH688469",
  )[0]!;
  expect(encodeFiveMinuteBar(max).readUInt32LE(24)).toBe(0xffffffff);
});
it("repairs only exact legacy volume signatures, preserves prices, amount, reserved and unrelated volume conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-volume-repair-"));
  try {
    for (const symbol of [
      "SH688469",
      "SZ399379",
      "SH204001",
      "SH520900",
      "SH588000",
    ]) {
      const row = samples.find((r) => r[0] === symbol)!;
      const input = compact(row[1], row[2], row[3], row[4]);
      const item = decodeWdzLc5Bars(input, symbol);
      const old = Buffer.from(item.data);
      old.writeUInt32LE(item.legacyVolumes.readUInt32LE(), 24);
      old.writeUInt32LE(123, 28);
      const target = join(dir, symbol.toLowerCase() + ".lc5");
      await writeFile(target, old);
      expect(
        (await importFiveMinuteBuffer(item.data, target, item)).repaired,
      ).toBe(1);
      const result = await readFile(target);
      expect(result.subarray(0, 24)).toEqual(old.subarray(0, 24));
      expect(result.readUInt32LE(24)).toBe(row[5]);
      expect(result.readUInt32LE(28)).toBe(123);
      expect(
        (await importFiveMinuteBuffer(item.data, target, item)).repaired,
      ).toBe(0);
      old.writeUInt32LE(777, 24);
      await writeFile(target, old);
      expect(
        (await importFiveMinuteBuffer(item.data, target, item)).repaired,
      ).toBe(0);
      expect(await readFile(target)).toEqual(old);
      old.writeUInt32LE(0, 24);
      await writeFile(target, old);
      expect(
        (await importFiveMinuteBuffer(item.data, target, item)).repaired,
      ).toBe(1);
      expect((await readFile(target)).readUInt32LE(24)).toBe(row[5]);
      old.writeUInt32LE(item.legacyVolumes.readUInt32LE(), 24);
      old.writeFloatLE(1, 20); // Amount differs: never overwrite this record.
      await writeFile(target, old);
      expect(
        (await importFiveMinuteBuffer(item.data, target, item)).repaired,
      ).toBe(0);
      expect(await readFile(target)).toEqual(old);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("mapped repair changes nothing if a later timestamp is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-volume-hole-"));
  try {
    const item = decodeWdzLc5Bars(
      compact(5.62, 6.35, 143995800, 870879000),
      "SH688469",
    );
    const old = Buffer.from(item.data);
    old.writeUInt32LE(item.legacyVolumes.readUInt32LE(), 24);
    const second = Buffer.from(item.data);
    second.writeUInt16LE(second.readUInt16LE(2) + 5, 2);
    const target = join(dir, "sh688469.lc5");
    await writeFile(target, old);
    expect(
      repairFiveMinuteFile(
        target,
        old.length,
        Buffer.concat([item.data, second]),
        Buffer.concat([item.legacyVolumes, item.legacyVolumes]),
      ),
    ).toBeNull();
    expect(await readFile(target)).toEqual(old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers a zero from exact raw source amount without accepting a nearby amount or changing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-raw-amount-"));
  try {
    const source = compact(1.985, 2.3, 216715968, 216716050432);
    const item = decodeWdzLc5Bars(source, "SH204001");
    const rawBits = item.sourceAmounts.readUInt32LE();
    expect(item.sourceAmounts.readFloatLE()).toBe(216716050432);
    expect(item.data.readUInt32LE(20)).not.toBe(rawBits);
    const old = Buffer.from(item.data);
    old.writeUInt32LE(rawBits, 20);
    old.writeUInt32LE(0, 24);
    old.writeUInt32LE(321, 28);
    const target = join(dir, "sh204001.lc5");
    await writeFile(target, old);
    const result = await importFiveMinuteBuffer(item.data, target, item);
    expect(result.repaired).toBe(1);
    // Amount still differs from the CSV-compatible source; do not call it identical.
    expect(result.conflicts).toBe(1);
    expect(result.identical).toBe(0);
    expect(result).not.toHaveProperty("sourceAmounts");
    const after = await readFile(target);
    expect(after.subarray(0, 24)).toEqual(old.subarray(0, 24));
    expect(after.readUInt32LE(28)).toBe(321);
    expect(after.readUInt32LE(24)).toBe(216716000);
    expect(
      (await importFiveMinuteBuffer(item.data, target, item)).repaired,
    ).toBe(0);
    // A single float ULP difference is still a different source amount.
    old.writeUInt32LE(rawBits + 1, 20);
    await writeFile(target, old);
    expect(
      (await importFiveMinuteBuffer(item.data, target, item)).repaired,
    ).toBe(0);
    expect(await readFile(target)).toEqual(old);
    old.writeUInt32LE(rawBits, 20);
    old.writeFloatLE(1, 4);
    await writeFile(target, old);
    expect(
      (await importFiveMinuteBuffer(item.data, target, item)).repaired,
    ).toBe(0);
    expect(await readFile(target)).toEqual(old);
    expect(() =>
      repairFiveMinuteFile(
        target,
        old.length,
        item.data,
        item.legacyVolumes,
        Buffer.alloc(1),
      ),
    ).toThrow("source amount metadata");
    // Raw-amount identity is deliberately limited to missing quantities.
    const nonzero = decodeWdzLc5Bars(
      compact(19, 21, 50000, 999999.9375),
      "SH600000",
    );
    const nonzeroOld = Buffer.from(nonzero.data);
    nonzeroOld.writeUInt32LE(nonzero.sourceAmounts.readUInt32LE(), 20);
    nonzeroOld.writeUInt32LE(nonzero.legacyVolumes.readUInt32LE(), 24);
    expect(nonzeroOld.readUInt32LE(24)).not.toBe(0);
    expect(nonzeroOld.readUInt32LE(24)).not.toBe(nonzero.data.readUInt32LE(24));
    expect(nonzeroOld.readUInt32LE(20)).not.toBe(nonzero.data.readUInt32LE(20));
    await writeFile(target, nonzeroOld);
    expect(
      (await importFiveMinuteBuffer(nonzero.data, target, nonzero)).repaired,
    ).toBe(0);
    expect(await readFile(target)).toEqual(nonzeroOld);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("raw amount metadata stays aligned through native sorting and deduplication", () => {
  const first = compact(1, 2, 1234, 123456789);
  const second = compact(1, 2, 2345, 234567891);
  second.writeUInt32LE(first.readUInt32LE(1) + 300, 1);
  const item = decodeWdzLc5Bars(
    Buffer.concat([second, first, first]),
    "SH204001",
  );
  expect(item.bars).toBe(2);
  expect(item.sourceAmounts.readFloatLE(0)).toBe(first.readFloatLE(25));
  expect(item.sourceAmounts.readFloatLE(4)).toBe(second.readFloatLE(25));
});

it("raw source amount also recovers volume when a history gap needs the normal merge path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-raw-merge-"));
  try {
    const first = compact(1.985, 2.3, 216715968, 216716050432);
    const second = Buffer.from(first);
    second.writeUInt32LE(first.readUInt32LE(1) + 300, 1);
    const item = decodeWdzLc5Bars(Buffer.concat([first, second]), "SH204001");
    const old = Buffer.from(item.data.subarray(0, 32));
    old.writeUInt32LE(item.sourceAmounts.readUInt32LE(), 20);
    old.writeUInt32LE(0, 24);
    const target = join(dir, "sh204001.lc5");
    await writeFile(target, old);
    const result = await importFiveMinuteBuffer(item.data, target, item);
    expect(result.added).toBe(1);
    expect(result.repaired).toBe(1);
    const after = await readFile(target);
    expect(after.subarray(0, 24)).toEqual(old.subarray(0, 24));
    expect(after.readUInt32LE(24)).toBe(216716000);
    expect(after.subarray(32)).toEqual(item.data.subarray(32));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
