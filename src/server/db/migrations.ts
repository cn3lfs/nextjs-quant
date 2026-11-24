import type Database from "better-sqlite3";
// Preserve the existing active-ledger SQL interface. A claim is one batch's
// version of an economic row. SQLite insertion order breaks ties independently
// of the broker's timestamps and of the order in which batches are revoked.
function deliveryClaimsMigration(table: string, fields: string) {
  const columns = fields.split(",");
  const claims = table + "_claims";
  return `
    ALTER TABLE ${table} RENAME TO ${table}_v21;
    CREATE TABLE ${claims} (claim_order INTEGER PRIMARY KEY,
      ${columns.map((c) => c + (c === "symbol" ? " TEXT" : " TEXT NOT NULL")).join(",")},
      UNIQUE(id,batch_id), FOREIGN KEY(batch_id) REFERENCES delivery_batches(id));
    INSERT INTO ${claims} (${fields}) SELECT ${fields} FROM ${table}_v21;
    DROP TABLE ${table}_v21;
    CREATE INDEX ${claims}_batch ON ${claims}(batch_id);
    CREATE INDEX ${claims}_account ON ${claims}(account);
    CREATE TABLE ${table}_canonical (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO ${table}_canonical (id,payload)
      SELECT c.id,c.payload FROM ${claims} c WHERE c.claim_order=(
        SELECT min(earlier.claim_order) FROM ${claims} earlier WHERE earlier.id=c.id);
    CREATE VIEW ${table} AS SELECT ${columns
      .filter((c) => c !== "payload")
      .map((c) => "c." + c)
      .join(",")},
      COALESCE(k.payload,c.payload) AS payload
      FROM ${claims} c
      JOIN delivery_batches b ON b.id=c.batch_id AND b.revoked_at IS NULL
      LEFT JOIN ${table}_canonical k ON k.id=c.id
      WHERE NOT EXISTS (SELECT 1 FROM ${claims} earlier
        JOIN delivery_batches active ON active.id=earlier.batch_id AND active.revoked_at IS NULL
        WHERE earlier.id=c.id AND earlier.claim_order<c.claim_order);
    CREATE TRIGGER ${table}_insert INSTEAD OF INSERT ON ${table} BEGIN
      INSERT INTO ${claims} (${fields}) VALUES (${columns.map((c) => "NEW." + c).join(",")});
      INSERT INTO ${table}_canonical (id,payload) VALUES (NEW.id,NEW.payload)
        ON CONFLICT(id) DO NOTHING; END;
    CREATE TRIGGER ${table}_update INSTEAD OF UPDATE ON ${table} BEGIN
      UPDATE ${claims} SET ${columns.map((c) => c + "=NEW." + c).join(",")}
        WHERE id=OLD.id AND batch_id=OLD.batch_id;
      UPDATE ${table}_canonical SET payload=NEW.payload WHERE id=OLD.id; END;
    CREATE TRIGGER ${table}_delete INSTEAD OF DELETE ON ${table} BEGIN
      DELETE FROM ${claims} WHERE id=OLD.id AND batch_id=OLD.batch_id;
      DELETE FROM ${table}_canonical WHERE id=OLD.id
        AND NOT EXISTS (SELECT 1 FROM ${claims} WHERE id=OLD.id); END;`;
}

/** Cover list metadata without reading immutable, potentially large bar evidence. */
export const intradaySummaryIndexes = `
  CREATE INDEX intraday_preview_summary ON records(kind,id,updated_at,
    jsonb(json_extract(payload,'$.sessionId','$.snapshot.symbol','$.barCutoff','$.rps','$.rpsDate','$.snapshot.source')),
    COALESCE(json_array_length(payload,'$.signals'),0))
    WHERE kind='intraday-preview' AND json_valid(payload);
  CREATE INDEX intraday_close_summary ON records(kind,CAST(json_extract(payload,'$.observationId') AS TEXT),
    CASE WHEN json_type(payload,'$.close.signalKeys')='array' THEN 1 ELSE 0 END)
    WHERE kind='intraday-close' AND json_valid(payload);`;
/** Metadata-only coverage for /signals. Keep expressions aligned with monitor-workspace-query. */
export const monitorWorkspaceIndexes = `
 CREATE INDEX monitor_workspace_delivery_history ON records(kind,json_extract(payload,'$.createdAt') DESC,id DESC,
   json_extract(payload,'$.signalId'),json_extract(payload,'$.channelId'),json_extract(payload,'$.kind'),
   json_extract(payload,'$.title'),json_extract(payload,'$.status'),json_extract(payload,'$.attempts'),
   json_extract(payload,'$.nextAt'),json_extract(payload,'$.expiresAt'),json_extract(payload,'$.manualRetry'),
   json_extract(payload,'$.sourceDeliveryId'),json_extract(payload,'$.summarySignalIds'),substr(json_extract(payload,'$.error'),1,300)) WHERE kind='delivery';
 CREATE INDEX monitor_workspace_signal_history ON records(kind,json_extract(payload,'$.createdAt') DESC,id DESC) WHERE kind='signal';
 CREATE INDEX monitor_workspace_delivery_signal ON records(kind,json_extract(payload,'$.signalId'),id,json_extract(payload,'$.status')) WHERE kind='delivery';
 CREATE INDEX monitor_workspace_summary_members ON records(kind,json_type(payload,'$.summarySignalIds'),json_extract(payload,'$.summarySignalIds'),id,json_extract(payload,'$.status')) WHERE kind='delivery' AND json_type(payload,'$.summarySignalIds')='array';
`;
/**
 * Task list/overview read job metadata only; without these covering indexes
 * every query re-parsed every job payload, results included (57 MB after a
 * few hundred backtests/screens: 150-220 ms per call, growing with history).
 * Keep expressions aligned with task-history.ts and job-summaries.ts.
 */
const jobSummaryColumns = `json_extract(payload,'$.type'), json_extract(payload,'$.status'),
   json_extract(payload,'$.progress'), json_extract(payload,'$.createdAt'), json_extract(payload,'$.updatedAt'),
   json_extract(payload,'$.attemptId'), json_extract(payload,'$.auditIncomplete'),
   substr(json_extract(payload,'$.phase'),1,128), substr(json_extract(payload,'$.error'),1,128),
   length(json_extract(payload,'$.phase')) > 128, length(json_extract(payload,'$.error')) > 128`;
export const jobTaskIndexes = `
 CREATE INDEX job_task_history ON records(kind,json_extract(payload,'$.createdAt') DESC,id DESC,${jobSummaryColumns}) WHERE kind='job';
 CREATE INDEX job_recent_summary ON records(kind,updated_at DESC,id,${jobSummaryColumns}) WHERE kind='job';
`;
/**
 * 14: chart views for every chart period (15/30/60-minute views could not be
 * saved under the original CHECK), and drawings shared across periods: the
 * shared drawings of each (symbol, origin period), mirrored on view save.
 */
export const chartViewPeriods = `
  CREATE TABLE chart_views_v14 (symbol TEXT NOT NULL,
    period TEXT NOT NULL CHECK(period IN ('day','week','month','5m','15m','30m','60m')),
    payload TEXT NOT NULL, PRIMARY KEY(symbol,period));
  INSERT INTO chart_views_v14 SELECT symbol, period, payload FROM chart_views;
  DROP TABLE chart_views;
  ALTER TABLE chart_views_v14 RENAME TO chart_views;
  CREATE TABLE chart_shared_drawings (symbol TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('day','week','month','5m','15m','30m','60m')),
    payload TEXT NOT NULL, PRIMARY KEY(symbol,origin));`;
export const migrations = [
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
  intradaySummaryIndexes,
  monitorWorkspaceIndexes,
  jobTaskIndexes,
  chartViewPeriods,
  `CREATE TABLE strategies (
    id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
    market TEXT NOT NULL CHECK(market IN ('cn-equity','crypto')),
    payload TEXT NOT NULL CHECK(json_valid(payload)), created_at INTEGER NOT NULL,
    PRIMARY KEY(id,version));
   CREATE TABLE trade_plans (
    id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    symbol TEXT NOT NULL, sleeve TEXT NOT NULL, trigger_key TEXT NOT NULL,
    expires_at TEXT, status TEXT NOT NULL CHECK(status IN ('open','closed','expired')),
    payload TEXT NOT NULL CHECK(json_valid(payload)), created_at INTEGER NOT NULL,
    FOREIGN KEY(strategy_id,strategy_version) REFERENCES strategies(id,version));
   CREATE INDEX trade_plans_strategy ON trade_plans(strategy_id,strategy_version,symbol,id);
   CREATE TABLE watch_events (
    dedupe_key TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    symbol TEXT NOT NULL, bar TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('entry','exit','stop','target')),
    price REAL NOT NULL CHECK(price>0), status TEXT NOT NULL CHECK(status IN ('new','planned','handled')),
    plan_id TEXT REFERENCES trade_plans(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
    FOREIGN KEY(strategy_id,strategy_version) REFERENCES strategies(id,version));
   CREATE INDEX watch_events_bar ON watch_events(bar,dedupe_key);`,
  `CREATE TABLE watch_events_v16 (
    dedupe_key TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    symbol TEXT NOT NULL, bar TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('entry','exit','stop','target','trailing','plan-entry','plan-expired','regime','allocation','missed')),
    price REAL CHECK(price IS NULL OR price>0),
    status TEXT NOT NULL CHECK(status IN ('new','planned','handled','shadow','live','missed')),
    plan_id TEXT REFERENCES trade_plans(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
    FOREIGN KEY(strategy_id,strategy_version) REFERENCES strategies(id,version));
   INSERT INTO watch_events_v16 SELECT * FROM watch_events;
   DROP TABLE watch_events;
   ALTER TABLE watch_events_v16 RENAME TO watch_events;
   CREATE INDEX watch_events_bar ON watch_events(bar,dedupe_key);`,
  `CREATE TABLE paper_accounts (
    id TEXT PRIMARY KEY, market TEXT NOT NULL CHECK(market IN ('cn-equity','crypto')),
    sleeve TEXT NOT NULL, started_at INTEGER NOT NULL, revision INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)));
   CREATE TABLE paper_state (account_id TEXT PRIMARY KEY REFERENCES paper_accounts(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
   CREATE TABLE paper_facts (account_id TEXT NOT NULL REFERENCES paper_accounts(id),
    kind TEXT NOT NULL CHECK(kind IN ('order','fill','position','equity','rejection','action','advance','mirror')),
    id TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    PRIMARY KEY(account_id,kind,id));
   CREATE INDEX paper_facts_date ON paper_facts(kind,date,account_id,id);
   CREATE TABLE watch_events_v17 (
    dedupe_key TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    symbol TEXT NOT NULL, bar TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('entry','exit','stop','target','trailing','plan-entry','plan-expired','regime','allocation','missed','paper-fill')),
    price REAL CHECK(price IS NULL OR price>0),
    status TEXT NOT NULL CHECK(status IN ('new','planned','handled','shadow','live','missed')),
    plan_id TEXT REFERENCES trade_plans(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
    FOREIGN KEY(strategy_id,strategy_version) REFERENCES strategies(id,version));
   INSERT INTO watch_events_v17 SELECT * FROM watch_events;
   DROP TABLE watch_events;
   ALTER TABLE watch_events_v17 RENAME TO watch_events;
   CREATE INDEX watch_events_bar ON watch_events(bar,dedupe_key);`,
  `CREATE TABLE account_trade_links (
    trade_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
   CREATE TABLE account_link_audit (
    id INTEGER PRIMARY KEY, trade_id TEXT NOT NULL, linked_at INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)));
   CREATE TABLE account_expectations (
    strategy_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    PRIMARY KEY(strategy_id,version),
    FOREIGN KEY(strategy_id,version) REFERENCES strategies(id,version));`,
  `CREATE TABLE account_protections (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('real','paper','exchange-simulation')),
    account TEXT NOT NULL, market TEXT NOT NULL CHECK(market IN ('cn-equity','crypto')), symbol TEXT NOT NULL,
    strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL, plan_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(kind,account,market,symbol),
    FOREIGN KEY(strategy_id,strategy_version) REFERENCES strategies(id,version), FOREIGN KEY(plan_id) REFERENCES trade_plans(id));
   UPDATE trade_plans SET payload=json_set(payload,'$.protection',json_object('version','unavailable','reason','旧计划未提供完整退出规格，请重新核验'))
   WHERE json_type(payload,'$.protection') IS NULL;`,
  `CREATE TABLE workspace_preferences (
    id INTEGER PRIMARY KEY CHECK(id=1),
    density TEXT NOT NULL CHECK(density IN ('comfort','compact')),
    sidebar_collapsed INTEGER NOT NULL CHECK(sidebar_collapsed IN (0,1)),
    expanded_groups TEXT NOT NULL CHECK(json_valid(expanded_groups) AND json_type(expanded_groups)='array'),
    close_to_tray INTEGER NOT NULL CHECK(close_to_tray IN (0,1)),
    holdings_reconciliation TEXT NOT NULL CHECK(holdings_reconciliation IN ('upper-bound','delivery-first','local-first')),
    single_key_shortcuts INTEGER NOT NULL CHECK(single_key_shortcuts IN (0,1)),
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO workspace_preferences VALUES(1,'comfort',0,'["今日交易"]',0,'upper-bound',1,unixepoch()*1000);`,
  `CREATE TABLE sim_accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    market TEXT NOT NULL CHECK(market IN ('cn-equity','crypto')),
    currency TEXT NOT NULL CHECK(currency IN ('CNY','USDT')),
    initial_capital_atoms INTEGER NOT NULL CHECK(initial_capital_atoms > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
    CHECK((market='cn-equity' AND currency='CNY') OR (market='crypto' AND currency='USDT'))
  ) STRICT;
  CREATE UNIQUE INDEX sim_accounts_active_name ON sim_accounts(market,name) WHERE status='active';
  CREATE TABLE sim_orders (
    account_id TEXT NOT NULL, id TEXT NOT NULL, client_request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')),
    execution_mode TEXT NOT NULL DEFAULT 'manual' CHECK(execution_mode IN ('manual','plan-manual','plan-auto')),
    plan_id TEXT, quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms > 0),
    price_atoms INTEGER NOT NULL CHECK(price_atoms > 0), trade_date TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL, rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
    PRIMARY KEY(account_id,id), UNIQUE(account_id,client_request_id),
    FOREIGN KEY(account_id) REFERENCES sim_accounts(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX sim_orders_date ON sim_orders(account_id,trade_date DESC,id DESC);
  CREATE TABLE sim_fills (
    account_id TEXT NOT NULL, id TEXT NOT NULL, order_id TEXT NOT NULL, symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms > 0),
    price_atoms INTEGER NOT NULL CHECK(price_atoms > 0), gross_atoms INTEGER NOT NULL CHECK(gross_atoms > 0),
    commission_atoms INTEGER NOT NULL CHECK(commission_atoms >= 0), tax_atoms INTEGER NOT NULL CHECK(tax_atoms >= 0),
    slippage_atoms INTEGER NOT NULL CHECK(slippage_atoms >= 0), trade_date TEXT NOT NULL, executed_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,id), UNIQUE(account_id,order_id),
    FOREIGN KEY(account_id,order_id) REFERENCES sim_orders(account_id,id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX sim_fills_symbol_replay ON sim_fills(account_id,symbol,id);
  CREATE TABLE sim_cash_flows (
    account_id TEXT NOT NULL, id TEXT NOT NULL, request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('opening','deposit','withdrawal','settlement')),
    delta_atoms INTEGER NOT NULL, fill_id TEXT, occurred_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(account_id,id), UNIQUE(account_id,request_id),
    FOREIGN KEY(account_id) REFERENCES sim_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(account_id,fill_id) REFERENCES sim_fills(account_id,id) ON DELETE RESTRICT
  ) STRICT;
  CREATE UNIQUE INDEX sim_cash_flows_fill ON sim_cash_flows(account_id,fill_id) WHERE fill_id IS NOT NULL;
  CREATE TABLE paper_cleanup_receipts (
    manifest_hash TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('archive','purge')),
    applied_at INTEGER NOT NULL, manifest_json TEXT NOT NULL, result_json TEXT NOT NULL, backup_hash TEXT,
    PRIMARY KEY(manifest_hash,action)
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY,account TEXT NOT NULL,source TEXT NOT NULL,
     file_hash TEXT NOT NULL,file_name TEXT NOT NULL,imported_at INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS import_batches_file ON import_batches(account,file_hash);
   CREATE TABLE IF NOT EXISTS trade_fills (id TEXT PRIMARY KEY,account TEXT NOT NULL,symbol TEXT,
     code TEXT NOT NULL,trade_date TEXT NOT NULL,batch_id TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cash_flows (id TEXT PRIMARY KEY,account TEXT NOT NULL,flow_date TEXT NOT NULL,
     batch_id TEXT NOT NULL,payload TEXT NOT NULL);
   ALTER TABLE import_batches RENAME TO delivery_batches;
   ALTER TABLE delivery_batches ADD COLUMN revoked_at INTEGER;
   DROP INDEX import_batches_file;
   CREATE UNIQUE INDEX import_batches_file ON delivery_batches(account,file_hash) WHERE revoked_at IS NULL;
   CREATE VIEW import_batches AS SELECT id,account,source,file_hash,file_name,imported_at,payload
     FROM delivery_batches WHERE revoked_at IS NULL;
   CREATE TRIGGER import_batches_insert INSTEAD OF INSERT ON import_batches BEGIN
     INSERT INTO delivery_batches VALUES(NEW.id,NEW.account,NEW.source,NEW.file_hash,NEW.file_name,NEW.imported_at,NEW.payload,NULL); END;
   CREATE TRIGGER import_batches_update INSTEAD OF UPDATE ON import_batches BEGIN
     UPDATE delivery_batches SET id=NEW.id, account=NEW.account, source=NEW.source,file_hash=NEW.file_hash,
       file_name=NEW.file_name,imported_at=NEW.imported_at,payload=NEW.payload WHERE id=OLD.id; END;
   CREATE TRIGGER import_batches_delete INSTEAD OF DELETE ON import_batches BEGIN
     UPDATE delivery_batches SET revoked_at=unixepoch()*1000 WHERE id=OLD.id; END;
   ${deliveryClaimsMigration("trade_fills", "id,account,symbol,code,trade_date,batch_id,payload")}
   ${deliveryClaimsMigration("cash_flows", "id,account,flow_date,batch_id,payload")}
   CREATE TABLE delivery_uncertain_claims(batch_id TEXT NOT NULL REFERENCES delivery_batches(id),
     fact_table TEXT NOT NULL, PRIMARY KEY(batch_id,fact_table));
   INSERT INTO delivery_uncertain_claims
     SELECT id,'trade_fills' FROM delivery_batches b WHERE
       json_extract(payload,'$.statistics.fills') IS NOT (SELECT count(*) FROM trade_fills_claims WHERE batch_id=b.id);
   INSERT INTO delivery_uncertain_claims
     SELECT id,'cash_flows' FROM delivery_batches b WHERE
       json_extract(payload,'$.statistics.cashFlows') IS NOT (SELECT count(*) FROM cash_flows_claims WHERE batch_id=b.id);`,
  `ALTER TABLE sim_fills ADD COLUMN transfer_atoms INTEGER NOT NULL DEFAULT 0 CHECK(transfer_atoms >= 0);`,
  `CREATE TABLE factor_composites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    weighting_method TEXT NOT NULL CHECK(weighting_method IN ('equal','icir','custom')),
    neutralization_mode TEXT NOT NULL CHECK(neutralization_mode IN ('none','industry','size','industry_size')),
    winsorize_method TEXT NOT NULL CHECK(winsorize_method IN ('none','mad','quantile')),
    config_json TEXT NOT NULL CHECK(json_valid(config_json)),
    latest_eval_summary_json TEXT CHECK(json_valid(latest_eval_summary_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX factor_composites_updated ON factor_composites(updated_at DESC, id DESC);
  CREATE TABLE rebalance_plans (
    id TEXT PRIMARY KEY,
    account_scope TEXT NOT NULL CHECK(account_scope IN ('real','paper')),
    account_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('alpha','etf_rotation','studio','manual')),
    source_ref_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    execute_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','confirmed','rechecked','expired','cancelled')),
    orders_json TEXT NOT NULL CHECK(json_valid(orders_json)),
    risk_summary_json TEXT NOT NULL CHECK(json_valid(risk_summary_json)),
    confirmed_at INTEGER,
    rechecked_at INTEGER,
    recheck_result_json TEXT CHECK(json_valid(recheck_result_json)),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX rebalance_plans_status_date ON rebalance_plans(account_scope, account_id, execute_date DESC, created_at DESC, id DESC);`,
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
