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
  `CREATE TABLE chart_views (symbol TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('day','week','month','5m')), payload TEXT NOT NULL, PRIMARY KEY(symbol,period));`,
  `CREATE TABLE rps_days (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
   CREATE TABLE rps_values (symbol TEXT NOT NULL, date TEXT NOT NULL, values_blob BLOB NOT NULL, PRIMARY KEY(symbol,date)) WITHOUT ROWID;
   CREATE INDEX rps_values_date ON rps_values(date,symbol);
   CREATE TABLE rps_job (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, payload TEXT NOT NULL, cancelled INTEGER NOT NULL, lease_until INTEGER NOT NULL);`,
  `CREATE TABLE industry_rps_days (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
   CREATE TABLE industry_rps_values (symbol TEXT NOT NULL, date TEXT NOT NULL, values_blob BLOB NOT NULL, PRIMARY KEY(symbol,date)) WITHOUT ROWID;
   CREATE INDEX industry_rps_values_date ON industry_rps_values(date,symbol);`,
  `CREATE TABLE concept_rps_days (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
   CREATE TABLE concept_rps_values (symbol TEXT NOT NULL, date TEXT NOT NULL, values_blob BLOB NOT NULL, PRIMARY KEY(symbol,date)) WITHOUT ROWID;
   CREATE INDEX concept_rps_values_date ON concept_rps_values(date,symbol);`,
  `CREATE TABLE import_batches (
     id TEXT PRIMARY KEY, account TEXT NOT NULL, source TEXT NOT NULL,
     file_hash TEXT NOT NULL, file_name TEXT NOT NULL,
     imported_at INTEGER NOT NULL, payload TEXT NOT NULL);
   CREATE UNIQUE INDEX import_batches_file ON import_batches(account,file_hash);
   CREATE TABLE trade_fills (
     id TEXT PRIMARY KEY, account TEXT NOT NULL, symbol TEXT, code TEXT NOT NULL,
     trade_date TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES import_batches(id),
     payload TEXT NOT NULL);
   CREATE INDEX trade_fills_account_date ON trade_fills(account,trade_date,code);
   CREATE INDEX trade_fills_batch ON trade_fills(batch_id);
   CREATE TABLE cash_flows (
     id TEXT PRIMARY KEY, account TEXT NOT NULL, flow_date TEXT NOT NULL,
     batch_id TEXT NOT NULL REFERENCES import_batches(id), payload TEXT NOT NULL);
   CREATE INDEX cash_flows_account_date ON cash_flows(account,flow_date);
   CREATE INDEX cash_flows_batch ON cash_flows(batch_id);`,
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
