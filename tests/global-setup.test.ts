import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { setup } from "./global-setup";

test("workers and subprocesses inherit the run temp directory", () => {
  expect(dirname(tmpdir()).endsWith("quant-tests")).toBe(true);
  expect(process.env.TEMP).toBe(tmpdir());
  expect(process.env.TMP).toBe(tmpdir());
  expect(process.env.TMPDIR).toBe(tmpdir());
  expect(
    execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(require('node:os').tmpdir())"],
      { encoding: "utf8" },
    ),
  ).toBe(tmpdir());
});

test("teardown deletes all nested temp files and restores the environment", () => {
  const previous = [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const teardown = setup();
  const run = tmpdir();
  try {
    const data = mkdtempSync(join(run, "quant-screening-"));
    writeFileSync(join(data, "data.txt"), "fixture");
  } finally {
    teardown();
  }
  expect(existsSync(run)).toBe(false);
  expect([process.env.TEMP, process.env.TMP, process.env.TMPDIR]).toEqual(
    previous,
  );
});

test("the next setup removes stale runs but preserves recent and unrelated directories", () => {
  const base = mkdtempSync(join(tmpdir(), "cleanup-fixture-"));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, base);
  const root = join(base, "quant-tests");
  const stale = join(root, `${Date.now() - 2 * 86400000}-123-abandoned`);
  const recent = join(root, `${Date.now()}-456-active`);
  const unrelated = join(root, "unrelated");
  for (const directory of [stale, recent, unrelated])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(stale, "leftover.txt"), "fixture");
  try {
    const teardown = setup();
    try {
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      teardown();
    }
    expect(existsSync(recent)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
