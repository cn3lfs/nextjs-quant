import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** @param {string} workspaceRoot @param {string} directory */
function checkDirectory(workspaceRoot, directory) {
  const owner = join(workspaceRoot, ".test-data");
  const rel = relative(owner, directory);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(
      "Check data must stay under this workspace's .test-data directory",
    );
  for (let path = directory; ; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Linked check directory refused: ${path}`);
    if (dirname(path) === path) break;
  }
}

/**
 * A fresh database and temp directory are mandatory, even if the caller has production env settings.
 * @param {{workspaceRoot: string, pnpmCli?: string, checkRoot?: string, includeBuild?: boolean,
 * runCommand?: (command: string, args: string[], options: import('node:child_process').SpawnSyncOptions & {env: NodeJS.ProcessEnv}) => {status: number | null}}} options
 */
export function runLocalChecks({
  workspaceRoot,
  pnpmCli,
  checkRoot,
  includeBuild = false,
  runCommand = (command, args, options) => spawnSync(command, args, options),
}) {
  workspaceRoot = resolve(workspaceRoot);
  checkRoot = resolve(checkRoot ?? join(workspaceRoot, ".test-data/checks"));
  checkDirectory(workspaceRoot, checkRoot);
  if (!pnpmCli) throw new Error("Run this entry through pnpm check");
  mkdirSync(checkRoot, { recursive: true });
  const dataDirectory = mkdtempSync(join(checkRoot, "check-"));
  const temporaryDirectory = join(dataDirectory, "temp");
  mkdirSync(temporaryDirectory);
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      [
        "QUANT_DATA_DIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "QUANT_CHECK_ACTIVE",
        "QUANT_RESEARCH_BAR_STORE_DIR",
      ].includes(key.toUpperCase())
    )
      delete inherited[key];
  }
  const env = {
    ...inherited,
    QUANT_CHECK_ACTIVE: "1",
    QUANT_DATA_DIR: dataDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  /** @type {{startedAt: number, finishedAt: number|null, dataDirectory: string, exitCode: number, steps: {name:string,exitCode:number,elapsedMs:number}[]}} */
  const report = {
    startedAt: Date.now(),
    finishedAt: null,
    dataDirectory,
    exitCode: 0,
    steps: [],
  };
  const commands = [
    "format:check",
    "check:dependencies",
    "runtime:build",
    "typecheck",
    "lint",
    "test",
    ...(includeBuild ? ["build"] : []),
  ];
  for (const name of commands) {
    console.log(`\n[check] ${name}`);
    const started = Date.now();
    let result;
    try {
      result = runCommand(process.execPath, [pnpmCli, "run", name], {
        cwd: workspaceRoot,
        env,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (error) {
      console.error(
        `Could not start ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      result = { status: 1 };
    }
    const exitCode =
      typeof result.status === "number" &&
      Number.isInteger(result.status) &&
      result.status >= 0
        ? result.status
        : 1;
    report.steps.push({ name, exitCode, elapsedMs: Date.now() - started });
    if (exitCode !== 0) {
      report.exitCode = exitCode;
      break;
    }
  }
  report.finishedAt = Date.now();
  writeFileSync(
    join(dataDirectory, "check-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `[check] ${report.exitCode === 0 ? "passed" : "failed"}; isolated data: ${dataDirectory}`,
  );
  return report;
}
