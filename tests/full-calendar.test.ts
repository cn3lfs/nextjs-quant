import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseBars } from "../src/server/data-sources/tdx/tdx";
import { createHash } from "node:crypto";
import {
  fullLocalCalendarReference,
  localCalendarReference,
} from "../src/server/market/data-health";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture(count = 620) {
  const root = await fs.mkdtemp(join(tmpdir(), "quant-full-calendar-"));
  roots.push(root);
  const directory = join(root, "vipdoc", "sh", "lday");
  await fs.mkdir(directory, { recursive: true });
  const days = Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  );
  const bytes = Buffer.alloc(count * 32);
  days.forEach((day, i) => {
    bytes.writeUInt32LE(Number(day.replaceAll("-", "")), i * 32);
    for (const field of [4, 8, 12, 16])
      bytes.writeUInt32LE(1000, i * 32 + field);
    bytes.writeFloatLE(10000, i * 32 + 20);
    bytes.writeUInt32LE(1000, i * 32 + 24);
  });
  const path = join(directory, "sh000001.day");
  await fs.writeFile(path, bytes);
  return { root, path, bytes, days };
}

it("reads and hashes all records while the recent reference retains its 400-record window", async () => {
  const { root, path, bytes, days } = await fixture();
  expect(await fullLocalCalendarReference(root, [])).toEqual({
    days,
    coverage: { start: days[0], end: days.at(-1), count: days.length },
    source: "本地上证指数全部已有交易日期（非完整官方日历）",
    hash: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(await localCalendarReference(root, [])).toEqual({
    days: days.slice(-400),
    source: "本地上证指数最近 400 根已有交易日期（非完整官方日历）",
    hash: createHash("sha256")
      .update(bytes.subarray(220 * 32))
      .digest("hex"),
  });
  expect(await fs.readFile(path)).toEqual(bytes);
});

it("retains explicitly configured dates and their provenance", async () => {
  const days = ["2021-01-04", "2021-01-05"];
  expect(await fullLocalCalendarReference("unused", days)).toEqual({
    ...(await localCalendarReference("unused", days)),
    coverage: { start: days[0], end: days.at(-1), count: 2 },
  });
});

it("rejects a truncated record instead of returning partial dates", async () => {
  const { root, path, bytes } = await fixture();
  await fs.writeFile(path, bytes.subarray(0, bytes.length - 1));
  await expect(fullLocalCalendarReference(root, [])).rejects.toThrow(
    "指数日期记录不完整",
  );
});

it.each(["after", "current"] as const)(
  "rejects changed %s file metadata and closes the handle",
  async (phase) => {
    const { root, path } = await fixture();
    const handle = await fs.open(path, "r");
    const before = await handle.stat();
    const changed = Object.assign(
      Object.create(Object.getPrototypeOf(before)),
      before,
      {
        mtimeMs: before.mtimeMs + 1,
      },
    );
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    vi.spyOn(handle, "stat")
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(phase === "after" ? changed : before);
    vi.spyOn(fs, "stat").mockResolvedValueOnce(
      phase === "current" ? changed : before,
    );
    const close = vi.spyOn(handle, "close");
    await expect(fullLocalCalendarReference(root, [])).rejects.toThrow(
      "读取期间发生变化",
    );
    expect(close).toHaveBeenCalledOnce();
  },
);

it("rejects a short read even when metadata is unchanged", async () => {
  const { root, path } = await fixture();
  const handle = await fs.open(path, "r");
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  vi.spyOn(handle, "read").mockResolvedValueOnce({
    bytesRead: 0,
    buffer: Buffer.alloc(0),
  });
  await expect(fullLocalCalendarReference(root, [])).rejects.toThrow(
    "读取期间发生变化",
  );
});

it("rejects an actual file append between the before and after checks", async () => {
  const { root, path } = await fixture();
  const handle = await fs.open(path, "r");
  const originalStat = handle.stat.bind(handle);
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
    const before = await originalStat();
    await fs.appendFile(path, Buffer.alloc(32));
    return before;
  });
  await expect(fullLocalCalendarReference(root, [])).rejects.toThrow(
    "读取期间发生变化",
  );
});

it("keeps historical dates with invalid OHLC while price readers remain strict", async () => {
  const { root, path, bytes } = await fixture(2);
  bytes.writeUInt32LE(19910508, 0);
  bytes.writeUInt32LE(19910509, 32);
  bytes.writeUInt32LE(0, 36);
  bytes.writeFloatLE(NaN, 52);
  await fs.writeFile(path, bytes);
  expect(() => parseBars(bytes, "day")).toThrow("行情记录非法：1991-05-09");
  expect(await localCalendarReference(root, [])).toEqual({
    days: [],
    source: "交易日期参考不可用",
    hash: null,
  });
  expect(await fullLocalCalendarReference(root, [])).toMatchObject({
    days: ["1991-05-08", "1991-05-09"],
    coverage: { start: "1991-05-08", end: "1991-05-09", count: 2 },
  });
});
it.each([
  20201231, 20210101, 20210229, 20211301, 20210001, 20210100, 0, 100000000,
])("rejects invalid or non-increasing date %s", async (date) => {
  const { root, path, bytes } = await fixture(2);
  bytes.writeUInt32LE(date, 32);
  await fs.writeFile(path, bytes);
  await expect(fullLocalCalendarReference(root, [])).rejects.toThrow(
    /指数日期(非法|倒序或重复)/,
  );
});
it("reports empty coverage explicitly", async () => {
  const { root } = await fixture(0);
  expect(await fullLocalCalendarReference(root, [])).toMatchObject({
    days: [],
    coverage: { start: null, end: null, count: 0 },
  });
});
it("accepts leap day", async () => {
  const { root, path, bytes } = await fixture(1);
  bytes.writeUInt32LE(20000229, 0);
  await fs.writeFile(path, bytes);
  expect((await fullLocalCalendarReference(root, [])).days).toEqual([
    "2000-02-29",
  ]);
});
