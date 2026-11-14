import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runner = resolve("scripts/run-browser-harness.mjs");
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(
    join(process.env.QUANT_DATA_DIR!, "browser-runner-"),
  );
  const directory = join(root, "tests/browser");
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files))
    writeFileSync(join(directory, name), source);
  return {
    root,
    run: (...args: string[]) =>
      spawnSync(process.execPath, [runner, ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
      }),
  };
}

it("fails when a filter matches nothing or the harness directory is empty", () => {
  const { run } = fixture({ "present.mjs": "throw Error('must not run')" });
  const result = run("typo");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('No browser harnesses matched "typo"');
  expect(result.stdout).not.toContain("passed");
  expect(fixture({}).run().status).toBe(1);
});

it("runs every selected file in stable order and ignores non-harness entries", () => {
  const source = (name: string) =>
    `import {appendFileSync} from 'node:fs'; appendFileSync('ran.txt', '${name}\\n');`;
  const { root, run } = fixture({
    "b-check.mjs": source("b"),
    "a-check.mjs": source("a"),
    "other.mjs": "throw Error('not selected')",
    "check.txt": "not JavaScript",
  });
  mkdirSync(join(root, "tests/browser/directory-check.mjs"));
  const result = run("check");
  expect(result.status).toBe(0);
  expect(readFileSync(join(root, "ran.txt"), "utf8")).toBe("a\nb\n");
  expect(result.stdout).toContain("2 browser harnesses passed.");
});

it("propagates child failures, retains both output streams and runs remaining files", () => {
  const { run } = fixture({
    "a-fails.mjs":
      "console.log('failure context'); console.error('failure detail'); process.exit(23)",
    "b-passes.mjs": "console.log('ok')",
  });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("failure context");
  expect(result.stdout).toContain("failure detail");
  expect(result.stdout).toContain("b-passes.mjs");
  expect(result.stdout).toContain("1 failed: a-fails.mjs");
  expect(result.stdout).not.toContain("browser harnesses passed.");
});

it("rejects extra arguments instead of silently ignoring requested filters", () => {
  const result = fixture({ "present.mjs": "throw Error('must not run')" }).run(
    "present",
    "ignored",
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage:");
  expect(result.stdout).toBe("");
});
