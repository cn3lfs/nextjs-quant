import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  mkdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  diagnoseArchiveDetailSchema,
  diagnoseSleeveAttributionSchema,
  diagnoseTimeHoldoutSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
} from "~/lib/research/diagnose-contract";
import { dataDirectory } from "../../infra/paths";
import { records } from "../../db/schema";
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
  /** Internal read mode for side-by-side comparison, including every cell. */
  allCells?: boolean;
  source?: DiagnoseArchiveSummary["source"];
  strategyKey?: string;
  symbol?: string;
  currentDllHash?: string;
}

const maxArchiveBytes = 16 * 1024 * 1024;
const labRoot = (options: DiagnoseArchiveOptions) =>
  resolve(
    /* turbopackIgnore: true */ options.archiveDir ??
      join(/* turbopackIgnore: true */ dataDirectory(), "diagnose-archives"),
  );
const cliRoot = (options: DiagnoseArchiveOptions) =>
  resolve(
    /* turbopackIgnore: true */ options.repoRoot ?? process.cwd(),
    ".test-data",
  );

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

function readArchiveJob(id: string) {
  const path = join(
    /* turbopackIgnore: true */ dataDirectory(),
    "quant.sqlite",
  );
  try {
    lstatSync(/* turbopackIgnore: true */ path);
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return drizzle(db)
      .select({
        status: sql<
          string | null
        >`json_extract(${records.payload}, '$.status')`,
      })
      .from(records)
      .where(and(eq(records.kind, "job"), eq(records.id, id)))
      .get();
  } finally {
    db.close();
  }
}

function labArchivePath(id: string, options: DiagnoseArchiveOptions) {
  if (!safeSegment(id) || !id.startsWith("lab-") || id.length === 4)
    throw new Error("非法诊断归档 ID");
  return join(/* turbopackIgnore: true */ labRoot(options), id);
}

export async function resolveDiagnoseArchiveKey(
  id: string,
  options: DiagnoseArchiveOptions = {},
) {
  const path = id.startsWith("lab-")
    ? labArchivePath(id, options)
    : join(
        /* turbopackIgnore: true */ cliRoot(options),
        ...decodeCliLocation(id),
      );
  if (!(await checked(path, "directory"))) throw new Error("诊断归档不存在");
  const canonical = await realpath(/* turbopackIgnore: true */ path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function readLab(
  id: string,
  options: DiagnoseArchiveOptions,
  drift: ReturnType<typeof dllWarnings>,
) {
  const path = labArchivePath(id, options);
  // Standalone archives can predate job IDs or have no database at all.
  const job = readArchiveJob(id.slice(4));
  if (job && job.status !== "completed") return null;
  const dir = await checked(path, "directory");
  if (!dir) throw new Error("诊断归档不存在");
  const bytes = await readBounded(
    join(/* turbopackIgnore: true */ path, "diagnose-group.json"),
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
  const declaredScenarios =
    detail.summary.statusCounts.ok +
    detail.summary.statusCounts.blocked +
    detail.summary.statusCounts.failed;
  const actualScenarios = detail.cells.reduce(
    (sum, cell) => sum + cell.scenarios.length,
    0,
  );
  const incompleteCells =
    detail.pagination.totalCells !== detail.cells.length ||
    declaredScenarios !== actualScenarios;
  if (incompleteCells) {
    detail.summary.missingFiles = [
      ...new Set([...detail.summary.missingFiles, "diagnose-group.json:cells"]),
    ];
  }
  return {
    summary: detail.summary,
    cells: options.allCells
      ? detail.cells
      : detail.cells.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize: options.allCells ? Math.max(1, detail.cells.length) : pageSize,
      totalCells: detail.cells.length,
    },
    boundaryState:
      incompleteCells || detail.boundaryState === "missing-files"
        ? ("missing-files" as const)
        : classifyArchiveBoundary(detail.summary),
  };
}

type WriteOptions = Pick<DiagnoseArchiveOptions, "archiveDir"> & {
  signal?: AbortSignal;
  beforePublish?: () => void;
};

function checkLabId(id: string) {
  if (!/^lab-[a-z0-9-]+$/i.test(id) || !safeSegment(id))
    throw new Error("非法 Lab 诊断归档 ID");
}

function checkStagingPath(stage: string, root: string) {
  if (
    stage !== resolve(/* turbopackIgnore: true */ stage) ||
    relative(root, dirname(stage)) !== "" ||
    !/^\.pending-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
      basename(stage),
    )
  )
    throw new UnsafeArchivePath();
}

export async function createDiagnoseStagingDir(archiveDir?: string) {
  const root = labRoot({ archiveDir });
  await ensureRealDirectory(root);
  const stage = join(
    /* turbopackIgnore: true */ root,
    `.pending-${randomUUID()}`,
  );
  await mkdir(/* turbopackIgnore: true */ stage);
  if (!(await checked(stage, "directory"))) throw new UnsafeArchivePath();
  return stage;
}

export async function stageDiagnoseArchive(
  detail: DiagnoseArchiveDetail,
  stage: string,
  options: WriteOptions = {},
) {
  checkLabId(detail.summary.id);
  if (detail.summary.source !== "lab-archive")
    throw new Error("非法 Lab 诊断归档 ID");
  options.signal?.throwIfAborted();
  const json = JSON.stringify(diagnoseArchiveDetailSchema.parse(detail));
  if (Buffer.byteLength(json) > maxArchiveBytes)
    throw new Error("诊断归档超过大小上限");
  checkStagingPath(stage, labRoot(options));
  if (!(await checked(stage, "directory"))) throw new UnsafeArchivePath();
  const tmp = join(/* turbopackIgnore: true */ stage, "diagnose-group.tmp");
  const file = join(/* turbopackIgnore: true */ stage, "diagnose-group.json");
  if (await checked(file, "file")) throw new Error("诊断归档已存在");
  await writeFile(/* turbopackIgnore: true */ tmp, json, {
    flag: "wx",
    signal: options.signal,
  });
  if (!(await checked(stage, "directory"))) throw new UnsafeArchivePath();
  await rename(/* turbopackIgnore: true */ tmp, file);
}

/** Synchronous so the host can hold SQLite's write reservation throughout publication. */
export function publishStagedDiagnoseArchive(
  stage: string,
  id: string,
  options: Pick<DiagnoseArchiveOptions, "archiveDir"> = {},
) {
  checkLabId(id);
  const root = labRoot(options);
  checkStagingPath(stage, root);
  const file = join(/* turbopackIgnore: true */ stage, "diagnose-group.json");
  const st = lstatSync(/* turbopackIgnore: true */ file);
  if (
    !st.isFile() ||
    st.size > maxArchiveBytes ||
    relative(file, realpathSync(/* turbopackIgnore: true */ file)) !== ""
  )
    throw new UnsafeArchivePath();
  const target = join(/* turbopackIgnore: true */ root, id);
  if (lstatSync(/* turbopackIgnore: true */ target, { throwIfNoEntry: false }))
    throw new Error("诊断归档已存在");
  renameSync(/* turbopackIgnore: true */ stage, target);
}

export async function cleanupDiagnoseStagingDir(
  stage: string,
  options: Pick<DiagnoseArchiveOptions, "archiveDir"> = {},
) {
  checkStagingPath(stage, labRoot(options));
  if (!(await checked(stage, "directory"))) return;
  for (const name of ["diagnose-group.tmp", "diagnose-group.json"]) {
    await unlink(join(/* turbopackIgnore: true */ stage, name)).catch(
      (error) => {
        if (!isAbsent(error)) throw error;
      },
    );
  }
  await rmdir(/* turbopackIgnore: true */ stage).catch((error) => {
    if (!isAbsent(error)) throw error;
  });
}

export async function publishDiagnoseArchive(
  detail: DiagnoseArchiveDetail,
  options: WriteOptions = {},
) {
  options.signal?.throwIfAborted();
  const stage = await createDiagnoseStagingDir(options.archiveDir);
  try {
    await stageDiagnoseArchive(detail, stage, options);
    options.signal?.throwIfAborted();
    options.beforePublish?.();
    options.signal?.throwIfAborted();
    publishStagedDiagnoseArchive(stage, detail.summary.id, options);
  } finally {
    await cleanupDiagnoseStagingDir(stage, options);
  }
}

export async function removeUnpublishedDiagnoseArchive(id: string) {
  if (!safeSegment(id) || !id.startsWith("lab-")) throw new UnsafeArchivePath();
  const dir = join(/* turbopackIgnore: true */ labRoot({}), id);
  if (!(await checked(dir, "directory"))) return;
  const file = join(/* turbopackIgnore: true */ dir, "diagnose-group.json");
  if (await checked(file, "file"))
    await unlink(/* turbopackIgnore: true */ file);
  await rmdir(/* turbopackIgnore: true */ dir);
}

async function readCliObject(dir: string, name: "summary.json" | "run.json") {
  const bytes = await readBounded(
    join(/* turbopackIgnore: true */ dir, name),
    2 * 1024 * 1024,
  );
  if (!bytes || bytes.truncated) return;
  try {
    const value: unknown = JSON.parse(bytes.text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* The CLI reader already records malformed metadata. */
  }
}

/** Follow the CLI reader's sorted cell order, including legacy flat and single-cell reports.
 * Only directory entries are used as path segments, never fields from report JSON. */
async function* cliCellDirectories(root: string) {
  let nested = false;
  for (const mode of ["per-symbol", "portfolio"]) {
    const modeDir = join(/* turbopackIgnore: true */ root, mode);
    for (const key of await directories(modeDir, true)) {
      const strategyDir = join(/* turbopackIgnore: true */ modeDir, key);
      for (const leaf of await directories(strategyDir, true)) {
        nested = true;
        yield join(/* turbopackIgnore: true */ strategyDir, leaf);
      }
    }
  }
  if (nested) return;
  let flat = false;
  for (const name of await directories(root)) {
    const dir = join(/* turbopackIgnore: true */ root, name);
    const run = await readCliObject(dir, "run.json");
    if (typeof run?.strategyKey === "string" && Array.isArray(run.symbols)) {
      flat = true;
      yield dir;
    }
  }
  if (!flat) yield root;
}

export async function readDiagnoseArchive(
  id: string,
  options: DiagnoseArchiveOptions = {},
): Promise<DiagnoseArchiveDetail | null> {
  const drift = dllWarnings(options);
  if (id.startsWith("lab-")) return readLab(id, options, drift);
  const location = decodeCliLocation(id);
  const base = cliRoot(options);
  const page = options.allCells
    ? { page: 1, pageSize: Number.MAX_SAFE_INTEGER, offset: 0 }
    : archivePage(options);
  const detail = await readCliReport(base, location, page, drift);
  if (options.allCells)
    detail.pagination.pageSize = Math.max(1, detail.cells.length);
  if (detail.cells.length) {
    let index = 0;
    for await (const dir of cliCellDirectories(
      join(/* turbopackIgnore: true */ base, ...location),
    )) {
      if (index++ < page.offset) continue;
      const cell = detail.cells[index - page.offset - 1]!;
      const summary = await readCliObject(dir, "summary.json");
      const metrics = cell.scenarios[0]!;
      if (summary?.timeHoldout !== undefined)
        metrics.timeHoldout = diagnoseTimeHoldoutSchema.parse(
          summary.timeHoldout,
        );
      if (summary?.sleeveAttribution !== undefined)
        metrics.sleeveAttribution = diagnoseSleeveAttributionSchema.parse(
          summary.sleeveAttribution,
        );
      if (index - page.offset === detail.cells.length) break;
    }
  }
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
