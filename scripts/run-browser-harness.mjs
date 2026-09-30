/**
 * Runs the self-contained browser harnesses in tests/browser (each bundles
 * one component with esbuild and mocked data, no server or database).
 * Page-level acceptance lives in Playwright Test (`pnpm e2e`).
 *   pnpm test:browser [name-filter]
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "tests", "browser");
const filter = process.argv[2] ?? "";
const failed = [];
for (const file of readdirSync(dir).filter(
  (f) => f.endsWith(".mjs") && f.includes(filter),
)) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(dir, file)], {
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  const ok = run.status === 0;
  console.log(`${ok ? "✓" : "✘"} ${file} (${Date.now() - started} ms)`);
  if (!ok) {
    failed.push(file);
    console.log((run.stderr || run.stdout).split("\n").slice(-15).join("\n"));
  }
}
if (failed.length) {
  console.log(`${failed.length} failed: ${failed.join(", ")}`);
  process.exit(1);
}
