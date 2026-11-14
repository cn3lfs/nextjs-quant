/** Opt-in mutation checks. Run alone; originals restored byte-for-byte in finally. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const file = "src/server/news/news-workspace-query.ts";
const original = readFileSync(file);
const source = original.toString("utf8");
const controls = [
  [
    "archive-limit-50",
    "const where = [\"kind='news-analysis'\"]",
    "const where = [\"kind='news-analysis' AND id IN (SELECT id FROM records WHERE kind='news-analysis' ORDER BY updated_at DESC LIMIT 50)\"]",
    "all 121 archive IDs",
    "tests/news-cls/news-workspace-query.test.ts",
  ],
  [
    "collection-cutoff",
    "datetime(collected_at) IS NOT NULL AND datetime(collected_at)<=?",
    "? IS NOT NULL",
    "searches full content",
    "tests/news-cls/news-workspace-query.test.ts",
  ],
  [
    "wrong-first-page",
    "{ ...input, cursor: expected.cursor }",
    "{ ...input, cursor: undefined }",
    "analyzes the exact displayed cursor page",
    "tests/news-cls/news-analysis.test.ts",
  ],
  [
    "summary-full-body",
    "preview: content.slice(0, 160),",
    "content, preview: content.slice(0, 160),",
    "pages all source rows",
    "tests/news-cls/news-workspace-query.test.ts",
  ],
];
const results = [];
try {
  for (const [name, from, to, test, spec] of controls) {
    assert.equal(
      source.split(from).length,
      2,
      `${name}: unique mutation anchor`,
    );
    writeFileSync(file, source.replace(from, to));
    const child = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", spec, "-t", test],
      { encoding: "utf8", timeout: 60000 },
    );
    const output = child.stdout + child.stderr;
    writeFileSync(
      join(tmpdir(), "logs", "quant-news", `negative-${name}.log`),
      output,
    );
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0, `${name} escaped`);
    assert.match(output, /AssertionError|expected .* to|当前页新闻已变化/);
    results.push({ name, status: child.status, caught: true });
    writeFileSync(file, original);
  }
} finally {
  writeFileSync(file, original);
}
assert.ok(readFileSync(file).equals(original));
writeFileSync(
  join(tmpdir(), "logs", "quant-news", "negative-controls.json"),
  JSON.stringify({ results, restored: true }, null, 2),
);
console.log(JSON.stringify(results));
