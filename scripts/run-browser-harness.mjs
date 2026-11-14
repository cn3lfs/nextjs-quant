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
if (process.argv.length > 3) {
  console.error("Usage: pnpm test:browser [name-filter]");
  process.exit(1);
}
const filter = process.argv[2] ?? "";
const files = readdirSync(dir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".mjs") &&
      entry.name.includes(filter),
  )
  .map((entry) => entry.name)
  .sort();
if (!files.length) {
  console.error(
    `No browser harnesses matched ${JSON.stringify(filter)} in ${dir}`,
  );
  process.exit(1);
}
const failed = [];
for (const file of files) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(dir, file)], {
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  const ok = run.status === 0;
  console.log(`${ok ? "✓" : "✘"} ${file} (${Date.now() - started} ms)`);
  if (!ok) {
    failed.push(file);
    if (run.error) console.error(run.error.message);
    console.log(
      [run.stdout, run.stderr]
        .filter(Boolean)
        .join("\n")
        .split("\n")
        .slice(-15)
        .join("\n"),
    );
  }
}
if (failed.length) {
  console.log(`${failed.length} failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`${files.length} browser harnesses passed.`);
