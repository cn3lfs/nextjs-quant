import type Database from "better-sqlite3";
import { PaperRepository } from "./paper-repository";
import type { PaperState } from "../paper/model";
import { sqlite } from "./index";

/** Version-review evidence is append-only and separate from accounting facts. */
export class PaperBuildReviewRepository {
  constructor(readonly db: Database.Database = sqlite()) {}
  atomic<T>(work: () => T) {
    return this.db.transaction(work).immediate();
  }
  snapshot(id: string) {
    const account = new PaperRepository(this.db).account(id);
    const row = this.db
      .prepare("SELECT payload FROM paper_state WHERE account_id=?")
      .get(id) as { payload: string } | undefined;
    const accountRow = this.db
      .prepare("SELECT payload FROM paper_accounts WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!account || !row || !accountRow)
      throw new Error("纸面账户尚无可复核的冻结执行记录");
    return {
      account,
      accountRaw: accountRow.payload,
      raw: row.payload,
      state: JSON.parse(row.payload) as PaperState & { build?: string },
    };
  }
  record<T>(id: string): T | null {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }
  immutable(kind: string, id: string, value: unknown) {
    const payload = JSON.stringify(value);
    const existing = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (existing && existing.payload !== payload)
      throw new Error("执行版本复核证据冲突");
    this.db
      .prepare("INSERT OR IGNORE INTO records VALUES(?,?,?,?)")
      .run(id, kind, payload, Date.now());
  }
  replaceBuild(id: string, previousPayload: string, nextPayload: string) {
    if (
      this.db
        .prepare(
          "UPDATE paper_state SET payload=? WHERE account_id=? AND payload=?",
        )
        .run(nextPayload, id, previousPayload).changes !== 1
    )
      throw new Error("纸面执行记录已变化，请重新复核");
  }
}
