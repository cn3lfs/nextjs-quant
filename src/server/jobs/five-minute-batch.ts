import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  lstat,
  statfs,
  stat,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { dataDirectory, get, put, sqlite } from "../db";
import { background, readJob, updateJob } from "./jobs";
import { processAlive } from "../infra/lease";
import { securityNames, isAStock } from "../data-sources/tdx/tdx";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isPriceScaleThreeFund } from "~/lib/market/security-classification";
import {
  fiveMinuteInput,
  type FiveMinuteInput,
} from "~/lib/settings/five-minute-import";
import {
  mergeFiveMinuteBars,
  parseFiveMinuteCsv,
  type ImportVolumeUnit,
} from "../data-sources/tdx/five-minute-csv";
import {
  importPreviewItem,
  removeImportedFile,
  restoreImportedFile,
} from "../data-sources/tdx/five-minute-write";
import type { FiveMinutePreviewItem } from "../data-sources/tdx/five-minute-preview";

type Category = "stock" | "fund" | "index";
type Item = FiveMinutePreviewItem & {
  category?: Category;
  unit?: ImportVolumeUnit;
  state: "preview" | "skipped" | "prepared" | "written" | "failed" | "restored";
  backup?: string;
  restoredError?: string;
  bytes?: number;
  outputBytes?: number;
  first?: string;
  last?: string;
};
type Batch = {
  id: string;
  root: string;
  input: FiveMinuteInput;
  createdAt: number;
  count: number;
  previewJob: string;
  operationJob?: string;
  status:
    | "previewing"
    | "ready"
    | "running"
    | "finished"
    | "partial"
    | "restoring"
    | "restored"
    | "restore-partial"
    | "interrupted";
};
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const batchDir = (id: string) =>
  join(dataDirectory(), "tdx-five-minute-import", id);
const batchKey = (id: string) => `tdx-import-${id}`;
function batch(id: string): Batch {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("批次编号无效");
  const value = get<Batch>(batchKey(id));
  if (!value) throw new Error("批次不存在");
  if (["previewing", "running", "restoring"].includes(value.status)) {
    const job = readJob(value.operationJob ?? value.previewJob);
    if (
      !job?.ownerPid ||
      !processAlive(job.ownerPid) ||
      job.status === "cancelled"
    ) {
      const recovered = { ...value, status: "interrupted" as const };
      put("tdx-import", batchKey(id), recovered);
      return recovered;
    }
  }
  return value;
}
const itemPrefix = (id: string) => `tdx-import-item-${id}-`;
async function saveItem(id: string, item: Item) {
  put("tdx-import-item", itemPrefix(id) + item.symbol, item);
}
async function loadItems(id: string): Promise<Item[]> {
  const prefix = itemPrefix(id);
  const rows = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='tdx-import-item' AND id >= ? AND id < ? ORDER BY id",
    )
    .all(prefix, prefix + "\uffff") as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as Item);
}
async function optionalFile(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("目标文件是符号链接");
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
async function targetDirs(root: string) {
  const base = await realpath(root),
    dirs: Record<string, string> = {};
  for (const m of ["sh", "sz"]) {
    const dir = await realpath(join(base, "vipdoc", m, "fzline"));
    if (!inside(base, dir)) throw new Error("五分钟目录位于通达信安装目录之外");
    dirs[m] = dir;
  }
  return { base, dirs };
}
function categoryOf(symbol: string): Category | undefined {
  if (isAStock(symbol)) return "stock";
  if (isPriceScaleThreeFund(symbol)) return "fund";
  if (isMarketIndex(symbol)) return "index";
}
async function checkClientClosed() {
  if (process.platform !== "win32")
    throw new Error("只支持在 Windows 上修改通达信行情");
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      "tasklist.exe",
      ["/FO", "CSV", "/NH"],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch {
    throw new Error("无法检查通达信进程，请关闭通达信后重试");
  }
  if (/^"(?:tdxw|tdxsp|tdxnonsp)\.exe"/im.test(stdout))
    throw new Error("通达信正在运行，请关闭后重试");
}
function claim(id: string) {
  sqlite()
    .transaction(() => {
      const old = get<{ pid: number; id: string }>("tdx-import-lease");
      if (old && old.pid > 0 && processAlive(old.pid))
        throw new Error("已有导入或恢复任务正在执行");
      put("tdx-import-lease", "tdx-import-lease", { pid: process.pid, id });
    })
    .immediate();
}
function release(id: string) {
  const current = get<{ id: string; pid: number }>("tdx-import-lease");
  if (current?.id === id && current.pid === process.pid)
    put("tdx-import-lease", "tdx-import-lease", { pid: 0, id: "" });
}
export async function startFiveMinutePreview(
  raw: FiveMinuteInput,
  root: string,
) {
  const input = fiveMinuteInput.parse(raw),
    { base, dirs } = await targetDirs(root);
  const names = {
    sh: await securityNames(base, "sh"),
    sz: await securityNames(base, "sz"),
  };
  const id = randomUUID();
  await mkdir(batchDir(id), { recursive: true });
  const files: { symbol: string; source: string }[] = [],
    seen = new Set<string>();
  for (const path of input.directories) {
    const dir = await realpath(resolve(path));
    const entries = await readdir(dir, { withFileTypes: true });
    const directories = [
      dir,
      ...entries
        .filter((entry) => entry.isDirectory() && /^(sh|sz)$/i.test(entry.name))
        .map((entry) => join(dir, entry.name)),
    ];
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^(sh|sz)\d{6}\.csv$/i.test(entry.name))
          continue;
        const symbol = entry.name.slice(0, 8).toLowerCase();
        if (seen.has(symbol))
          throw new Error(`多个目录包含 ${symbol}，请消除重复后重试`);
        seen.add(symbol);
        files.push({ symbol, source: join(directory, entry.name) });
      }
    }
  }
  if (!files.length) throw new Error("所选目录没有符合命名规则的 CSV 文件");
  files.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const job = background(
    "tdx-import",
    { mode: "preview", batchId: id },
    async (job, signal) => {
      try {
        for (const [i, file] of files.entries()) {
          signal.throwIfAborted();
          const market = file.symbol.slice(0, 2) as "sh" | "sz",
            category = categoryOf(file.symbol);
          const item: Item = {
            ...file,
            target: join(dirs[market]!, `${file.symbol}.lc5`),
            category,
            state: "preview",
          };
          try {
            if (!names[market].has(file.symbol))
              throw new Error("通达信证券资料中未找到此代码");
            if (!category) throw new Error("证券类别无法确认");
            {
              const unit = "lots" as const;
              item.unit = unit;
              const source = await readFile(file.source),
                bars = parseFiveMinuteCsv(
                  source.toString("utf8"),
                  unit,
                  category === "index" ? "zero-signed" : "error",
                );
              const original = await optionalFile(item.target),
                merged = mergeFiveMinuteBars(original ?? Buffer.alloc(0), bars);
              Object.assign(item, {
                sourceHash: digest(source),
                indexVolumeOverflow: category === "index",
                overflowTimes: merged.insertedOverflowTimes,
                targetHash: original ? digest(original) : undefined,
                targetMissing: !original,
                mergedHash: digest(merged.data),
                added: merged.added,
                identical: merged.identical,
                conflicts: merged.conflicts,
                bytes: original?.length ?? 0,
                outputBytes: merged.data.length,
                first: bars[0]?.time,
                last: bars.at(-1)?.time,
              });
            }
          } catch (error) {
            item.state = "failed";
            item.error = error instanceof Error ? error.message : String(error);
          }
          await saveItem(id, item);
          if (i % 10 === 0 || i === files.length - 1)
            updateJob(job.id, {
              progress: Math.round(((i + 1) * 100) / files.length),
              phase: `预检 ${i + 1}/${files.length} ${file.symbol}`,
            });
        }
        const value = batch(id);
        put("tdx-import", batchKey(id), { ...value, status: "ready" });
        return { batchId: id };
      } catch (error) {
        const value = batch(id);
        put("tdx-import", batchKey(id), { ...value, status: "interrupted" });
        throw error;
      }
    },
  );
  put("tdx-import", batchKey(id), {
    id,
    root: base,
    input,
    createdAt: Date.now(),
    count: files.length,
    previewJob: job.id,
    status: "previewing",
  } satisfies Batch);
  return { id, jobId: job.id };
}
export async function fiveMinuteBatch(
  id: string,
  page: number,
  filter: string,
) {
  const value = batch(id),
    prefix = itemPrefix(id);
  const where = "kind='tdx-import-item' AND id >= ? AND id < ?";
  const filters: Record<string, string> = {
    failed:
      "json_extract(payload, '$.state') = 'failed' OR json_extract(payload, '$.restoredError') IS NOT NULL",
    skipped: "json_extract(payload, '$.state') = 'skipped'",
    conflicts: "json_extract(payload, '$.conflicts') > 0",
    overflow: "json_array_length(payload, '$.overflowTimes') > 0",
    prepared: "json_extract(payload, '$.state') = 'prepared'",
    written: "json_extract(payload, '$.state') = 'written'",
    restored: "json_extract(payload, '$.state') = 'restored'",
  };
  if (filter && !filters[filter]) throw new Error("明细筛选无效");
  const selectedWhere = where + (filter ? ` AND (${filters[filter]})` : "");
  const args = [prefix, prefix + "\uffff"];
  const rows = sqlite()
    .prepare(
      `SELECT payload FROM records WHERE ${selectedWhere} ORDER BY id LIMIT 50 OFFSET ?`,
    )
    .all(...args, page * 50) as { payload: string }[];
  const count = sqlite()
    .prepare(`SELECT count(*) AS n FROM records WHERE ${selectedWhere}`)
    .get(...args) as { n: number };
  const summary = sqlite()
    .prepare(
      `SELECT
    coalesce(sum(json_extract(payload,'$.added')),0) AS added,
    coalesce(sum(json_extract(payload,'$.conflicts')),0) AS conflicts,
    coalesce(sum(json_extract(payload,'$.identical')),0) AS identical,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='failed' OR json_extract(payload,'$.restoredError') IS NOT NULL THEN 1 ELSE 0 END),0) AS errors,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='skipped' THEN 1 ELSE 0 END),0) AS skipped,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='written' THEN 1 ELSE 0 END),0) AS written,
    coalesce(sum(CASE WHEN json_extract(payload,'$.targetMissing')=1 THEN 1 ELSE 0 END),0) AS newFiles,
    coalesce(sum(json_array_length(payload,'$.overflowTimes')),0) AS overflow,
    coalesce(sum(CASE WHEN json_extract(payload,'$.added')>0 THEN coalesce(json_extract(payload,'$.bytes'),0) ELSE 0 END),0) AS backupBytes
    FROM records WHERE ${where}`,
    )
    .get(...args) as {
    added: number;
    conflicts: number;
    identical: number;
    errors: number;
    skipped: number;
    written: number;
    newFiles: number;
    overflow: number;
    backupBytes: number;
  };
  return {
    batch: value,
    backupDirectory: batchDir(id),
    job: readJob(value.operationJob ?? value.previewJob) ?? null,
    total: count.n,
    items: rows.map((row) => JSON.parse(row.payload) as Item),
    summary,
  };
}
export function fiveMinuteHistory(page: number) {
  const rows = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind = 'tdx-import' ORDER BY updated_at DESC, id DESC LIMIT 50 OFFSET ?",
    )
    .all(page * 50) as { payload: string }[];
  const total = sqlite()
    .prepare("SELECT count(*) AS n FROM records WHERE kind = 'tdx-import'")
    .get() as { n: number };
  return {
    items: rows.map((row) => JSON.parse(row.payload) as Batch),
    total: total.n,
  };
}
export async function runFiveMinuteBatch(
  id: string,
  currentRoot: string | null,
  restore: boolean,
  guard = checkClientClosed,
) {
  const value = batch(id);
  const targetRoot = currentRoot ?? value.root;
  if ((await realpath(targetRoot)) !== value.root)
    throw new Error("通达信目录已变更，请重新预检");
  if (
    (!restore && value.status !== "ready") ||
    (restore &&
      ![
        "finished",
        "partial",
        "interrupted",
        "restored",
        "restore-partial",
      ].includes(value.status))
  )
    throw new Error("批次当前状态不能执行此操作");
  await guard();
  const items = await loadItems(id);
  if (!restore) {
    const required = items.reduce(
      (s, i) => s + (i.added ? (i.bytes ?? 0) : 0),
      0,
    );
    const space = await statfs(batchDir(id));
    const backupDevice = (await stat(batchDir(id))).dev;
    let sameVolumeTemporary = 0;
    const dirs = (await targetDirs(targetRoot)).dirs;
    for (const market of ["sh", "sz"]) {
      const largest = items.reduce(
        (max, i) =>
          i.symbol.startsWith(market) && i.added
            ? Math.max(max, i.outputBytes ?? 0)
            : max,
        0,
      );
      const targetSpace = await statfs(dirs[market]!);
      if (
        (await stat(/*turbopackIgnore: true*/ dirs[market]!)).dev ===
        backupDevice
      )
        sameVolumeTemporary = Math.max(sameVolumeTemporary, largest);
      else if (targetSpace.bavail * targetSpace.bsize < largest)
        throw new Error(`${market} 目标目录可用空间不足`);
    }
    if (space.bavail * space.bsize < required + sameVolumeTemporary)
      throw new Error("备份目录可用空间不足");
  }
  if (batch(id).status !== value.status)
    throw new Error("批次状态已改变，请刷新");
  try {
    const job = background(
      "tdx-import",
      { mode: restore ? "restore" : "import", batchId: id },
      async (job, signal) => {
        let claimed = false;
        try {
          claim(id);
          claimed = true;
          let failed =
            !restore && items.some((item) => item.state === "failed");
          for (const [index, item] of items.entries()) {
            signal.throwIfAborted();
            if (index % 25 === 0) await guard();
            try {
              const dirs = (await targetDirs(value.root)).dirs;
              const expected = join(
                dirs[item.symbol.slice(0, 2)]!,
                `${item.symbol}.lc5`,
              );
              if (item.target !== expected)
                throw new Error("目标目录已改变，请重新预检");
              if (restore && ["written", "prepared"].includes(item.state)) {
                if (!item.mergedHash) throw new Error("缺少导入后指纹");
                const current = await optionalFile(item.target);
                if (
                  (item.targetMissing && !current) ||
                  (current &&
                    item.targetHash &&
                    digest(current) === item.targetHash)
                ) {
                  item.state = "restored";
                  item.restoredError = undefined;
                } else if (item.targetMissing)
                  await removeImportedFile(item.target, item.mergedHash);
                else if (item.backup && item.targetHash)
                  await restoreImportedFile(
                    item.target,
                    item.backup,
                    item.targetHash,
                    item.mergedHash,
                  );
                else throw new Error("备份记录缺失");
                item.state = "restored";
                item.restoredError = undefined;
              } else if (
                !restore &&
                item.state === "preview" &&
                item.added &&
                item.unit
              ) {
                item.backup = join(batchDir(id), `${item.symbol}.lc5.backup`);
                item.state = "prepared";
                await saveItem(id, item);
                await importPreviewItem(item, item.unit, item.backup);
                item.state = "written";
              }
            } catch (e) {
              failed = true;
              item.restoredError = e instanceof Error ? e.message : String(e);
              if (!restore && item.state !== "prepared") item.state = "failed";
            }
            await saveItem(id, item);
            if (index % 10 === 0 || index === items.length - 1)
              updateJob(job.id, {
                progress: Math.round(((index + 1) * 100) / items.length),
                phase: `${restore ? "恢复" : "导入"} ${index + 1}/${items.length} ${item.symbol}`,
              });
          }
          signal.throwIfAborted();
          put("tdx-import", batchKey(id), {
            ...batch(id),
            status: restore
              ? failed
                ? "restore-partial"
                : "restored"
              : failed
                ? "partial"
                : "finished",
          });
          return { batchId: id };
        } catch (error) {
          put("tdx-import", batchKey(id), {
            ...batch(id),
            status: "interrupted",
          });
          throw error;
        } finally {
          if (claimed) release(id);
        }
      },
    );
    put("tdx-import", batchKey(id), {
      ...value,
      operationJob: job.id,
      status: restore ? "restoring" : "running",
    });
    return { jobId: job.id };
  } catch (error) {
    throw error;
  }
}
export async function exportFiveMinuteBatch(id: string) {
  const items = await loadItems(batch(id).id);
  const quote = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [
    [
      "证券",
      "类别",
      "开始",
      "结束",
      "新增",
      "相同",
      "冲突",
      "指数超限置零时间",
      "状态",
      "原因",
      "源文件",
      "目标文件",
      "备份文件",
    ],
    ...items.map((i) => [
      i.symbol,
      i.category,
      i.first,
      i.last,
      i.added,
      i.identical,
      i.conflicts,
      i.overflowTimes?.join("; "),
      i.state,
      i.error ?? i.restoredError,
      i.source,
      i.target,
      i.backup,
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
}
