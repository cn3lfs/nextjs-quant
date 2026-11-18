import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";

const contentHashPattern = /^[a-f0-9]{64}$/;

const checkpointEnvelopeSchema = z
  .object({
    identity: z.string().min(1),
    key: z.unknown(),
    row: z.unknown(),
    contentHash: z.string().regex(contentHashPattern),
  })
  .strict();

const lockMetadataSchema = z
  .object({
    pid: z.number().int().positive(),
    host: z.string().min(1),
    token: z.string().min(1),
    acquiredAt: z.string().min(1),
  })
  .strict();

export type ResearchCheckpoint<Row = unknown> = {
  identity: string;
  key: unknown;
  row: Row;
  contentHash: string;
};

export type ResearchCheckpointExpectation<Row = unknown> = {
  identity: string;
  key: unknown;
  /**
   * Runs after the checkpoint validates and before it is handed to the caller.
   * Cancellation, budget or identity failures here must stop the run instead
   * of resuming work that is no longer authorized.
   */
  beforeResume?: () => void | Promise<void>;
  /**
   * Reads a checkpoint recorded before the shared envelope existed. The
   * callback owns the old format's identity checks; the returned envelope is
   * still validated by the shared identity/key/content-hash flow. Return null
   * when the value is unrelated, throw when it matches but is damaged.
   */
  readLegacy?: (
    value: Record<string, unknown>,
  ) => ResearchCheckpoint<Row> | null;
};

export type ResearchRunAbortReason = "cancelled" | "deadline" | "budget";

export class ResearchRunAbortedError extends Error {
  readonly reason: ResearchRunAbortReason;

  constructor(reason: ResearchRunAbortReason, detail: string) {
    super(`Research run stopped (${reason}): ${detail}`);
    this.name = "ResearchRunAbortedError";
    this.reason = reason;
  }
}

export class ResearchIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchIdentityError";
  }
}

/** A checkpoint file is damaged or belongs to a different identity/input.
 * Callers must fail the run instead of treating it as "no checkpoint". */
export class ResearchCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchCheckpointError";
  }
}

export type ResearchRunBudget = {
  /** Cooperative cancellation. A synchronous engine call is not preempted;
   * the signal is observed at explicit checkpoints and progress callbacks. */
  signal?: AbortSignal;
  /** Epoch milliseconds. A finite positive value; zero time budget is
   * represented by leaving this undefined. */
  deadline?: number;
  /** Finite positive MiB. */
  maxRssMiB?: number;
  onAbort?: (reason: ResearchRunAbortReason) => void;
};

export function validateResearchRunBudget(
  budget: ResearchRunBudget,
): ResearchRunBudget {
  if (
    budget.deadline !== undefined &&
    (!Number.isFinite(budget.deadline) || budget.deadline <= 0)
  )
    throw new Error(
      "deadline must be a finite positive epoch millisecond value",
    );
  if (
    budget.maxRssMiB !== undefined &&
    (!Number.isFinite(budget.maxRssMiB) || budget.maxRssMiB <= 0)
  )
    throw new Error("RSS budget must be a finite positive number of MiB");
  return budget;
}

/** Centralizes CLI/programmatic budget parsing. A time budget of 0 means
 * unlimited; negative, NaN or infinite values are rejected instead of being
 * used to disable a limit accidentally. */
export function createResearchRunBudget(input: {
  signal?: AbortSignal;
  timeBudgetMs?: number;
  maxRssMiB?: number;
  onAbort?: (reason: ResearchRunAbortReason) => void;
  now?: number;
}): ResearchRunBudget {
  const timeBudgetMs = input.timeBudgetMs ?? 0;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 0)
    throw new Error(
      "time budget must be a finite non-negative number of milliseconds",
    );
  const budget: ResearchRunBudget = {
    signal: input.signal,
    deadline:
      timeBudgetMs > 0 ? (input.now ?? Date.now()) + timeBudgetMs : undefined,
    maxRssMiB: input.maxRssMiB,
    onAbort: input.onAbort,
  };
  return validateResearchRunBudget(budget);
}

export function researchDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function researchJsonHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Research value is not JSON-serializable");
  return researchDigest(serialized);
}

function jsonBody(value: unknown): string {
  const body = JSON.stringify(value, null, 2);
  if (body === undefined)
    throw new Error("Research value is not JSON-serializable");
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes a complete JSON document and only then exposes it at `path`.
 * Returns true when this call published the file, false when an immutable
 * publication found an existing file.
 *
 * This guarantees completeness against process interruption, not power-loss
 * durability: there is no fsync, so the OS may lose the rename/link after a
 * machine crash. Only this call's own pending file is removed in `finally`. */
async function publishJson(
  path: string,
  body: string,
  immutable: boolean,
  beforePublish?: () => void | Promise<void>,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    // The guard runs after the pending bytes exist, so a cancellation during
    // the write still cannot publish the destination.
    await beforePublish?.();
    if (!immutable) {
      await rename(temporary, path);
      return true;
    }
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Atomic JSON write. A process crash leaves only a `.pending` temporary,
 * never a half-written destination. Immutable writes never replace recorded
 * evidence. No fsync: completeness is against process interruption, not
 * power-loss durability. */
export async function writeResearchJsonAtomic(
  path: string,
  value: unknown,
  options: {
    immutable?: boolean;
    /** Runs after the pending bytes exist and before the destination is
     * published. A throw cancels the publication and removes the pending file. */
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  const body = jsonBody(value);
  const published = await publishJson(
    path,
    body,
    options.immutable ?? false,
    options.beforeCommit,
  );
  if (published) return;
  if ((await readFile(path, "utf8")) !== body)
    throw new Error(`Immutable research JSON differs: ${path}`);
}

/** Publishes a registration once and accepts later calls only when the
 * recorded content still has the same identity. The identity is the compact
 * JSON hash used by the existing research scripts, so old registrations keep
 * their recorded identity. */
export async function ensureResearchRegistration(
  path: string,
  registration: unknown,
  identity = researchJsonHash(registration),
): Promise<string> {
  const registrationIdentity = researchJsonHash(registration);
  if (identity !== registrationIdentity)
    throw new Error(
      `Research registration identity does not match the supplied registration: ${path}`,
    );
  const body = jsonBody(registration);
  const published = await publishJson(path, body, true);
  if (published) return identity;
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      `Existing research registration is not valid JSON: ${path}`,
    );
  }
  if (researchJsonHash(existing) !== identity)
    throw new Error(
      `Existing research registration differs from the expected identity: ${path}`,
    );
  return identity;
}

function isCheckpointEnvelope(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  identity: string;
  key: unknown;
  row: unknown;
  contentHash: string;
} {
  return (
    typeof value.identity === "string" &&
    "key" in value &&
    "row" in value &&
    typeof value.contentHash === "string"
  );
}

function assertCheckpointMatches<Row>(
  checkpoint: ResearchCheckpoint<Row>,
  expected: Pick<ResearchCheckpointExpectation<Row>, "identity" | "key">,
  path: string,
): void {
  if (checkpoint.identity !== expected.identity)
    throw new ResearchCheckpointError(
      `Research checkpoint identity mismatch: ${path}`,
    );
  if (JSON.stringify(checkpoint.key) !== JSON.stringify(expected.key))
    throw new ResearchCheckpointError(
      `Research checkpoint key mismatch: ${path}`,
    );
  if (checkpoint.contentHash !== researchJsonHash(checkpoint.row))
    throw new ResearchCheckpointError(
      `Research checkpoint content hash mismatch: ${path}`,
    );
}

/** Validates identity, key and content hash before a checkpoint may be
 * resumed. Missing files return null; damaged or mismatched files throw. */
export async function readResearchCheckpoint<Row = unknown>(
  path: string,
  expected: ResearchCheckpointExpectation<Row>,
): Promise<ResearchCheckpoint<Row> | null> {
  // The guard must also run when no checkpoint exists: a caller that is
  // already cancelled or over budget must not start recomputing.
  await expected.beforeResume?.();
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ResearchCheckpointError(
      `Research checkpoint is not valid JSON: ${path}`,
    );
  }
  if (!isRecord(value))
    throw new ResearchCheckpointError(
      `Research checkpoint has no object envelope: ${path}`,
    );

  let checkpoint: ResearchCheckpoint<Row>;
  if (isCheckpointEnvelope(value)) {
    const parsed = checkpointEnvelopeSchema.safeParse(value);
    if (!parsed.success)
      throw new ResearchCheckpointError(
        `Research checkpoint envelope is invalid: ${path}`,
      );
    checkpoint = parsed.data as ResearchCheckpoint<Row>;
  } else if (expected.readLegacy) {
    let legacy: ResearchCheckpoint<Row> | null;
    try {
      legacy = expected.readLegacy(value);
    } catch (error) {
      if (error instanceof ResearchCheckpointError) throw error;
      throw new ResearchCheckpointError(
        `Legacy research checkpoint is damaged: ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!legacy)
      throw new ResearchCheckpointError(
        `Research checkpoint has an unrecognized format: ${path}`,
      );
    checkpoint = legacy;
  } else {
    throw new ResearchCheckpointError(
      `Research checkpoint has an unrecognized format: ${path}`,
    );
  }

  assertCheckpointMatches(checkpoint, expected, path);
  await expected.beforeResume?.();
  return checkpoint;
}

/** Publishes a success checkpoint only after the caller's pre-commit guard
 * passes. A cancellation, budget or identity failure therefore cannot leave a
 * checkpoint that a later run would mistake for completed work. */
export async function writeResearchCheckpoint<Row>(
  path: string,
  checkpoint: { identity: string; key: unknown; row: Row },
  options: { beforeCommit?: () => void | Promise<void> } = {},
): Promise<string> {
  const contentHash = researchJsonHash(checkpoint.row);
  const envelope: ResearchCheckpoint<Row> = {
    identity: checkpoint.identity,
    key: checkpoint.key,
    row: checkpoint.row,
    contentHash,
  };
  const body = jsonBody(envelope);

  const published = await publishJson(path, body, true, options.beforeCommit);
  if (published) return contentHash;

  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ResearchCheckpointError(
      `Existing research checkpoint is not valid JSON: ${path}`,
    );
  }
  if (!isRecord(existing) || !isCheckpointEnvelope(existing))
    throw new ResearchCheckpointError(
      `Existing research checkpoint has an unrecognized format: ${path}`,
    );
  const parsed = checkpointEnvelopeSchema.safeParse(existing);
  if (!parsed.success)
    throw new ResearchCheckpointError(
      `Existing research checkpoint envelope is invalid: ${path}`,
    );
  const saved = parsed.data as ResearchCheckpoint<Row>;
  assertCheckpointMatches(saved, checkpoint, path);
  if (saved.contentHash !== contentHash)
    throw new ResearchCheckpointError(
      `Existing research checkpoint content hash differs: ${path}`,
    );
  return saved.contentHash;
}

/** Best-effort audit diagnostic. Emits only the filesystem error code and the
 * journal path, never the original message, which may contain input data. */
export function reportResearchJournalFailure(
  path: string,
  error: unknown,
): void {
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(
    `research journal append failed (${code ?? "unknown"}): ${path}\n`,
  );
}

/** Append-only attempt journal. The caller bounds attempts with the run
 * budget; no attempt row is rewritten or removed here. */
export async function appendResearchAttempt(
  path: string,
  record: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify(record);
  if (line === undefined)
    throw new Error("Research attempt is not JSON-serializable");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`);
}

/** Throws before work, during progress, after work and before commit.
 * Cancellation is cooperative: a synchronous engine call is not preempted. */
export function assertResearchRunActive(budget: ResearchRunBudget): void {
  validateResearchRunBudget(budget);
  const stop = (reason: ResearchRunAbortReason, detail: string): never => {
    budget.onAbort?.(reason);
    throw new ResearchRunAbortedError(reason, detail);
  };

  if (budget.signal?.aborted) {
    const reason = budget.signal.reason;
    stop(
      "cancelled",
      reason === undefined ? "abort signal received" : String(reason),
    );
  }
  if (budget.deadline !== undefined && Date.now() >= budget.deadline)
    stop(
      "deadline",
      `deadline ${new Date(budget.deadline).toISOString()} reached`,
    );
  if (budget.maxRssMiB !== undefined) {
    const peak = Math.max(
      process.memoryUsage().rss,
      process.resourceUsage().maxRSS * 1024,
    );
    if (peak > budget.maxRssMiB * 1024 ** 2)
      stop(
        "budget",
        `peak RSS ${(peak / 1024 ** 2).toFixed(1)}MiB exceeds ${budget.maxRssMiB}MiB`,
      );
  }
}

export function createResearchRunGuard(budget: ResearchRunBudget): () => void {
  return () => assertResearchRunActive(budget);
}

export function assertResearchIdentity(
  expected: string,
  current: string,
  message = "Research runtime/source identity changed during the run",
): void {
  if (expected !== current)
    throw new ResearchIdentityError(
      `${message}: expected ${expected}, current ${current}`,
    );
}

export type ResearchDependencyHash = {
  path: string;
  hash: string;
};

/** The complete execution dependency identity recorded by a run: the runner,
 * explicitly named definitions outside the package build, every executable
 * package artifact plus the app source closure, and the lockfile. */
export type ResearchExecutionIdentity = {
  runner: ResearchDependencyHash;
  definitions: ResearchDependencyHash[];
  artifacts: { roots: string[]; hash: string };
  lockfile: ResearchDependencyHash;
};

/** Conservative default: every package that a research CLI can import plus the
 * app source closure. A later import addition cannot silently escape the hash. */
export const defaultResearchArtifactRoots = [
  "packages/quant-backtest/dist",
  "packages/quant-performance/dist",
  "packages/quant-rps/dist",
  "packages/trading-strategies/dist",
  "packages/trading-strategy-core/dist",
  "packages/tstdx/dist",
  "src",
] as const;

function dependencyLabel(path: string): string {
  return path.replaceAll("\\", "/");
}

function dependencySource(path: string | URL): {
  label: string;
  source: string | URL;
} {
  return {
    label: dependencyLabel(
      typeof path === "string" ? path : fileURLToPath(path),
    ),
    source: path,
  };
}

async function hashDependency(
  path: string | URL,
): Promise<ResearchDependencyHash> {
  const { label, source } = dependencySource(path);
  return { path: label, hash: researchDigest(await readFile(source)) };
}

export async function researchArtifactIdentity(
  roots: readonly string[] = defaultResearchArtifactRoots,
): Promise<{ roots: string[]; hash: string }> {
  const hash = createHash("sha256");
  const labels: string[] = [];
  for (const folder of roots) {
    const label = dependencyLabel(folder);
    labels.push(label);
    for (const name of (await readdir(folder, { recursive: true }))
      .filter((name) => /\.(js|ts|tsx|json)$/.test(name))
      .sort()) {
      hash.update(`${label}/${dependencyLabel(name)}`);
      hash.update(await readFile(join(folder, name)));
    }
  }
  return { roots: labels, hash: hash.digest("hex") };
}

export async function researchExecutionIdentity(input: {
  runner: string | URL;
  definitions?: readonly (string | URL)[];
  artifactRoots?: readonly string[];
  lockfile?: string;
}): Promise<ResearchExecutionIdentity> {
  return {
    runner: await hashDependency(input.runner),
    definitions: await Promise.all(
      (input.definitions ?? []).map((definition) => hashDependency(definition)),
    ),
    artifacts: await researchArtifactIdentity(input.artifactRoots),
    lockfile: await hashDependency(input.lockfile ?? "pnpm-lock.yaml"),
  };
}

/** Recomputes every recorded dependency, including definitions outside the
 * build roots, before resuming or committing work. */
export async function assertResearchExecutionIdentity(
  recorded: ResearchExecutionIdentity,
  message = "Research execution dependencies changed during the run",
): Promise<void> {
  const current = await researchExecutionIdentity({
    runner: recorded.runner.path,
    definitions: recorded.definitions.map((definition) => definition.path),
    artifactRoots: recorded.artifacts.roots,
    lockfile: recorded.lockfile.path,
  });
  if (JSON.stringify(current) !== JSON.stringify(recorded))
    throw new ResearchIdentityError(
      `${message}: expected ${researchJsonHash(recorded)}, current ${researchJsonHash(current)}`,
    );
}

export type ResearchMatrixCell<Key = unknown> = {
  key: Key;
  checkpointPath: string;
};

/** A matrix row is either a computed result or the blocked placeholder written
 * when `blockedRow` handles an ordinary failure. Callers name this union so
 * `execute` and `blockedRow` cannot widen `Row` into each other. */
export type ResearchMatrixRow<Key, Completed extends object> =
  | (Key & Completed & { status: "completed" })
  | (Key & { status: "blocked"; reason: string });

export type ResearchMatrixOptions<Key, Row> = {
  identity: string;
  cells: Iterable<ResearchMatrixCell<Key>>;
  /** Computes one cell. Ordinary failures become blocked rows only when
   * `blockedRow` is supplied; cancellation and identity drift always stop. */
  execute: (cell: ResearchMatrixCell<Key>) => Promise<Row>;
  journalPath?: string;
  /** Validated cancellation/budget/identity hook. Read before resume, before
   * execution and before commit so stale work never starts or publishes. */
  beforeResume?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
  blockedRow?: (
    cell: ResearchMatrixCell<Key>,
    error: unknown,
  ) => Row | null | undefined;
  onRow?: (
    row: Row,
    cell: ResearchMatrixCell<Key>,
    origin: "restored" | "computed",
  ) => void | Promise<void>;
};

function researchStopError(error: unknown): boolean {
  return (
    error instanceof ResearchRunAbortedError ||
    error instanceof ResearchIdentityError
  );
}

function researchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared registration/restore/commit loop for research matrices. The caller
 * owns registration and result publication; this loop owns checkpoint resume,
 * attempt journaling and the pre-commit guard. */
export async function runResearchMatrix<Key, Row>(
  options: ResearchMatrixOptions<Key, Row>,
): Promise<Row[]> {
  const rows: Row[] = [];
  const journal = async (record: Record<string, unknown>) => {
    if (options.journalPath)
      await appendResearchAttempt(options.journalPath, record);
  };
  const journalStop = async (record: Record<string, unknown>) => {
    if (!options.journalPath) return;
    await appendResearchAttempt(options.journalPath, record).catch((error) =>
      reportResearchJournalFailure(options.journalPath!, error),
    );
  };

  for (const cell of options.cells) {
    const saved = await readResearchCheckpoint<Row>(cell.checkpointPath, {
      identity: options.identity,
      key: cell.key,
      beforeResume: options.beforeResume,
    });
    if (saved) {
      await journal({
        identity: options.identity,
        key: cell.key,
        event: "restored",
        contentHash: saved.contentHash,
      });
      rows.push(saved.row);
      await options.onRow?.(saved.row, cell, "restored");
      continue;
    }

    const attemptId = `${Date.now()}-${process.pid}`;
    await journal({
      identity: options.identity,
      key: cell.key,
      attemptId,
      event: "started",
    });

    let row: Row;
    let outcome: "completed" | "blocked" = "completed";
    try {
      await options.beforeResume?.();
      row = await options.execute(cell);
    } catch (error) {
      if (researchStopError(error)) {
        await journalStop({
          identity: options.identity,
          key: cell.key,
          attemptId,
          event: "aborted",
          reason: researchErrorMessage(error),
        });
        throw error;
      }
      const blocked = options.blockedRow?.(cell, error);
      if (blocked === null || blocked === undefined) {
        await journalStop({
          identity: options.identity,
          key: cell.key,
          attemptId,
          event: "failed",
          reason: researchErrorMessage(error),
        });
        throw error;
      }
      row = blocked;
      outcome = "blocked";
    }

    let contentHash: string;
    try {
      contentHash = await writeResearchCheckpoint(
        cell.checkpointPath,
        { identity: options.identity, key: cell.key, row },
        { beforeCommit: options.beforeCommit },
      );
    } catch (error) {
      await journalStop({
        identity: options.identity,
        key: cell.key,
        attemptId,
        event: researchStopError(error) ? "aborted" : "failed",
        reason: researchErrorMessage(error),
      });
      throw error;
    }

    await journal({
      identity: options.identity,
      key: cell.key,
      attemptId,
      event: outcome,
      contentHash,
    });
    rows.push(row);
    await options.onRow?.(row, cell, "computed");
  }
  await options.beforeCommit?.();
  return rows;
}

type ResearchRunLockOwner = {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
};

function researchProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that proves the owner is gone. EPERM and
    // unknown failures are treated as alive so a live owner is never stolen.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readResearchRunLock(
  lockPath: string,
): Promise<ResearchRunLockOwner | null> {
  let body: string;
  try {
    body = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = lockMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reclaims one observed stale lock. The token-scoped guard makes the
 * check-then-unlink sequence single-owner, so a concurrent reclaimer cannot
 * delete a fresh lock created by the winner.
 *
 * Limitation: if the reclaimer itself is interrupted, its token-scoped guard
 * remains and later attempts for that same stale lock stop with a diagnostic.
 * That conservative block is deliberate; there is no recursive lock system. */
async function reclaimStaleResearchRunLock(
  lockPath: string,
  observed: ResearchRunLockOwner,
): Promise<boolean> {
  const guardPath = `${lockPath}.reclaim-${observed.token}`;
  let guard: FileHandle;
  try {
    guard = await open(guardPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const current = await readResearchRunLock(lockPath);
    if (!current) return true;
    if (current.token !== observed.token || current.pid !== observed.pid)
      throw new Error(
        `Research run lock changed while reclaiming; inspect ${lockPath} before recovery`,
      );
    if (researchProcessAlive(current.pid))
      throw new Error(
        `Research run lock owner (pid ${current.pid}) is still alive; not stealing ${lockPath}`,
      );
    await unlink(lockPath);
    return true;
  } finally {
    await guard.close();
    await unlink(guardPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function acquireResearchRunLock(
  lockPath: string,
  owner: ResearchRunLockOwner,
): Promise<void> {
  const body = JSON.stringify(owner);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Publish the complete owner through the pending+link path. A crash can
    // leave an owned `.pending`, but never a truncated lock that a later run
    // would misread as a live owner.
    if (await publishJson(lockPath, body, true)) return;
    const current = await readResearchRunLock(lockPath);
    if (!current)
      throw new Error(
        `Research run lock is unrecognized; inspect ${lockPath} before recovery`,
      );
    if (current.host !== owner.host)
      throw new Error(
        `Research run lock belongs to host ${current.host}; inspect ${lockPath} before recovery`,
      );
    if (researchProcessAlive(current.pid))
      throw new Error(
        `Another research run process (pid ${current.pid}) is active; inspect ${lockPath}`,
      );
    if (!(await reclaimStaleResearchRunLock(lockPath, current)))
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Research run lock could not be acquired: ${lockPath}`);
}

async function releaseResearchRunLock(
  lockPath: string,
  token: string,
): Promise<void> {
  let body: string;
  try {
    body = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`Research run lock was replaced; not deleting ${lockPath}`);
  }
  if (!isRecord(value) || value.token !== token)
    throw new Error(
      `Research run lock ownership changed; not deleting ${lockPath}`,
    );
  await unlink(lockPath);
}

/**
 * Main-thread-only exclusive run lease. Worker threads share the host PID, so
 * a PID lease cannot distinguish them; workers must use the host job dedupe
 * and checkpoints instead of this lock.
 */
export async function withResearchRunLock<Result>(
  lockPath: string,
  run: () => Promise<Result>,
): Promise<Result> {
  if (!isMainThread)
    throw new Error(
      "Research run lock is main-thread only; workers must use host job dedupe and checkpoints",
    );
  const owner: ResearchRunLockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  await mkdir(dirname(lockPath), { recursive: true });
  await acquireResearchRunLock(lockPath, owner);
  try {
    return await run();
  } finally {
    await releaseResearchRunLock(lockPath, owner.token);
  }
}
