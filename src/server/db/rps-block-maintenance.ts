import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { BlockEligibility } from "~/lib/market/block-eligibility";
import { rpsHash } from "../infra/content-hash";
import {
  rebuildBlockRps,
  type BlockRpsGroup,
} from "../screening/rps-block-rebuild";
import type { RpsObservation } from "../screening/rps-observation";
import { RpsStore } from "./rps-store";

type StoredRecord = { id: string; payload: string; updated_at: number };
type Change = {
  kind: "observation" | "daily";
  key: string;
  target: "industry" | "concept" | "";
  expected_hash: string;
  payload: string;
  updated_at: number;
};
export type BlockRebuildSummary = {
  version: "block-rps-rebuild-1";
  database: string;
  userVersion: number;
  createdAt: number;
  policy: BlockEligibility;
  observations: number;
  daily: Record<"industry" | "concept", number>;
  changes: number;
  dates: string[];
  removed: Record<"region" | "style", string[]>;
  stockHash: string;
  planHash: string;
};
function assertIdle(db: Database.Database) {
  const job = db
    .prepare("SELECT 1 FROM rps_job WHERE lease_until>? LIMIT 1")
    .get(Date.now());
  const observation = db
    .prepare(
      "SELECT 1 FROM records WHERE id='workflow-lease-rps-observation' AND json_extract(payload,'$.leaseUntil')>? LIMIT 1",
    )
    .get(Date.now());
  if (job || observation)
    throw new Error("RPS 正在计算，等待任务结束后再执行重算");
}
export function stockRpsFingerprint(db: Database.Database) {
  const hash = createHash("sha256");
  for (const row of db
    .prepare("SELECT date,payload FROM rps_days ORDER BY date")
    .iterate() as Iterable<{ date: string; payload: string }>)
    hash.update(row.date).update(row.payload);
  for (const row of db
    .prepare(
      "SELECT symbol,date,values_blob FROM rps_values ORDER BY symbol,date",
    )
    .iterate() as Iterable<{
    symbol: string;
    date: string;
    values_blob: Buffer;
  }>)
    hash.update(row.symbol).update(row.date).update(row.values_blob);
  return hash.digest("hex");
}
function dailyHash(
  db: Database.Database,
  target: "industry" | "concept",
  date: string,
) {
  const row = db
    .prepare(`SELECT payload FROM ${target}_rps_days WHERE date=?`)
    .get(date) as { payload: string };
  if (!row) throw new Error("板块日期已变化，请重新生成计划");
  const values = db
    .prepare(
      `SELECT symbol,values_blob FROM ${target}_rps_values WHERE date=? ORDER BY symbol`,
    )
    .all(date) as { symbol: string; values_blob: Buffer }[];
  return rpsHash({
    payload: row.payload,
    values: values.map((value) => [
      value.symbol,
      value.values_blob.toString("base64"),
    ]),
  });
}
function changesHash(stage: Database.Database) {
  const hash = createHash("sha256");
  for (const row of stage
    .prepare("SELECT * FROM changes ORDER BY kind,target,key")
    .iterate())
    hash.update(JSON.stringify(row));
  return hash.digest("hex");
}
function readSummary(stage: Database.Database): BlockRebuildSummary {
  const value = stage
    .prepare("SELECT payload FROM metadata WHERE id='summary'")
    .get() as { payload: string } | undefined;
  if (!value) throw new Error("缺少重算计划");
  const summary = JSON.parse(value.payload) as BlockRebuildSummary;
  if (
    summary.version !== "block-rps-rebuild-1" ||
    changesHash(stage) !== summary.planHash
  )
    throw new Error("重算计划校验失败");
  return summary;
}
export function planBlockRebuild(
  db: Database.Database,
  stage: Database.Database,
  policy: BlockEligibility,
  now = Date.now(),
) {
  assertIdle(db);
  stage.exec(
    "CREATE TABLE metadata(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE changes(kind TEXT NOT NULL,key TEXT NOT NULL,target TEXT NOT NULL,expected_hash TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,key,target));",
  );
  const insert = stage.prepare(
    "INSERT INTO changes VALUES(@kind,@key,@target,@expected_hash,@payload,@updated_at)",
  );
  const dates = new Set<string>();
  const removed = { region: new Set<string>(), style: new Set<string>() };
  const collect = (group: BlockRpsGroup) => {
    dates.add(group.day.date);
    for (const item of group.day.industry?.snapshot.selectionPolicy?.removed ??
      [])
      removed[item.kind].add(item.name);
  };
  let observations = 0;
  for (const row of db
    .prepare(
      "SELECT id,payload,updated_at FROM records WHERE kind='rps-observation' ORDER BY updated_at,id",
    )
    .iterate() as Iterable<StoredRecord>) {
    observations++;
    const old = JSON.parse(row.payload) as RpsObservation;
    const groups = { ...old.groups };
    let changed = false;
    for (const target of ["industry", "concept"] as const) {
      const before = groups[target];
      if (!before) continue;
      const next = rebuildBlockRps(before, policy);
      groups[target] = next;
      if (next !== before) {
        collect(next);
        changed = true;
      }
    }
    if (!changed) continue;
    const id = `${old.id}-block-${policy.hash.slice(0, 12)}`;
    const next = {
      ...old,
      id,
      groups,
      blockRebuild: {
        version: policy.version,
        policyHash: policy.hash,
        previousId: old.id,
        recalculatedAt: now,
      },
    };
    if (
      rpsHash({ day: old.day, rows: old.rows }) !==
      rpsHash({ day: next.day, rows: next.rows })
    )
      throw new Error("个股观察值发生变化，拒绝重算");
    insert.run({
      kind: "observation",
      key: row.id,
      target: "",
      expected_hash: rpsHash(row),
      payload: JSON.stringify(next),
      updated_at: row.updated_at,
    });
  }
  const daily = { industry: 0, concept: 0 };
  for (const target of ["industry", "concept"] as const) {
    const store = new RpsStore(db, target);
    const days = db
      .prepare(`SELECT date FROM ${target}_rps_days ORDER BY date`)
      .all() as { date: string }[];
    daily[target] = days.length;
    for (const { date } of days) {
      const before = { day: store.day(date)!, rows: store.rows(date) };
      const next = rebuildBlockRps(before, policy);
      if (next === before) continue;
      collect(next);
      insert.run({
        kind: "daily",
        key: date,
        target,
        expected_hash: dailyHash(db, target, date),
        payload: JSON.stringify(next),
        updated_at: now,
      });
    }
  }
  const count = stage.prepare("SELECT count(*) AS n FROM changes").get() as {
    n: number;
  };
  const summary: BlockRebuildSummary = {
    version: "block-rps-rebuild-1",
    database: db.name,
    userVersion: db.pragma("user_version", { simple: true }) as number,
    createdAt: now,
    policy,
    observations,
    daily,
    changes: count.n,
    dates: [...dates].sort(),
    removed: {
      region: [...removed.region].sort(),
      style: [...removed.style].sort(),
    },
    stockHash: stockRpsFingerprint(db),
    planHash: changesHash(stage),
  };
  stage
    .prepare("INSERT INTO metadata VALUES('summary',?)")
    .run(JSON.stringify(summary));
  return summary;
}
/** All dates and observations switch together; original payloads remain addressable by ID. */
export function applyBlockRebuild(
  db: Database.Database,
  stage: Database.Database,
  policy: BlockEligibility,
) {
  const summary = readSummary(stage);
  if (
    db.name !== summary.database ||
    rpsHash(policy) !== rpsHash(summary.policy) ||
    db.pragma("user_version", { simple: true }) !== summary.userVersion
  )
    throw new Error("数据库或板块分类已变化，请重新生成计划");
  return db
    .transaction(() => {
      assertIdle(db);
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM records WHERE kind='rps-observation'",
        )
        .get() as { n: number };
      if (
        count.n !== summary.observations ||
        stockRpsFingerprint(db) !== summary.stockHash
      )
        throw new Error("计划后 RPS 数据已变化，请重新生成计划");
      for (const target of ["industry", "concept"] as const) {
        const days = db
          .prepare(`SELECT count(*) AS n FROM ${target}_rps_days`)
          .get() as { n: number };
        if (days.n !== summary.daily[target])
          throw new Error("板块日期已变化，请重新生成计划");
      }
      for (const change of stage
        .prepare("SELECT * FROM changes ORDER BY kind,target,key")
        .iterate() as Iterable<Change>) {
        if (change.kind === "observation") {
          const old = db
            .prepare(
              "SELECT id,payload,updated_at FROM records WHERE id=? AND kind='rps-observation'",
            )
            .get(change.key) as StoredRecord | undefined;
          if (!old || rpsHash(old) !== change.expected_hash)
            throw new Error("观察批次已变化，请重新生成计划");
          const next = JSON.parse(change.payload) as RpsObservation;
          const before = JSON.parse(old.payload) as RpsObservation;
          if (
            rpsHash({ day: before.day, rows: before.rows }) !==
            rpsHash({ day: next.day, rows: next.rows })
          )
            throw new Error("计划试图修改个股观察值");
          if (db.prepare("SELECT 1 FROM records WHERE id=?").get(next.id))
            throw new Error("新板块批次 ID 已存在，未覆盖任何记录");
          db.prepare(
            "UPDATE records SET kind='rps-observation-archive' WHERE id=?",
          ).run(old.id);
          db.prepare(
            "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'rps-observation',?,?)",
          ).run(next.id, change.payload, change.updated_at);
          db.prepare(
            "UPDATE records SET payload=json_set(payload,'$.id',?),updated_at=? WHERE kind='rps-observation-index' AND json_extract(payload,'$.id')=?",
          ).run(next.id, Date.now(), old.id);
        } else {
          if (change.target !== "industry" && change.target !== "concept")
            throw new Error("重算目标非法");
          if (dailyHash(db, change.target, change.key) !== change.expected_hash)
            throw new Error("板块向量已变化，请重新生成计划");
          const next = JSON.parse(change.payload) as BlockRpsGroup;
          const store = new RpsStore(db, change.target);
          store.replaceBlockDay(
            next.day,
            next.rows,
            store.day(change.key)!.inputHash,
          );
        }
      }
      if (stockRpsFingerprint(db) !== summary.stockHash)
        throw new Error("个股 RPS 校验不一致，全部回滚");
      const run = {
        ...summary,
        policy: {
          version: policy.version,
          hash: policy.hash,
          sourceHash: policy.sourceHash,
        },
        appliedAt: Date.now(),
      };
      db.prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'rps-block-rebuild',?,?)",
      ).run(
        `rps-block-rebuild-${summary.planHash}`,
        JSON.stringify(run),
        Date.now(),
      );
      return run;
    })
    .immediate();
}
