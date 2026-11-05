import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFiveMinuteDirectory } from "../../src/server/data-sources/tdx/five-minute-preview";
import {
  importPreviewItem,
  restoreImportedFile,
} from "../../src/server/data-sources/tdx/five-minute-write";
import {
  encodeFiveMinuteBar,
  mergeFiveMinuteBars,
  parseFiveMinuteCsv,
} from "../../src/server/data-sources/tdx/five-minute-csv";

const csv = `Date,Open,Low,High,Close,Volume,Amount
2026-09-01 09:35:00,11.680,11.650,11.780,11.780,85125,99820580.00
2026-09-01 09:40:00,11.780,11.780,11.850,11.850,120947,142908400.00`;

describe("通达信五分钟 CSV", () => {
  it("指数大成交量按微盛规则置零并只标记实际新增记录", () => {
    const input = csv.replace("85125", "60990100");
    const bars = parseFiveMinuteCsv(input, "lots", "zero-signed");
    expect(bars[0]).toMatchObject({ volume: 0, volumeOverflow: true });
    expect(bars[1]?.volume).toBe(12094700);
    const result = mergeFiveMinuteBars(Buffer.alloc(0), bars, 2026);
    expect(result.data.readUInt32LE(24)).toBe(0);
    expect(result.insertedOverflowTimes).toEqual(["2026-09-01 09:35:00"]);
    expect(
      mergeFiveMinuteBars(result.data, bars, 2026).insertedOverflowTimes,
    ).toEqual([]);
    expect(() => parseFiveMinuteCsv(input, "lots")).toThrow();
  });
  it("按列名读取并以手转换为股，编码后可保持原记录", () => {
    const bars = parseFiveMinuteCsv(csv, "lots");
    expect(bars[0]).toEqual({
      time: "2026-09-01 09:35:00",
      open: 11.68,
      low: 11.65,
      high: 11.78,
      close: 11.78,
      volume: 8512500,
      amount: 99820580,
    });
    const existing = encodeFiveMinuteBar(bars[0]!);
    existing.writeUInt32LE(123, 28);
    const merged = mergeFiveMinuteBars(existing, bars, 2026);
    expect([merged.added, merged.identical, merged.conflicts]).toEqual([
      1, 1, 0,
    ]);
    expect(merged.data.subarray(0, 32)).toEqual(existing);
    expect(mergeFiveMinuteBars(merged.data, bars, 2026).added).toBe(0);
  });
  it("保留已存在时间的冲突数据", () => {
    const bars = parseFiveMinuteCsv(csv, "shares");
    const original = encodeFiveMinuteBar({ ...bars[0]!, close: 11.7 });
    const result = mergeFiveMinuteBars(original, bars, 2026);
    expect(result.conflicts).toBe(1);
    expect(result.data.subarray(0, 32)).toEqual(original);
  });
  it.each([
    ["非法日期", csv.replace("2026-09-01", "2026-02-30")],
    ["重复时间", csv.replace("09:40:00", "09:35:00")],
    ["价格范围错误", csv.replace("11.650", "12.000")],
    ["成交量溢出", csv.replace("85125", "4294967295")],
    ["错误列", csv.replace("Amount", "Money")],
  ])("拒绝%s", (_label, input) => {
    expect(() => parseFiveMinuteCsv(input, "lots")).toThrow();
  });
  it("拒绝损坏及乱序的目标文件", () => {
    const bars = parseFiveMinuteCsv(csv, "shares");
    expect(() => mergeFiveMinuteBars(Buffer.alloc(31), bars, 2026)).toThrow();
    expect(() =>
      mergeFiveMinuteBars(
        Buffer.concat([
          encodeFiveMinuteBar(bars[1]!),
          encodeFiveMinuteBar(bars[0]!),
        ]),
        bars,
        2026,
      ),
    ).toThrow();
  });
  it("支持可辨识的 2004 年前年份并拒绝含糊的跨度", () => {
    const older = parseFiveMinuteCsv(
      csv.replaceAll("2026-09-01", "2001-09-01"),
      "shares",
    );
    const result = mergeFiveMinuteBars(Buffer.alloc(0), older, 2026);
    expect(result.added).toBe(2);
    const ancient = parseFiveMinuteCsv(
      csv.replaceAll("2026-09-01", "1990-09-01"),
      "shares",
    );
    expect(() => mergeFiveMinuteBars(Buffer.alloc(0), ancient, 2026)).toThrow(
      "无法无歧义",
    );
  });
  it("预检隔离目录时记录冲突及缺失目标，不修改任何文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "quant-lc5-preview-"));
    try {
      const source = join(root, "source"),
        target = join(root, "tdx", "vipdoc", "sz", "fzline");
      await mkdir(source, { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(source, "SZ000001.csv"), csv);
      await writeFile(join(source, "SZ000002.csv"), csv);
      const original = encodeFiveMinuteBar(parseFiveMinuteCsv(csv, "lots")[0]!);
      await writeFile(join(target, "sz000001.lc5"), original);
      const result = await previewFiveMinuteDirectory(
        source,
        join(root, "tdx"),
        "lots",
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ added: 1, identical: 1, conflicts: 0 });
      expect(result[1]?.error).toBeTruthy();
      expect(await readFile(join(target, "sz000001.lc5"))).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("在隔离目录备份、导入并恢复，拒绝覆盖导入后的修改", async () => {
    const root = await mkdtemp(join(tmpdir(), "quant-lc5-write-"));
    try {
      const source = join(root, "source"),
        targetDir = join(root, "tdx", "vipdoc", "sz", "fzline");
      await mkdir(source, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(source, "SZ000001.csv"), csv);
      const target = join(targetDir, "sz000001.lc5"),
        backup = join(root, "backup.lc5");
      const original = encodeFiveMinuteBar(parseFiveMinuteCsv(csv, "lots")[0]!);
      await writeFile(target, original);
      const [preview] = await previewFiveMinuteDirectory(
        source,
        join(root, "tdx"),
        "lots",
      );
      const receipt = await importPreviewItem(preview!, "lots", backup);
      expect(await readFile(backup)).toEqual(original);
      const imported = await readFile(target);
      await writeFile(target, Buffer.concat([imported, Buffer.alloc(32)]));
      await expect(
        restoreImportedFile(
          target,
          backup,
          receipt.beforeHash!,
          receipt.afterHash,
        ),
      ).rejects.toThrow("发生变化");
      await writeFile(target, imported);
      await restoreImportedFile(
        target,
        backup,
        receipt.beforeHash!,
        receipt.afterHash,
      );
      expect(await readFile(target)).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
