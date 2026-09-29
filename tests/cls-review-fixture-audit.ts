import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { seedClsReview } from "./helpers/cls-review-fixture";
const directory=resolve(process.env.QUANT_DATA_DIR??"");
assert.ok(directory.startsWith(resolve(tmpdir())+"\\quant-cls-review-"));
const restore=process.argv.includes("--restore");
const db=new Database(join(directory,"quant.sqlite"),{readonly:!restore});
const expected=new Database(":memory:");
try {
  if(restore) db.prepare(`DELETE FROM records WHERE kind='cls-review-fact'
    AND json_extract(payload,'$.reportId') IN ('cls-review-report:fixture-00999','cls-review-report:fixture-00997')
    AND json_extract(payload,'$.evidence') IN ('隔离浏览器核对依据','隔离竞态保存A')
    AND id NOT LIKE 'cls-review-fact:fixture-%'`).run();
  expected.exec("CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)");
  seedClsReview(expected);
  const query="SELECT * FROM records WHERE kind LIKE 'cls-review-%' ORDER BY id";
  const actual=db.prepare(query).all(), golden=expected.prepare(query).all();
  assert.deepEqual(actual,golden,"isolated CLS records must match deterministic initial fixture exactly");
  const result={restored:restore,records:actual.length,sha256:createHash("sha256").update(JSON.stringify(actual)).digest("hex"),userVersion:db.pragma("user_version",{simple:true}),integrity:db.pragma("integrity_check",{simple:true})};
  writeFileSync(join(tmpdir(),"logs/quant-cls-review/fixture-restored.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{db.close();expected.close();}
