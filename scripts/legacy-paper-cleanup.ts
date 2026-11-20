/**
 * Retired hardcoded paper accounts (r2a-*) cleanup CLI.
 *
 * Default mode is a strictly read-only inspection. Purge requires an explicit
 * --apply purge plus the manifest hash printed by that inspection and a fresh
 * SQLite backup. Real brokerage rows are checksummed before and after; the
 * whole purge runs inside one BEGIN IMMEDIATE transaction.
 *
 * Usage:
 *   tsx scripts/legacy-paper-cleanup.ts --db <absolute-path> [--dry-run]
 *   tsx scripts/legacy-paper-cleanup.ts --db <absolute-path> --apply purge \
 *     --manifest-hash <sha256> --backup <absolute-path>
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import frozenJson from "../src/server/data/paper-candidates.json";

export const MANIFEST_SCHEMA = "legacy-paper-cleanup-2";
export const RECEIPT_SCHEMA = "legacy-paper-cleanup-receipt-1";
export const RECEIPT_KIND = "paper-cleanup-receipt";

type StrategyRef = { id: string; version: number };
type CandidateRefs = { id: string; candidates: StrategyRef[] };
type ProtectedChecksum = { rows: number; sha256: string };
type ProtectedChecksums = {
  import_batches: ProtectedChecksum;
  trade_fills: ProtectedChecksum;
  cash_flows: ProtectedChecksum;
  trade_ledger: ProtectedChecksum;
};

export type LegacyCleanupManifest = {
  schema: typeof MANIFEST_SCHEMA;
  database: { path: string; userVersion: number; schemaHash: string };
  legacyStrategies: StrategyRef[];
  accounts: (CandidateRefs & {
    market: string;
    sleeve: string;
    /** paper_accounts 行内容（id,market,sleeve,started_at,revision,payload）。 */
    accountSha256: string;
    stateRows: number;
    stateSha256: string;
    factRows: number;
    factSha256: string;
  })[];
  excluded: {
    mixed: CandidateRefs[];
    custom: CandidateRefs[];
    unreadable: { id: string }[];
  };
  reservations: {
    id: string;
    accountId: string;
    action: "release" | "retain";
  }[];
  totals: { accounts: number; stateRows: number; factRows: number };
  protected: ProtectedChecksums;
};

export type LegacyCleanupReport = {
  ok: true;
  mode: "dry-run";
  database: string;
  manifestHash: string;
  manifest: LegacyCleanupManifest;
  instructions: {
    apply: string;
    note: string;
  };
};

export type ApplyPurgeOptions = {
  dbPath: string;
  manifestHash: string;
  backupPath: string;
  now?: number;
};

export type PurgeResult = {
  ok: true;
  mode: "apply";
  manifestHash: string;
  database: string;
  backup: { path: string; sha256: string; integrity: "ok" };
  removed: {
    accountIds: string[];
    accounts: number;
    stateRows: number;
    factRows: number;
  };
  protected: { before: ProtectedChecksums; after: ProtectedChecksums };
  reservations: { released: string[]; retained: string[] };
  receipt: { store: "paper_cleanup_receipts" | "records"; id: string };
};

export class LegacyPaperCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyPaperCleanupError";
  }
}

type CliArgs =
  | { mode: "help" }
  | {
      mode: "dry-run";
      dbPath: string;
    }
  | {
      mode: "apply";
      dbPath: string;
      manifestHash: string;
      backupPath: string;
    };

const protectedTables = [
  {
    table: "import_batches",
    columns: [
      "id",
      "account",
      "source",
      "file_hash",
      "file_name",
      "imported_at",
      "payload",
    ],
    orderBy: "id",
  },
  {
    table: "trade_fills",
    columns: [
      "id",
      "account",
      "symbol",
      "code",
      "trade_date",
      "batch_id",
      "payload",
    ],
    orderBy: "id",
  },
  {
    table: "cash_flows",
    columns: ["id", "account", "flow_date", "batch_id", "payload"],
    orderBy: "id",
  },
  {
    table: "trade_ledger",
    columns: ["id", "symbol", "trade_date", "payload"],
    orderBy: "id",
  },
] as const;

const legacyStrategies: StrategyRef[] = (
  frozenJson as {
    candidates: { strategy: { id: string; version: number } }[];
  }
).candidates
  .map((candidate) => ({
    id: candidate.strategy.id,
    version: candidate.strategy.version,
  }))
  .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);

const legacyKeys = new Set(legacyStrategies.map(pairKey));

function pairKey(ref: StrategyRef) {
  return `${ref.id}@v${ref.version}`;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new LegacyPaperCleanupError(message);
}

function tableExists(db: Database.Database, table: string) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}

function databasePath(raw: string) {
  if (!isAbsolute(raw)) fail("--db 必须是绝对路径");
  if (!existsSync(raw)) fail(`数据库文件不存在：${raw}`);
  if (!statSync(raw).isFile()) fail(`--db 不是文件：${raw}`);
  return resolve(raw);
}

function openReadonly(dbPath: string) {
  // NEVER use sqlite(): it opens the default production database, enables WAL
  // and runs migrations. Inspection must be read-only and migration-free.
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function checksumRows(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  orderBy: string,
  where?: { clause: string; params: unknown[] },
): ProtectedChecksum {
  if (!tableExists(db, table))
    fail(`表 ${table} 不存在；请确认数据库版本，拒绝继续`);
  const filter = where ? ` WHERE ${where.clause}` : "";
  const rows = db
    .prepare(
      `SELECT ${columns.join(",")} FROM ${table}${filter} ORDER BY ${orderBy}`,
    )
    .all(...(where?.params ?? [])) as Record<string, unknown>[];
  const canonical = rows
    .map((row) => JSON.stringify(columns.map((column) => row[column] ?? null)))
    .join("\n");
  return {
    rows: rows.length,
    sha256: sha256(`${table}\n${rows.length}\n${canonical}`),
  };
}

function checksumTable(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  orderBy: string,
): ProtectedChecksum {
  return checksumRows(db, table, columns, orderBy);
}

function protectedChecksums(db: Database.Database): ProtectedChecksums {
  const result = {} as ProtectedChecksums;
  for (const spec of protectedTables) {
    result[spec.table] = checksumTable(
      db,
      spec.table,
      spec.columns,
      spec.orderBy,
    );
  }
  return result;
}

function hasUnknownMirrorIntent(db: Database.Database, accountId: string) {
  const rows = db
    .prepare(
      "SELECT payload FROM paper_facts WHERE account_id=? AND kind='mirror'",
    )
    .all(accountId) as { payload: string }[];
  return rows.some((row) => {
    try {
      const value = JSON.parse(row.payload) as { phase?: unknown };
      return value?.phase === "attempted" || value?.phase === "unknown";
    } catch {
      // Unparseable evidence is unknown intent: never release the reservation.
      return true;
    }
  });
}

function strategyRef(value: unknown): StrategyRef {
  const strategy = (
    value as { strategy?: { id?: unknown; version?: unknown } } | undefined
  )?.strategy;
  return {
    id: typeof strategy?.id === "string" ? strategy.id : "",
    version:
      typeof strategy?.version === "number" && Number.isFinite(strategy.version)
        ? strategy.version
        : -1,
  };
}

function sortedRefs(refs: StrategyRef[]) {
  return [...refs].sort(
    (a, b) => a.id.localeCompare(b.id) || a.version - b.version,
  );
}

export function legacyStrategyIds() {
  return legacyStrategies.map((ref) => `${ref.id}@v${ref.version}`);
}

/** Build the exact manifest from an already-open connection. */
export function buildLegacyCleanupManifest(
  db: Database.Database,
  dbPath: string,
): LegacyCleanupManifest {
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  const schemaRows = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
  const schemaHash = sha256(JSON.stringify(schemaRows));

  const rows = db
    .prepare("SELECT id,market,sleeve,payload FROM paper_accounts ORDER BY id")
    .all() as {
    id: string;
    market: string;
    sleeve: string;
    payload: string;
  }[];

  const accounts: LegacyCleanupManifest["accounts"] = [];
  const mixed: CandidateRefs[] = [];
  const custom: CandidateRefs[] = [];
  const unreadable: { id: string }[] = [];

  for (const row of rows) {
    let payload: { candidates?: unknown };
    try {
      payload = JSON.parse(row.payload) as { candidates?: unknown };
    } catch {
      unreadable.push({ id: row.id });
      continue;
    }
    const raw = Array.isArray(payload.candidates) ? payload.candidates : [];
    const refs = sortedRefs(raw.map(strategyRef));
    const known = refs.filter((ref) => legacyKeys.has(pairKey(ref)));
    // Frozen strategy reuse alone does not prove legacy account provenance:
    // require exact registrar-generated `paper:` id format (per-candidate or market:sleeve,
    // optionally with `:from:<epoch>` suffix), excluding arbitrary `paper:custom` ids.
    const baseId = row.id.replace(/:from:\d+$/, "");
    const allowedIds = new Set<string>([
      `paper:${row.market}:${row.sleeve}`,
      ...(refs.length === 1
        ? [`paper:${refs[0]!.id}:v${refs[0]!.version}`]
        : []),
    ]);
    const standardId = allowedIds.has(baseId);
    if (refs.length === 0 || known.length === 0) {
      custom.push({ id: row.id, candidates: refs });
      continue;
    }
    if (known.length !== refs.length) {
      // Mixed legacy + unknown candidates are never deleted automatically.
      mixed.push({ id: row.id, candidates: refs });
      continue;
    }
    if (!standardId) {
      custom.push({ id: row.id, candidates: refs });
      continue;
    }
    // Hash the actual contents, not just row counts: a same-count update after
    // the dry-run (or after the backup) must change the manifest hash.
    const account = checksumRows(
      db,
      "paper_accounts",
      ["id", "market", "sleeve", "started_at", "revision", "payload"],
      "id",
      { clause: "id=?", params: [row.id] },
    );
    const state = checksumRows(
      db,
      "paper_state",
      ["account_id", "payload"],
      "account_id",
      { clause: "account_id=?", params: [row.id] },
    );
    const facts = checksumRows(
      db,
      "paper_facts",
      ["account_id", "kind", "id", "date", "payload"],
      "account_id,kind,id",
      { clause: "account_id=?", params: [row.id] },
    );
    accounts.push({
      id: row.id,
      market: row.market,
      sleeve: row.sleeve,
      candidates: refs,
      accountSha256: account.sha256,
      stateRows: state.rows,
      stateSha256: state.sha256,
      factRows: facts.rows,
      factSha256: facts.sha256,
    });
  }

  const targetIds = new Set(accounts.map((account) => account.id));
  const reservationRows = db
    .prepare(
      "SELECT id,payload FROM records WHERE kind='paper-mirror-reservation' ORDER BY id",
    )
    .all() as { id: string; payload: string }[];
  const reservations: LegacyCleanupManifest["reservations"] = [];
  for (const row of reservationRows) {
    let value: unknown;
    try {
      value = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (typeof value !== "string" || !targetIds.has(value)) continue;
    reservations.push({
      id: row.id,
      accountId: value,
      action: hasUnknownMirrorIntent(db, value) ? "retain" : "release",
    });
  }

  const totals = {
    accounts: accounts.length,
    stateRows: accounts.reduce((sum, account) => sum + account.stateRows, 0),
    factRows: accounts.reduce((sum, account) => sum + account.factRows, 0),
  };

  return {
    schema: MANIFEST_SCHEMA,
    database: { path: dbPath, userVersion, schemaHash },
    legacyStrategies,
    accounts,
    excluded: {
      mixed: mixed.sort((a, b) => a.id.localeCompare(b.id)),
      custom: custom.sort((a, b) => a.id.localeCompare(b.id)),
      unreadable: unreadable.sort((a, b) => a.id.localeCompare(b.id)),
    },
    reservations,
    totals,
    protected: protectedChecksums(db),
  };
}

export function legacyCleanupManifestHash(manifest: LegacyCleanupManifest) {
  return sha256(JSON.stringify(manifest));
}

/** Read-only preview. Opens SQLite with readonly+fileMustExist, never migrates. */
export function inspectLegacyPaper(rawPath: string): LegacyCleanupReport {
  const dbPath = databasePath(rawPath);
  const db = openReadonly(dbPath);
  try {
    const manifest = buildLegacyCleanupManifest(db, dbPath);
    const manifestHash = legacyCleanupManifestHash(manifest);
    return {
      ok: true,
      mode: "dry-run",
      database: dbPath,
      manifestHash,
      manifest,
      instructions: {
        apply: `tsx scripts/legacy-paper-cleanup.ts --db "${dbPath}" --apply purge --manifest-hash ${manifestHash} --backup "<absolute-backup-path>"`,
        note: "请先关闭工作台并核对上方账户与受保护真实账本行数；--apply purge 会在一个 BEGIN IMMEDIATE 事务内重算清单并严格比对哈希。",
      },
    };
  } finally {
    db.close();
  }
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function verifyBackup(backupPath: string, expected: LegacyCleanupManifest) {
  const db = openReadonly(backupPath);
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      fail(`备份文件完整性校验失败：${String(integrity)}`);
    const manifest = buildLegacyCleanupManifest(db, backupPath);
    if (!isDeepStrictEqual(manifest.accounts, expected.accounts))
      fail("备份中的目标账户与清单不一致，拒绝清理");
    if (!isDeepStrictEqual(manifest.totals, expected.totals))
      fail("备份中的目标账户行数与清单不一致，拒绝清理");
    if (!isDeepStrictEqual(manifest.protected, expected.protected))
      fail("备份中的受保护真实账本校验和与清单不一致，拒绝清理");
  } finally {
    db.close();
  }
}

type Receipt = {
  schema: typeof RECEIPT_SCHEMA;
  manifestHash: string;
  appliedAt: number;
  database: {
    path: string;
    userVersion: number;
    schemaHash: string;
  };
  backup: { path: string; sha256: string; integrity: "ok" };
  removed: PurgeResult["removed"];
  protected: PurgeResult["protected"];
  reservations: PurgeResult["reservations"];
  excluded: LegacyCleanupManifest["excluded"];
};

function writeReceipt(
  db: Database.Database,
  receipt: Receipt,
  manifest: LegacyCleanupManifest,
  manifestHash: string,
): PurgeResult["receipt"] {
  if (tableExists(db, "paper_cleanup_receipts")) {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(paper_cleanup_receipts)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    // v21 schema: (manifest_hash, action, applied_at, manifest_json,
    // result_json, backup_hash). Keep the generic column intersection for
    // older/experimental shapes, but only when every required field exists.
    if (
      columns.has("manifest_hash") &&
      columns.has("action") &&
      columns.has("applied_at") &&
      columns.has("manifest_json") &&
      columns.has("result_json")
    ) {
      db.prepare(
        `INSERT INTO paper_cleanup_receipts
           (manifest_hash,action,applied_at,manifest_json,result_json,backup_hash)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(manifest_hash,action) DO UPDATE SET
           applied_at=excluded.applied_at,manifest_json=excluded.manifest_json,
           result_json=excluded.result_json,backup_hash=excluded.backup_hash`,
      ).run(
        manifestHash,
        "purge",
        receipt.appliedAt,
        JSON.stringify(manifest),
        JSON.stringify(receipt),
        receipt.backup.sha256,
      );
      return {
        store: "paper_cleanup_receipts",
        id: `${manifestHash}:purge`,
      };
    }
  }
  const id = `${RECEIPT_KIND}-${manifestHash}`;
  db.prepare(
    `INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at`,
  ).run(id, RECEIPT_KIND, JSON.stringify(receipt), receipt.appliedAt);
  return { store: "records", id };
}

/**
 * Purge the exact legacy r2a-* paper accounts inside one immediate transaction.
 * The live manifest must still hash to `manifestHash` or nothing is deleted.
 */
export async function applyLegacyPaperPurge(
  options: ApplyPurgeOptions,
): Promise<PurgeResult> {
  const dbPath = databasePath(options.dbPath);
  if (
    typeof options.manifestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(options.manifestHash)
  )
    fail("--apply purge 必须提供 64 位小写十六进制 --manifest-hash");
  if (!options.backupPath || !isAbsolute(options.backupPath))
    fail("--backup 必须是绝对路径");
  const backupPath = resolve(options.backupPath);
  if (backupPath === dbPath) fail("--backup 不能与 --db 相同");
  if (existsSync(backupPath)) fail(`备份文件已存在，拒绝覆盖：${backupPath}`);
  const parent = dirname(backupPath);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    fail(`备份目录不存在：${parent}`);

  // Pre-check before creating a backup so an obviously stale hash leaves no files.
  const preview = inspectLegacyPaper(dbPath);
  if (preview.manifest.totals.accounts === 0)
    fail("没有找到可清理的历史 r2a-* 模拟账户；拒绝执行");
  if (preview.manifestHash !== options.manifestHash)
    fail(
      `清单哈希不匹配：期望 ${options.manifestHash}，实时 ${preview.manifestHash}。请重新运行 --dry-run 核对。`,
    );

  const live = new Database(dbPath);
  live.pragma("foreign_keys = ON");
  live.pragma("busy_timeout = 5000");
  try {
    await live.backup(backupPath);
    const backupSha = await hashFile(backupPath);
    verifyBackup(backupPath, preview.manifest);

    const now = options.now ?? Date.now();
    const committed = live
      .transaction(() => {
        const current = buildLegacyCleanupManifest(live, dbPath);
        const currentHash = legacyCleanupManifestHash(current);
        if (currentHash !== options.manifestHash)
          fail(
            `实时清单在备份后发生漂移：期望 ${options.manifestHash}，实时 ${currentHash}。事务已回滚。`,
          );
        if (current.totals.accounts === 0)
          fail("没有可清理的历史 r2a-* 模拟账户；事务已回滚");

        const accountIds = current.accounts.map((account) => account.id);
        const placeholders = accountIds.map(() => "?").join(",");
        const factChanges = live
          .prepare(
            `DELETE FROM paper_facts WHERE account_id IN (${placeholders})`,
          )
          .run(...accountIds).changes;
        if (factChanges !== current.totals.factRows)
          fail("paper_facts 删除行数与清单不一致；事务已回滚");
        const stateChanges = live
          .prepare(
            `DELETE FROM paper_state WHERE account_id IN (${placeholders})`,
          )
          .run(...accountIds).changes;
        if (stateChanges !== current.totals.stateRows)
          fail("paper_state 删除行数与清单不一致；事务已回滚");
        const accountChanges = live
          .prepare(`DELETE FROM paper_accounts WHERE id IN (${placeholders})`)
          .run(...accountIds).changes;
        if (accountChanges !== accountIds.length)
          fail("paper_accounts 删除行数与清单不一致；事务已回滚");

        const released: string[] = [];
        const retained: string[] = [];
        for (const reservation of current.reservations) {
          if (reservation.action === "retain") {
            retained.push(reservation.id);
            continue;
          }
          const row = live
            .prepare(
              "SELECT payload FROM records WHERE id=? AND kind='paper-mirror-reservation'",
            )
            .get(reservation.id) as { payload: string } | undefined;
          if (!row) fail(`镜像预留 ${reservation.id} 与清单不一致；事务已回滚`);
          let value: unknown;
          try {
            value = JSON.parse(row.payload);
          } catch {
            fail(`镜像预留 ${reservation.id} 内容不可解析；事务已回滚`);
          }
          if (value !== reservation.accountId)
            fail(`镜像预留 ${reservation.id} 与清单不一致；事务已回滚`);
          live.prepare("DELETE FROM records WHERE id=?").run(reservation.id);
          released.push(reservation.id);
        }

        const afterProtected = protectedChecksums(live);
        if (!isDeepStrictEqual(afterProtected, current.protected))
          fail("受保护真实数据校验和在清理中发生变化；事务已回滚");

        const removed = {
          accountIds,
          accounts: accountIds.length,
          stateRows: current.totals.stateRows,
          factRows: current.totals.factRows,
        };
        const receipt: Receipt = {
          schema: RECEIPT_SCHEMA,
          manifestHash: currentHash,
          appliedAt: now,
          database: {
            path: dbPath,
            userVersion: current.database.userVersion,
            schemaHash: current.database.schemaHash,
          },
          backup: { path: backupPath, sha256: backupSha, integrity: "ok" },
          removed,
          protected: {
            before: current.protected,
            after: afterProtected,
          },
          reservations: { released, retained },
          excluded: current.excluded,
        };
        const written = writeReceipt(live, receipt, current, currentHash);
        return { current, removed, receipt, released, retained, written };
      })
      .immediate();

    return {
      ok: true,
      mode: "apply",
      manifestHash: options.manifestHash,
      database: dbPath,
      backup: { path: backupPath, sha256: backupSha, integrity: "ok" },
      removed: committed.removed,
      protected: committed.receipt.protected,
      reservations: {
        released: committed.released,
        retained: committed.retained,
      },
      receipt: committed.written,
    };
  } finally {
    live.close();
  }
}

function takeValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${flag} 缺少参数值`);
  return value;
}

export function parseCleanupArgs(argv: string[]): CliArgs {
  let db: string | undefined;
  let dryRun = false;
  let apply = false;
  let manifestHash: string | undefined;
  let backup: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--db") {
      db = takeValue(argv, ++index, "--db");
      continue;
    }
    if (arg.startsWith("--db=")) {
      db = arg.slice("--db=".length);
      continue;
    }
    if (arg === "--apply") {
      const value = takeValue(argv, ++index, "--apply");
      if (value !== "purge") fail("--apply 仅支持 purge");
      apply = true;
      continue;
    }
    if (arg.startsWith("--apply=")) {
      const value = arg.slice("--apply=".length);
      if (value !== "purge") fail("--apply 仅支持 purge");
      apply = true;
      continue;
    }
    if (arg === "--manifest-hash") {
      manifestHash = takeValue(argv, ++index, "--manifest-hash");
      continue;
    }
    if (arg.startsWith("--manifest-hash=")) {
      manifestHash = arg.slice("--manifest-hash=".length);
      continue;
    }
    if (arg === "--backup") {
      backup = takeValue(argv, ++index, "--backup");
      continue;
    }
    if (arg.startsWith("--backup=")) {
      backup = arg.slice("--backup=".length);
      continue;
    }
    fail(`未知参数：${arg}`);
  }

  if (!db) fail("必须提供 --db <绝对路径>");
  if (dryRun && apply) fail("--dry-run 与 --apply purge 不能同时使用");
  if (!apply) {
    if (manifestHash || backup)
      fail("--manifest-hash 与 --backup 仅用于 --apply purge");
    return { mode: "dry-run", dbPath: databasePath(db) };
  }
  if (!manifestHash) fail("--apply purge 必须提供 --manifest-hash");
  if (!/^[a-f0-9]{64}$/.test(manifestHash))
    fail("--manifest-hash 必须是 64 位小写十六进制 SHA-256");
  if (!backup) fail("--apply purge 必须提供 --backup <绝对路径>");
  if (!isAbsolute(backup)) fail("--backup 必须是绝对路径");
  return {
    mode: "apply",
    dbPath: databasePath(db),
    manifestHash,
    backupPath: resolve(backup),
  };
}

export const usage = `用法：
  tsx scripts/legacy-paper-cleanup.ts --db <绝对路径> [--dry-run]
  tsx scripts/legacy-paper-cleanup.ts --db <绝对路径> --apply purge \\
    --manifest-hash <sha256> --backup <绝对备份路径>

默认且安全的模式是 --dry-run：只读打开数据库，不迁移、不写 WAL。
--apply purge 会先创建并校验 SQLite 备份，然后在一个 BEGIN IMMEDIATE
事务内重算清单、严格比对哈希，并删除精确的历史 r2a-* 模拟账户。`;

async function main(argv: string[]) {
  try {
    const args = parseCleanupArgs(argv);
    if (args.mode === "help") {
      console.log(usage);
      return;
    }
    if (args.mode === "dry-run") {
      console.log(JSON.stringify(inspectLegacyPaper(args.dbPath), null, 2));
      return;
    }
    const result = await applyLegacyPaperPurge(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
  void main(process.argv.slice(2));
