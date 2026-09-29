/** Read-only post-acceptance restoration check. Never accepts the default data directory. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import {
  newsFixtureAnalysis,
  newsFixtureContent,
} from "./helpers/news-workspace-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-news-"));
const db = new Database(join(directory, "quant.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
const source = new Database(join(directory, "news.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
try {
  const archives = db
    .prepare("SELECT id,payload FROM records WHERE kind='news-analysis'")
    .all() as { id: string; payload: string }[];
  assert.equal(archives.length, 121);
  const saved = new Map(
    archives.map((row) => [row.id, JSON.parse(row.payload)]),
  );
  for (let i = 0; i < 121; i++) {
    const expected = newsFixtureAnalysis(i);
    assert.deepEqual(saved.get(expected.id), expected);
  }
  assert.equal(
    db.prepare("SELECT id FROM records WHERE id='news-ui-fixture-job'").get(),
    undefined,
  );
  const settings = JSON.parse(
    (
      db.prepare("SELECT payload FROM records WHERE id='settings'").get() as {
        payload: string;
      }
    ).payload,
  );
  assert.equal(settings.clsDbPath, join(directory, "news.sqlite"));
  assert.equal(settings.autoNewsAnalysis, false);
  assert.equal(settings.tdxRoot, "Z:\\quant-fixture-unavailable");
  const counts = source
    .prepare(
      "SELECT count(*) total,sum(content != (? || CASE WHEN id%10=1 THEN '末尾关键词' ELSE '' END)) altered FROM news",
    )
    .get(newsFixtureContent) as { total: number; altered: number };
  assert.deepEqual(counts, { total: 10000, altered: 0 });
  writeFileSync(
    join(tmpdir(), "logs", "quant-news", "fixture-restored.json"),
    JSON.stringify(
      {
        archives: 121,
        source: counts,
        settingsRestored: true,
        syntheticJobRemoved: true,
      },
      null,
      2,
    ),
  );
  console.log("isolated fixtures restored");
} finally {
  source.close();
  db.close();
}
