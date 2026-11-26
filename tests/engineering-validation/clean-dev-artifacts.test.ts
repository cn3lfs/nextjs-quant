import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeDevArtifactCleanup,
  planDevArtifactCleanup,
} from "../../scripts/clean-dev-artifacts.mjs";

const tempRoots: string[] = [];

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "clean-dev-artifacts-test-"));
  tempRoots.push(root);
  const repoRoot = join(root, "repo");
  const fakeTemp = join(root, "os-temp");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(fakeTemp, { recursive: true });
  return { root, repoRoot, fakeTemp };
}

async function put(path: string, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("scripts/clean-dev-artifacts.mjs", () => {
  it("dry-run previews disposable targets without deleting anything", async () => {
    const { repoRoot, fakeTemp } = await createFixtureRoot();
    await put(join(repoRoot, ".test-data/checks/check-abc/log.txt"), "123456");
    await put(join(repoRoot, ".test-data/fleet/run-1/meta.json"), "{}");
    await put(join(repoRoot, "playwright-report/index.html"), "<html>");
    await put(join(repoRoot, "release/win-unpacked/GuanlanQuant.exe"), "bin");
    await put(join(repoRoot, "release/_prev/win-unpacked/old.exe"), "old");
    await put(join(fakeTemp, "quant-wave0-abc/tmp.sqlite"), "db");
    await put(join(fakeTemp, "unrelated-app-dir/keep.txt"), "keep");

    const result = await executeDevArtifactCleanup({
      repoRoot,
      tempRoot: fakeTemp,
      apply: false,
      listActiveProcesses: () => [],
      listTrackedFiles: () => new Set(),
    });

    expect(result.mode).toBe("dry-run");
    expect(result.deletedCount).toBe(0);
    expect(result.plannedCount).toBe(4);
    expect(result.plannedBytes).toBeGreaterThan(0);
    expect(existsSync(join(repoRoot, ".test-data/checks/check-abc"))).toBe(
      true,
    );
    expect(existsSync(join(fakeTemp, "quant-wave0-abc"))).toBe(true);
    expect(
      result.skipped.some((s: { path: string }) => s.path.endsWith("_prev")),
    ).toBe(true);
  });

  it("--apply deletes only validated disposable artifacts and preserves protected & unrelated dirs", async () => {
    const { repoRoot, fakeTemp } = await createFixtureRoot();
    await put(join(repoRoot, ".test-data/checks/check-1/a.txt"), "aaaa");
    await put(join(repoRoot, ".test-data/iter5-empirical/panel.bin"), "bbbbbb");
    await put(join(repoRoot, "test-results/trace.zip"), "zip");
    await put(join(repoRoot, "release/_next/win-unpacked/stage.exe"), "stage");
    await put(join(repoRoot, "release/win-unpacked/GuanlanQuant.exe"), "live");
    await put(join(repoRoot, "release/_prev/win-unpacked/old.exe"), "prev");
    await put(join(repoRoot, "src/index.ts"), "code");
    await put(join(fakeTemp, "quant-desktop-xyz/smoke.log"), "log");
    await put(join(fakeTemp, "other-user-folder/important.txt"), "important");

    const result = await executeDevArtifactCleanup({
      repoRoot,
      tempRoot: fakeTemp,
      apply: true,
      listActiveProcesses: () => [],
      listTrackedFiles: () => new Set(["src/index.ts"]),
    });

    expect(result.failedCount).toBe(0);
    expect(result.deletedCount).toBe(5);
    expect(existsSync(join(repoRoot, ".test-data/checks/check-1"))).toBe(false);
    expect(existsSync(join(repoRoot, ".test-data/iter5-empirical"))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, "test-results"))).toBe(false);
    expect(existsSync(join(repoRoot, "release/_next"))).toBe(false);
    expect(existsSync(join(fakeTemp, "quant-desktop-xyz"))).toBe(false);

    // Strictly preserved
    expect(
      existsSync(join(repoRoot, "release/win-unpacked/GuanlanQuant.exe")),
    ).toBe(true);
    expect(
      existsSync(join(repoRoot, "release/_prev/win-unpacked/old.exe")),
    ).toBe(true);
    expect(existsSync(join(repoRoot, "src/index.ts"))).toBe(true);
    expect(existsSync(join(fakeTemp, "other-user-folder/important.txt"))).toBe(
      true,
    );
  });

  it("refuses symlinks/junctions, active-process targets, tracked files and honors --keep-fleet", async () => {
    const { root, repoRoot, fakeTemp } = await createFixtureRoot();
    const externalDir = join(root, "external-protected");
    await put(join(externalDir, "secret.txt"), "secret");

    const busyDir = join(repoRoot, ".test-data/checks/check-busy");
    await put(join(busyDir, "db.sqlite"), "busy");

    const trackedDir = join(repoRoot, ".test-data/tracked-fixture");
    await put(join(trackedDir, "fixture.json"), "{}");

    const fleetOld = join(repoRoot, ".test-data/fleet/run-old");
    const fleetNew = join(repoRoot, ".test-data/fleet/run-new");
    await put(join(fleetOld, "meta.json"), "{}");
    await put(join(fleetNew, "meta.json"), "{}");
    await utimes(
      fleetOld,
      new Date(1_700_000_000_000),
      new Date(1_700_000_000_000),
    );
    await utimes(
      fleetNew,
      new Date(1_800_000_000_000),
      new Date(1_800_000_000_000),
    );

    const linkedDir = join(repoRoot, ".test-data/linked-dir");
    await symlink(externalDir, linkedDir, "junction");

    const plan = await planDevArtifactCleanup({
      repoRoot,
      tempRoot: fakeTemp,
      keepFleet: 1,
      listActiveProcesses: () => [
        { pid: 99999, name: "node.exe", commandLine: `vitest ${busyDir}` },
      ],
      listTrackedFiles: () =>
        new Set([".test-data/tracked-fixture/fixture.json"]),
    });

    expect(plan.targets.map((t: { path: string }) => t.path)).toEqual([
      fleetOld,
    ]);
    expect(
      plan.skipped.some(
        (s: { path: string; reason: string }) =>
          s.path === linkedDir && s.reason.startsWith("symlink-or-junction"),
      ),
    ).toBe(true);
    expect(
      plan.skipped.some(
        (s: { path: string; reason: string }) =>
          s.path === busyDir && s.reason.includes("active-process"),
      ),
    ).toBe(true);
    expect(
      plan.skipped.some(
        (s: { path: string; reason: string }) =>
          s.path === trackedDir && s.reason === "contains-tracked-git-files",
      ),
    ).toBe(true);
    expect(
      plan.skipped.some(
        (s: { path: string; reason: string }) =>
          s.path === fleetNew && s.reason.includes("keep-fleet"),
      ),
    ).toBe(true);
    expect(existsSync(join(externalDir, "secret.txt"))).toBe(true);
  });
});
