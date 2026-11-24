import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import Database from "better-sqlite3";
import { z } from "zod";
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
  diagnoseArchiveSummarySchema,
  diagnoseFamilyHoldoutSchema,
  diagnoseSampleOrderSchema,
  diagnoseScenarioMetricsSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
  type DiagnoseScenarioMetrics,
  type DiagnoseTimeHoldoutResult,
} from "~/lib/research/diagnose-contract";
import { dataDirectory } from "../../infra/paths";
import { recordRuntimeError } from "../../infra/runtime-errors";
import { atomic } from "../../db";
import { getJobStatus } from "../../db/jobs";
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
import { renderReport } from "./report";
import type { DiagnoseCell } from "./types";

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
const sidecarSchema = diagnoseArchiveSummarySchema.extend({
  dllHashes: z.array(z.string()),
  sleeveScenarios: z
    .array(
      diagnoseScenarioMetricsSchema
        .pick({
          scenarioId: true,
          sleeveInvestment: true,
          sleeveTrades: true,
        })
        .extend({ strategyKey: z.string(), symbols: z.array(z.string()) }),
    )
    .optional(),
});
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

function incompleteJobArchive(path: string, id: string) {
  const names = readdirSync(/* turbopackIgnore: true */ path);
  if (names.some((name) => /^\.(?:pending|staging|tmp)-|\.tmp$/.test(name)))
    return true;
  const file = join(/* turbopackIgnore: true */ path, "diagnose-group.json");
  const st = lstatSync(/* turbopackIgnore: true */ file, {
    throwIfNoEntry: false,
  });
  if (!st) return true;
  if (
    !st.isFile() ||
    relative(file, realpathSync(/* turbopackIgnore: true */ file)) !== ""
  )
    throw new UnsafeArchivePath();
  if (st.size > maxArchiveBytes) return true;
  const bytes = readFileSync(/* turbopackIgnore: true */ file, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch {
    return true;
  }
  const summary = diagnoseArchiveDetailSchema.safeParse(json).data?.summary;
  return summary?.id !== id || summary.source !== "lab-archive";
}

/** Recover the rename-before-commit window. Keep each original directory intact,
 * outside the visible lab-* namespace. Serialize with the publication transaction
 * so a live host between rename and COMMIT always gets to finish first. */
export function recoverDiagnoseArchives() {
  const root = labRoot({});
  const dir = lstatSync(/* turbopackIgnore: true */ root, {
    throwIfNoEntry: false,
  });
  if (!dir) return [];
  if (
    !dir.isDirectory() ||
    relative(root, realpathSync(/* turbopackIgnore: true */ root)) !== ""
  )
    throw new UnsafeArchivePath();
  const recovered: string[] = [];
  const ids = readdirSync(/* turbopackIgnore: true */ root)
    .filter((id) => /^lab-[A-Za-z0-9-]+$/.test(id) && safeSegment(id))
    .sort();
  for (const id of ids) {
    try {
      const path = labArchivePath(id, {});
      const generated =
        /^lab-job-[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
      const isOrphan = () => {
        const current = lstatSync(/* turbopackIgnore: true */ path);
        if (
          !current.isDirectory() ||
          relative(path, realpathSync(/* turbopackIgnore: true */ path)) !== ""
        )
          throw new UnsafeArchivePath();
        const status = getJobStatus(id.slice(4));
        if (status !== undefined && status !== "completed") return true;
        return generated && incompleteJobArchive(path, id);
      };
      if (!isOrphan()) continue;
      const quarantined = atomic(() => {
        if (!isOrphan()) return false;
        const base = join(/* turbopackIgnore: true */ root, `.orphan-${id}`);
        let target = base;
        for (
          let suffix = 1;
          lstatSync(/* turbopackIgnore: true */ target, {
            throwIfNoEntry: false,
          });
          suffix++
        )
          target = `${base}-${suffix}`;
        renameSync(/* turbopackIgnore: true */ path, target);
        return true;
      });
      if (quarantined) recovered.push(id);
    } catch (error) {
      // Concurrent recovery may have already renamed this entry.
      if (!isAbsent(error))
        recordRuntimeError("runtime-start", error, { jobId: id.slice(4) });
    }
  }
  return recovered;
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

/** The worker sends this projection to its host; only the host publishes it. */
export function diagnoseArchiveSidecar(
  detail: DiagnoseArchiveDetail,
): z.infer<typeof sidecarSchema> {
  const dllHashes = new Set<string>();
  const sleeveScenarios: NonNullable<
    z.infer<typeof sidecarSchema>["sleeveScenarios"]
  > = [];
  let scenarios = 0;
  for (const cell of detail.cells) {
    scenarios += cell.scenarios.length;
    for (const scenario of cell.scenarios) {
      for (const native of scenario.nativeChan ?? [])
        if (native.identity?.dllHash) dllHashes.add(native.identity.dllHash);
      if (scenario.sleeveInvestment || scenario.sleeveTrades)
        sleeveScenarios.push({
          strategyKey: cell.strategyKey,
          symbols: cell.symbols,
          scenarioId: scenario.scenarioId,
          sleeveInvestment: scenario.sleeveInvestment,
          sleeveTrades: scenario.sleeveTrades,
        });
    }
  }
  const { ok, blocked, failed } = detail.summary.statusCounts;
  const missingFiles = new Set(detail.summary.missingFiles);
  if (
    detail.pagination.totalCells !== detail.cells.length ||
    scenarios !== ok + failed + blocked
  )
    missingFiles.add("diagnose-group.json:cells");
  return {
    ...detail.summary,
    missingFiles: [...missingFiles],
    dllHashes: [...dllHashes],
    ...(sleeveScenarios.length && { sleeveScenarios }),
  };
}

async function listedSummary(
  {
    dllHashes,
    sleeveScenarios: _sleeves,
    ...summary
  }: ReturnType<typeof diagnoseArchiveSidecar>,
  drift: ReturnType<typeof dllWarnings>,
) {
  summary.driftWarnings = [
    ...new Set([...summary.driftWarnings, ...(await drift(dllHashes))]),
  ];
  return summary;
}

function visibleLab(id: string) {
  // Standalone archives can predate job IDs or have no database at all.
  const job = readArchiveJob(id.slice(4));
  return !job || job.status === "completed";
}

async function readLab(
  id: string,
  options: DiagnoseArchiveOptions,
  drift: ReturnType<typeof dllWarnings>,
) {
  const path = labArchivePath(id, options);
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
  const summary = await listedSummary(diagnoseArchiveSidecar(detail), drift);
  return {
    summary,
    cells: options.allCells
      ? detail.cells
      : detail.cells.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize: options.allCells ? Math.max(1, detail.cells.length) : pageSize,
      totalCells: detail.cells.length,
    },
    boundaryState:
      detail.boundaryState === "missing-files"
        ? ("missing-files" as const)
        : classifyArchiveBoundary(summary),
  };
}

async function readLabSummary(
  id: string,
  options: DiagnoseArchiveOptions,
  drift: ReturnType<typeof dllWarnings>,
) {
  if (!visibleLab(id)) return null;
  const path = labArchivePath(id, options);
  if (!(await checked(path, "directory"))) return null;
  let parsed: z.infer<typeof sidecarSchema> | undefined;
  try {
    const sidecar = await readBounded(
      join(/* turbopackIgnore: true */ path, "summary.json"),
      maxArchiveBytes,
    );
    if (sidecar && !sidecar.truncated)
      parsed = sidecarSchema.parse(JSON.parse(sidecar.text));
  } catch {
    // The optional projection can always be reconstructed from the detail.
  }
  if (parsed?.id === id && parsed.source === "lab-archive") {
    const full = await checked(
      join(/* turbopackIgnore: true */ path, "diagnose-group.json"),
      "file",
    );
    if (full && full.size <= maxArchiveBytes)
      return listedSummary(parsed, drift);
  }
  return (await readLab(id, options, drift)).summary;
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

export async function stageDiagnoseSummary(
  stage: string,
  id: string,
  value: ReturnType<typeof diagnoseArchiveSidecar>,
  options: WriteOptions = {},
) {
  checkLabId(id);
  const sidecar = sidecarSchema.parse(value);
  if (sidecar.id !== id || sidecar.source !== "lab-archive")
    throw new Error("诊断摘要与归档 ID 不一致");
  checkStagingPath(stage, labRoot(options));
  if (!(await checked(stage, "directory"))) throw new UnsafeArchivePath();
  await writeFile(
    join(/* turbopackIgnore: true */ stage, "summary.json"),
    JSON.stringify(sidecar),
    {
      flag: "wx",
      signal: options.signal,
    },
  );
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
  for (const name of ["diagnose-group.json", "summary.json"]) {
    const file = join(/* turbopackIgnore: true */ stage, name);
    const st = lstatSync(/* turbopackIgnore: true */ file);
    if (
      !st.isFile() ||
      st.size > maxArchiveBytes ||
      relative(file, realpathSync(/* turbopackIgnore: true */ file)) !== ""
    )
      throw new UnsafeArchivePath();
  }
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
  for (const name of [
    "diagnose-group.tmp",
    "diagnose-group.json",
    "summary.json",
  ]) {
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
    await stageDiagnoseSummary(
      stage,
      detail.summary.id,
      diagnoseArchiveSidecar(detail),
      options,
    );
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
  try {
    for (const name of ["diagnose-group.json", "summary.json"]) {
      const file = join(/* turbopackIgnore: true */ dir, name);
      if (await checked(file, "file"))
        await unlink(/* turbopackIgnore: true */ file);
    }
    await rmdir(/* turbopackIgnore: true */ dir);
  } catch (error) {
    // Another starting host may already have quarantined this rolled-back publication.
    if (!isAbsent(error)) throw error;
  }
}

async function readCliObject(
  dir: string,
  name: "summary.json" | "run.json" | "report.json",
) {
  const bytes = await readBounded(
    join(/* turbopackIgnore: true */ dir, name),
    name === "report.json" ? maxArchiveBytes : 2 * 1024 * 1024,
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

const cliDisclosures = diagnoseScenarioMetricsSchema.pick({
  timeHoldout: true,
  sleeveAttribution: true,
  sleeveInvestment: true,
  sleeveTrades: true,
  sessionEvidence: true,
  bookControl: true,
});

/** Some CLI fills refer to orders past the independently capped order sample. */
async function attachCliFillTriggers(
  dir: string,
  metrics: DiagnoseScenarioMetrics,
) {
  const orderById = new Map(
    metrics.sampleOrders.map((order) => [order.id, order]),
  );
  const missingIds = new Set(
    metrics.sampleFills
      .filter((fill) => !fill.trigger && !orderById.has(fill.orderId))
      .map((fill) => fill.orderId),
  );
  if (missingIds.size) {
    const csv = await readBounded(
      join(/* turbopackIgnore: true */ dir, "orders.csv"),
      2 * 1024 * 1024,
    );
    if (csv) {
      // Discard only the incomplete record at the CLI reader's byte limit.
      let end = csv.text.length;
      if (csv.truncated) {
        end = 0;
        let quoted = false;
        for (let i = 0; i < csv.text.length; i++) {
          if (csv.text[i] === '"') quoted = !quoted;
          else if (!quoted && csv.text[i] === "\n") end = i + 1;
        }
      }
      const { parseTmtCsv } =
        await import("../../strategies/sentiment/tmt-cache");
      let rows: Record<string, string>[] = [];
      try {
        rows = parseTmtCsv(csv.text.slice(0, end));
      } catch {
        // A malformed ledger can still supply validated orders from the original sample.
      }
      for (const row of rows) {
        const id = Number(row.id);
        if (!/^\d+$/.test(row.id ?? "") || !missingIds.has(id)) continue;
        const order = diagnoseSampleOrderSchema.safeParse({
          ...row,
          id,
          attempts: /^\d+$/.test(row.attempts ?? "")
            ? Number(row.attempts)
            : undefined,
          due: row.due || null,
          reason: row.reason || null,
          capacityClipped:
            row.capacityClipped === "true"
              ? true
              : row.capacityClipped === "false"
                ? false
                : row.capacityClipped || undefined,
        });
        if (order.success) orderById.set(id, order.data);
      }
    }
  }
  for (const fill of metrics.sampleFills) {
    const trigger = orderById.get(fill.orderId)?.trigger;
    if (!fill.trigger && trigger) fill.trigger = trigger;
  }
}

async function readCliFamilies(root: string) {
  const report = await readCliObject(root, "report.json");
  const comparisonSchema = z.object({
    mode: z.enum(["portfolio", "per-symbol"]),
    symbols: z.array(z.string()),
    familyHoldout: z.object({
      family: z.string(),
      disclosure: z.string().optional(),
      statistics: z.record(z.unknown()),
    }),
  });
  return (Array.isArray(report?.comparisons) ? report.comparisons : []).flatMap(
    (value: unknown) => {
      const comparison = comparisonSchema.safeParse(value);
      if (!comparison.success) return [];
      const { familyHoldout, mode, symbols } = comparison.data;
      const summary = diagnoseFamilyHoldoutSchema.parse({
        ...familyHoldout.statistics,
        family: familyHoldout.family,
        note: familyHoldout.disclosure,
      });
      return [{ mode, symbols, summary }];
    },
  );
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
  if (id.startsWith("lab-"))
    return visibleLab(id) ? readLab(id, options, drift) : null;
  const location = decodeCliLocation(id);
  const base = cliRoot(options);
  const page = options.allCells
    ? { page: 1, pageSize: Number.MAX_SAFE_INTEGER, offset: 0 }
    : archivePage(options);
  const detail = await readCliReport(base, location, page, drift);
  const root = join(/* turbopackIgnore: true */ base, ...location);
  const families = await readCliFamilies(root);
  if (families.length === 1)
    detail.summary.familyHoldout = families[0]!.summary;
  if (options.allCells)
    detail.pagination.pageSize = Math.max(1, detail.cells.length);
  if (detail.cells.length) {
    let index = 0;
    for await (const dir of cliCellDirectories(root)) {
      if (index++ < page.offset) continue;
      const cell = detail.cells[index - page.offset - 1]!;
      const summary = await readCliObject(dir, "summary.json");
      const metrics = cell.scenarios[0]!;
      await attachCliFillTriggers(dir, metrics);
      if (summary)
        Object.assign(
          metrics,
          cliDisclosures.parse({
            ...summary,
            sessionEvidence: summary.suspensionEvidence,
          }),
        );
      const family = families.find(
        (f) =>
          f.mode === cell.mode &&
          f.symbols.length === cell.symbols.length &&
          f.symbols.every((s) => cell.symbols.includes(s)),
      );
      if (family) metrics.familyHoldout = family.summary;
      if (index - page.offset === detail.cells.length) break;
    }
  }
  return { ...detail, boundaryState: classifyArchiveBoundary(detail.summary) };
}

function reportHoldout(
  review: DiagnoseTimeHoldoutResult | undefined,
): DiagnoseCell["timeHoldout"] {
  if (!review || review.status === "insufficient") return undefined;
  // The renderer uses null for unavailable metrics. Early archives omitted Calmar.
  const leg = (row: typeof review.holdout.base) => ({
    ...row,
    calmar: row.calmar ?? null,
    benchmarkCalmar: row.benchmarkCalmar ?? null,
    calmarDifference: row.calmarDifference ?? null,
  });
  return {
    ...review,
    holdout: {
      base: leg(review.holdout.base),
      doubledCost: leg(review.holdout.doubledCost),
      delayed: leg(review.holdout.delayed),
    },
  };
}

function renderArchiveMarkdown(detail: DiagnoseArchiveDetail) {
  const rows = detail.cells.flatMap((cell) =>
    cell.scenarios.map((scenario) => ({ cell, scenario })),
  );
  const reportCells: DiagnoseCell[] = rows.map(({ cell, scenario: s }) => ({
    strategy: `${cell.strategyKey} · ${s.label}`,
    symbols: cell.symbols,
    mode: cell.mode,
    start: cell.start,
    end: cell.end,
    status: s.status,
    error: s.error,
    runPath: "",
    counts: s.counts,
    findings: s.findings,
    rejectionReasons: s.rejectionReasons,
    checks: s.checks.flatMap((check) =>
      check.status === "pass" ||
      check.status === "fail" ||
      check.status === "warn"
        ? [{ ...check, status: check.status }]
        : [],
    ),
    suspensionEvidence: s.sessionEvidence,
    timeHoldout: reportHoldout(s.timeHoldout),
    sleeveTrades: s.sleeveTrades,
    sleeveInvestment: s.sleeveInvestment,
    sleeveAttribution: s.sleeveAttribution,
    bookControl: s.bookControl,
  }));
  const { summary } = detail;
  const lines = [
    renderReport(reportCells, summary.pool),
    "## 归档信息",
    "",
    `${summary.title} · ${summary.id} · ${summary.generatedAt}`,
    ...summary.driftWarnings.map((w) => `- ${w}`),
    ...summary.missingFiles.map((f) => `- 缺少 ${f}`),
  ];
  if (summary.run)
    lines.push(
      "",
      "### 复跑参数",
      "",
      "```json",
      JSON.stringify(summary.run, null, 2),
      "```",
    );
  for (const { cell, scenario: s } of rows) {
    const percent = (v: number | null) =>
      v === null ? "未记录" : `${(v * 100).toFixed(3)}%`;
    lines.push(
      "",
      `### ${cell.strategyKey} · ${cell.symbols.join("、")} · ${s.label}`,
      "",
      `${cell.start ?? "未记录"} 至 ${cell.end ?? "未记录"} · ${s.status}`,
      `- 收益 ${percent(s.totalReturn)}，最大回撤 ${percent(s.maxDrawdown)}，总费用 ${s.totalFees ?? "未记录"}`,
      `- 执行情景 ${s.scenarioId}，参与率上限 ${percent(s.maxParticipation)}，容量约束${s.capacityActive ? "生效" : "未生效"}`,
      ...(s.capacityNote ? [s.capacityNote] : []),
      ...(s.timeHoldout?.status === "insufficient"
        ? [
            `- 历史留出（${s.timeHoldout.holdoutStart}）样本不足：${s.timeHoldout.reasons.join("；")}`,
          ]
        : []),
      ...s.checks.map((c) => `- ${c.id} [${c.status}] ${c.message}`),
      "",
      "#### 情景证据与成交样本",
      "",
      "```json",
      JSON.stringify(
        {
          inputHash: s.inputHash,
          timingStatus: s.timingStatus,
          layer: s.layer,
          nativeChan: s.nativeChan,
          growthPit: s.growthPit ?? s.canslimPit,
          wyckoffFunnel: s.wyckoffFunnel,
          timeHoldout:
            s.timeHoldout?.status === "insufficient"
              ? s.timeHoldout
              : undefined,
          familyHoldout: s.familyHoldout,
          sessionEvidence: s.sessionEvidence,
          sampleOrders: s.sampleOrders,
          sampleFills: s.sampleFills,
          sampleRejections: s.sampleRejections,
        },
        null,
        2,
      ),
      "```",
    );
  }
  return lines.join("\n") + "\n";
}

export async function exportDiagnoseArchive(
  archiveId: string,
  format: "markdown" | "json",
) {
  const detail = await readDiagnoseArchive(archiveId, { allCells: true });
  if (!detail) throw new Error("诊断归档不可读取");
  const basename =
    archiveId.length <= 200
      ? archiveId
      : `cli-${decodeCliLocation(archiveId).at(-1)}`;
  if (format === "json")
    return {
      filename: `${basename}.json`,
      content: JSON.stringify({ ...detail, allCells: detail.cells }, null, 2),
    };
  if (detail.summary.source === "cli-report") {
    const root = join(
      /* turbopackIgnore: true */ cliRoot({}),
      ...decodeCliLocation(archiveId),
    );
    const report = await readBounded(
      join(/* turbopackIgnore: true */ root, "report.md"),
      maxArchiveBytes,
    );
    if (report && !report.truncated)
      return { filename: `${basename}.md`, content: report.text };
  }
  return {
    filename: `${basename}.md`,
    content: renderArchiveMarkdown(detail),
  };
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
        const summary = await readLabSummary(
          id,
          { ...options, page: 1, pageSize: 1 },
          drift,
        );
        if (summary) summaries.push(summary);
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
