import type Database from "better-sqlite3";

/** Only records committed by this connection; raw SQL and other writers invalidate them. */
export class WriteReceipts {
  private entries = new Map<
    string,
    { kind: string; payload: string; bytes: number }
  >();
  private bytes = 0;
  private localChanges = -1;
  private kindRevisions = new Map<string, number>();
  constructor(private readonly connection: Database.Database) {}
  private changes() {
    return (
      this.connection.prepare("SELECT total_changes() AS n").get() as {
        n: number;
      }
    ).n;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  observeLocal() {
    const n = this.changes();
    if (n !== this.localChanges) this.clear();
    this.localChanges = n;
  }
  acknowledgeLocal() {
    this.localChanges = this.changes();
  }
  private revision(kind: string) {
    return (
      (
        this.connection
          .prepare("SELECT revision FROM record_kind_revisions WHERE kind=?")
          .get(kind) as { revision: number } | undefined
      )?.revision ?? 0
    );
  }
  /** Called under the batch's write transaction, so validation and use are atomic. */
  observeExternal(kind: string) {
    const revision = this.revision(kind);
    if (revision !== this.kindRevisions.get(kind))
      for (const [id, entry] of this.entries)
        if (entry.kind === kind) this.forget(id);
    this.kindRevisions.set(kind, revision);
  }
  /** Capture our own changes before releasing the write lock. */
  acknowledgeKind(kind: string) {
    this.kindRevisions.set(kind, this.revision(kind));
  }
  forget(id: string) {
    this.bytes -= this.entries.get(id)?.bytes ?? 0;
    this.entries.delete(id);
  }
  matches(id: string, kind: string, payload: string) {
    const old = this.entries.get(id);
    return old?.kind === kind && old.payload === payload;
  }
  remember(id: string, kind: string, payload: string) {
    this.forget(id);
    const bytes = (id.length + kind.length + payload.length) * 2 + 128;
    const limit = 256 * 1024 * 1024;
    if (bytes > limit) return;
    while (
      this.entries.size &&
      (this.bytes + bytes > limit || this.entries.size >= 20000)
    )
      this.forget(this.entries.keys().next().value!);
    this.entries.set(id, { kind, payload, bytes });
    this.bytes += bytes;
  }
}
