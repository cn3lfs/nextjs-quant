import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importFiveMinuteDirect,
  mergeNative,
} from "../../src/server/data-sources/tdx/five-minute-native";
import {
  parseFiveMinuteCsv,
  encodeFiveMinuteBar,
  mergeFiveMinuteBars,
} from "../../src/server/data-sources/tdx/five-minute-csv";
const csv =
  "Date,Open,Low,High,Close,Volume,Amount\n2026-11-04 09:35:00,10,9,11,10,100,10000\n2026-11-04 09:40:00,10,9,11,10,200,20000\n";

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
it("direct append retains the original bytes, repeat imports do not write duplicates, older inserts merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-native-"));
  const source = join(dir, "SH000001.csv"),
    target = join(dir, "sh000001.lc5");
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
