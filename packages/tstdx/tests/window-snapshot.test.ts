import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSnapshot, readWindowSnapshot } from "../src/local/index.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function source(
  period: "day" | "5m",
  bytes: Buffer,
  symbol = "sh600000",
) {
  root = await mkdtemp(join(tmpdir(), "tstdx-window-"));
  const parent = join(root, "vipdoc/sh", period === "day" ? "lday" : "fzline");
  await mkdir(parent, { recursive: true });
  const path = join(parent, `${symbol}.${period === "day" ? "day" : "lc5"}`);
  await writeFile(path, bytes);
  return { root, path, symbol };
}

function daily(days: number) {
  const bytes = Buffer.alloc(days * 32);
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10);
    bytes.writeUInt32LE(Number(date.replaceAll("-", "")), i * 32);
    for (const offset of [4, 8, 12, 16])
      bytes.writeUInt32LE(1010 + i, i * 32 + offset);
    bytes.writeFloatLE(i + 0.25, i * 32 + 20);
    bytes.writeUInt32LE(i, i * 32 + 24);
  }
  return bytes;
}

it("matches full fund decoding across pages and keeps global repair evidence", async () => {
  const bytes = daily(8300);
  bytes.writeUInt32LE(bytes.readUInt32LE(4095 * 32), 4096 * 32);
  bytes.writeUInt32LE(bytes.readUInt32LE(4) - 1, 8);
  const file = await source("day", bytes, "sh510300");
  const options = { from: "2011-03-19", to: "2011-03-21", chartFunds: true };
  const full = await readSnapshot(file.root, file.symbol, "day", options);
  const expected = full.bars.filter(
    (bar) => bar.date >= options.from && bar.date <= options.to,
  );
  expect(expected.map((bar) => bar.date)).toEqual(["2011-03-19", "2011-03-21"]);
  expect(full.sourceNote).toContain("修正 1 根");
  expect(full.sourceNote).toContain("剔除 1 根");
  for (let i = 0; i < 2; i++) {
    const result = await readWindowSnapshot(
      file.root,
      file.symbol,
      "day",
      options,
    );
    expect(result.bars).toEqual(expected);
    expect(result.bars[0]!.close).toBe(5.105);
    expect(result.hash).toBe(full.hash);
    expect(result.sourceNote).toBe(full.sourceNote);
    expect(result.sourceLastDate).toBe(full.bars.at(-1)!.date);
  }
  expect(await readFile(file.path)).toEqual(bytes);
});

it("invalidates a warm date index and source hash for edits inside and outside the window", async () => {
  const bytes = daily(9000);
  const { root, path, symbol } = await source("day", bytes);
  const options = { from: "2011-03-19", to: "2011-03-20" };
  await utimes(path, 1700000000, 1700000000);
  let result = await readWindowSnapshot(root, symbol, "day", options);
  for (const record of [0, 4096, 8999]) {
    const offset = record * 32;
    bytes.writeUInt32LE(bytes.readUInt32LE(offset + 24) + 5, offset + 24);
    if (record === 4096)
      bytes.writeUInt32LE(bytes.readUInt32LE(offset - 32), offset);
    await writeFile(path, bytes);
    await utimes(path, 1700000000, 1700000000);
    const next = await readWindowSnapshot(root, symbol, "day", options);
    const full = await readSnapshot(root, symbol, "day");
    expect(next.hash).not.toBe(result.hash);
    expect(next.hash).toBe(full.hash);
    expect(next.bars).toEqual(
      full.bars.filter(
        (bar) => bar.date >= options.from && bar.date <= options.to,
      ),
    );
    result = next;
  }
});

it.each([false, true])(
  "matches 5m date bounds and full-history year decoding with wrap=%s",
  async (wrap) => {
    const rows = [
      [wrap ? 2003 : 2004, 1231, 895],
      [2004 + Number(!wrap), 102, 575],
      [2004 + Number(!wrap), 102, 580],
      [2004 + Number(!wrap), 103, 575],
    ];
    const bytes = Buffer.alloc(rows.length * 32);
    for (const [i, [year, day, minute]] of rows.entries()) {
      const at = i * 32;
      bytes.writeUInt16LE((((year! - 2004 + 32) % 32) << 11) + day!, at);
      bytes.writeUInt16LE(minute!, at + 2);
      for (const offset of [4, 8, 12, 16])
        bytes.writeFloatLE(1.25 + i, at + offset);
    }
    const { root, symbol } = await source("5m", bytes);
    const day = `${rows[1]![0]}-01-02`;
    const full = await readSnapshot(root, symbol, "5m");
    for (let i = 0; i < 2; i++) {
      const result = await readWindowSnapshot(root, symbol, "5m", {
        from: day,
        to: day,
      });
      expect(result.bars.map((bar) => bar.date)).toEqual([
        `${day}T09:35:00+08:00`,
        `${day}T09:40:00+08:00`,
      ]);
      expect(result.bars).toEqual(full.bars.slice(1, 3));
      expect(result.hash).toBe(full.hash);
      expect(result.regularMinuteSession).toBe(true);
    }
  },
);

it("returns empty for disjoint coverage and rejects invalid ranges, truncated records and oversized sources", async () => {
  const { root, path, symbol } = await source("day", daily(3));
  const read = (from: string, to?: string) =>
    readWindowSnapshot(root, symbol, "day", { from, to });
  expect((await read("1999-01-01", "1999-12-31")).bars).toEqual([]);
  expect((await read("2000-01-04")).bars).toEqual([]);
  await expect(read("2000-01-03", "2000-01-02")).rejects.toThrow(
    "行情区间非法",
  );
  await expect(read("2000-02-30")).rejects.toThrow("通达信日期非法");
  await truncate(path, 95);
  await expect(read("2000-01-01")).rejects.toThrow("记录长度");
  await truncate(path, 64 * 1024 ** 2 + 32);
  await expect(read("2000-01-01")).rejects.toThrow("容量超限");
});
