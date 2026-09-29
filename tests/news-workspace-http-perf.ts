import Database from "better-sqlite3";
import SuperJSON from "superjson";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import {
  seedNewsAnalyses,
  newsFixtureCutoff,
} from "./helpers/news-workspace-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-news-"));
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const logs = join(tmpdir(), "logs", "quant-news");
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
type Row = { id: string; kind: string; payload: string; updated_at: number };
const archives = db
  .prepare("SELECT * FROM records WHERE kind='news-analysis'")
  .all() as Row[];
const settings = db
  .prepare("SELECT * FROM records WHERE id='settings'")
  .get() as Row;
const originalSettings = JSON.parse(settings.payload);
const results: unknown[] = [];
async function request(procedure: string, input: unknown) {
  const response = await fetch(
    `${base}/api/trpc/${procedure}?input=${encodeURIComponent(SuperJSON.stringify(input))}`,
    {
      headers: {
        "x-quant-client": "workbench",
        origin: base,
        connection: "close",
      },
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 300));
  return {
    value: SuperJSON.deserialize(JSON.parse(text).result.data) as {
      total: number;
      nextCursor: unknown;
    },
    bytes: Buffer.byteLength(text),
  };
}
async function measure(
  name: string,
  procedure: string,
  input: unknown,
  context: object,
) {
  const samples: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const response = await request(procedure, input);
    if (i >= 5) samples.push(performance.now() - start);
    bytes = response.bytes;
  }
  samples.sort((a, b) => a - b);
  results.push({
    ...context,
    name,
    procedure,
    p50: samples[15],
    p95: samples[28],
    bytes,
  });
}
try {
  const fixtures = JSON.parse(
    readFileSync(join(logs, "sql-before.json"), "utf8"),
  ).results.filter(
    (r: { kind: string; count: number; query: string }) =>
      r.kind === "source" && r.count === 10000 && r.query === "",
  );
  for (const fixture of fixtures) {
    db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
      JSON.stringify({
        ...originalSettings,
        clsDbPath: join(fixture.directory, "news.sqlite"),
      }),
    );
    const filter = { cutoff: newsFixtureCutoff, historical: true, query: "" };
    const first = await request("newsWorkspace", filter);
    assert.equal(first.value.total, 10000);
    for (const query of ["", "末尾关键词"]) {
      await measure(
        "old",
        "news",
        { ...filter, query },
        { indexed: fixture.indexed, query },
      );
      await measure(
        "new",
        "newsWorkspace",
        { ...filter, query },
        { indexed: fixture.indexed, query },
      );
    }
    await measure(
      "page2",
      "newsWorkspace",
      { ...filter, cursor: first.value.nextCursor },
      { indexed: fixture.indexed },
    );
  }
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    settings.payload,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM records WHERE kind='news-analysis'").run();
    seedNewsAnalyses(db, 1000);
  })();
  const first = await request("newsArchiveHistory", {});
  assert.equal(first.value.total, 1000);
  await measure("old-limited-50", "newsAnalyses", undefined, { count: 1000 });
  for (const [name, input] of [
    ["all", {}],
    ["keyword", { query: "半导体" }],
    ["status", { status: "partial" }],
    ["page2", { cursor: first.value.nextCursor }],
  ] as const)
    await measure(name, "newsArchiveHistory", input, { count: 1000 });
  writeFileSync(
    join(logs, "http-performance.json"),
    JSON.stringify(
      {
        node: process.version,
        note: "5 warmups/30 sequential HTTP samples, same retained source fixture, old endpoint retained for compatibility; old archive only50 vs new full1000",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  db.transaction(() => {
    db.prepare(
      "UPDATE records SET payload=?,updated_at=? WHERE id='settings'",
    ).run(settings.payload, settings.updated_at);
    db.prepare("DELETE FROM records WHERE kind='news-analysis'").run();
    const insert = db.prepare(
      "INSERT INTO records(id,kind,payload,updated_at) VALUES(@id,@kind,@payload,@updated_at)",
    );
    for (const row of archives) insert.run(row);
  })();
  assert.equal(
    (
      db
        .prepare("SELECT count(*) n FROM records WHERE kind='news-analysis'")
        .get() as { n: number }
    ).n,
    archives.length,
  );
  db.close();
}
