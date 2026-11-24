import type { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import type { LabDiagnoseRunInput } from "~/lib/research/diagnose-contract";
import { strategyLabRouter } from "~/server/api/routers/strategy-lab";
import { sqlite } from "~/server/db";
import { readJob } from "~/server/db/jobs";
import * as jobStore from "~/server/db/jobs";
import { saveSettings } from "~/server/infra/settings";
import * as jobs from "~/server/jobs/jobs";
import * as archives from "~/server/research/diagnose/archive";
import { recoverRuntimeJobs } from "~/server/runtime";
import * as czsc from "~/server/strategies/chan/czsc";
import * as strategyNative from "~/server/strategies/strategy-center-native";
import { strategyCenterJob } from "~/server/strategies/strategy-center-service";
import * as runtimeErrors from "~/server/infra/runtime-errors";
import gbbq from "../../fixtures/tdx-gbbq.json";

const data = process.env.QUANT_DATA_DIR!;
const archiveRoot = join(data, "diagnose-archives");
const api = strategyLabRouter.createCaller({ headers: new Headers() });
const input: LabDiagnoseRunInput = {
  strategyKey: "research-chan",
  symbols: ["sh600000"],
  start: "auto",
  end: "2021-07-30",
  initial: 200_000,
  costScenario: "fixed",
  scenarios: ["strict"],
  confirmed: true,
};

beforeAll(async () => {
  const tdxRoot = join(data, "tdx");
  const lday = join(tdxRoot, "vipdoc/sh/lday");
  const cache = join(tdxRoot, "T0002/hq_cache");
  await mkdir(lday, { recursive: true });
  await mkdir(cache, { recursive: true });
  const rows: Buffer[] = [];
  for (
    let time = Date.UTC(2021, 0, 1);
    time <= Date.parse(input.end);
    time += 86_400_000
  ) {
    const day = new Date(time);
    if ([0, 6].includes(day.getUTCDay())) continue;
    const row = Buffer.alloc(32);
    row.writeUInt32LE(
      Number(day.toISOString().slice(0, 10).replaceAll("-", "")),
    );
    for (const offset of [4, 8, 12, 16]) row.writeUInt32LE(1000, offset);
    row.writeUInt32LE(1010, 8);
    row.writeUInt32LE(990, 12);
    row.writeFloatLE(1_000_000, 20);
    row.writeUInt32LE(100_000, 24);
    rows.push(row);
  }
  for (const symbol of ["sh000001", "sh600000", "sh600519"])
    await writeFile(join(lday, symbol + ".day"), Buffer.concat(rows));
  await writeFile(join(cache, "gbbq"), Buffer.from(gbbq.gbbqBase64, "base64"));
  saveSettings(settingsSchema.parse({ tdxRoot }));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => czsc.closeCzsc());

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
const pendingDirs = async () =>
  (await readdir(archiveRoot)).filter((name) => name.startsWith(".pending-"));
async function expectCancelled(id: string) {
  expect(readJob(id)?.status).toBe("cancelled");
  expect(existsSync(join(archiveRoot, "lab-" + id))).toBe(false);
  expect(await archives.readDiagnoseArchive("lab-" + id)).toBeNull();
}
async function completed(id: string) {
  await vi.waitFor(() => expect(readJob(id)?.status).toBe("completed"), {
    timeout: 15_000,
  });
  const { detail } = await api.strategyLabDiagnoseResult({ jobId: id });
  expect(detail?.cells[0]?.scenarios[0]?.error).toBeUndefined();
  expect(detail?.summary.statusCounts.ok).toBe(1);
  return detail!;
}

it("独立归档的列表和详情读取不会创建 quant.sqlite", async () => {
  const root = await mkdtemp(join(data, "standalone-"));
  vi.stubEnv("QUANT_DATA_DIR", root);
  const lookup = vi.spyOn(jobStore, "readJob");
  try {
    const id = "lab-standalone";
    await mkdir(join(root, "diagnose-archives", id), { recursive: true });
    expect(
      await archives.listDiagnoseArchives({ source: "lab-archive" }),
    ).toMatchObject([{ id }]);
    expect((await archives.readDiagnoseArchive(id))?.boundaryState).toBe(
      "missing-files",
    );
    expect(existsSync(join(root, "quant.sqlite"))).toBe(false);
    const missingDir = join(root, "no-data-directory");
    vi.stubEnv("QUANT_DATA_DIR", missingDir);
    expect(
      (
        await archives.readDiagnoseArchive(id, {
          archiveDir: join(root, "diagnose-archives"),
        })
      )?.summary.id,
    ).toBe(id);
    expect(existsSync(missingDir)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("工作线程直接调用 projectCzsc 在 fork 前拒绝", async () => {
  const bundle = await build({
    platform: "node",
    format: "cjs",
    bundle: true,
    write: false,
    external: ["better-sqlite3"],
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    const child = require("node:child_process");
    let forks = 0;
    child.fork = () => { forks++; throw Error("unexpected fork"); };
    const { projectCzsc } = require("./src/server/strategies/chan/czsc.ts");
    projectCzsc({ high:[1], low:[1], close:[1], volume:[1] })
      .then(() => ({ ok: true }), error => ({ error: error.message, forks }))
      .then(reply => require("node:worker_threads").parentPort.postMessage(reply));
    `,
    },
  });
  const worker = new Worker(bundle.outputFiles[0]!.text, {
    eval: true,
    execArgv: [],
  });
  try {
    expect((await once(worker, "message"))[0]).toEqual({
      error: "原生缠论工作进程只能由主线程创建，请通过主线程代理调用",
      forks: 0,
    });
  } finally {
    await worker.terminate();
  }
});

it("清理仅接受指定归档根下的暂存目录，半写入文件可重复清理", async () => {
  const archiveDir = await mkdtemp(join(data, "other-archives-"));
  const stage = await archives.createDiagnoseStagingDir(archiveDir);
  const tmp = join(stage, "diagnose-group.tmp");
  await writeFile(tmp, "partial");
  await expect(archives.cleanupDiagnoseStagingDir(stage)).rejects.toThrow(
    "路径不安全",
  );
  expect(existsSync(tmp)).toBe(true);
  await archives.cleanupDiagnoseStagingDir(stage, { archiveDir });
  await archives.cleanupDiagnoseStagingDir(stage, { archiveDir });
  expect(await readdir(archiveDir)).toEqual([]);
});

it("两个真实诊断 Worker 共用一个原生进程，第三个任务排队取消仅清理自己的暂存", async () => {
  const hold = gate();
  const realIdentity = czsc.getCurrentCzscIdentity;
  const identity = vi
    .spyOn(czsc, "getCurrentCzscIdentity")
    .mockImplementation(async (...args) => {
      await hold.pending;
      return realIdentity(...args);
    });
  const project = vi.spyOn(czsc, "projectCzsc");
  const writes = vi.spyOn(jobStore, "saveJob");
  const children: ChildProcess[] = [];
  const observe = (message: unknown) => {
    children.push((message as { process: ChildProcess }).process);
  };
  const launches = channel("child_process");
  launches.subscribe(observe);
  try {
    const first = await api.strategyLabDiagnoseRun(input);
    const second = await api.strategyLabDiagnoseRun({
      ...input,
      symbols: ["sh600519"],
    });
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    });
    const activeStages = (await pendingDirs()).sort();
    expect(activeStages).toHaveLength(2);
    const queued = await api.strategyLabDiagnoseRun(input);
    await vi.waitFor(() =>
      expect(readJob(queued.id)?.phase).toBe("等待计算资源"),
    );
    jobs.cancelJob(queued.id);
    await vi.waitFor(async () =>
      expect((await pendingDirs()).sort()).toEqual(activeStages),
    );
    await expectCancelled(queued.id);
    hold.release();
    const results = await Promise.all([
      completed(first.id),
      completed(second.id),
    ]);
    expect(results.map((r) => r.summary.symbols)).toEqual([
      ["sh600000"],
      ["sh600519"],
    ]);
    expect(project.mock.calls.length).toBeGreaterThan(2);
    for (const job of [first, second]) {
      expect(project.mock.calls.some((call) => call[3] === job.id)).toBe(true);
      expect(identity.mock.calls.some((call) => call[4] === job.id)).toBe(true);
      const phases = writes.mock.calls
        .map(([entry]) => entry)
        .filter(
          (entry) =>
            entry.id === job.id && entry.phase?.startsWith("原生缠论前缀"),
        );
      expect(phases[0]?.phase).toMatch(/ 1\/\d+$/);
      expect(phases.at(-1)?.progress).toBeGreaterThan(phases[0]!.progress);
    }
    expect(
      children.filter((child) =>
        child.spawnargs.some((arg) => arg.endsWith("czsc-worker.cjs")),
      ),
    ).toHaveLength(1);
    for (const { summary, boundaryState } of results) {
      expect(readJob(summary.id.slice(4))?.result).toEqual({
        archiveId: summary.id,
        title: summary.title,
        strategyKeys: summary.strategyKeys,
        symbols: summary.symbols,
        scenarios: summary.scenarios,
        statusCounts: summary.statusCounts,
        boundaryState,
        driftWarningsCount: 0,
        missingFilesCount: 0,
      });
    }
    expect(await pendingDirs()).toEqual([]);
  } finally {
    hold.release();
    launches.unsubscribe(observe);
  }
});

it("在途原生投影取消后丢弃迟到的回复，后续任务仍可执行", async () => {
  const hold = gate();
  const realProject = czsc.projectCzsc;
  const project = vi
    .spyOn(czsc, "projectCzsc")
    .mockImplementationOnce(async (...args) => {
      const snapshot = await realProject(...args);
      await hold.pending;
      return snapshot;
    });
  try {
    const job = await api.strategyLabDiagnoseRun(input);
    await vi.waitFor(() => expect(project).toHaveBeenCalled(), {
      timeout: 15_000,
    });
    jobs.cancelJob(job.id);
    await vi.waitFor(async () => expect(await pendingDirs()).toEqual([]));
    await expectCancelled(job.id);
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    hold.release();
    await project.mock.results[0]!.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(posts.mock.calls.filter(([msg]) => msg?.czscReply)).toHaveLength(0);
    await completed((await api.strategyLabDiagnoseRun(input)).id);
  } finally {
    hold.release();
  }
});

it("投影与冷启动身份请求排队期间取消后不发送原生 IPC", async () => {
  const queue = globalThis as typeof globalThis & {
    czscQueue?: Promise<unknown>;
    czscWorker: ChildProcess;
  };
  const bars = { high: [1], low: [1], close: [1], volume: [1] };
  await czsc.projectCzsc(bars);
  const send = vi.spyOn(queue.czscWorker, "send");
  const hold = gate();
  const controller = new AbortController();
  const shouldSkip = () => controller.signal.aborted;
  queue.czscQueue = hold.pending;
  try {
    const project = czsc.projectCzsc(bars, {}, shouldSkip);
    const identity = czsc.getCurrentCzscIdentity(
      undefined,
      { dllHash: "unused", workerHash: "cold" },
      undefined,
      shouldSkip,
    );
    const settled = Promise.allSettled([project, identity]);
    controller.abort();
    hold.release();
    for (const result of await settled)
      expect(result).toMatchObject({
        status: "rejected",
        reason: { name: "AbortError" },
      });
    expect(send).not.toHaveBeenCalled();
  } finally {
    hold.release();
  }
});

const nativeBars = { high: [1], low: [1], close: [1], volume: [1] };
function nativeChild() {
  return (globalThis as typeof globalThis & { czscWorker: ChildProcess })
    .czscWorker;
}

it("另一个 SQLite 连接取消排队请求后，只有第一项调用 DLL", async () => {
  const job = jobs.newJob("research", {});
  jobs.updateJob(job.id, { status: "running" });
  const other = new Database(sqlite().name, { fileMustExist: true });
  await czsc.projectCzsc(nativeBars);
  const child = nativeChild();
  const send = child.send.bind(child);
  const sent = gate();
  const ipc = vi
    .spyOn(child, "send")
    .mockImplementationOnce((...args: Parameters<typeof send>) => {
      const ok = send(...args);
      sent.release();
      return ok;
    });
  try {
    const first = czsc.projectCzsc(nativeBars);
    const second = czsc.projectCzsc(nativeBars, {}, () => false, job.id);
    const cancelled = expect(second).rejects.toMatchObject({
      name: "AbortError",
    });
    await sent.pending;
    expect(
      other
        .prepare(
          "UPDATE records SET payload=json_set(payload,'$.status','cancelled') WHERE kind='job' AND id=?",
        )
        .run(job.id).changes,
    ).toBe(1);
    await first;
    await cancelled;
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(jobStore.getJobStatus(job.id)).toBe("cancelled");
  } finally {
    other.close();
  }
});

it("策略中心排队的首个原生前缀在轮询前识别另一连接的取消，新增 DLL 调用为零", async () => {
  await czsc.projectCzsc(nativeBars);
  const send = vi.spyOn(nativeChild(), "send");
  const capture = vi.spyOn(strategyNative, "captureNativeChanObservations");
  const hold = gate();
  const queue = globalThis as typeof globalThis & {
    czscQueue: Promise<unknown>;
  };
  queue.czscQueue = hold.pending;
  const other = new Database(sqlite().name, { fileMustExist: true });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const job = strategyCenterJob({
      strategyId: "research-chan",
      symbol: "sh600000",
      start: "2021-07-28",
      end: input.end,
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(queue.czscQueue).not.toBe(hold.pending);
    const rejected = expect(
      capture.mock.results[0]!.value,
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      other
        .prepare(
          "UPDATE records SET payload=json_set(payload,'$.status','cancelled') WHERE kind='job' AND id=?",
        )
        .run(job.id).changes,
    ).toBe(1);
    expect(capture.mock.calls[0]![2]?.aborted).toBe(false);
    hold.release();
    await rejected;
    expect(send).not.toHaveBeenCalled();
  } finally {
    hold.release();
    other.close();
    vi.useRealTimers();
  }
});

it("超时终止无回复子进程后，下一项由新进程接手", async () => {
  await czsc.projectCzsc(nativeBars);
  const child = nativeChild();
  const before = await czsc.getCzscTelemetry();
  const sent = gate();
  vi.spyOn(child, "send").mockImplementationOnce(() => {
    sent.release();
    return true;
  });
  vi.stubEnv("QUANT_CZSC_TIMEOUT_MS", "5000");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const timeout = expect(czsc.projectCzsc(nativeBars)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    const next = czsc.projectCzsc(nativeBars);
    await sent.pending;
    vi.advanceTimersByTime(5000);
    await timeout;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(next).resolves.toHaveProperty("apiVersion", 22);
    const after = await czsc.getCzscTelemetry();
    expect(after).toMatchObject({
      requests: before.requests + 2,
      timeouts: before.timeouts + 1,
      pending: 0,
    });
    expect(after.workerPid).not.toBe(child.pid);
    expect(after.workerRssBytes).toBeGreaterThan(0);
    expect(after.lastDllCallMs).toBeGreaterThanOrEqual(0);
    expect(after.lastQueueWaitMs).toBeGreaterThanOrEqual(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await czsc.closeCzsc();
  }
});

it.each(["request timeout", "idle TTL"] as const)(
  "%s bounds SIGKILL failures and late child errors without blocking the next projection",
  async (mode) => {
    await czsc.closeCzsc();
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      ref: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      kill: vi.fn(() => {
        child.emit("error", new Error("kill error event"));
        throw new Error("kill threw");
      }),
    });
    const queue = globalThis as typeof globalThis & {
      czscWorker?: ChildProcess;
      czscQueue: Promise<unknown>;
    };
    queue.czscWorker = child as unknown as ChildProcess;
    const report = vi.spyOn(runtimeErrors, "recordRuntimeError");
    vi.stubEnv("QUANT_CZSC_KILL_GRACE_MS", "50");
    vi.stubEnv("QUANT_CZSC_TIMEOUT_MS", "1000");
    vi.stubEnv("QUANT_CZSC_IDLE_TTL_MS", "10");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const projection = czsc.projectCzsc(nativeBars);
      await Promise.resolve();
      expect(child.send).toHaveBeenCalledOnce();
      let retired: Promise<unknown>;
      if (mode === "idle TTL") {
        const { id } = child.send.mock.calls[0]![0];
        child.emit("message", { id, result: {} });
        await projection;
        await vi.advanceTimersByTimeAsync(10);
        retired = queue.czscQueue;
        expect(child.disconnect).toHaveBeenCalledOnce();
      } else {
        retired = expect(projection).rejects.toMatchObject({
          code: "ETIMEDOUT",
        });
      }
      const next = czsc.projectCzsc(nativeBars);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(queue.czscWorker).toBeUndefined();
      expect(report).toHaveBeenCalledWith(
        "czsc-worker",
        new Error("kill error event"),
      );
      expect(report).toHaveBeenCalledWith(
        "czsc-worker",
        new Error("kill threw"),
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(queue.czscWorker).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await retired;
      expect(report).toHaveBeenCalledWith(
        "czsc-worker",
        expect.objectContaining({
          message: "CZSC worker did not exit after SIGKILL",
        }),
      );
      expect(child.unref).toHaveBeenCalled();
      expect(child.disconnect).toHaveBeenCalled();
      child.emit("error", new Error("late kill error"));
      child.emit("exit", 1);
      await expect(next).resolves.toHaveProperty("apiVersion", 22);
      expect(nativeChild().pid).toBeDefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await czsc.closeCzsc();
    }
  },
);

it("空闲 TTL 到期才回收进程，稍后的请求可重新启动", async () => {
  vi.stubEnv("QUANT_CZSC_IDLE_TTL_MS", "50");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await czsc.projectCzsc(nativeBars);
    const child = nativeChild();
    vi.advanceTimersByTime(49);
    expect(child.connected).toBe(true);
    const closed = once(child, "exit");
    vi.advanceTimersByTime(1);
    await closed;
    expect(await czsc.getCzscTelemetry()).toMatchObject({
      workerPid: null,
      workerRssBytes: null,
    });
    await czsc.projectCzsc(nativeBars);
    expect(nativeChild().pid).not.toBe(child.pid);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await czsc.closeCzsc();
  }
});

it("启动恢复保留完成归档，仅隔离 rename 后未提交的目录，重复恢复无副作用", async () => {
  const interrupted = jobs.newJob("research", {});
  jobs.updateJob(interrupted.id, { status: "running", ownerPid: undefined });
  const orphan = `lab-${interrupted.id}`;
  const imported = "lab-job-a1a1a1a1-aaaa-4aaa-aaaa-a1a1a1a1a1a1";
  const partial = "lab-job-a1a1a1a1-aaaa-4aaa-aaaa-a1a1a1a1a1a2";
  const standalone = "lab-imported";
  const valid = await completed(
    (await api.strategyLabDiagnoseRun({ ...input, strategyKey: "hold" })).id,
  );
  const published = join(archiveRoot, valid.summary.id, "diagnose-group.json");
  const bytes = await readFile(published);
  for (const id of [orphan, imported])
    await archives.publishDiagnoseArchive({
      ...valid,
      summary: { ...valid.summary, id },
    });
  await mkdir(join(archiveRoot, partial));
  await mkdir(join(archiveRoot, standalone));
  const original = await readFile(
    join(archiveRoot, orphan, "diagnose-group.json"),
    "utf8",
  );
  const copied = await readFile(
    join(archiveRoot, imported, "diagnose-group.json"),
  );
  expect(jobStore.getJobStatus(imported.slice(4))).toBeUndefined();
  expect(recoverRuntimeJobs()).toEqual([orphan, partial].sort());
  expect(existsSync(join(archiveRoot, `.orphan-${partial}`))).toBe(true);
  expect(
    await readFile(join(archiveRoot, imported, "diagnose-group.json")),
  ).toEqual(copied);
  expect((await archives.readDiagnoseArchive(imported))?.cells).toEqual(
    valid.cells,
  );
  expect(existsSync(join(archiveRoot, standalone))).toBe(true);
  expect(readJob(interrupted.id)?.status).toBe("failed");
  expect(existsSync(join(archiveRoot, orphan))).toBe(false);
  expect(
    await readFile(
      join(archiveRoot, `.orphan-${orphan}`, "diagnose-group.json"),
      "utf8",
    ),
  ).toBe(original);
  expect(await readFile(published)).toEqual(bytes);
  expect(recoverRuntimeJobs()).toEqual([]);
});

it("真实 Worker 的 hold 成交可从列表和详情读取", async () => {
  const job = await api.strategyLabDiagnoseRun({
    ...input,
    strategyKey: "hold",
    start: "2021-07-21",
  });
  const { summary, cells } = await completed(job.id);
  expect(cells[0]!.scenarios[0]!.counts.fills).toBeGreaterThan(0);
  expect(
    await api.strategyLabDiagnoseArchives({
      source: "lab-archive",
      strategyKey: "hold",
    }),
  ).toContainEqual(summary);
  expect(
    (await api.strategyLabDiagnoseArchiveDetail({ id: summary.id }))?.summary
      .id,
  ).toBe(summary.id);
});

it.each(["missing", "completed", "cancelled"] as const)(
  "任务在获取发布锁前变为 %s 时不重命名暂存目录",
  async (status) => {
    const run = jobs.runWorker;
    const publish = vi.spyOn(archives, "publishStagedDiagnoseArchive");
    const cleanup = vi.spyOn(archives, "cleanupDiagnoseStagingDir");
    vi.spyOn(jobs, "runWorker").mockImplementationOnce(
      async <T>(...args: Parameters<typeof run>) => {
        const result = await run<T>(...args);
        // A second host changed the row without touching the local AbortSignal.
        if (status === "missing")
          sqlite()
            .prepare("DELETE FROM records WHERE kind='job' AND id=?")
            .run(args[1]!);
        else jobs.updateJob(args[1]!, { status, result: { prior: true } });
        return result;
      },
    );
    const job = await api.strategyLabDiagnoseRun({
      ...input,
      strategyKey: "hold",
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), {
      timeout: 15_000,
    });
    await cleanup.mock.results[0]!.value;
    const current = readJob(job.id);
    if (status === "missing") expect(current).toBeUndefined();
    else expect(current).toMatchObject({ status, result: { prior: true } });
    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(join(archiveRoot, "lab-" + job.id))).toBe(false);
    expect(await pendingDirs()).toEqual([]);
  },
);

it("SQLite 拒绝完成态写入时不发布归档", async () => {
  const publish = vi.spyOn(archives, "publishStagedDiagnoseArchive");
  sqlite().exec(`CREATE TRIGGER reject_completed BEFORE UPDATE ON records
    WHEN NEW.kind='job' AND json_extract(NEW.payload,'$.status')='completed'
    BEGIN SELECT RAISE(ABORT, 'reject completed'); END`);
  try {
    const job = await api.strategyLabDiagnoseRun(input);
    await vi.waitFor(() => expect(readJob(job.id)?.status).toBe("failed"), {
      timeout: 15_000,
    });
    expect(readJob(job.id)?.error).toContain("reject completed");
    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(join(archiveRoot, "lab-" + job.id))).toBe(false);
    expect(await pendingDirs()).toEqual([]);
  } finally {
    sqlite().exec("DROP TRIGGER reject_completed");
  }
});

it("发布时已有同名归档会回滚新回执并保留原目录", async () => {
  const run = jobs.runWorker;
  vi.spyOn(jobs, "runWorker").mockImplementationOnce(
    async <T>(...args: Parameters<typeof run>) => {
      const result = await run<T>(...args);
      const target = join(archiveRoot, `lab-${args[1]}`);
      await mkdir(target);
      await writeFile(join(target, "existing"), "earlier archive");
      return result;
    },
  );
  const publish = archives.publishStagedDiagnoseArchive;
  const publishState = vi
    .spyOn(archives, "publishStagedDiagnoseArchive")
    .mockImplementationOnce((stage, archiveId) => {
      expect(sqlite().inTransaction).toBe(true);
      expect(readJob(archiveId.slice(4))).toMatchObject({
        status: "completed",
        result: { archiveId },
      });
      publish(stage, archiveId);
    });
  const job = await api.strategyLabDiagnoseRun({
    ...input,
    strategyKey: "hold",
  });
  await vi.waitFor(() => expect(readJob(job.id)?.status).toBe("failed"), {
    timeout: 15_000,
  });
  expect(publishState).toHaveBeenCalledOnce();
  expect(readJob(job.id)?.error).toContain("诊断归档已存在");
  expect(readJob(job.id)?.result).toBeUndefined();
  expect(await readdir(join(archiveRoot, `lab-${job.id}`))).toEqual([
    "existing",
  ]);
  expect(await pendingDirs()).toEqual([]);
});

it("SQLite 在 rename 后提交失败会回滚完成回执并清除本次归档", async () => {
  const db = sqlite();
  db.exec(`CREATE TEMP TABLE commit_parent(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER fail_commit AFTER UPDATE ON main.records
    WHEN NEW.kind='job' AND json_extract(NEW.payload,'$.status')='completed'
    BEGIN INSERT INTO commit_child VALUES (1); END`);
  const publish = vi.spyOn(archives, "publishStagedDiagnoseArchive");
  const remove = vi.spyOn(archives, "removeUnpublishedDiagnoseArchive");
  try {
    const job = await api.strategyLabDiagnoseRun({
      ...input,
      strategyKey: "hold",
    });
    await vi.waitFor(() => expect(readJob(job.id)?.status).toBe("failed"), {
      timeout: 15_000,
    });
    expect(readJob(job.id)?.error).toContain("FOREIGN KEY");
    expect(readJob(job.id)?.result).toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(`lab-${job.id}`);
    expect(existsSync(join(archiveRoot, `lab-${job.id}`))).toBe(false);
    expect(await pendingDirs()).toEqual([]);
  } finally {
    db.exec(
      "DROP TRIGGER fail_commit; DROP TABLE commit_child; DROP TABLE commit_parent",
    );
  }
});

it.each(["等待计算资源", "计算中"])(
  "%s 状态写入失败后释放任务的 Worker 和控制器",
  async (phase) => {
    const job = jobs.newJob("scan", {});
    const save = jobStore.saveJob;
    vi.spyOn(jobStore, "saveJob").mockImplementation((next) => {
      if (next.phase === phase) throw new Error("state write failed");
      return save(next);
    });
    await expect(
      jobs.runWorker({ type: "scan", root: join(data, "tdx") }, job.id),
    ).rejects.toThrow("state write failed");
    const { quantJobs } = globalThis as typeof globalThis & {
      quantJobs: {
        workers: Map<string, Worker>;
        computeControllers: Map<string, AbortController>;
        cancellationTimer?: NodeJS.Timeout;
      };
    };
    expect(quantJobs.workers.has(job.id)).toBe(false);
    expect(quantJobs.computeControllers.has(job.id)).toBe(false);
    expect(quantJobs.cancellationTimer).toBeUndefined();
  },
);
