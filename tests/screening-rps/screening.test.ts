import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  stat,
  utimes,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, readTailSnapshot } from "tstdx/local";
import { tailCacheStats } from "tstdx/local";
import { completedBar, completedBarFilter } from "~/lib/completed-bars";
import { defaultStrategy } from "~/lib/domain";
import { metrics } from "trading-strategies/research/technical/screening-metrics";
function data(count: number, year = 2025) {
  const bytes = Buffer.alloc(count * 32);
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(year, 0, i + 1))
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
    bytes.writeUInt32LE(Number(date), i * 32);
    [1000 + i * 10, 1020 + i * 10, 990 + i * 10, 1010 + i * 10].forEach(
      (price, j) => bytes.writeUInt32LE(price, i * 32 + 4 + j * 4),
    );
    bytes.writeFloatLE(100000, i * 32 + 20);
    bytes.writeUInt32LE(10000, i * 32 + 24);
  }
  return bytes;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-screening-"));
  await mkdir(join(root, "vipdoc", "sh", "lday"), { recursive: true });
  await mkdir(join(root, "T0002", "hq_cache"), { recursive: true });
  const names = Buffer.alloc(50 + 360 * 2);
  ["600001", "600002"].forEach((code, i) => {
    names.write(code, 50 + i * 360, "ascii");
    names.write(`Company ${i}`, 50 + i * 360 + 31, "ascii");
  });
  await writeFile(join(root, "T0002", "hq_cache", "shs.tnf"), names);
  return root;
}
it("缓存命中不共享可变对象；追加、同长度改写、替换及删除使缓存失效", async () => {
  const root = await fixture(),
    file = join(root, "vipdoc", "sh", "lday", "sh600001.day");
  await writeFile(file, data(100));
  const first = await readTailSnapshot(root, "sh600001", "day", 60);
  const baseline = tailCacheStats();
  expect(baseline.bytes).toBeGreaterThan(0);
  expect(baseline.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  first.bars[0]!.close = 999;
  first.bars = [];
  const cached = await readTailSnapshot(root, "sh600001", "day", 60);
  expect(tailCacheStats().hits).toBe(baseline.hits + 1);
  expect(tailCacheStats().bytes).toBe(baseline.bytes);
  expect(cached.bars).toHaveLength(60);
  expect(cached.bars[0]!.close).not.toBe(999);
  await writeFile(file, data(101));
  const appended = await readTailSnapshot(root, "sh600001", "day", 60);
  expect(appended.hash).not.toBe(cached.hash);
  const before = await stat(file),
    rewritten = data(101);
  rewritten.writeUInt32LE(2001, 100 * 32 + 16);
  await writeFile(file, rewritten);
  await utimes(file, before.atime, before.mtime);
  const changed = await readTailSnapshot(root, "sh600001", "day", 60);
  expect(changed.hash).not.toBe(appended.hash);
  const replacement = file + ".replacement";
  await writeFile(replacement, data(102));
  await rename(replacement, file);
  expect((await readTailSnapshot(root, "sh600001", "day", 60)).hash).not.toBe(
    changed.hash,
  );
  const bytesBeforeDelete = tailCacheStats().bytes;
  await unlink(file);
  await expect(readTailSnapshot(root, "sh600001", "day", 60)).rejects.toThrow();
  expect(tailCacheStats().bytes).toBeLessThan(bytesBeforeDelete);
});
it("不依赖 watcher，30 秒后重新读取校验窗口", async () => {
  const root = await fixture(),
    file = join(root, "vipdoc", "sh", "lday", "sh600001.day");
  await writeFile(file, data(100));
  const first = await readTailSnapshot(root, "sh600001", "day", 60),
    loads = tailCacheStats().loads;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31000);
  try {
    const next = await readTailSnapshot(root, "sh600001", "day", 60);
    expect(next.hash).toBe(first.hash);
    expect(tailCacheStats().loads).toBe(loads + 1);
  } finally {
    clock.mockRestore();
  }
});
it("尾窗与全历史的当前指标一致且快照标识隔离", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600001.day"),
    data(400),
  );
  const full = await readSnapshot(root, "sh600001", "day"),
    tail = await readTailSnapshot(root, "sh600001", "day", 300);
  expect(tail.bars).toEqual(full.bars.slice(-300));
  expect(metrics(tail.bars, defaultStrategy)).toEqual(
    metrics(full.bars, defaultStrategy),
  );
  expect(tail.id).not.toBe(full.id);
});
it("破损文件明确报错，不把残余记录当正常行情", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600001.day"),
    Buffer.alloc(33),
  );
  await expect(readTailSnapshot(root, "sh600001", "day", 300)).rejects.toThrow(
    "不完整",
  );
});
it("今日未收盘日线和未来分钟线不进入已完成窗口", () => {
  const now = Date.parse("2026-09-08T10:00:00+08:00");
  expect(completedBar("2026-09-08", "day", now)).toBe(false);
  expect(completedBar("2026-09-07", "day", now)).toBe(true);
  expect(completedBar("2026-09-08T10:05:00+08:00", "5m", now)).toBe(false);
});
it("a shared cutoff preserves the 15:05 daily boundary and exact minute completion", () => {
  const before = completedBarFilter(
    "day",
    Date.parse("2026-09-08T15:04:59+08:00"),
  );
  const after = completedBarFilter(
    "day",
    Date.parse("2026-09-08T15:05:00+08:00"),
  );
  expect(["2026-09-07", "2026-09-08", "2026-09-09"].map(before)).toEqual([
    true,
    false,
    false,
  ]);
  expect(["2026-09-07", "2026-09-08", "2026-09-09"].map(after)).toEqual([
    true,
    true,
    false,
  ]);
  const minute = completedBarFilter(
    "5m",
    Date.parse("2026-09-08T10:00:00+08:00"),
  );
  expect(
    [
      "2026-09-08T09:55:00+08:00",
      "2026-09-08T10:00:00+08:00",
      "2026-09-08T10:05:00+08:00",
      "2026-09-09T09:35:00+08:00",
    ].map(minute),
  ).toEqual([true, true, false, false]);
});
