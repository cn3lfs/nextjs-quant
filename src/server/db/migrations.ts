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
