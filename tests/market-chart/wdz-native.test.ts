import { it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeWdzBars,
  decodeWdzBlock,
  decodeWdzLc5Bars,
  readWdzFiveMinute,
  readWdzLc5,
} from "../../src/server/data-sources/tdx/wdz-native";
import {
  parseFiveMinuteCsv,
  encodeFiveMinuteBar,
} from "../../src/server/data-sources/tdx/five-minute-csv";
import {
  importFiveMinuteBuffer,
  normalizeFiveMinuteCsv,
} from "../../src/server/data-sources/tdx/five-minute-native";
import { probeFiveMinuteFile } from "../../src/server/data-sources/tdx/five-minute-probe";

const fixture = "tests/fixtures/wdz/sh000001-20261104.wdz";
it("all three CLIs handle one symbol split over blocks without a concurrent overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-wdz-cli-"));
  try {
    const source = "tests/fixtures/wdz/split-sh000001.wdz",
      csv = join(dir, "csv");
    const roots = [join(dir, "via-csv"), join(dir, "direct")];
    for (const root of roots)
      for (const market of ["sh", "sz"])
        await mkdir(join(root, "vipdoc", market, "fzline"), {
          recursive: true,
        });
    function cli(script: string, args: string[]) {
      execFileSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", `scripts/${script}.ts`, ...args],
        { windowsHide: true, stdio: "pipe" },
      );
    }
    cli("extract-wdz", ["--source", source, "--out", csv]);
    expect(await readFile(join(csv, "SH", "SH000001.csv"))).toEqual(
      await readFile("tests/fixtures/wdz/SH000001.csv"),
    );
    cli("import-tdx-five-minute", [
      "--source",
      csv,
      "--tdx-root",
      roots[0]!,
      "--workers",
      "4",
    ]);
    cli("import-wdz-five-minute", [
      "--source",
      source,
      "--tdx-root",
      roots[1]!,
      "--workers",
      "4",
    ]);
    const actual = await readFile(
      join(roots[1]!, "vipdoc/sh/fzline/sh000001.lc5"),
    );
    expect(actual.length).toBe(48 * 32);
    expect(actual).toEqual(
      await readFile(join(roots[0]!, "vipdoc/sh/fzline/sh000001.lc5")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
async function collect(source: string) {
  const rows = [];
  for await (const row of readWdzFiveMinute(source)) rows.push(row);
  return rows;
}
it("decodes the fixed real 48-bar index fixture exactly like the original exporter", async () => {
  const rows = await collect(fixture);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.symbol).toBe("SH000001");
  expect(rows[0]!.bars).toBe(48);
  expect(rows[0]!.csv).toEqual(
    await readFile("tests/fixtures/wdz/SH000001.csv"),
  );
});

it("direct WDZ LC5 bytes equal CSV conversion, preserve old conflicts and import idempotently", async () => {
  const text = await readFile("tests/fixtures/wdz/SH000001.csv", "utf8");
  const expected = Buffer.concat(
    parseFiveMinuteCsv(text, "shares").map(encodeFiveMinuteBar),
  );
  const dir = await mkdtemp(join(tmpdir(), "quant-wdz-lc5-"));
  try {
    const target = join(dir, "sh000001.lc5");
    for await (const item of readWdzLc5(fixture)) {
      expect(item.data).toEqual(expected);
      const old = Buffer.from(expected.subarray(32 * 10, 32 * 20));
      old.writeFloatLE(3000, 16); // Same time, changed close: keep the original.
      await writeFile(target, old);
      const first = await importFiveMinuteBuffer(item.data, target, item);
      expect([first.added, first.identical, first.conflicts]).toEqual([
        38, 9, 1,
      ]);
      const actual = await readFile(target);
      expect(actual.subarray(32 * 10, 32 * 20)).toEqual(old);
      const repeat = await importFiveMinuteBuffer(item.data, target, item);
      expect([repeat.added, repeat.identical, repeat.conflicts]).toEqual([
        0, 47, 1,
      ]);
      expect(await readFile(target)).toEqual(actual);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects corrupted compressed data and declared sizes", async () => {
  const bytes = await readFile(fixture);
  const block = Buffer.from(bytes.subarray(0, bytes.readUInt32LE() + 4));
  block[10] = block[10]! ^ 128;
  expect(() => decodeWdzBlock(block)).toThrow();
  expect(() => decodeWdzBlock(bytes.subarray(0, 7))).toThrow();
  const huge = Buffer.alloc(8);
  huge.writeUInt32LE(4);
  huge.writeUInt32LE(0xffffffff, 4);
  expect(() => decodeWdzBlock(huge)).toThrow();
});

it("bounds compact fields, normalizes unordered records and reports invalid observations", () => {
  const record = Buffer.alloc(29);
  record[0] = 2;
  record.writeUInt32LE(1793784900, 1);
  [3599.5, 3605.39, 3616.23, 3613.22, 56211528, 70906347520].forEach((v, i) =>
    record.writeFloatLE(v, 5 + i * 4),
  );
  expect(decodeWdzBars(record).bars).toBe(1);
  const ordinary = decodeWdzLc5Bars(record, "SH600000");
  const historical = Buffer.from(record);
  const empty = Buffer.from(record);
  empty.fill(0, 5);
  const zero = decodeWdzLc5Bars(empty, "SH000001");
  expect(zero.bars).toBe(0);
  expect(zero.skippedTimes).toHaveLength(1);
  const withEmpty = Buffer.from(record);
  withEmpty.writeUInt32LE(record.readUInt32LE(1) + 300, 1);
  expect(
    decodeWdzLc5Bars(Buffer.concat([empty, withEmpty]), "SH000001").bars,
  ).toBe(1);
  historical.writeUInt32LE(Date.UTC(2000, 0, 4, 9, 35) / 1000, 1);
  const historicCsv = decodeWdzBars(historical).csv.toString();
  expect(decodeWdzLc5Bars(historical, "SH000001").data).toEqual(
    Buffer.concat(
      parseFiveMinuteCsv(historicCsv, "shares").map(encodeFiveMinuteBar),
    ),
  );
  expect(ordinary.data.readUInt32LE(24)).toBe(0);
  expect(ordinary.overflowTimes).toHaveLength(1);
  expect(decodeWdzLc5Bars(record, "SH000001").data.readUInt32LE(24)).toBe(
    56211530,
  );
  for (let n = 1; n < record.length; n++)
    expect(() => decodeWdzBars(record.subarray(0, n))).toThrow();
  const nan = Buffer.from(record);
  nan.writeFloatLE(NaN, 5);
  expect(() => decodeWdzBars(nan)).toThrow();
  const unsupported = Buffer.from(record);
  unsupported[0] = 26;
  expect(() => decodeWdzBars(unsupported)).toThrow();
  const earlier = Buffer.from(record);
  earlier.writeUInt32LE(1793784600, 1);
  const unsorted = Buffer.concat([record, earlier, record]);
  const sortedCsv = normalizeFiveMinuteCsv(
    decodeWdzBars(unsorted).csv.toString(),
  );
  expect(decodeWdzLc5Bars(unsorted, "SH000001").data).toEqual(
    Buffer.concat(
      parseFiveMinuteCsv(sortedCsv, "shares").map(encodeFiveMinuteBar),
    ),
  );
  const invalidTime = Buffer.from(record);
  invalidTime.writeUInt32LE(record.readUInt32LE(1) + 1, 1);
  expect(decodeWdzLc5Bars(invalidTime, "SH000001").skippedTimes).toHaveLength(
    1,
  );
  const invalidPrice = Buffer.from(record);
  invalidPrice.writeFloatLE(0, 5);
  expect(decodeWdzLc5Bars(invalidPrice, "SH000001").skippedTimes).toHaveLength(
    1,
  );
  const conflict = Buffer.from(record);
  conflict.writeFloatLE(3610, 17);
  expect(() =>
    decodeWdzLc5Bars(Buffer.concat([record, conflict]), "SH000001"),
  ).toThrow();
  expect(decodeWdzBars(Buffer.alloc(0)).bars).toBe(0);
});

it("C sorting handles larger unordered histories across LC5's wrapped year field", () => {
  let seed = 1234;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (const n of [1, 2, 3, 5, 101, 1000]) {
    const stamps = Array.from(
      { length: n },
      (_, i) =>
        Date.UTC(i % 2 ? 2026 : 2000, 0, 4, 9, 35) / 1000 +
        Math.floor(i / 2) * 300,
    );
    const records = stamps.map((stamp) => {
      const b = Buffer.alloc(29);
      b[0] = 2;
      b.writeUInt32LE(stamp, 1);
      [9, 10, 11, 10, 100, 10000].forEach((v, i) =>
        b.writeFloatLE(v, 5 + 4 * i),
      );
      return b;
    });
    records.push(...records.slice(0, Math.min(10, n)));
    for (let i = records.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [records[i], records[j]] = [records[j]!, records[i]!];
    }
    const expected = Buffer.concat(
      stamps
        .sort((a, b) => a - b)
        .map((stamp) =>
          encodeFiveMinuteBar({
            time: new Date(stamp * 1000)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19),
            open: 10,
            low: 9,
            high: 11,
            close: 10,
            volume: 100,
            amount: 10000,
          }),
        ),
    );
    expect(decodeWdzLc5Bars(Buffer.concat(records), "SH000001").data).toEqual(
      expected,
    );
  }
});

it("mapped probing preserves same-time conflicts, ignores reserved bytes and detects history holes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-lc5-probe-"));
  try {
    const incoming = Buffer.concat(
      parseFiveMinuteCsv(
        await readFile("tests/fixtures/wdz/SH000001.csv", "utf8"),
        "shares",
      ).map(encodeFiveMinuteBar),
    );
    const target = join(dir, "sh600000.lc5"),
      old = Buffer.from(incoming);
    old.writeUInt32LE(123, 28);
    old.writeFloatLE(3000, 32 + 16);
    await writeFile(target, old);
    expect(probeFiveMinuteFile(target, old.length, incoming)).toEqual({
      identical: 47,
      conflicts: 1,
    });
    await writeFile(
      target,
      Buffer.concat([old.subarray(0, 32 * 20), old.subarray(32 * 21)]),
    );
    expect(probeFiveMinuteFile(target, old.length - 32, incoming)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects missing trailers, impossible block boundaries and invalid index offsets", async () => {
  const bytes = await readFile(fixture);
  const dir = await mkdtemp(join(tmpdir(), "quant-wdz-"));
  try {
    const source = join(dir, "bad.wdz");
    const invalidIndex = Buffer.from(bytes);
    invalidIndex.writeUInt32LE(0xffffffff, bytes.length - 4);
    const invalidBlock = Buffer.from(bytes);
    invalidBlock.writeUInt32LE(0xffffffff);
    for (const bad of [
      bytes.subarray(0, 7),
      bytes.subarray(0, bytes.length - 1),
      invalidIndex,
      invalidBlock,
    ]) {
      await writeFile(source, bad);
      await expect(collect(source)).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
