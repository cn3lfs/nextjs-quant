import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "../../src/server/api/root";
import { saveSettings } from "../../src/server/infra/settings";
import { settingsSchema } from "../../src/lib/domain";
import { get, put, sqlite } from "../../src/server/db";
import * as jobs from "../../src/server/jobs/jobs";
import {
  buildLocalFinancialArchive,
  type LocalFinancialArchive,
} from "../../src/server/financial/local-financial-archive";
import { runLocalFinancialScreen } from "../../src/server/financial/local-financial-work";
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "quant-financial-api-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  const calendar = Buffer.alloc(3 * 32);
  [20261030, 20261102, 20261103].forEach((day, i) =>
    calendar.writeUInt32LE(day, i * 32),
  );
  await writeFile(join(root, "vipdoc/sh/lday/sh000001.day"), calendar);
  await writeFile(
    join(root, "vipdoc/cw/gpcw20260930.dat"),
    await readFile(
      new URL(
        "../../packages/tstdx/tests/fixtures/local/gpcw20260930.dat",
        import.meta.url,
      ),
    ),
  );
  saveSettings(settingsSchema.parse({ tdxRoot: root }));
  return { root, api: createCaller({ headers: new Headers() }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("本地财务RPC与任务持久化", () => {
  it("查询校验、历史版本、分页与完整导出使用同一份证据", async () => {
    const { root, api } = await setup();
    await expect(
      api.localFinancialView({ symbol: "sh600519", asOf: "2026-02-30" }),
    ).rejects.toThrow();
    const query = await api.localFinancialView({
      symbol: "sh600519",
      search: "FN63",
      pageSize: 1,
    });
    expect(query.rows[0]?.value).toBe(37883273216);
    const exported = await api.localFinancialExport({
      query: query.query,
      expectedSha256: query.selected!.sourceSha256,
      expectedManifestHash: query.sourceManifestHash,
    });
    expect(exported.report.fields).toHaveLength(658);
    expect(exported.query.search).toBe("FN63");
    expect(exported.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      api.localFinancialExport({
        query: query.query,
        expectedSha256: "0".repeat(64),
        expectedManifestHash: query.sourceManifestHash,
      }),
    ).rejects.toThrow("源文件已更新");
    await expect(
      api.localFinancialExport({
        query: query.query,
        expectedSha256: query.selected!.sourceSha256,
        expectedManifestHash: "0".repeat(64),
      }),
    ).rejects.toThrow("计算组成期");
    const archive = await buildLocalFinancialArchive(root, "sh600519");
    put("local-financial-archive", archive.id, archive);
    expect(
      (await api.localFinancialArchiveHistory()).some(
        (item) => item.id === archive.id,
      ),
    ).toBe(true);
    expect((await api.localFinancialArchive(archive.id))?.hash).toBe(
      archive.hash,
    );
    const work = {
      type: "local-financial" as const,
      operation: "screen" as const,
      root,
      input: {
        asOf: "2026-11-02",
        strict: true,
        mode: "all" as const,
        conditions: [{ field: "FN96", operator: "gt" as const, threshold: 0 }],
        technical: [],
      },
      symbols: ["sh600519", "sz300999"],
      names: {},
      rps: null,
      poolSource: { hash: "test", description: "固定测试池" },
    };
    const screen = await runLocalFinancialScreen(work);
    put("local-financial-screen", screen.id, screen);
    const page = await api.localFinancialScreenPage({
      id: screen.id,
      status: "unknown",
      pageSize: 1,
    });
    expect(page?.rowCount).toBe(1);
    expect(page?.rows[0]?.symbol).toBe("sz300999");
    expect(
      (await api.localFinancialScreenExport(screen.id))?.counts.unknown,
    ).toBe(1);
    const changed = { ...archive, hash: "0".repeat(64) };
    put("local-financial-archive", archive.id, changed);
    await expect(api.localFinancialArchive(archive.id)).rejects.toThrow(
      "校验失败",
    );
    await api.localFinancialArchiveDelete(archive.id);
    expect(await api.localFinancialArchive(archive.id)).toBeNull();
  });
  it("取消后的任务不得留下成功档案，已完成任务正常写入独立版本", async () => {
    const { root, api } = await setup();
    const archive = await buildLocalFinancialArchive(root, "sh600519");
    let release: ((value: LocalFinancialArchive) => void) | undefined;
    const spy = vi.spyOn(jobs, "runWorker").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = (value) => resolve(value as never);
        }),
    );
    const job = await api.localFinancialArchiveCreate({ symbol: "sh600519" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await api.cancel(job.id);
    release!(archive);
    await vi.waitFor(() =>
      expect(jobs.readJob(job.id)?.status).toBe("cancelled"),
    );
    expect(get(archive.id)).toBeUndefined();
    spy.mockResolvedValue(archive as never);
    const completed = await api.localFinancialArchiveCreate({
      symbol: "sh600519",
    });
    await vi.waitFor(() =>
      expect(jobs.readJob(completed.id)?.status).toBe("completed"),
    );
    expect(get<LocalFinancialArchive>(archive.id)?.hash).toBe(archive.hash);
    // No hidden online provider request or fallback is involved in the local job.
    expect(
      sqlite()
        .prepare(
          "SELECT count(*) AS n FROM records WHERE kind='financial-quality'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});
