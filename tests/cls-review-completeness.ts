import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { clsReportPage, clsFactPage } from "../src/server/news/cls-review-query";
import { seedClsReview } from "./helpers/cls-review-fixture";
const directory=resolve(process.env.QUANT_DATA_DIR??"");
assert.ok(directory.startsWith(resolve(tmpdir())+"\\quant-cls-review-"));
const db=new Database(join(directory,"quant.sqlite"),{readonly:true});
const memory=new Database(":memory:");
try {
  const reportIds:string[]=[];let cursor:string|undefined;
  do {const page=clsReportPage(db,{cursor});reportIds.push(...page.items.map(row=>row.id));cursor=page.nextCursor??undefined;}while(cursor);
  const expected=(db.prepare("SELECT id FROM records WHERE kind='cls-review-report' ORDER BY updated_at DESC,id DESC").all() as {id:string}[]).map(row=>row.id);
  assert.deepEqual(reportIds,expected);assert.equal(new Set(reportIds).size,1000);
  memory.exec("CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER); CREATE INDEX records_kind ON records(kind)");
  seedClsReview(memory,1,10000);
  const factIds:string[]=[];
  do {const page=clsFactPage(memory,{reportId:"cls-review-report:fixture-00000",mode:"history",cursor});factIds.push(...page.items.map(row=>row.id));cursor=page.nextCursor??undefined;}while(cursor);
  const facts=(memory.prepare("SELECT id FROM records WHERE kind='cls-review-fact' ORDER BY json_extract(payload,'$.reviewedAt') DESC,id DESC").all() as {id:string}[]).map(row=>row.id);
  assert.deepEqual(factIds,facts);assert.equal(new Set(factIds).size,10000);
  const result={reports:reportIds.length,reportPages:Math.ceil(reportIds.length/20),facts:factIds.length,factPages:Math.ceil(factIds.length/20),duplicates:0,missing:0};
  writeFileSync(join(tmpdir(),"logs/quant-cls-review/completeness.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{db.close();memory.close();}
