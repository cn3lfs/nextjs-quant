import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const csv =
  "Date,Open,Low,High,Close,Volume,Amount\n2026-09-01 09:35:00,11.68,11.65,11.78,11.78,85125,99820580\n";
let root: string, dataRoot: string, source: string;
let module: typeof import("../../src/server/jobs/five-minute-batch");
let jobs: typeof import("../../src/server/jobs/jobs");
let db: typeof import("../../src/server/db");
const previous = process.env.QUANT_DATA_DIR;
async function completed(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = jobs.readJob(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("任务超时");
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quant-batch-"));
  dataRoot = join(root, "data");
  source = join(root, "csv");
  process.env.QUANT_DATA_DIR = dataRoot;
  for (const market of ["sh", "sz"])
    await mkdir(join(root, "tdx", "vipdoc", market, "fzline"), {
      recursive: true,
    });
  await mkdir(join(root, "tdx", "T0002", "hq_cache"), { recursive: true });
  await mkdir(source, { recursive: true });
  const record = Buffer.alloc(410);
  record.write("000001", 50, "ascii");
  record.write("sample", 81, "ascii");
  await writeFile(join(root, "tdx", "T0002", "hq_cache", "szs.tnf"), record);
  const shRecords = Buffer.alloc(50 + 3 * 360);
  ["600000", "510300", "000001"].forEach((code, i) => {
    shRecords.write(code, 50 + i * 360, "ascii");
    shRecords.write("sample", 81 + i * 360, "ascii");
  });
  await writeFile(join(root, "tdx", "T0002", "hq_cache", "shs.tnf"), shRecords);
  await writeFile(join(source, "SZ000001.csv"), csv);
  module = await import("../../src/server/jobs/five-minute-batch");
  jobs = await import("../../src/server/jobs/jobs");
  db = await import("../../src/server/db");
});
afterAll(async () => {
  db?.sqlite().close();
  if (previous === undefined) delete process.env.QUANT_DATA_DIR;
  else process.env.QUANT_DATA_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
describe("五分钟批次", () => {
  it("使用微盛预设扫描 SH/SZ，指数超限置零并展示准确时间", async () => {
    const parent = join(root, "multi"),
      sh = join(parent, "SH"),
      sz = join(parent, "SZ");
    await mkdir(sh, { recursive: true });
    await mkdir(sz, { recursive: true });
    for (const name of ["SH600000.csv", "SH510300.csv"])
      await writeFile(join(sh, name), csv);
    await writeFile(join(sh, "SH000001.csv"), csv.replace("85125", "60990100"));
    await writeFile(join(sz, "SZ000001.csv"), csv);
    const started = await module.startFiveMinutePreview(
      { directories: [parent], source: "wswdz" },
      join(root, "tdx"),
    );
    expect((await completed(started.jobId)).status).toBe("completed");
    const result = await module.fiveMinuteBatch(started.id, 0, "");
    expect(result.total).toBe(4);
    expect(result.items.find((x) => x.symbol === "sh000001")).toMatchObject({
      state: "preview",
      category: "index",
      added: 1,
      overflowTimes: ["2026-09-01 09:35:00"],
    });
    expect(result.summary.overflow).toBe(1);
    expect(await module.exportFiveMinuteBatch(started.id)).toContain(
      "2026-09-01 09:35:00",
    );
    for (const symbol of ["sh600000", "sh510300", "sz000001"])
      expect(result.items.find((x) => x.symbol === symbol)).toMatchObject({
        unit: "lots",
        added: 1,
      });
    const target = join(root, "tdx", "vipdoc", "sh", "fzline", "sh000001.lc5");
    const imported = await module.runFiveMinuteBatch(
      started.id,
      join(root, "tdx"),
      false,
      async () => {},
    );
    expect((await completed(imported.jobId)).status).toBe("completed");
    expect((await readFile(target)).readUInt32LE(24)).toBe(0);
    const restored = await module.runFiveMinuteBatch(
      started.id,
      join(root, "tdx"),
      true,
      async () => {},
    );
    expect((await completed(restored.jobId)).status).toBe("completed");
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("预检、新建、恢复并保留批次记录", async () => {
    const tdx = join(root, "tdx"),
      target = join(tdx, "vipdoc", "sz", "fzline", "sz000001.lc5");
    const started = await module.startFiveMinutePreview(
      {
        directories: [source],
        source: "wswdz",
      },
      tdx,
    );
    expect((await completed(started.jobId)).status).toBe("completed");
    const preview = await module.fiveMinuteBatch(started.id, 0, "");
    expect(preview.batch.status).toBe("ready");
    expect(preview.items[0]).toMatchObject({ targetMissing: true, added: 1 });
    await expect(
      module.runFiveMinuteBatch(started.id, tdx, false, async () => {
        throw new Error("通达信正在运行");
      }),
    ).rejects.toThrow("通达信正在运行");
    const imported = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      false,
      async () => {},
    );
    expect((await completed(imported.jobId)).status).toBe("completed");
    expect((await readFile(target)).length).toBe(32);
    expect(
      (await module.fiveMinuteBatch(started.id, 0, "")).summary.written,
    ).toBe(1);
    const importedBytes = await readFile(target);
    await writeFile(target, Buffer.concat([importedBytes, Buffer.alloc(32)]));
    const blocked = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      true,
      async () => {},
    );
    expect((await completed(blocked.jobId)).status).toBe("completed");
    expect((await module.fiveMinuteBatch(started.id, 0, "")).batch.status).toBe(
      "restore-partial",
    );
    expect((await readFile(target)).length).toBe(64);
    await writeFile(target, importedBytes);
    const restored = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      true,
      async () => {},
    );
    expect((await completed(restored.jobId)).status).toBe("completed");
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await module.fiveMinuteBatch(started.id, 0, "")).items[0]?.state,
    ).toBe("restored");
  });
  it("预检后源文件变化时跳过写入，恢复不触碰原文件", async () => {
    const tdx = join(root, "tdx"),
      target = join(tdx, "vipdoc", "sz", "fzline", "sz000001.lc5");
    await writeFile(join(source, "SZ000001.csv"), csv);
    const started = await module.startFiveMinutePreview(
      {
        directories: [source],
        source: "wswdz",
      },
      tdx,
    );
    expect((await completed(started.jobId)).status).toBe("completed");
    await writeFile(join(source, "SZ000001.csv"), `${csv}\n`);
    const imported = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      false,
      async () => {},
    );
    expect((await completed(imported.jobId)).status).toBe("completed");
    const failed = await module.fiveMinuteBatch(started.id, 0, "");
    expect(failed.summary.errors).toBe(1);
    expect(failed.items[0]?.restoredError).toContain("已改变");
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      true,
      async () => {},
    );
    expect((await completed(restored.jobId)).status).toBe("completed");
    expect(
      (await module.fiveMinuteBatch(started.id, 0, "")).items[0]?.state,
    ).toBe("restored");
  });
  it("可根据预写入状态恢复写入后中断的已有文件", async () => {
    const tdx = join(root, "tdx"),
      target = join(tdx, "vipdoc", "sz", "fzline", "sz000001.lc5");
    const extended =
      csv + "2026-09-01 09:40:00,11.78,11.78,11.85,11.85,120947,142908400\n";
    const format =
      await import("../../src/server/data-sources/tdx/five-minute-csv");
    const original = format.encodeFiveMinuteBar(
      format.parseFiveMinuteCsv(csv, "lots")[0]!,
    );
    await writeFile(target, original);
    await writeFile(join(source, "SZ000001.csv"), extended);
    const started = await module.startFiveMinutePreview(
      {
        directories: [source],
        source: "wswdz",
      },
      tdx,
    );
    expect((await completed(started.jobId)).status).toBe("completed");
    const imported = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      false,
      async () => {},
    );
    expect((await completed(imported.jobId)).status).toBe("completed");
    expect((await readFile(target)).length).toBe(64);
    const key = `tdx-import-item-${started.id}-sz000001`,
      item = db.get<Record<string, unknown>>(key)!;
    db.put("tdx-import-item", key, { ...item, state: "prepared" });
    const batchKey = `tdx-import-${started.id}`,
      state = db.get<Record<string, unknown>>(batchKey)!;
    db.put("tdx-import", batchKey, { ...state, status: "interrupted" });
    const restored = await module.runFiveMinuteBatch(
      started.id,
      tdx,
      true,
      async () => {},
    );
    expect((await completed(restored.jobId)).status).toBe("completed");
    expect(await readFile(target)).toEqual(original);
  });
});
