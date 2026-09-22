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
import {
  readSnapshot,
  readTailSnapshot,
  tailCacheStats,
} from "~/server/data-sources/tdx/tdx";
import { screenLocal } from "~/server/screening/screening";
import { completedBar, completedBarFilter } from "~/lib/completed-bars";
import { defaultStrategy } from "~/lib/domain";
import { metrics } from "~/lib/screening-metrics";
import * as tdx from "~/server/data-sources/tdx/tdx";
import { createHash } from "node:crypto";
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
it("reports attempted reads separately from verification failures and exclusions", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600001.day"),
    data(100, 2025),
  );
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600002.day"),
    data(100, 2024),
  );
  const progress = vi.fn();
  const result = await screenLocal(
    {
      root,
      symbols: ["sh600001", "sh600002", "sh600003"],
      period: "day",
      strategy: defaultStrategy,
    },
    progress,
  );
  expect(result.errors).toHaveLength(1);
  expect(result.excluded).toHaveLength(1);
  expect(progress.mock.calls.map((call) => call[2])).toContainEqual({
    stage: "读取行情",
    unit: "证券",
    processed: 3,
    total: 3,
    failed: 1,
    excluded: 0,
  });
  expect(progress.mock.calls.map((call) => call[2])).toContainEqual({
    stage: "复核候选",
    unit: "证券",
    processed: 2,
    total: 2,
    failed: 0,
    excluded: 1,
  });
});
it("完整筛选缓存复用结果但不共享对象，改写行情或名称后失效", async () => {
  const root = await fixture(),
    file = join(root, "vipdoc", "sh", "lday", "sh600001.day");
  await writeFile(file, data(100));
  const input = {
    root,
    symbols: ["sh600001"],
    period: "day" as const,
    strategy: defaultStrategy,
  };
  const first = await screenLocal(input);
  expect(first.cacheHit).toBe(false);
  expect(first.candidates).toHaveLength(1);
  first.candidates[0]!.name = "mutated";
  const originalScore = first.candidates[0]!.metrics.score;
  first.candidates[0]!.metrics.score = 999;
  first.snapshots[0]!.bars[0]!.close = 999;
  const cached = await screenLocal(input);
  expect(cached.cacheHit).toBe(true);
  expect(cached.candidates[0]!.name).not.toBe("mutated");
  expect(cached.candidates[0]!.metrics.score).toBe(originalScore);
  expect(cached.poolContext).toMatchObject({
    observed: 1,
    up: 1,
    requested: 1,
  });
  cached.poolContext!.warnings[0] = "mutated";
  expect((await screenLocal(input)).poolContext!.warnings[0]).not.toBe(
    "mutated",
  );
  expect(cached.snapshots[0]!.bars[0]!.close).not.toBe(999);
  const strategyRenamed = await screenLocal({
    ...input,
    strategy: { ...defaultStrategy, name: "另一个显示名称" },
  });
  expect(strategyRenamed.cacheHit).toBe(true);
  expect(strategyRenamed.candidates).toEqual(cached.candidates);
  const differentRules = await screenLocal({
    ...input,
    strategy: { ...defaultStrategy, minVolumeRatio: 20 },
  });
  expect(differentRules.cacheHit).toBe(false);
  expect(differentRules.candidates).toEqual([]);
  const unrelatedNames = Buffer.alloc(50 + 720);
  unrelatedNames.write("600001", 50);
  unrelatedNames.write("Company 0", 81);
  unrelatedNames.write("600002", 410);
  unrelatedNames.write("Unrelated rename", 441);
  await writeFile(join(root, "T0002", "hq_cache", "shs.tnf"), unrelatedNames);
  expect((await screenLocal(input)).cacheHit).toBe(true);
  const before = await stat(file),
    rewritten = data(100);
  rewritten.writeUInt32LE(2001, 99 * 32 + 16);
  await writeFile(file, rewritten);
  await utimes(file, before.atime, before.mtime);
  expect((await screenLocal(input)).cacheHit).toBe(false);
  expect((await screenLocal(input)).cacheHit).toBe(true);
  const names = Buffer.alloc(410);
  names.write("600001", 50);
  names.write("New name", 81);
  await writeFile(join(root, "T0002", "hq_cache", "shs.tnf"), names);
  const renamed = await screenLocal(input);
  expect(renamed.cacheHit).toBe(false);
  expect(renamed.candidates[0]?.name).toBe("New name");
  await unlink(file);
  const missing = await screenLocal(input);
  expect(missing.cacheHit).toBe(false);
  expect(missing.errors).toHaveLength(1);
});
it("未变行情跨30秒复用；完成时点、策略和日期变化阻止复用", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600001.day"),
    data(100),
  );
  const input = {
    root,
    symbols: ["sh600001"],
    period: "day" as const,
    strategy: defaultStrategy,
  };
  const now = Date.parse("2026-09-08T15:04:59+08:00"),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await screenLocal(input);
    expect((await screenLocal(input)).cacheHit).toBe(true);
    clock.mockReturnValue(now + 1000);
    expect((await screenLocal(input)).cacheHit).toBe(false);
    expect((await screenLocal(input)).cacheHit).toBe(true);
    clock.mockReturnValue(now + 32000);
    expect((await screenLocal(input)).cacheHit).toBe(true);
    clock.mockReturnValue(now + 3600000);
    expect((await screenLocal(input)).cacheHit).toBe(true);
    expect(
      (
        await screenLocal({
          ...input,
          strategy: { ...defaultStrategy, slow: 25 },
        })
      ).cacheHit,
    ).toBe(false);
    clock.mockReturnValue(now + 86400000);
    expect((await screenLocal(input)).cacheHit).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
it("历史截止日读取尾窗以外的数据，未来记录不进入指标，缺少当前名称不删除历史证券", async () => {
  const root = await fixture(),
    // Use a synthetic identity: sh600003 now resolves through the exchange archive.
    file = join(root, "vipdoc", "sh", "lday", "sh609999.day");
  await writeFile(file, data(500));
  const input = {
    root,
    symbols: ["sh609999"],
    period: "day" as const,
    strategy: defaultStrategy,
    asOf: "2025-04-10",
  };
  const result = await screenLocal(input);
  expect(result.candidates).toHaveLength(1);
  expect(result.snapshots[0]?.bars).toHaveLength(100);
  expect(result.snapshots[0]?.historicalAsOf).toBe(input.asOf);
  expect(result.candidates[0]?.name).toContain("历史名称未核验");
  expect(result.snapshots[0]?.bars.at(-1)?.date).toBe(input.asOf);
  const bytes = data(501);
  bytes.writeUInt32LE(9000, 500 * 32 + 8);
  bytes.writeUInt32LE(8000, 500 * 32 + 16);
  await writeFile(file, bytes);
  const changedFuture = await screenLocal(input);
  expect(changedFuture.candidates).toEqual(result.candidates);
  expect(changedFuture.snapshots[0]?.hash).toBe(result.snapshots[0]?.hash);
});
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
it("已核验主档名称可供筛选使用，缺名时仍隔离", async () => {
  const root = await fixture();
  await writeFile(join(root, "vipdoc", "sh", "lday", "sh600099.day"), data(60));
  const input = {
    root,
    symbols: ["sh600099"],
    period: "day" as const,
    strategy: defaultStrategy,
  };
  const missing = await screenLocal(input);
  expect(missing.candidates).toHaveLength(0);
  expect(missing.excluded[0]?.reason).toContain("身份待核验");
  expect(missing.poolContext?.observed).toBe(0);
  const confirmed = await screenLocal({
    ...input,
    names: { sh600099: "Verified name" },
  });
  expect(confirmed.candidates[0]?.name).toBe("Verified name");
  expect(confirmed.snapshots[0]?.name).toBe("Verified name");
});
it("统一日期隔离旧行情，不用旧股票的最后一次交易参加当前排名", async () => {
  const root = await fixture();
  await writeFile(join(root, "vipdoc", "sh", "lday", "sh600001.day"), data(40));
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600002.day"),
    data(40, 2004),
  );
  const result = await screenLocal({
    root,
    symbols: ["sh600001", "sh600002", "sh600001"],
    period: "day",
    strategy: defaultStrategy,
  });
  expect(result.total).toBe(2);
  expect(result.candidates.map((c) => c.symbol)).toEqual(["sh600001"]);
  expect(result.excluded[0]?.symbol).toBe("sh600002");
  expect(result.asOf).toBe("2025-02-09");
  expect(result.poolContext).toMatchObject({
    requested: 2,
    observed: 1,
    up: 1,
  });
  const unmatched = await screenLocal({
    root,
    symbols: ["sh600001", "sh600002"],
    period: "day",
    strategy: { ...defaultStrategy, minVolumeRatio: 20 },
  });
  expect(unmatched.candidates).toHaveLength(0);
  expect(unmatched.poolContext?.observed).toBe(1);
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

it("completed window hashes retain the original formula when the source prefix grows", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "vipdoc", "sh", "lday", "sh600001.day"),
    data(60, 2026),
  );
  const input = {
    root,
    symbols: ["sh600001"],
    period: "day" as const,
    strategy: defaultStrategy,
  };
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-03-01T15:04:00+08:00"));
  try {
    const raw = await readTailSnapshot(root, "sh600001", "day", 300);
    const expected = (length: number) =>
      createHash("sha256")
        .update(`completed-v1:${raw.hash}:`)
        .update(JSON.stringify(raw.bars.slice(0, length)))
        .digest("hex");
    const before = await screenLocal(input);
    expect(before.snapshots[0]!.bars).toHaveLength(59);
    expect(before.snapshots[0]!.hash).toBe(expected(59));
    clock.mockReturnValue(Date.parse("2026-03-01T15:05:00+08:00"));
    const after = await screenLocal(input);
    expect(after.cacheHit).toBe(false);
    expect(after.snapshots[0]!.bars).toHaveLength(60);
    expect(after.snapshots[0]!.hash).toBe(expected(60));
    const changed = await screenLocal({
      ...input,
      strategy: { ...defaultStrategy, fast: 6 },
    });
    expect(changed.cacheHit).toBe(false);
    expect(changed.snapshots[0]!.hash).toBe(expected(60));
  } finally {
    clock.mockRestore();
  }
});

async function minuteFixture() {
  const root = await fixture();
  await mkdir(join(root, "vipdoc", "sh", "fzline"), { recursive: true });
  const bytes = Buffer.alloc(60 * 32);
  for (let i = 0; i < 60; i++) {
    bytes.writeUInt16LE((22 << 11) + 908, i * 32);
    bytes.writeUInt16LE(575 + i * 5, i * 32 + 2);
    [10 + i / 10, 10.2 + i / 10, 9.9 + i / 10, 10.1 + i / 10].forEach(
      (value, j) => bytes.writeFloatLE(value, i * 32 + 4 + j * 4),
    );
    bytes.writeFloatLE(100000, i * 32 + 20);
    bytes.writeUInt32LE(10000, i * 32 + 24);
  }
  const file = join(root, "vipdoc", "sh", "fzline", "sh600001.lc5");
  await writeFile(file, bytes);
  return {
    root,
    file,
    bytes,
    input: {
      root,
      symbols: ["sh600001"],
      period: "5m" as const,
      strategy: defaultStrategy,
    },
  };
}

it("fully completed minute sources reuse across minutes but refresh on files, rules, names and dates", async () => {
  const { input, file, bytes } = await minuteFixture();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-08T15:00:59+08:00"));
    const first = await screenLocal(input);
    expect(first.completionStable).toBe(true);
    vi.setSystemTime(new Date("2026-09-08T15:02:00+08:00"));
    const repeated = await screenLocal(input);
    expect(repeated.cacheHit).toBe(true);
    expect(repeated.candidates).toEqual(first.candidates);
    expect(
      (
        await screenLocal({
          ...input,
          strategy: { ...defaultStrategy, fast: 6 },
        })
      ).cacheHit,
    ).toBe(false);
    expect(
      (await screenLocal({ ...input, names: { sh600001: "New name" } }))
        .cacheHit,
    ).toBe(false);
    bytes.writeFloatLE(15.95, 59 * 32 + 16);
    await writeFile(file, bytes);
    expect((await screenLocal(input)).cacheHit).toBe(false);
    expect((await screenLocal(input)).cacheHit).toBe(true);
    vi.setSystemTime(new Date("2026-09-09T00:00:00+08:00"));
    expect((await screenLocal(input)).cacheHit).toBe(false);
    vi.setSystemTime(new Date("2026-09-08T15:01:00+08:00"));
    expect((await screenLocal(input)).cacheHit).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("a future minute bar prevents stable reuse until its completion time", async () => {
  const { input } = await minuteFixture();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-08T14:25:00+08:00"));
    const first = await screenLocal(input);
    expect(first.completionStable).toBe(false);
    expect(first.snapshots[0]!.bars.at(-1)!.date).toBe(
      "2026-09-08T14:25:00+08:00",
    );
    vi.setSystemTime(new Date("2026-09-08T14:30:00+08:00"));
    const next = await screenLocal(input);
    expect(next.cacheHit).toBe(false);
    expect(next.snapshots[0]!.bars.at(-1)!.date).toBe(
      "2026-09-08T14:30:00+08:00",
    );
    expect(next.completionStable).toBe(true);
    vi.setSystemTime(new Date("2026-09-08T14:31:00+08:00"));
    expect((await screenLocal(input)).cacheHit).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("a completed-source calculation crossing a minute still populates its validated cache", async () => {
  const { input } = await minuteFixture();
  const original = tdx.readTailSnapshot;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T15:00:59+08:00"));
  const reader = vi
    .spyOn(tdx, "readTailSnapshot")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      vi.setSystemTime(new Date("2026-09-08T15:01:01+08:00"));
      return result;
    });
  try {
    const first = await screenLocal(input);
    expect(first.errors).toEqual([]);
    expect(first.completionStable).toBe(true);
    expect(first.cacheHit).toBe(false);
    const reads = reader.mock.calls.length;
    const repeat = await screenLocal(input);
    expect(repeat.cacheHit).toBe(true);
    expect(reader.mock.calls).toHaveLength(reads);
    expect(repeat.candidates).toEqual(first.candidates);
  } finally {
    reader.mockRestore();
    vi.useRealTimers();
  }
});

it("completed minute hashes distinguish decoded year cycles for identical source bytes", async () => {
  const root = await fixture();
  await mkdir(join(root, "vipdoc", "sh", "fzline"), { recursive: true });
  const bytes = Buffer.alloc(60 * 32);
  for (let i = 0; i < 60; i++) {
    bytes.writeUInt16LE((29 << 11) + 102, i * 32);
    bytes.writeUInt16LE(575 + i * 5, i * 32 + 2);
    [10 + i / 10, 10.2 + i / 10, 9.9 + i / 10, 10.1 + i / 10].forEach(
      (value, j) => bytes.writeFloatLE(value, i * 32 + 4 + j * 4),
    );
    bytes.writeFloatLE(100000, i * 32 + 20);
    bytes.writeUInt32LE(10000, i * 32 + 24);
  }
  await writeFile(join(root, "vipdoc", "sh", "fzline", "sh600001.lc5"), bytes);
  vi.useFakeTimers();
  try {
    const input = {
      root,
      symbols: ["sh600001"],
      period: "5m" as const,
      strategy: defaultStrategy,
    };
    vi.setSystemTime(new Date("2026-06-01T12:00:00+08:00"));
    const before = await screenLocal(input);
    vi.setSystemTime(new Date("2033-06-01T12:00:00+08:00"));
    const after = await screenLocal(input);
    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(before.snapshots[0]!.bars[0]!.date).toMatch(/^2001-/);
    expect(after.snapshots[0]!.bars[0]!.date).toMatch(/^2033-/);
    expect(after.snapshots[0]!.bars.length).toBe(
      before.snapshots[0]!.bars.length,
    );
    expect(after.snapshots[0]!.hash).not.toBe(before.snapshots[0]!.hash);
    const raw = await readTailSnapshot(root, "sh600001", "5m", 300);
    expect(after.snapshots[0]!.hash).toBe(
      createHash("sha256")
        .update(`completed-v1:${raw.hash}:`)
        .update(JSON.stringify(raw.bars))
        .digest("hex"),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("research windows use bounded concurrency while retaining candidate metrics and snapshots", async () => {
  const root = await fixture();
  const symbols = Array.from({ length: 12 }, (_, i) => `sh${600010 + i}`);
  await Promise.all(
    symbols.map((symbol) =>
      writeFile(join(root, "vipdoc", "sh", "lday", `${symbol}.day`), data(60)),
    ),
  );
  const original = tdx.readTailSnapshot;
  let active = 0,
    peak = 0;
  const spy = vi
    .spyOn(tdx, "readTailSnapshot")
    .mockImplementation(async (...args) => {
      if (args[3] < 300) return original(...args);
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await original(...args);
      } finally {
        active--;
      }
    });
  try {
    const result = await screenLocal({
      root,
      symbols,
      names: Object.fromEntries(
        symbols.map((symbol) => [symbol, `Name ${symbol}`]),
      ),
      period: "day",
      strategy: defaultStrategy,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(12);
    for (const candidate of result.candidates) {
      const full = await readSnapshot(root, candidate.symbol, "day");
      const snapshot = result.snapshots.find(
        (s) => s.id === candidate.snapshotId,
      )!;
      expect(snapshot.bars).toEqual(full.bars);
      expect(candidate.metrics).toEqual(metrics(full.bars, defaultStrategy));
    }
  } finally {
    spy.mockRestore();
  }
});
