import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  buildSupermindRows,
  canonicalSupermindPayload,
  materializeSupermindRows,
  supermindCaptureId,
  supermindDatasets,
  supermindEnvelopeSchema,
  supermindFrozenRowSchema,
  type SupermindDataset,
  type SupermindEnvelope,
  type SupermindFrozenRow,
} from "~/lib/research/workflow/research-supermind-snapshot";

/**
 * Frozen SuperMind snapshot store.
 *
 * Layout (all of it outside git; see `.data/` in .gitignore):
 *
 *   <root>/index.json
 *   <root>/<dataset>/<captureId>/payload.jsonl
 *   <root>/<dataset>/<captureId>/envelope.json
 *
 * `payload.jsonl` is the canonical, sorted, de-duplicated frozen fact set.
 * `envelope.json` carries the capture stamp, the request that produced it and
 * the payload hash. The store is append-only: a capture id starts with its
 * capture stamp and ends with the payload hash prefix, so a re-capture after a
 * restatement lands beside the earlier one instead of overwriting it, and
 * nothing here is ever rewritten or deleted.
 *
 * The backtest reads `readSupermindSnapshot`; it never calls the cloud itself.
 */

export const supermindSnapshotRoot = () =>
  resolve(
    process.env.SUPERMIND_SNAPSHOT_DIR ??
      join(process.cwd(), ".data", "supermind-snapshots"),
  );

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const indexEntrySchema = supermindEnvelopeSchema
  .pick({ dataset: true, captureId: true, capturedAt: true })
  .extend({
    rowCount: z.number().int().nonnegative(),
    inputRowCount: z.number().int().nonnegative().optional(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    request: z.record(z.string(), z.unknown()),
  });
export type SupermindIndexEntry = z.infer<typeof indexEntrySchema>;

const indexSchema = z
  .object({
    version: z.literal(1),
    captures: z.array(indexEntrySchema),
  })
  .strict();

function readIndex(root: string) {
  const path = join(root, "index.json");
  if (!existsSync(path)) return { version: 1 as const, captures: [] };
  const parsed = indexSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new Error(
      `SuperMind 快照索引损坏：${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  return parsed.data;
}

function writeIndex(root: string, index: z.infer<typeof indexSchema>) {
  mkdirSync(root, { recursive: true });
  // Insertion order is preserved on purpose: it is the only ordering the store
  // can vouch for, and the reader takes the last entry as "most recent".
  writeFileSync(
    join(root, "index.json"),
    `${JSON.stringify({ version: 1, captures: index.captures }, null, 2)}\n`,
    "utf8",
  );
}

export function captureDirectory(
  dataset: SupermindDataset,
  captureId: string,
  root = supermindSnapshotRoot(),
) {
  // The capture id is generated from a timestamp and a hash, never from caller
  // text, so it cannot escape the dataset directory.
  if (!/^[0-9A-Za-z-]+$/.test(captureId))
    throw new Error(`快照标识非法：${captureId}`);
  return join(root, dataset, captureId);
}

export type FreezeSupermindInput = {
  dataset: SupermindDataset;
  /** Parsed JSON of the remote fetch result, in the dataset's raw shape. */
  raw: unknown;
  /** What was asked of the platform; recorded verbatim for auditing. */
  request: Record<string, unknown>;
  capturedAt: string;
  root?: string;
};

export type FreezeSupermindResult = {
  captureId: string;
  payloadHash: string;
  payloadPath: string;
  envelopePath: string;
  /** Frozen rows after canonical de-duplication. */
  rowCount: number;
  /** Raw records summed over the shards handed in; >= rowCount. */
  inputRowCount: number;
  payloadBytes: number;
  /** True when this exact payload was already frozen under another capture. */
  alreadyFrozen: boolean;
};

/**
 * Validate the raw platform response, map it to as-of rows, canonicalise, and
 * write the frozen capture. Content addressing makes re-freezing the same facts
 * idempotent: the payload file may already exist and must then be byte-equal.
 */
export function freezeSupermindSnapshot(
  input: FreezeSupermindInput,
): FreezeSupermindResult {
  const root = input.root ?? supermindSnapshotRoot();
  const rows = buildSupermindRows(input.dataset, input.raw);
  const payload = canonicalSupermindPayload(rows);
  // De-duplication happens inside canonicalisation, so the persisted row count
  // must be read back from the payload: recording the pre-de-duplication count
  // would make a later `readSupermindSnapshot` reject a healthy snapshot as
  // "行数与信封不符" as soon as any two shards overlapped.
  const frozenRowCount = payload
    ? payload.split("\n").filter(Boolean).length
    : 0;
  const payloadHash = sha256(payload);
  const captureId = supermindCaptureId(input.capturedAt, payloadHash);
  const directory = captureDirectory(input.dataset, captureId, root);
  mkdirSync(directory, { recursive: true });

  const payloadPath = join(directory, "payload.jsonl");
  const existing = existsSync(payloadPath)
    ? readFileSync(payloadPath, "utf8")
    : undefined;
  if (existing !== undefined && existing !== payload)
    throw new Error(
      `${input.dataset}/${captureId} 已存在且字节不同；内容寻址的快照不得被覆盖`,
    );
  if (existing === undefined) writeFileSync(payloadPath, payload, "utf8");
  const alreadyFrozen = existing !== undefined;

  const envelope: SupermindEnvelope = {
    version: 1,
    dataset: input.dataset,
    captureId,
    capturedAt: input.capturedAt,
    request: input.request,
    rowCount: frozenRowCount,
    inputRowCount: rows.length,
    payloadHash,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
  };
  writeFileSync(
    join(directory, "envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8",
  );

  const index = readIndex(root);
  if (!index.captures.some((entry) => entry.captureId === captureId))
    index.captures.push({
      dataset: envelope.dataset,
      captureId,
      capturedAt: envelope.capturedAt,
      rowCount: envelope.rowCount,
      inputRowCount: envelope.inputRowCount,
      payloadHash: envelope.payloadHash,
      request: envelope.request,
    });
  writeIndex(root, index);

  return {
    captureId,
    payloadHash,
    payloadPath,
    envelopePath: join(directory, "envelope.json"),
    rowCount: frozenRowCount,
    inputRowCount: rows.length,
    payloadBytes: envelope.payloadBytes,
    alreadyFrozen,
  };
}

/**
 * Captures in WRITE order, oldest first, so the last entry is the most
 * recently frozen one.
 *
 * Deliberately NOT sorted by `capturedAt`. That field is a label the caller
 * supplies, and an early capture was labelled with a wall-clock time later
 * than a capture written after it, which made "latest" pick the wrong one. The
 * order used here is the envelope file's own modification time — a fact the
 * filesystem recorded, not an assertion anyone can type in.
 */
export function listSupermindCaptures(
  dataset?: SupermindDataset,
  root = supermindSnapshotRoot(),
) {
  return readIndex(root)
    .captures.filter((entry) => !dataset || entry.dataset === dataset)
    .map((entry, index) => {
      let writtenAt = index;
      try {
        writtenAt = statSync(
          join(
            captureDirectory(entry.dataset, entry.captureId, root),
            "envelope.json",
          ),
        ).mtimeMs;
      } catch {
        // A catalogue entry without its envelope is reported by `verify`.
      }
      return { entry, writtenAt, index };
    })
    .sort((a, b) => a.writtenAt - b.writtenAt || a.index - b.index)
    .map((row) => row.entry);
}

export type ReadSupermindResult = {
  envelope: SupermindEnvelope;
  payloadHash: string;
  /** Rows exactly as frozen, without the capture stamp. */
  rows: SupermindFrozenRow[];
  /** The same rows with `capturedAt` attached: valid as-of observations. */
  observations: ReturnType<typeof materializeSupermindRows>;
};

/**
 * Read a frozen capture. Without `captureId` the most recently WRITTEN one
 * wins; every value keeps the provenance it was frozen with.
 */
export function readSupermindSnapshot(options: {
  dataset: SupermindDataset;
  captureId?: string;
  root?: string;
}): ReadSupermindResult {
  const root = options.root ?? supermindSnapshotRoot();
  const captures = listSupermindCaptures(options.dataset, root);
  const selected = options.captureId
    ? captures.find((entry) => entry.captureId === options.captureId)
    : captures.at(-1);
  if (!selected)
    throw new Error(
      options.captureId
        ? `未找到快照 ${options.dataset}/${options.captureId}`
        : `${options.dataset} 尚无冻结快照；先运行取数并冻结，回测不得实时拉取`,
    );
  const directory = captureDirectory(options.dataset, selected.captureId, root);
  const envelope = supermindEnvelopeSchema.parse(
    JSON.parse(readFileSync(join(directory, "envelope.json"), "utf8")),
  );
  const payload = readFileSync(join(directory, "payload.jsonl"), "utf8");
  const payloadHash = sha256(payload);
  if (payloadHash !== envelope.payloadHash)
    throw new Error(
      `${options.dataset}/${selected.captureId} 载荷与信封哈希不一致；快照已损坏`,
    );
  const rows = payload.length
    ? payload
        .split("\n")
        .filter(Boolean)
        .map((line) => supermindFrozenRowSchema.parse(JSON.parse(line)))
    : [];
  if (rows.length !== envelope.rowCount)
    throw new Error(
      `${options.dataset}/${selected.captureId} 行数与信封不符：${rows.length} != ${envelope.rowCount}`,
    );
  return {
    envelope,
    payloadHash,
    rows,
    observations: materializeSupermindRows(rows, envelope.capturedAt),
  };
}

/** Recompute every capture's payload hash from disk. */
export function verifySupermindSnapshots(root = supermindSnapshotRoot()) {
  const captures = listSupermindCaptures(undefined, root);
  const broken: string[] = [];
  for (const entry of captures) {
    const directory = captureDirectory(entry.dataset, entry.captureId, root);
    const payloadPath = join(directory, "payload.jsonl");
    const envelopePath = join(directory, "envelope.json");
    if (!existsSync(payloadPath) || !existsSync(envelopePath)) {
      broken.push(`${entry.captureId}: 缺少载荷或信封`);
      continue;
    }
    const payload = readFileSync(payloadPath, "utf8");
    const hash = sha256(payload);
    if (hash !== entry.payloadHash) {
      broken.push(`${entry.captureId}: 载荷哈希不符`);
      continue;
    }
    const lines = payload.split("\n").filter(Boolean);
    if (lines.length !== entry.rowCount) {
      broken.push(`${entry.captureId}: 行数不符`);
      continue;
    }
    for (const line of lines) {
      if (!supermindFrozenRowSchema.safeParse(JSON.parse(line)).success) {
        broken.push(`${entry.captureId}: 存在不符合 as-of 契约的行`);
        break;
      }
    }
  }
  return {
    root,
    datasets: supermindDatasets,
    captures: captures.length,
    broken,
  };
}

/** Files directly under `dataset/`, used by the CLI to report what exists. */
export function captureIds(
  dataset: SupermindDataset,
  root = supermindSnapshotRoot(),
) {
  const path = join(root, dataset);
  return existsSync(path) ? readdirSync(path).sort() : [];
}
