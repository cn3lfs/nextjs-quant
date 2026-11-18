import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { QuantTeamError } from "./errors";
import { isSafeIdentifier } from "./types";

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const defaultTeamRoot = join(repoRoot, ".test-data", "quant-team");

function resolveRelative(target: string): string {
  return resolve(target);
}

export function assertSafePath(root: string, target: string): void {
  const rootAbs = resolveRelative(root);
  const targetAbs = resolveRelative(target);
  const rel = relative(rootAbs, targetAbs);
  if (!rel || rel === ".") return;
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new QuantTeamError(
      "UNSAFE_PATH",
      `路径逃逸: ${targetAbs} 不在 ${rootAbs} 下`,
    );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reject symlink/junction components between root and target. */
export function assertNoLinks(root: string, target: string): void {
  assertSafePath(root, target);
  const rootAbs = resolveRelative(root);
  const targetAbs = resolveRelative(target);
  try {
    if (lstatSync(rootAbs).isSymbolicLink())
      throw new QuantTeamError(
        "UNSAFE_PATH",
        `拒绝使用符号链接/目录联接: ${rootAbs}`,
      );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const parts = relative(rootAbs, targetAbs)
    .split(sep)
    .filter((part) => part.length > 0);
  let current = rootAbs;
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (stats.isSymbolicLink())
      throw new QuantTeamError(
        "UNSAFE_PATH",
        `拒绝经过符号链接/目录联接: ${current}`,
      );
  }
  try {
    const realRoot = realpathSync(rootAbs);
    const realTarget = realpathSync(targetAbs);
    assertSafePath(realRoot, realTarget);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function ensureSafeDir(root: string, target: string): string {
  const rootAbs = resolveRelative(root);
  const targetAbs = resolveRelative(target);
  assertSafePath(rootAbs, targetAbs);
  if (rootAbs === targetAbs) {
    mkdirSync(rootAbs, { recursive: true });
    if (lstatSync(rootAbs).isSymbolicLink())
      throw new QuantTeamError(
        "UNSAFE_PATH",
        `拒绝使用符号链接目录: ${rootAbs}`,
      );
    return rootAbs;
  }
  mkdirSync(rootAbs, { recursive: true });
  assertNoLinks(rootAbs, targetAbs);
  mkdirSync(targetAbs, { recursive: true });
  assertNoLinks(rootAbs, targetAbs);
  if (!lstatSync(targetAbs).isDirectory())
    throw new QuantTeamError("UNSAFE_PATH", `不是目录: ${targetAbs}`);
  return targetAbs;
}

/**
 * Validate the team root against the repo root before creating or writing it.
 * This catches `.test-data`/`quant-team` junctions that a team-root-only check
 * would miss. Custom roots outside the repo are checked from their parent.
 */
export function assertTeamRootSafe(
  teamRoot: string,
  baseRoot: string = repoRoot,
): string {
  const root = resolveRelative(teamRoot);
  const base = resolveRelative(baseRoot);
  const rel = relative(base, root);
  if (!rel.startsWith("..") && !isAbsolute(rel)) assertNoLinks(base, root);
  else assertNoLinks(dirname(root), root);
  return root;
}

export function runDirFor(teamRoot: string, runId: string): string {
  if (!isSafeIdentifier(runId) || runId === "coordinator.lock")
    throw new QuantTeamError(
      "INVALID_IDENTIFIER",
      `runId 不安全: ${JSON.stringify(runId)}`,
    );
  const root = resolveRelative(teamRoot);
  const target = join(root, runId);
  assertSafePath(root, target);
  return target;
}

export function assertSafeRunDir(teamRoot: string, runId: string): string {
  const root = assertTeamRootSafe(teamRoot);
  const target = runDirFor(root, runId);
  assertNoLinks(root, target);
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (isMissing(error))
      throw new QuantTeamError("RUN_NOT_FOUND", `找不到运行记录: ${runId}`);
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new QuantTeamError(
      "UNSAFE_PATH",
      `运行目录是符号链接/目录联接: ${target}`,
    );
  if (!stats.isDirectory())
    throw new QuantTeamError("UNSAFE_PATH", `运行路径不是目录: ${target}`);
  return target;
}
