import type Database from "better-sqlite3";
const migrations = [
  `CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS records_kind ON records(kind,updated_at);`,
  `CREATE INDEX IF NOT EXISTS delivery_status ON records(kind,json_extract(payload,'$.status'),updated_at);`,
  `CREATE TABLE record_kind_revisions(kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
   CREATE TRIGGER records_revision_insert AFTER INSERT ON records BEGIN
     INSERT INTO record_kind_revisions VALUES(NEW.kind,1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1;
   END;
   CREATE TRIGGER records_revision_delete AFTER DELETE ON records BEGIN
     INSERT INTO record_kind_revisions VALUES(OLD.kind,1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1;
   END;
   CREATE TRIGGER records_revision_update AFTER UPDATE ON records BEGIN
     INSERT INTO record_kind_revisions VALUES(OLD.kind,1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1;
     INSERT INTO record_kind_revisions SELECT NEW.kind,1 WHERE NEW.kind<>OLD.kind ON CONFLICT(kind) DO UPDATE SET revision=revision+1;
   END;
   -- REPLACE may delete the old row without firing DELETE triggers.
   CREATE TRIGGER records_revision_replace BEFORE INSERT ON records BEGIN
     INSERT INTO record_kind_revisions SELECT kind,1 FROM records WHERE id=NEW.id AND kind<>NEW.kind
     ON CONFLICT(kind) DO UPDATE SET revision=revision+1;
   END;`,
  `CREATE TABLE signal_ledger (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, observed_date TEXT NOT NULL, payload TEXT NOT NULL);
   CREATE INDEX signal_ledger_date ON signal_ledger(observed_date,symbol);
   CREATE TABLE signal_ledger_outcomes (signal_id TEXT NOT NULL REFERENCES signal_ledger(id), horizon INTEGER NOT NULL CHECK(horizon IN (5,10,20)), settled INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(signal_id,horizon));
   CREATE TABLE signal_ledger_baselines (symbol TEXT PRIMARY KEY, payload TEXT NOT NULL);
   CREATE TABLE signal_ledger_runs (date TEXT PRIMARY KEY, payload TEXT NOT NULL);`,
  `CREATE TABLE trade_ledger (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, trade_date TEXT NOT NULL, payload TEXT NOT NULL);
   CREATE INDEX trade_ledger_symbol_date ON trade_ledger(symbol,trade_date);
   CREATE TABLE trade_adjustments (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, payload TEXT NOT NULL);`,
];
export function migrate(connection: Database.Database) {
  const version = connection.pragma("user_version", { simple: true }) as number;
  if (version > migrations.length)
    throw new Error("数据库版本高于此应用版本，请使用较新的应用");
  connection.transaction(() => {
    for (let i = version; i < migrations.length; i++) {
      connection.exec(migrations[i]!);
      connection.pragma(`user_version = ${i + 1}`);
    }
  })();
}
