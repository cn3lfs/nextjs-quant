import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { deliveryFilePage } from "../src/server/portfolio/delivery-file-page";
const directory = await mkdtemp(join(tmpdir(), "quant-delivery-file-perf-"));
const results = [];
try {
  for (const count of [100, 1000]) {
    for (let i = count === 100 ? 0 : 100; i < count; i++)
      await writeFile(
        join(directory, `${String(i).padStart(4, "0")}.csv`),
        "synthetic",
      );
    const times = [];
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      const page = await deliveryFilePage({ directory });
      if (i >= 5) times.push(performance.now() - start);
      assert.equal(page.items.length, 20);
      assert.equal(page.count, count);
      assert.ok(
        page.items.every((item) => item.size === 9 && item.error === null),
      );
    }
    const all = [];
    let offset: number | null = 0;
    let version: string | undefined;
    while (offset !== null) {
      const page = await deliveryFilePage({ directory, offset, version });
      version = page.version;
      all.push(...page.items.map((i) => i.name));
      offset = page.nextOffset;
    }
    assert.equal(all.length, count);
    assert.equal(new Set(all).size, count);
    times.sort((a, b) => a - b);
    results.push({
      count,
      n: times.length,
      p50: times[14],
      p95: times[28],
      max: times.at(-1),
    });
  }
  const report = {
    results,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    scope:
      "service file enumeration plus current-page stat; not HTTP or cold disk",
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-delivery-import/workspace-file-perf.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(
    !isAbsolute(child) &&
      !child.startsWith("..") &&
      child.startsWith("quant-delivery-file-perf-"),
  );
  await rm(directory, { recursive: true, force: true });
}
