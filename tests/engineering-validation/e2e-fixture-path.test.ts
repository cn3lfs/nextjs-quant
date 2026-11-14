import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureDirectory } from "../e2e/fixture-directory";

it("accepts only descendants of the task data directory before output cleanup", () => {
  expect(fixtureDirectory(".test-data/p0-acceptance")).toBe(
    resolve(".test-data/p0-acceptance"),
  );
  for (const path of [
    ".",
    ".test-data",
    ".test-data/../../outside",
    "release",
    "C:/outside-p0-data",
  ])
    expect(() => fixtureDirectory(path)).toThrow("child directory");
});
it("refuses a linked parent even when its target is inside the test directory", () => {
  mkdirSync(resolve(".test-data"), { recursive: true });
  const directory = mkdtempSync(resolve(".test-data/p0-path-"));
  try {
    const target = join(directory, "actual");
    mkdirSync(target);
    symlinkSync(target, join(directory, "linked"), "junction");
    expect(() => fixtureDirectory(join(directory, "linked/results"))).toThrow(
      "Linked fixture path",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
