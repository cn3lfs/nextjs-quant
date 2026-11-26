#!/usr/bin/env node
/**
 * Safe, reusable post-task cleanup script for disposable dev/test/agent artifacts.
 *
 * Defaults to DRY-RUN (preview only). Pass `--apply` to delete validated targets.
 *
 * Usage:
 *   pnpm clean:artifacts                      # dry-run preview
 *   pnpm clean:artifacts:apply                # delete disposable targets
 *   node scripts/clean-dev-artifacts.mjs --apply --keep-fleet 1
 *   node scripts/clean-dev-artifacts.mjs --apply --include-prev-release
 *   node scripts/clean-dev-artifacts.mjs --json
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ pid: number, name: string, commandLine: string }} ActiveProcess
 * @typedef {{ path: string, category: string, bytes: number, files: number }} CleanupTarget
 * @typedef {{ path: string, category: string, reason: string }} SkippedTarget
 * @typedef {{ path: string, category: string, bytes: number, files: number, error: string }} FailedTarget
 * @typedef {{
 *   repoRoot?: string,
 *   tempRoot?: string,
 *   includeTemp?: boolean,
 *   includePrevRelease?: boolean,
 *   keepFleet?: number,
 *   apply?: boolean,
 *   json?: boolean,
 *   listActiveProcesses?: () => ActiveProcess[],
 *   listTrackedFiles?: (repoRoot: string) => Set<string>,
 * }} CleanupOptions
 * @typedef {{
 *   mode: "apply" | "dry-run",
 *   repoRoot: string,
 *   tempRoot: string | null,
 *   plannedCount: number,
 *   plannedBytes: number,
 *   plannedFiles: number,
 *   deletedCount: number,
 *   reclaimedBytes: number,
 *   failedCount: number,
 *   targets: CleanupTarget[],
 *   deleted: CleanupTarget[],
 *   failed: FailedTarget[],
 *   skipped: SkippedTarget[],
 * }} CleanupResult
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDir, "..");

/** Prefixes of disposable isolated test directories created under OS %TEMP%. */
export const TEMP_PREFIXES = [
  "quant-desktop-",
  "quant-wave",
  "quant-etf-",
  "quant-perold-",
  "quant-w2",
  "quant-iter",
  "quant-test-",
  "nextjs-quant-",
  "wave0-",
  "wave1-",
  "wave2-",
  "ledger-w",
];

/** Top-level repo directories that must NEVER be deleted by this script. */
const PROTECTED_TOP_LEVEL = new Set([
  ".git",
  ".next",
  "node_modules",
  "src",
  "packages",
  "docs",
  "electron",
  "public",
  "runtime",
  "vendor",
  "scripts",
  "tests",
  "desktop",
]);

/** @param {string} p */
function normalizePath(p) {
  return resolve(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

/**
 * Inspect Windows / POSIX running process command lines once upfront so we
 * never delete a directory actively referenced by a running build/test/agent.
 * @returns {ActiveProcess[]}
 */
export function defaultListActiveProcesses() {
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    if (ps.status !== 0 || !ps.stdout.trim()) return [];
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(ps.stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      /** @type {ActiveProcess[]} */
      const result = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const row =
          /** @type {{ ProcessId?: unknown, Name?: unknown, CommandLine?: unknown }} */ (
            item
          );
        const pid = Number(row.ProcessId);
        if (!Number.isFinite(pid) || pid === process.pid) continue;
        result.push({
          pid,
          name: String(row.Name ?? ""),
          commandLine: String(row.CommandLine ?? ""),
        });
      }
      return result;
    } catch {
      return [];
    }
  }
  const ps = spawnSync("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (ps.status !== 0) return [];
  /** @type {ActiveProcess[]} */
  const result = [];
  for (const raw of ps.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    result.push({ pid, name: m[2] ?? "", commandLine: m[3] ?? "" });
  }
  return result;
}

/**
 * List git-tracked relative paths so this script refuses to touch anything tracked.
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function defaultListTrackedFiles(repoRoot) {
  const res = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "core.quotePath=false", "ls-files"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  if (res.status !== 0) return new Set();
  return new Set(
    res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\\/g, "/").toLowerCase())
      .filter(Boolean),
  );
}

/** @param {string} root @param {string} target */
async function hasReparseAncestor(root, target) {
  let cursor = resolve(target);
  const stop = resolve(root);
  while (cursor.length >= stop.length) {
    if (existsSync(cursor)) {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) return cursor;
    }
    if (normalizePath(cursor) === normalizePath(stop)) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Recursively measure a directory/file while strictly refusing any symlink or
 * Windows directory junction inside the subtree (never follows links).
 * @param {string} target
 * @returns {Promise<{ ok: true, bytes: number, files: number, mtimeMs: number } | { ok: false, reason: string, bytes: 0, files: 0 }>}
 */
async function measureTreeSafely(target) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: "symlink-or-junction", bytes: 0, files: 0 };
  }
  if (!stat.isDirectory()) {
    return { ok: true, bytes: stat.size, files: 1, mtimeMs: stat.mtimeMs };
  }
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        return {
          ok: false,
          reason: `symlink-descendant:${entry.name}`,
          bytes: 0,
          files: 0,
        };
      }
      const childStat = await lstat(full);
      if (childStat.isSymbolicLink()) {
        return {
          ok: false,
          reason: `symlink-descendant:${entry.name}`,
          bytes: 0,
          files: 0,
        };
      }
      if (childStat.isDirectory()) {
        stack.push(full);
      } else {
        bytes += childStat.size;
        files += 1;
      }
    }
  }
  return { ok: true, bytes, files, mtimeMs: stat.mtimeMs };
}

/** @param {string} repoRoot @param {string} target */
function isProtectedRepoPath(repoRoot, target) {
  const rel = relative(resolve(repoRoot), resolve(target)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return false;
  const segments = rel.split("/");
  const top = segments[0] ?? "";
  if (PROTECTED_TOP_LEVEL.has(top)) return true;
  if (
    top === "release" &&
    segments[1] &&
    segments[1].toLowerCase() === "win-unpacked"
  ) {
    return true;
  }
  if (rel.toLowerCase().includes(".env")) return true;
  return false;
}

/** @param {string} repoRoot @param {string} target @param {Set<string>} trackedSet */
function hasTrackedDescendant(repoRoot, target, trackedSet) {
  if (!trackedSet || trackedSet.size === 0) return false;
  const rel = relative(resolve(repoRoot), resolve(target))
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!rel || rel.startsWith("..")) return false;
  if (trackedSet.has(rel)) return true;
  const prefix = `${rel}/`;
  for (const item of trackedSet) {
    if (item.startsWith(prefix)) return true;
  }
  return false;
}

/** @param {string} target @param {ActiveProcess[]} processes @param {string} category */
function findLockingProcess(target, processes, category) {
  const normTarget = normalizePath(target);
  const slashTarget = normTarget.replace(/\\/g, "/");
  for (const proc of processes) {
    const cmd = (proc.commandLine || "").toLowerCase();
    const cmdSlash = cmd.replace(/\\/g, "/");
    if (cmd.includes(normTarget) || cmdSlash.includes(slashTarget)) {
      return proc;
    }
    if (
      category === "release-staging" &&
      /(pack-desktop\.ps1|electron-builder)/i.test(proc.commandLine || "")
    ) {
      return proc;
    }
  }
  return null;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Scan allowed disposable locations and build a validated cleanup plan.
 * @param {CleanupOptions} [options]
 */
export async function planDevArtifactCleanup(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const tempRoot = options.tempRoot
    ? resolve(options.tempRoot)
    : await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const includeTemp = options.includeTemp !== false;
  const includePrevRelease = Boolean(options.includePrevRelease);
  const keepFleet = Math.max(0, Number(options.keepFleet ?? 0) || 0);
  const processes = (
    options.listActiveProcesses ?? defaultListActiveProcesses
  )();
  const trackedSet = (options.listTrackedFiles ?? defaultListTrackedFiles)(
    repoRoot,
  );

  /** @type {Array<{ path: string, root: string, category: string }>} */
  const candidates = [];
  /** @type {SkippedTarget[]} */
  const skipped = [];

  // 1. Repo .test-data/
  const testDataRoot = join(repoRoot, ".test-data");
  if (existsSync(testDataRoot)) {
    const rootLink = await hasReparseAncestor(repoRoot, testDataRoot);
    if (rootLink) {
      skipped.push({
        path: testDataRoot,
        category: "test-data",
        reason: `reparse-ancestor:${rootLink}`,
      });
    } else {
      const topEntries = await readdir(testDataRoot, { withFileTypes: true });
      for (const entry of topEntries) {
        const full = join(testDataRoot, entry.name);
        if (
          entry.name === "checks" &&
          entry.isDirectory() &&
          !entry.isSymbolicLink()
        ) {
          const runs = await readdir(full, { withFileTypes: true });
          for (const run of runs) {
            candidates.push({
              path: join(full, run.name),
              root: repoRoot,
              category: "check-runs",
            });
          }
        } else if (
          entry.name === "fleet" &&
          entry.isDirectory() &&
          !entry.isSymbolicLink()
        ) {
          const runs = await readdir(full, { withFileTypes: true });
          /** @type {Array<{ path: string, mtimeMs: number }>} */
          const runStats = [];
          for (const run of runs) {
            const runPath = join(full, run.name);
            const st = await lstat(runPath).catch(() => null);
            runStats.push({
              path: runPath,
              mtimeMs: st?.mtimeMs ?? 0,
            });
          }
          runStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
          for (let i = 0; i < runStats.length; i++) {
            const entryStat = runStats[i];
            if (!entryStat) continue;
            if (i < keepFleet) {
              skipped.push({
                path: entryStat.path,
                category: "fleet-runs",
                reason: `retained-by-keep-fleet(${keepFleet})`,
              });
            } else {
              candidates.push({
                path: entryStat.path,
                root: repoRoot,
                category: "fleet-runs",
              });
            }
          }
        } else {
          candidates.push({
            path: full,
            root: repoRoot,
            category: "test-data",
          });
        }
      }
    }
  }

  // 2. Playwright reports & results
  for (const dirName of ["playwright-report", "test-results"]) {
    const full = join(repoRoot, dirName);
    if (existsSync(full)) {
      candidates.push({ path: full, root: repoRoot, category: "playwright" });
    }
  }

  // 3. Stale desktop pack staging directory (never release/win-unpacked!)
  const releaseNext = join(repoRoot, "release", "_next");
  if (existsSync(releaseNext)) {
    candidates.push({
      path: releaseNext,
      root: repoRoot,
      category: "release-staging",
    });
  }
  const releasePrev = join(repoRoot, "release", "_prev");
  if (existsSync(releasePrev)) {
    if (includePrevRelease) {
      candidates.push({
        path: releasePrev,
        root: repoRoot,
        category: "release-prev-backup",
      });
    } else {
      skipped.push({
        path: releasePrev,
        category: "release-prev-backup",
        reason: "preserved-by-default(pass --include-prev-release to remove)",
      });
    }
  }

  // 4. OS %TEMP% repo-owned isolated directories
  if (includeTemp && existsSync(tempRoot)) {
    const tempEntries = await readdir(tempRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of tempEntries) {
      const lower = entry.name.toLowerCase();
      if (TEMP_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        candidates.push({
          path: join(tempRoot, entry.name),
          root: tempRoot,
          category: "os-temp",
        });
      }
    }
  }

  /** @type {CleanupTarget[]} */
  const targets = [];

  for (const item of candidates) {
    if (!isInside(item.root, item.path)) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: "outside-allowed-root",
      });
      continue;
    }
    if (item.root === repoRoot && isProtectedRepoPath(repoRoot, item.path)) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: "protected-path",
      });
      continue;
    }
    if (
      item.root === repoRoot &&
      hasTrackedDescendant(repoRoot, item.path, trackedSet)
    ) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: "contains-tracked-git-files",
      });
      continue;
    }
    const linkAncestor = await hasReparseAncestor(item.root, item.path);
    if (linkAncestor) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: `symlink-or-junction:${linkAncestor}`,
      });
      continue;
    }
    const locker = findLockingProcess(item.path, processes, item.category);
    if (locker) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: `active-process(pid=${locker.pid},${locker.name})`,
      });
      continue;
    }
    const measured = await measureTreeSafely(item.path);
    if (!measured.ok) {
      skipped.push({
        path: item.path,
        category: item.category,
        reason: measured.reason,
      });
      continue;
    }
    targets.push({
      path: item.path,
      category: item.category,
      bytes: measured.bytes,
      files: measured.files,
    });
  }

  targets.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const totalBytes = targets.reduce((sum, t) => sum + t.bytes, 0);
  const totalFiles = targets.reduce((sum, t) => sum + t.files, 0);

  return {
    repoRoot,
    tempRoot: includeTemp ? tempRoot : null,
    targets,
    skipped,
    totalBytes,
    totalFiles,
  };
}

/**
 * Execute (or preview) the validated cleanup plan.
 * @param {CleanupOptions} [options]
 * @returns {Promise<CleanupResult>}
 */
export async function executeDevArtifactCleanup(options = {}) {
  const apply = Boolean(options.apply);
  const plan = await planDevArtifactCleanup(options);
  /** @type {CleanupTarget[]} */
  const deleted = [];
  /** @type {FailedTarget[]} */
  const failed = [];

  if (apply) {
    for (const target of plan.targets) {
      try {
        await rm(target.path, { recursive: true, force: true });
        if (existsSync(target.path)) {
          failed.push({ ...target, error: "still-exists-after-rm" });
        } else {
          deleted.push(target);
        }
      } catch (error) {
        failed.push({
          ...target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    repoRoot: plan.repoRoot,
    tempRoot: plan.tempRoot,
    plannedCount: plan.targets.length,
    plannedBytes: plan.totalBytes,
    plannedFiles: plan.totalFiles,
    deletedCount: deleted.length,
    reclaimedBytes: deleted.reduce((sum, t) => sum + t.bytes, 0),
    failedCount: failed.length,
    targets: plan.targets,
    deleted,
    failed,
    skipped: plan.skipped,
  };
}

/** @param {string[]} argv */
function parseCliArgs(argv) {
  /** @type {CleanupOptions} */
  const options = {
    apply: false,
    json: false,
    includeTemp: true,
    includePrevRelease: false,
    keepFleet: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-temp") options.includeTemp = false;
    else if (arg === "--include-prev-release")
      options.includePrevRelease = true;
    else if (arg === "--keep-fleet") {
      const next = Number(argv[++i]);
      if (!Number.isInteger(next) || next < 0) {
        throw new Error("--keep-fleet requires a non-negative integer");
      }
      options.keepFleet = next;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/clean-dev-artifacts.mjs [options]
  --dry-run                Preview cleanup targets only (default)
  --apply                  Delete validated disposable artifacts
  --keep-fleet <N>         Retain latest N .test-data/fleet runs (default: 0)
  --include-prev-release   Also remove release/_prev rollback backup
  --no-temp                Skip OS %TEMP% repo-owned directories
  --json                   Print machine-readable JSON summary`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/** @param {CleanupResult} result */
function printHumanSummary(result) {
  const tag = result.mode === "apply" ? "APPLY" : "DRY-RUN";
  console.log(`\n[clean-dev-artifacts] Mode: ${tag}`);
  console.log(`  Repo: ${result.repoRoot}`);
  if (result.tempRoot) console.log(`  Temp: ${result.tempRoot}`);

  if (result.targets.length === 0) {
    console.log("  No disposable dev/test artifacts found.");
  } else {
    /** @type {Map<string, { count: number, bytes: number, files: number }>} */
    const byCategory = new Map();
    for (const t of result.targets) {
      const cur = byCategory.get(t.category) ?? {
        count: 0,
        bytes: 0,
        files: 0,
      };
      cur.count += 1;
      cur.bytes += t.bytes;
      cur.files += t.files;
      byCategory.set(t.category, cur);
    }
    console.log("\n  Summary by category:");
    for (const [cat, stat] of byCategory) {
      console.log(
        `    - ${cat.padEnd(20)} ${String(stat.count).padStart(3)} items | ${String(stat.files).padStart(6)} files | ${formatBytes(stat.bytes)}`,
      );
    }
    console.log("\n  Targets:");
    for (const t of result.targets) {
      console.log(
        `    [${t.category}] ${formatBytes(t.bytes).padStart(10)}  ${t.path}`,
      );
    }
  }

  if (result.skipped.length > 0) {
    console.log(`\n  Preserved / skipped (${result.skipped.length}):`);
    for (const s of result.skipped) {
      console.log(`    - ${s.path}  (${s.reason})`);
    }
  }

  if (result.mode === "apply") {
    console.log(
      `\n  Deleted ${result.deletedCount}/${result.plannedCount} targets, reclaimed ${formatBytes(result.reclaimedBytes)}.`,
    );
    if (result.failedCount > 0) {
      console.error(`  Failed (${result.failedCount}):`);
      for (const f of result.failed) {
        console.error(`    - ${f.path}: ${f.error}`);
      }
    }
  } else {
    console.log(
      `\n  Preview only: ${result.plannedCount} targets (${formatBytes(result.plannedBytes)}). Re-run with --apply (or pnpm clean:artifacts:apply) to delete.`,
    );
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = resolve(fileURLToPath(import.meta.url));
if (invokedPath && normalizePath(invokedPath) === normalizePath(selfPath)) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const result = await executeDevArtifactCleanup(cliOptions);
  if (cliOptions.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanSummary(result);
  }
  if (result.failedCount > 0) process.exit(1);
}
