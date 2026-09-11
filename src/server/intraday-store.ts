import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { evaluateIntraday } from "./intraday-strategy";
import { previewConfirmation } from "~/lib/intraday-preview";

export type IntradayObservation = Awaited<
  ReturnType<typeof evaluateIntraday>
> & {
  sessionId: string;
  rpsDate: string;
  rps: number;
  poolHash: string;
  capturedAt?: number;
  sourceVersions?: string[];
};
export type IntradayClose = {
  snapshot?: Awaited<ReturnType<typeof evaluateIntraday>>["snapshot"];
  observedAt: number;
  snapshotHash: string | null;
  signalKeys: string[] | null;
  reason: string | null;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Append-only evidence in the existing records store; no automatic expiry.
 * Keys include the session and symbol, so retries cannot replace a preview.
 * Explicit deletion removes an observation and its own close attempts only.
 */
export class IntradayStore {
  constructor(
    readonly db: Database.Database,
    readonly maxEvidenceBytes = 512 * 1024 * 1024,
  ) {}

  usage() {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes,COUNT(*) AS records FROM records WHERE kind IN ('intraday-preview','intraday-close')",
      )
      .get() as { bytes: number; records: number };
    return { ...row, limitBytes: this.maxEvidenceBytes };
  }
  private append(
    kind: "intraday-preview" | "intraday-close",
    id: string,
    value: unknown,
    now: number,
  ) {
    this.db
      .transaction(() => {
        if (this.db.prepare("SELECT id FROM records WHERE id=?").get(id))
          return;
        const payload = JSON.stringify(value);
        if (
          this.usage().bytes + Buffer.byteLength(payload) >
          this.maxEvidenceBytes
        )
          throw new Error("预选研究快照已达存储上限，请先导出并清理记录");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(id, kind, payload, now);
      })
      .immediate();
  }

  record(value: IntradayObservation) {
    const id = `intraday-preview:${hash([value.sessionId, value.snapshot.symbol])}`;
    this.append("intraday-preview", id, value, value.observedAt);
    return { id, value: this.observation(id)! };
  }

  observation(id: string): IntradayObservation | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM records WHERE id=? AND kind='intraday-preview'",
      )
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as IntradayObservation) : undefined;
  }

  confirm(id: string, close: IntradayClose) {
    return this.db
      .transaction(() => {
        const observation = this.observation(id);
        if (!observation) throw new Error("预选记录不存在");
        const date = observation.barCutoff.slice(0, 10);
        if (
          !Number.isFinite(close.observedAt) ||
          close.observedAt < Date.parse(`${date}T15:05:00+08:00`)
        )
          throw new Error("尚未到收盘确认时间");
        if (close.signalKeys === null ? !close.reason : !close.snapshotHash)
          throw new Error("收盘确认缺少行情依据或失败原因");
        const previous = this.attempts(id);
        const settled = previous.find(
          (attempt) => attempt.close.signalKeys !== null,
        );
        if (settled) return settled;
        const value = {
          observationId: id,
          close,
          signals: observation.signals.map((signal) => ({
            key: signal.key,
            status: previewConfirmation(signal.key, close.signalKeys),
          })),
        };
        const attemptId = `intraday-close:${hash(value)}`;
        this.append("intraday-close", attemptId, value, close.observedAt);
        return value;
      })
      .immediate();
  }

  attempts(id: string) {
    const rows = this.db
      .prepare(
        "SELECT payload FROM records WHERE kind='intraday-close' AND json_extract(payload,'$.observationId')=? ORDER BY updated_at,id",
      )
      .all(id) as { payload: string }[];
    return rows.map(
      (row) =>
        JSON.parse(row.payload) as {
          observationId: string;
          close: IntradayClose;
          signals: {
            key: string;
            status: ReturnType<typeof previewConfirmation>;
          }[];
        },
    );
  }

  page(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error("分页无效");
    const rows = this.db
      .prepare(
        "SELECT id,payload FROM records WHERE kind='intraday-preview' ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?",
      )
      .all(offset) as { id: string; payload: string }[];
    return rows.map((row) => ({
      id: row.id,
      value: JSON.parse(row.payload) as IntradayObservation,
      attempts: this.attempts(row.id),
    }));
  }

  remove(id: string, now = Date.now()) {
    this.db
      .transaction(() => {
        const observation = this.observation(id);
        if (!observation) return;
        const row = this.db
          .prepare(
            "SELECT payload FROM records WHERE id=? AND kind='intraday-run'",
          )
          .get(observation.sessionId) as { payload: string } | undefined;
        if (row) {
          const run = JSON.parse(row.payload) as {
            status: string;
            leaseUntil: number;
            results: { observationId: string | null; reason: string | null }[];
          };
          if (run.status === "running" && run.leaseUntil > now)
            throw new Error("批次仍在执行，请完成后清理");
          for (const result of run.results)
            if (result.observationId === id)
              result.reason = "原始记录已由用户清理";
          this.db
            .prepare(
              "UPDATE records SET payload=? WHERE id=? AND kind='intraday-run'",
            )
            .run(JSON.stringify(run), observation.sessionId);
        }
        this.db
          .prepare(
            "DELETE FROM records WHERE kind='intraday-close' AND json_extract(payload,'$.observationId')=?",
          )
          .run(id);
        this.db
          .prepare("DELETE FROM records WHERE kind='intraday-preview' AND id=?")
          .run(id);
      })
      .immediate();
  }
}
