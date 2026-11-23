import { randomUUID } from "node:crypto";
import { renameSync, statSync } from "node:fs";
import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  diagnoseArchiveDetailSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
} from "~/lib/research/diagnose-contract";
import { dataDirectory } from "../../infra/paths";
import { readJob } from "../../db/jobs";
import { czscRuntimeFingerprint } from "../../strategies/chan/czsc";
import {
  checked,
  directories,
  ensureRealDirectory,
  isAbsent,
  readBounded,
  safeSegment,
  UnsafeArchivePath,
} from "./archive-fs";
import {
  discoverCliArchives,
  decodeCliLocation,
  readCliReport,
} from "./cli-archive";

export interface DiagnoseArchiveOptions {
  archiveDir?: string;
  repoRoot?: string;
  page?: number;
  pageSize?: number;
  source?: DiagnoseArchiveSummary["source"];
  strategyKey?: string;
  symbol?: string;
  currentDllHash?: string;
}

const maxArchiveBytes = 16 * 1024 * 1024;
const labRoot = (options: DiagnoseArchiveOptions) =>
  resolve(options.archiveDir ?? join(dataDirectory(), "diagnose-archives"));
const cliRoot = (options: DiagnoseArchiveOptions) =>
  resolve(options.repoRoot ?? process.cwd(), ".test-data");

export function classifyArchiveBoundary(
  summary: DiagnoseArchiveSummary,
): DiagnoseArchiveDetail["boundaryState"] {
  if (summary.missingFiles.length) return "missing-files";
  const { ok, failed, blocked, zeroSignal } = summary.statusCounts;
  if (failed || blocked || !ok) return "blocked";
  return ok === zeroSignal ? "zero-signal" : "ok";
}

export function archivePage(options: DiagnoseArchiveOptions) {
  const { page = 1, pageSize = 10 } = options;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  )
    throw new Error("诊断归档分页参数无效");
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function dllWarnings(options: DiagnoseArchiveOptions) {
  let current: Promise<string | undefined> | undefined;
  return async (hashes: Iterable<string>) => {
    const values = [...new Set(hashes)];
    if (!values.length) return [];
    current ??= options.currentDllHash
      ? Promise.resolve(options.currentDllHash)
      : czscRuntimeFingerprint().then(
          (result) => result.dllHash,
          () => undefined,
        );
    const hash = await current;
    if (!hash) return ["当前原生缠论 DLL 指纹不可用，无法核对历史归档"];
    return values
      .filter((value) => value !== hash)
      .map((value) => `原生缠论 DLL 指纹已变化（归档 ${value}，当前 ${hash}）`);
  };
}

async function readLab(
  id: string,
  options: DiagnoseArchiveOptions,
  drift: ReturnType<typeof dllWarnings>,
) {
  if (!safeSegment(id) || !id.startsWith("lab-") || id.length === 4)
    throw new Error("非法诊断归档 ID");
  // readJob opens and migrates SQLite on demand. Standalone archives may
  // have no database, or predate job-based archive IDs.
  if (
    statSync(join(dataDirectory(), "quant.sqlite"), { throwIfNoEntry: false })
  ) {
    const job = readJob(id.slice(4));
    if (job && job.status !== "completed") return null;
  }
  const path = join(labRoot(options), id);
  const dir = await checked(path, "directory");
  if (!dir) throw new Error("诊断归档不存在");
  const bytes = await readBounded(
    join(path, "diagnose-group.json"),
    maxArchiveBytes,
  );
  const { page, pageSize, offset } = archivePage(options);
  let detail: DiagnoseArchiveDetail | undefined;
  if (bytes && !bytes.truncated) {
    try {
      detail = diagnoseArchiveDetailSchema.parse(JSON.parse(bytes.text));
    } catch {
      /* a damaged archive is still inspectable in the library */
    }
  }
  if (
    !detail ||
    detail.summary.id !== id ||
    detail.summary.source !== "lab-archive"
  ) {
    const reason = !bytes
      ? "diagnose-group.json 缺失"
      : bytes.truncated
        ? "diagnose-group.json 超出读取上限"
        : "diagnose-group.json 内容或身份无效";
    return {
      summary: {
        id,
        source: "lab-archive",
        title: id,
        generatedAt: dir.mtime.toISOString(),
        strategyKeys: [],
        symbols: [],
        scenarios: [],
        statusCounts: { ok: 0, blocked: 0, failed: 0, zeroSignal: 0 },
        driftWarnings: [reason],
        missingFiles: ["diagnose-group.json"],
      },
      cells: [],
      pagination: { page, pageSize, totalCells: 0 },
      boundaryState: "missing-files",
    } satisfies DiagnoseArchiveDetail;
  }
  const hashes = detail.cells.flatMap((cell) =>
    cell.scenarios.flatMap((scenario) =>
      (scenario.nativeChan ?? []).flatMap((row) =>
        row.identity?.dllHash ? [row.identity.dllHash] : [],
      ),
    ),
  );
  detail.summary.driftWarnings = [
    ...new Set([...detail.summary.driftWarnings, ...(await drift(hashes))]),
  ];
  return {
    summary: detail.summary,
    cells: detail.cells.slice(offset, offset + pageSize),
    pagination: { page, pageSize, totalCells: detail.cells.length },
    boundaryState: classifyArchiveBoundary(detail.summary),
  };
}

/** Publish the complete file atomically. Job-backed archives also require a completed job. */
export async function publishDiagnoseArchive(
  detail: DiagnoseArchiveDetail,
  options: {
    archiveDir?: string;
    signal?: AbortSignal;
    beforePublish?: () => void;
  } = {},
) {
  const { id, source } = detail.summary;
  if (
    !/^lab-[a-z0-9-]+$/i.test(id) ||
    !safeSegment(id) ||
    source !== "lab-archive"
  )
    throw new Error("非法 Lab 诊断归档 ID");
  options.signal?.throwIfAborted();
  const json = JSON.stringify(diagnoseArchiveDetailSchema.parse(detail));
  if (Buffer.byteLength(json) > maxArchiveBytes)
    throw new Error("诊断归档超过大小上限");
  const root = labRoot(options);
  await ensureRealDirectory(root);
  const target = join(root, id);
  if (await checked(target, "directory")) throw new Error("诊断归档已存在");
  const stage = join(root, `.pending-${randomUUID()}`);
  await mkdir(stage);
  try {
    await checked(stage, "directory");
    await writeFile(join(stage, "diagnose-group.tmp"), json, {
      flag: "wx",
      signal: options.signal,
    });
    await checked(stage, "directory");
    await rename(
      join(stage, "diagnose-group.tmp"),
      join(stage, "diagnose-group.json"),
    );
    await checked(stage, "directory");
    options.signal?.throwIfAborted();
    options.beforePublish?.();
    // No event-loop turn between the final cancellation check and publication.
    renameSync(stage, target);
  } catch (error) {
    if (await checked(stage, "directory")) {
      for (const name of ["diagnose-group.tmp", "diagnose-group.json"])
        await unlink(join(stage, name)).catch((error) => {
          if (!isAbsent(error)) throw error;
        });
      await rmdir(stage);
    }
    throw error;
  }
}

export async function removeUnpublishedDiagnoseArchive(id: string) {
  if (!safeSegment(id) || !id.startsWith("lab-")) throw new UnsafeArchivePath();
  const dir = join(labRoot({}), id);
  if (!(await checked(dir, "directory"))) return;
  const file = join(dir, "diagnose-group.json");
  if (await checked(file, "file")) await unlink(file);
  await rmdir(dir);
}

export async function readDiagnoseArchive(
  id: string,
  options: DiagnoseArchiveOptions = {},
): Promise<DiagnoseArchiveDetail | null> {
  const drift = dllWarnings(options);
  if (id.startsWith("lab-")) return readLab(id, options, drift);
  const location = decodeCliLocation(id);
  const detail = await readCliReport(
    cliRoot(options),
    location,
    archivePage(options),
    drift,
  );
  return { ...detail, boundaryState: classifyArchiveBoundary(detail.summary) };
}

export async function listDiagnoseArchives(
  options: DiagnoseArchiveOptions = {},
): Promise<DiagnoseArchiveSummary[]> {
  const summaries: DiagnoseArchiveSummary[] = [];
  const drift = dllWarnings(options);
  if (options.source !== "cli-report")
    for (const id of (await directories(labRoot(options))).filter((name) =>
      /^lab-[a-z0-9-]+$/i.test(name),
    )) {
      try {
        const detail = await readLab(
          id,
          { ...options, page: 1, pageSize: 1 },
          drift,
        );
        if (detail) summaries.push(detail.summary);
      } catch (error) {
        if (!(error instanceof UnsafeArchivePath)) throw error;
      }
    }
  if (options.source !== "lab-archive")
    for (const location of await discoverCliArchives(cliRoot(options))) {
      try {
        const { summary } = await readCliReport(
          cliRoot(options),
          location,
          { page: 1, pageSize: 0, offset: 0 },
          drift,
        );
        summaries.push(summary);
      } catch (error) {
        if (!(error instanceof UnsafeArchivePath)) throw error;
      }
    }
  const { offset, pageSize } = archivePage({
    ...options,
    pageSize: options.pageSize ?? 50,
  });
  return summaries
    .filter(
      (summary) =>
        (!options.strategyKey ||
          summary.strategyKeys.includes(options.strategyKey)) &&
        (!options.symbol || summary.symbols.includes(options.symbol)),
    )
    .sort(
      (a, b) =>
        b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id),
    )
    .slice(offset, offset + pageSize);
}
