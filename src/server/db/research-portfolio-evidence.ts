import type Database from "better-sqlite3";
import { researchJsonHash } from "../research/research-run";
import { sqlite } from "./index";
import { NotificationPolicyStore } from "./notification-policy-store";
import type {
  TenPositionCheckpointKey,
  TenPositionCheckpointRow,
  TenPositionRegistration,
  TenPositionRegistrationVersion,
} from "~/lib/research/lab-portfolio-evidence";

export const researchPortfolioRegistrationKind =
  "research-portfolio-registration";
export const researchPortfolioRegistrationSummaryKind =
  "research-portfolio-registration-summary";
export const researchPortfolioCheckpointKind = "research-portfolio-checkpoint";
export const researchPortfolioCheckpointIndexKind =
  "research-portfolio-checkpoint-index";

export type ResearchPortfolioRegistrationRecord = {
  identity: string;
  registration: TenPositionRegistration;
  importedAt: number;
  filename: string;
  byteLength: number;
};

export type ResearchPortfolioRegistrationSummary = {
  identity: string;
  version: TenPositionRegistrationVersion;
  account: { maxPositions: 10; targetWeight: 0.1 };
  markets: ("cn-equity" | "crypto")[];
  windows: { label: string; start: string; end: string }[];
  scenarios: string[];
  includeBaseline: boolean;
  candidateCount: number;
  expectedCheckpoints: number;
  importedAt: number;
  filename: string;
  byteLength: number;
};

export type ResearchPortfolioCheckpointRecord = {
  identity: string;
  key: TenPositionCheckpointKey;
  row: TenPositionCheckpointRow;
  contentHash: string;
  importedAt: number;
  filename: string;
  byteLength: number;
};

export type ResearchPortfolioCheckpointIndex = {
  identity: string;
  key: TenPositionCheckpointKey;
  keyHash: string;
  contentHash: string;
  status: "completed" | "blocked";
  reason: string | null;
  importedAt: number;
  filename: string;
  byteLength: number;
  evidenceId: string;
};

export type ResearchPortfolioCheckpointCounts = {
  total: number;
  completed: number;
  blocked: number;
};

const registrationId = (identity: string) =>
  `research-portfolio:registration:${identity}`;
const registrationSummaryId = (identity: string) =>
  `research-portfolio:registration-summary:${identity}`;
const checkpointKeyHash = (key: TenPositionCheckpointKey) =>
  researchJsonHash(key);
const checkpointId = (identity: string, key: TenPositionCheckpointKey) =>
  `research-portfolio:checkpoint:${identity}:${checkpointKeyHash(key)}`;
const checkpointIndexId = (identity: string, key: TenPositionCheckpointKey) =>
  `research-portfolio:checkpoint-index:${identity}:${checkpointKeyHash(key)}`;

function registrationSummaryOf(
  record: ResearchPortfolioRegistrationRecord,
): ResearchPortfolioRegistrationSummary {
  const { registration } = record;
  const candidateCount =
    registration.candidates.length + (registration.includeBaseline ? 1 : 0);
  return {
    identity: record.identity,
    version: registration.version,
    account: registration.account,
    markets: [...registration.markets],
    windows: registration.windows.map((window) => ({ ...window })),
    scenarios: [...registration.scenarios],
    includeBaseline: registration.includeBaseline,
    candidateCount,
    expectedCheckpoints:
      candidateCount *
      registration.markets.length *
      registration.windows.length *
      registration.scenarios.length,
    importedAt: record.importedAt,
    filename: record.filename,
    byteLength: record.byteLength,
  };
}

function checkpointIndexOf(
  record: ResearchPortfolioCheckpointRecord,
): ResearchPortfolioCheckpointIndex {
  return {
    identity: record.identity,
    key: { ...record.key },
    keyHash: checkpointKeyHash(record.key),
    contentHash: record.contentHash,
    status: record.row.status,
    reason: record.row.status === "blocked" ? record.row.reason : null,
    importedAt: record.importedAt,
    filename: record.filename,
    byteLength: record.byteLength,
    evidenceId: checkpointId(record.identity, record.key),
  };
}

/** Evidence storage reuses the existing `records` key/value table: the full
 * registration/checkpoint stays immutable, while small derived summaries and
 * indexes keep list/detail reads from parsing large rows. No migration. */
export class ResearchPortfolioEvidenceRepository {
  private readonly store: NotificationPolicyStore;

  constructor(readonly db: Database.Database = sqlite()) {
    this.store = new NotificationPolicyStore(db);
  }

  atomic<T>(action: () => T): T {
    return this.db.transaction(action).immediate();
  }

  private readKind<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=? AND kind=?")
      .get(id, kind) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }

  private saveIfChanged<T>(kind: string, id: string, value: T): boolean {
    const existing = this.readKind<unknown>(kind, id);
    if (
      existing !== undefined &&
      JSON.stringify(existing) === JSON.stringify(value)
    )
      return false;
    this.store.save(kind, id, value);
    return true;
  }

  registration(identity: string) {
    return this.readKind<ResearchPortfolioRegistrationRecord>(
      researchPortfolioRegistrationKind,
      registrationId(identity),
    );
  }

  registrationSummary(identity: string) {
    return this.readKind<ResearchPortfolioRegistrationSummary>(
      researchPortfolioRegistrationSummaryKind,
      registrationSummaryId(identity),
    );
  }

  registrationSummaries() {
    return this.store.all<ResearchPortfolioRegistrationSummary>(
      researchPortfolioRegistrationSummaryKind,
    );
  }

  checkpoint(identity: string, key: TenPositionCheckpointKey) {
    return this.readKind<ResearchPortfolioCheckpointRecord>(
      researchPortfolioCheckpointKind,
      checkpointId(identity, key),
    );
  }

  checkpointIndexes(identity: string) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind=? AND json_extract(payload,'$.identity')=? ORDER BY id",
        )
        .all(researchPortfolioCheckpointIndexKind, identity) as {
        payload: string;
      }[]
    ).map((row) => JSON.parse(row.payload) as ResearchPortfolioCheckpointIndex);
  }

  checkpointIndexByHash(contentHash: string) {
    const rows = this.db
      .prepare(
        "SELECT payload FROM records WHERE kind=? AND json_extract(payload,'$.contentHash')=? LIMIT 2",
      )
      .all(researchPortfolioCheckpointIndexKind, contentHash) as {
      payload: string;
    }[];
    if (rows.length > 1)
      throw new Error("同一内容哈希被多个检查点索引引用，证据库需核对");
    return rows[0]
      ? (JSON.parse(rows[0].payload) as ResearchPortfolioCheckpointIndex)
      : undefined;
  }

  checkpointCounts() {
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload,'$.identity') identity,
           count(*) total,
           sum(CASE WHEN json_extract(payload,'$.status')='completed' THEN 1 ELSE 0 END) completed,
           sum(CASE WHEN json_extract(payload,'$.status')='blocked' THEN 1 ELSE 0 END) blocked
         FROM records WHERE kind=? GROUP BY identity`,
      )
      .all(researchPortfolioCheckpointIndexKind) as {
      identity: string;
      total: number;
      completed: number | null;
      blocked: number | null;
    }[];
    return new Map<string, ResearchPortfolioCheckpointCounts>(
      rows.map((row): [string, ResearchPortfolioCheckpointCounts] => [
        row.identity,
        {
          total: row.total,
          completed: row.completed ?? 0,
          blocked: row.blocked ?? 0,
        },
      ]),
    );
  }

  /** Returns false when the exact same registration is already stored. The
   * stored bytes are never rewritten; only a missing derived summary is added. */
  ensureRegistration(record: ResearchPortfolioRegistrationRecord) {
    const existing = this.registration(record.identity);
    if (existing) {
      if (
        existing.identity !== record.identity ||
        researchJsonHash(existing.registration) !== record.identity
      )
        throw new Error("已保存的登记内容与身份哈希不一致");
      this.saveIfChanged(
        researchPortfolioRegistrationSummaryKind,
        registrationSummaryId(record.identity),
        registrationSummaryOf(existing),
      );
      return false;
    }
    this.store.save(
      researchPortfolioRegistrationKind,
      registrationId(record.identity),
      record,
    );
    this.saveIfChanged(
      researchPortfolioRegistrationSummaryKind,
      registrationSummaryId(record.identity),
      registrationSummaryOf(record),
    );
    return true;
  }

  /** A scenario key is immutable once stored: identical content is a no-op,
   * different content is rejected instead of replacing prior evidence. */
  ensureCheckpoint(record: ResearchPortfolioCheckpointRecord) {
    const existing = this.checkpoint(record.identity, record.key);
    if (existing) {
      if (
        researchJsonHash(existing.row) !== existing.contentHash ||
        existing.identity !== record.identity ||
        JSON.stringify(existing.key) !== JSON.stringify(record.key)
      )
        throw new Error("已保存的检查点内容与其身份、键或内容哈希不一致");
      if (existing.contentHash !== record.contentHash)
        throw new Error("同一场景已保存不同证据，拒绝覆盖");
      this.saveIfChanged(
        researchPortfolioCheckpointIndexKind,
        checkpointIndexId(record.identity, record.key),
        checkpointIndexOf(existing),
      );
      return false;
    }
    const sameHash = this.checkpointIndexByHash(record.contentHash);
    if (
      sameHash &&
      (sameHash.identity !== record.identity ||
        JSON.stringify(sameHash.key) !== JSON.stringify(record.key))
    )
      throw new Error("该内容哈希已用于其他场景，拒绝重复引用");
    this.store.save(
      researchPortfolioCheckpointKind,
      checkpointId(record.identity, record.key),
      record,
    );
    this.saveIfChanged(
      researchPortfolioCheckpointIndexKind,
      checkpointIndexId(record.identity, record.key),
      checkpointIndexOf(record),
    );
    return true;
  }
}
