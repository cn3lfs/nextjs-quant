import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importFiveMinuteDirect,
  mergeNative,
  normalizeFiveMinuteCsv,
} from "../../src/server/data-sources/tdx/five-minute-native";
import {
  parseFiveMinuteCsv,
  encodeFiveMinuteBar,
  mergeFiveMinuteBars,
} from "../../src/server/data-sources/tdx/five-minute-csv";
const csv =
  "Date,Open,Low,High,Close,Volume,Amount\n2026-11-04 09:35:00,10,9,11,10,100,10000\n2026-11-04 09:40:00,10,9,11,10,200,20000\n";

it("sorts source rows, removes exact duplicates and rejects conflicting duplicates", () => {
  const [header, first, second] = csv.trim().split("\n");
  const normalized = normalizeFiveMinuteCsv(
    [header, second, first, second, first].join("\n"),
  );
  expect(parseFiveMinuteCsv(normalized, "lots")).toHaveLength(2);
  expect(normalized).toBe(csv.trim());
  expect(() =>
    normalizeFiveMinuteCsv(
      [header, first, first!.replace(",100,", ",101,")].join("\n"),
    ),
  ).toThrow("内容冲突");
});

it("C merge matches fixed LC5 encoding, preserves conflicts and rejects corrupt times", () => {
  const bars = parseFiveMinuteCsv(csv, "lots");
  const old = encodeFiveMinuteBar({ ...bars[0]!, close: 9.5 });
  old.writeUInt32LE(123, 28);
  const incoming = Buffer.concat(bars.map(encodeFiveMinuteBar));
  const actual = mergeNative(old, incoming);
  expect(actual.data).toEqual(mergeFiveMinuteBars(old, bars).data);
  expect([actual.added, actual.identical, actual.conflicts]).toEqual([1, 0, 1]);
  expect(() => mergeNative(Buffer.alloc(31), incoming)).toThrow();
  expect(() =>
    mergeNative(
      Buffer.concat([incoming.subarray(32), incoming.subarray(0, 32)]),
      incoming,
    ),
  ).toThrow();
});
it("common indices keep lots and repair only matching legacy volume fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-index-unit-"));
  const source = join(dir, "SH000001.csv"),
    target = join(dir, "sh000001.lc5");
  const input = csv.replace(",100,", ",60990100,");
  const legacy = Buffer.concat(
    parseFiveMinuteCsv(input, "lots", "zero-signed").map(encodeFiveMinuteBar),
  );
  legacy.writeUInt32LE(123, 28);
  await writeFile(source, input);
  await writeFile(target, legacy);
  const result = await importFiveMinuteDirect(source, target);
  expect(result.repaired).toBe(2);
  const actual = await readFile(target);
  expect(actual.readUInt32LE(24)).toBe(60990100);
  expect(actual.readUInt32LE(56)).toBe(200);
  expect(actual.subarray(0, 24)).toEqual(legacy.subarray(0, 24));
  expect(actual.readUInt32LE(28)).toBe(123);
  expect((await importFiveMinuteDirect(source, target)).repaired).toBe(0);
});
it("direct append retains the original bytes, repeat imports do not write duplicates, older inserts merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-native-"));
  const source = join(dir, "SH600000.csv"),
    target = join(dir, "sh600000.lc5");
  const bars = parseFiveMinuteCsv(csv, "lots");
  const original = encodeFiveMinuteBar(bars[0]!);
  await writeFile(target, original);
  await writeFile(
    source,
    csv.split("\n")[0] + "\n" + csv.split("\n")[2] + "\n",
  );
  expect((await importFiveMinuteDirect(source, target)).added).toBe(1);
  const appended = await readFile(target);
  expect(appended.subarray(0, 32)).toEqual(original);
  expect(appended.length).toBe(64);
  expect((await importFiveMinuteDirect(source, target)).added).toBe(0);
  expect(await readFile(target)).toEqual(appended);
  await writeFile(target, encodeFiveMinuteBar(bars[1]!));
  await writeFile(source, csv);
  expect((await importFiveMinuteDirect(source, target)).added).toBe(1);
  expect(await readFile(target)).toEqual(
    Buffer.concat(bars.map(encodeFiveMinuteBar)),
  );
  await writeFile(source, csv.replace("09:40:00", "09:35:00"));
  await expect(importFiveMinuteDirect(source, target)).rejects.toThrow();
  expect(await readFile(target)).toEqual(appended);
});
