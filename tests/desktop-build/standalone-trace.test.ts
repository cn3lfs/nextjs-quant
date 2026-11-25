import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, test, vi } from "vitest";
import {
  directories,
  ensureRealDirectory,
  isAbsent,
  readBounded,
  UnsafeArchivePath,
} from "~/server/research/diagnose/archive-fs";
import {
  decodeCliLocation,
  discoverCliArchives,
  readCliReport,
} from "~/server/research/diagnose/cli-archive";

const archiveSources = {
  "src/server/research/diagnose/archive-fs.ts": [
    "lstat",
    "resolve",
    "realpath",
    "mkdir",
    "readdir",
    "open",
  ],
  "src/server/research/diagnose/cli-archive.ts": ["join", "readdir"],
};
const page = { page: 1, pageSize: 1, offset: 0 };
const noDrift = async () => [];
const require = createRequire(import.meta.url);

async function putFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

test("the build cleanup command strips Next's copied dotenv files", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "build-standalone");
  const standalone = join(root, ".next/standalone");
  await putFile(join(root, ".env.production"), "build source");
  await putFile(join(standalone, ".env.production"), "copied by Next");
  await putFile(join(standalone, "nested/.env"), "traced fixture");
  await putFile(join(standalone, "server.js"), "server fixture");
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/prepare-desktop.mjs"), "--strip-env"],
    { cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  const tree = await readdir(standalone, { recursive: true });
  expect(tree.sort()).toEqual(["nested", "server.js"]);
  expect(await readFile(join(root, ".env.production"), "utf8")).toBe(
    "build source",
  );
});

test.each([
  "node_modules",
  ".next/node_modules",
  "runtime",
  "node_modules/@koromix",
  "public/nested",
])(
  "prepare refuses a linked %s destination before any writes",
  async (path) => {
    const parent = join(
      process.env.QUANT_DATA_DIR!,
      `linked-${path.replaceAll("/", "-")}`,
    );
    const root = join(parent, "project");
    const external = join(parent, "external");
    const standalone = join(root, ".next/standalone");
    const marker = join(standalone, ".next/desktop-prepared-build-id");
    const staticAsset = join(standalone, ".next/static/previous.js");
    await putFile(join(root, ".next/BUILD_ID"), "current");
    await putFile(marker, "previous");
    await putFile(staticAsset, "previous chunk");
    await putFile(join(external, "sentinel"), "keep");
    const link = join(standalone, path);
    await mkdir(dirname(link), { recursive: true });
    await symlink(
      external,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const preparePath = "../../scripts/prepare-desktop.mjs";
    const { prepareDesktop } = await import(preparePath);
    const copy = vi.fn();
    await expect(
      prepareDesktop({ root, guard: () => {}, copy }),
    ).rejects.toThrow(link);
    expect(copy).not.toHaveBeenCalled();
    expect(await readFile(marker, "utf8")).toBe("previous");
    expect(await readFile(staticAsset, "utf8")).toBe("previous chunk");
    expect(await readdir(external)).toEqual(["sentinel"]);
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "prepares a dotenv-free standalone tree with loadable Windows SQLite bindings",
  async () => {
    const root = join(process.env.QUANT_DATA_DIR!, "prepare-standalone");
    const standalone = join(root, ".next/standalone");
    await putFile(join(root, ".next/BUILD_ID"), "fixture");
    await putFile(join(root, ".next/static/chunks/app.js"), "fixture");
    await putFile(join(root, "public/nested/.env.local"), "private");
    await putFile(join(root, "public/nested/keep.txt"), "public");
    await putFile(join(root, "runtime/.env.production"), "private");
    await putFile(
      join(root, "runtime/node_modules/@koromix/koffi-win32-x64/fixture.node"),
      "fixture",
    );
    await putFile(join(standalone, ".env"), "private");
    await putFile(join(standalone, ".next/cache/.ENV.production"), "private");
    await putFile(join(standalone, "node_modules/other/.env.local"), "private");
    await putFile(join(standalone, "nested/.env.d/secret"), "private");
    const sqlite = resolve("node_modules/better-sqlite3");
    const sqlitePaths = [
      "node_modules/better-sqlite3",
      "node_modules/better-sqlite3-7ab1",
      ".next/node_modules/better-sqlite3-831e",
    ].map((path) => join(standalone, path));
    for (const path of sqlitePaths) {
      await cp(sqlite, path, {
        recursive: true,
        filter: (entry) =>
          /^(?:lib|package\.json|LICENSE|prebuilds)(?:[\\/]|$)/.test(
            relative(sqlite, entry),
          ) || entry === sqlite,
      });
      await putFile(join(path, "src/sqlite.cpp"), "fixture");
      await putFile(join(path, "deps/sqlite.c"), "fixture");
      await putFile(join(path, "build/Release/sqlite.obj"), "fixture");
      await putFile(join(path, "binding.gyp"), "fixture");
    }
    const locales = join(root, "release/win-unpacked/locales");
    await putFile(join(locales, "zh-CN.pak"), "locale fixture");
    const preparePath = "../../scripts/prepare-desktop.mjs";
    const { prepareDesktop } = await import(preparePath);
    await prepareDesktop({
      root,
      guard: () => {},
      copy: async (source: string, destination: string, options: object) => {
        if (
          destination.includes("third-party-notices") ||
          destination.endsWith("node.exe")
        ) {
          await putFile(destination, "fixture");
        } else {
          await cp(source, destination, options);
        }
      },
    });

    const tree = await readdir(standalone, { recursive: true });
    expect(
      tree.filter((path) => /^\.env(?:\.|$)/i.test(basename(path))),
    ).toEqual([]);
    expect(await readFile(join(root, "public/nested/.env.local"), "utf8")).toBe(
      "private",
    );
    expect(
      await readFile(join(standalone, "public/nested/keep.txt"), "utf8"),
    ).toBe("public");
    expect(await readFile(join(locales, "zh-CN.pak"), "utf8")).toBe(
      "locale fixture",
    );
    expect(
      await readFile(
        join(standalone, ".next/desktop-prepared-build-id"),
        "utf8",
      ),
    ).toBe("fixture");
    for (const path of sqlitePaths) {
      expect(await readdir(join(path, "prebuilds"))).toEqual([
        "win32-x64.node",
      ]);
      expect((await readdir(path)).sort()).toEqual([
        "LICENSE",
        "lib",
        "package.json",
        "prebuilds",
      ]);
      for (const file of [
        "lib/index.js",
        "LICENSE",
        "package.json",
        "prebuilds/win32-x64.node",
      ])
        expect(
          (await readFile(join(path, file))).equals(
            await readFile(join(sqlite, file)),
          ),
        ).toBe(true);
      const Database = require(path);
      const db = new Database(":memory:");
      try {
        expect(db.prepare("select 42 as answer").get()).toEqual({ answer: 42 });
      } finally {
        db.close();
      }
    }
  },
);

test("electron-builder excludes dotenv files from both server resource mappings", async () => {
  const { load } = require("js-yaml");
  const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
  const { extraResources } = load(
    await readFile("electron-builder.yml", "utf8"),
  );
  expect(extraResources.map(({ to }: { to: string }) => to)).toEqual([
    "server",
    "server/node_modules",
  ]);
  const file = { isDirectory: () => false };
  for (const mapping of extraResources) {
    const from = resolve(mapping.from);
    const includes = new FileMatcher(
      from,
      mapping.to,
      (value: string) => value,
      mapping.filter,
    ).createFilter();
    for (const name of [
      ".env",
      ".env.local",
      "nested/.ENV.local",
      "nested/.env.production",
      "nested/.env.d/key",
    ]) {
      expect(includes(join(from, name), file), name).toBe(false);
    }
    expect(includes(join(from, "nested/entry.js"), file)).toBe(true);
  }
});

test.skipIf(process.platform !== "win32").each([
  ["standalone-env", "Environment file in desktop output"],
  ["staged-env", "Environment file in desktop output"],
  ["backup-failure", "injected move failure"],
  ["publish-failure", "injected move failure"],
  ["locked-rollback", "Previous release restored"],
  ["locked-rollback-and-quarantine", "Close processes locking builder.yml"],
  ["success", "Latest desktop"],
])(
  "desktop pack %s preserves or replaces the release as a unit",
  async (scenario, message) => {
    const root = join(process.env.QUANT_DATA_DIR!, `pack-${scenario}`);
    const release = join(root, "release");
    const locked = scenario.startsWith("locked-rollback");
    const recoveryRequired = scenario === "locked-rollback-and-quarantine";
    const executable = "win-unpacked/GuanlanQuant.exe";
    await putFile(join(release, "builder.yml"), "old-builder");
    await putFile(join(release, executable), "old-exe");
    await putFile(join(release, "win-unpacked/old-only.txt"), "old-extra");
    await putFile(join(root, "next-fixture/builder.yml"), "new-builder");
    await putFile(join(root, "next-fixture", executable), "new-exe");
    if (locked) {
      await putFile(join(release, "metadata.yml"), "old-metadata");
      await putFile(join(root, "next-fixture/metadata.yml"), "new-metadata");
    }
    await putFile(join(root, ".next/standalone/server.js"), "fixture");
    await putFile(
      join(root, "node_modules/.modules.yaml"),
      "nodeLinker: hoisted\n",
    );
    const server = join(root, "next-fixture/win-unpacked/resources/server");
    for (const dependency of ["next", "react", "react-dom"])
      await putFile(
        join(server, "node_modules", dependency, "package.json"),
        "{}",
      );
    if (scenario === "standalone-env")
      await putFile(join(root, ".next/standalone/.env"), "fixture");
    if (scenario === "staged-env")
      await putFile(
        join(server, "node_modules/next/.env.production"),
        "fixture",
      );
    await mkdir(join(root, "scripts"), { recursive: true });
    await copyFile(
      "scripts/pack-desktop.ps1",
      join(root, "scripts/pack-desktop.ps1"),
    );
    const harness = join(root, "pack-fixture.ps1");
    await writeFile(
      harness,
      String.raw`
param([string] $Scenario)
$ErrorActionPreference = 'Stop'
$script:restages = 0
function Get-CimInstance { }
function Start-Sleep { }
function pnpm {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'exec') {
        Microsoft.PowerShell.Management\Move-Item -LiteralPath 'next-fixture' -Destination 'release\_next'
    }
}
function Move-Item([string] $LiteralPath, [string] $Destination) {
    $sourceParent = Split-Path $LiteralPath
    $destinationParent = Split-Path $Destination
    if ($Scenario -like 'locked-rollback*') {
        $name = Split-Path $LiteralPath -Leaf
        if ($name -eq 'win-unpacked' -and (Split-Path $sourceParent -Leaf) -eq '_next') {
            if (-not (Test-Path -LiteralPath (Join-Path $destinationParent 'metadata.yml'))) {
                throw 'win-unpacked must be published last'
            }
            throw 'injected publish failure'
        }
        if ($name -eq 'builder.yml' -and (Split-Path $destinationParent -Leaf) -eq '_next') {
            throw 'injected locked rollback move'
        }
    }
    $targetMove = ($Scenario -eq 'publish-failure' -and (Split-Path $sourceParent -Leaf) -eq '_next') -or
        ($Scenario -eq 'backup-failure' -and (Split-Path $destinationParent -Leaf) -eq '_prev')
    if ($targetMove -and $script:restages -gt 0) { throw 'injected move failure' }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    if ($targetMove) { $script:restages++ }
}
function Rename-Item([string] $LiteralPath, [string] $NewName) {
    if ($Scenario -eq 'locked-rollback-and-quarantine' -and (Split-Path $LiteralPath -Leaf) -eq 'builder.yml') {
        throw 'injected locked rollback rename'
    }
    Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName
}
try { & (Join-Path $PSScriptRoot 'scripts\pack-desktop.ps1') }
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`,
    );
    const runPack = () =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          harness,
          scenario,
        ],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 },
      );
    const result = runPack();
    const success = scenario === "success";
    expect(result.status, result.error?.message ?? result.stderr).toBe(
      success ? 0 : 1,
    );
    expect(result.stdout + result.stderr).toContain(message);
    expect(await readFile(join(release, executable), "utf8")).toBe(
      success ? "new-exe" : "old-exe",
    );
    expect(await readFile(join(release, "builder.yml"), "utf8")).toBe(
      success || recoveryRequired ? "new-builder" : "old-builder",
    );
    const releaseEntries = await readdir(release);
    if (locked) {
      expect(await readFile(join(release, "metadata.yml"), "utf8")).toBe(
        "old-metadata",
      );
      expect(await readFile(join(release, "_next/metadata.yml"), "utf8")).toBe(
        "new-metadata",
      );
      expect(await readFile(join(release, "_next", executable), "utf8")).toBe(
        "new-exe",
      );
      expect(result.stderr).toContain("injected publish failure");
    }
    if (recoveryRequired) {
      const backup = join(release, "_prev");
      expect(result.stderr).toContain(
        `restore the previous release from '${backup}'`,
      );
      expect(result.stderr).toContain("injected locked rollback move");
      expect(result.stderr).toContain("injected locked rollback rename");
      expect((await readdir(backup)).sort()).toEqual([
        "builder.yml",
        "metadata.yml",
        "win-unpacked",
      ]);
      for (const [name, contents] of [
        ["builder.yml", "old-builder"],
        ["metadata.yml", "old-metadata"],
        [executable, "old-exe"],
        ["win-unpacked/old-only.txt", "old-extra"],
      ] as const)
        expect(await readFile(join(backup, name), "utf8")).toBe(contents);
      const retry = runPack();
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain(backup);
      return;
    }
    expect(releaseEntries).not.toContain("_prev");
    if (success) {
      expect(releaseEntries).not.toContain("_next");
      await expect(
        stat(join(release, "win-unpacked/old-only.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(
        await readFile(join(release, "win-unpacked/old-only.txt"), "utf8"),
      ).toBe("old-extra");
      if (scenario !== "standalone-env") {
        if (scenario === "locked-rollback") {
          const quarantines = releaseEntries.filter((name) =>
            name.startsWith("_rollback_stuck_"),
          );
          expect(quarantines).toHaveLength(1);
          expect(quarantines[0]).toMatch(/_builder\.yml$/);
          expect(await readFile(join(release, quarantines[0]!), "utf8")).toBe(
            "new-builder",
          );
          const retry = runPack();
          expect(retry.status).toBe(1);
          expect(retry.stderr).toContain("Review quarantined outputs");
          expect(await readdir(release)).toEqual(releaseEntries);
        } else {
          expect(
            await readFile(join(release, "_next", executable), "utf8"),
          ).toBe("new-exe");
          expect(
            await readFile(join(release, "_next/builder.yml"), "utf8"),
          ).toBe("new-builder");
        }
      }
    }
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "packaging preserves a startup backup when the live release is missing",
  async () => {
    const root = join(process.env.QUANT_DATA_DIR!, "pack-pending-backup");
    const backup = join(root, "release/_prev/win-unpacked/GuanlanQuant.exe");
    await putFile(backup, "previous executable");
    await mkdir(join(root, "scripts"));
    const script = join(root, "scripts/pack-desktop.ps1");
    await copyFile("scripts/pack-desktop.ps1", script);
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(1);
    expect(result.stderr).toContain("Recover the previous release");
    expect(await readFile(backup, "utf8")).toBe("previous executable");
    expect(await readdir(join(root, "release"))).toEqual(["_prev"]);
  },
);

test("a current instrumentation trace excludes old desktop release files", async ({
  skip,
}) => {
  const traceDir = ".next/server";
  const manifest = join(traceDir, "instrumentation.js.nft.json");
  const trace = await stat(manifest).catch((error: unknown) => {
    if (!isAbsent(error)) throw error;
  });
  if (!trace)
    return skip("No instrumentation trace. Run after the Next build.");
  const sources = await Promise.all(
    Object.keys(archiveSources).map((source) => stat(source)),
  );
  if (sources.some((source) => source.mtimeMs > trace.mtimeMs))
    return skip("Instrumentation trace predates the archive sources.");

  const { files } = JSON.parse(await readFile(manifest, "utf8")) as {
    files: string[];
  };
  expect(Array.isArray(files)).toBe(true);
  expect(files.length).toBeGreaterThan(0);
  const paths = files.map((file) =>
    relative(process.cwd(), resolve(traceDir, file.replaceAll("\\", "/")))
      .replaceAll("\\", "/")
      .toLowerCase(),
  );
  expect(paths.filter((path) => path.startsWith("release/"))).toEqual([]);
  expect(
    paths.filter(
      (path) =>
        basename(path) === "czsc64.dll" &&
        path !== "runtime/czsc/czsc64.dll" &&
        path !== "vendor/czsc/czsc64.dll",
    ),
  ).toEqual([]);
  expect(
    paths.filter(
      (path) =>
        basename(path) === "hq.dll" &&
        path !== "runtime/thsdk/hq.dll" &&
        path !== "vendor/thsdk/hq.dll",
    ),
  ).toEqual([]);
});

test.each(Object.entries(archiveSources))(
  "%s annotates the runtime argument of each traced path operation",
  async (file, operations) => {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const seen = new Set<string>();
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        operations.includes(node.expression.text)
      ) {
        seen.add(node.expression.text);
        expect(
          node.arguments[0]?.getFullText(source).trim(),
          node.getText(),
        ).toMatch(/^\/\*\s*turbopackIgnore:\s*true\s*\*\//);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(seen).toEqual(new Set(operations));
  },
);

test("CLI archive IDs reject traversal and illegal Windows path segments", () => {
  const nestedId = (path: string) =>
    `cli-~${Buffer.from(path).toString("base64url")}`;
  expect(decodeCliLocation(nestedId("backtest-diagnose/batch/run"))).toEqual([
    "backtest-diagnose",
    "batch",
    "run",
  ]);
  for (const id of [
    "cli-../outside",
    "cli-..\\outside",
    "cli-C:drive",
    "cli-AUX.txt",
    "cli-report.",
    nestedId("backtest-diagnose/../outside"),
    nestedId("backtest-diagnose//run"),
    nestedId("outside/batch"),
  ]) {
    expect(() => decodeCliLocation(id), id).toThrow("非法诊断归档路径");
  }
});

test("CLI discovery skips directory links and archive I/O rejects linked paths", async () => {
  const sandbox = process.env.QUANT_DATA_DIR!;
  const base = join(sandbox, "cli-links");
  const outside = join(sandbox, "outside-cli-links");
  const linked = join(base, "linked");
  await mkdir(base);
  await mkdir(outside);
  await writeFile(join(outside, "report.md"), "# 回测诊断报告");
  await symlink(outside, linked, "junction");

  await expect(discoverCliArchives(base)).resolves.toEqual([]);
  await expect(directories(base, true)).rejects.toBeInstanceOf(
    UnsafeArchivePath,
  );
  await expect(
    readCliReport(base, ["linked"], page, noDrift),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
  await expect(
    readBounded(join(linked, "report.md"), 1024),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
  await expect(
    ensureRealDirectory(join(linked, "child")),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
});

test("bounded CLI reads keep complete CSV rows and exclude the truncated row", async () => {
  const base = join(process.env.QUANT_DATA_DIR!, "cli-bounds");
  const dir = join(base, "run");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ strategyKey: "hold", symbols: ["sh600000"] }),
  );
  const csv = join(dir, "rejections.csv");
  const prefix = "orderId,date,reason\n1,2026-01-01,halted\n";
  await writeFile(csv, prefix);
  await expect(readBounded(csv, prefix.length)).resolves.toEqual({
    text: prefix,
    truncated: false,
  });
  await writeFile(
    csv,
    `${prefix}2,2026-01-02,${"x".repeat(2 * 1024 * 1024)}\n`,
  );
  await expect(readBounded(csv, prefix.length)).resolves.toEqual({
    text: prefix,
    truncated: true,
  });

  const detail = await readCliReport(base, ["run"], page, noDrift);
  expect(detail.cells[0]?.scenarios[0]).toMatchObject({
    sampleRejections: [{ orderId: 1, date: "2026-01-01", reason: "halted" }],
    rejectionReasons: [],
  });
  expect(detail.summary.driftWarnings).toContain(
    "rejections.csv 超出读取上限，仅显示已读取样本",
  );
});
