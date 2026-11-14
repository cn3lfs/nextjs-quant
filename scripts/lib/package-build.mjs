import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const cacheName = ".quant-build.json";
/** @param {string} root @param {string} path */
function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Build path outside its owner: ${path}`);
  return path;
}
/** @param {string} path */
function regularPath(path) {
  // Validate ancestors too: a normal-looking dist can live below a junction.
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Linked build path refused: ${current}`);
    if (dirname(current) === current) break;
  }
}
/** @param {string[]} paths @param {Set<string>} [ignored] */
function fingerprint(paths, ignored = new Set()) {
  const hash = createHash("sha256");
  /** @param {string} path @param {string} label */
  function visit(path, label) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) {
      hash.update(JSON.stringify([label, "missing"]));
      return;
    }
    if (info.isSymbolicLink())
      throw new Error(`Linked build input/output refused: ${path}`);
    if (info.isDirectory()) {
      hash.update(JSON.stringify([label, "directory"]));
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        if (!ignored.has(child)) visit(child, `${label}/${name}`);
      }
    } else if (info.isFile()) {
      const bytes = readFileSync(path);
      hash.update(JSON.stringify([label, bytes.length]));
      hash.update(bytes);
    } else throw new Error(`Unsupported build file: ${path}`);
  }
  paths.forEach((path, index) => {
    regularPath(path);
    visit(path, String(index));
  });
  return hash.digest("hex");
}
/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
/** @param {string} path */
function acquireLock(path) {
  regularPath(path);
  if (existsSync(path)) {
    const owner = readJson(path);
    if (
      owner.tool !== "quant-package-build" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      throw new Error(
        `Unrecognized build lock; inspect before removing: ${path}`,
      );
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH")
        alive = false;
    }
    if (alive)
      throw new Error(
        `Package build already running (PID ${owner.pid}): ${path}`,
      );
    unlinkSync(path);
  }
  const token = randomUUID();
  const fd = openSync(path, "wx");
  try {
    writeFileSync(
      fd,
      JSON.stringify({ tool: "quant-package-build", pid: process.pid, token }),
    );
  } finally {
    closeSync(fd);
  }
  return () => {
    regularPath(path);
    if (readJson(path).token !== token)
      throw new Error("Package build lock ownership changed");
    unlinkSync(path);
  };
}

/** pnpm owns dependency ordering; this function validates one package's inputs and outputs.
 * @param {{workspaceRoot: string, packageRoot: string, force?: boolean}} options
 */
export function buildPackage({ workspaceRoot, packageRoot, force = false }) {
  workspaceRoot = resolve(workspaceRoot);
  packageRoot = inside(join(workspaceRoot, "packages"), resolve(packageRoot));
  if (dirname(packageRoot) !== join(workspaceRoot, "packages"))
    throw new Error("Expected a direct workspace package");
  regularPath(packageRoot);
  const metadata = readJson(join(packageRoot, "package.json"));
  const output = inside(packageRoot, join(packageRoot, "dist"));
  const cachePath = join(output, cacheName);
  const lockPath = join(packageRoot, ".quant-build.lock");
  const release = acquireLock(lockPath);
  const started = Date.now();
  try {
    const require = createRequire(join(packageRoot, "package.json"));
    const compiler = require.resolve("typescript/bin/tsc");
    const compilerRoot = dirname(dirname(compiler));
    const inputPaths = [
      join(workspaceRoot, "package.json"),
      join(workspaceRoot, "pnpm-lock.yaml"),
      join(workspaceRoot, "pnpm-workspace.yaml"),
      join(workspaceRoot, ".npmrc"),
      join(workspaceRoot, "tsconfig.json"),
      join(workspaceRoot, "scripts/build-package.mjs"),
      join(workspaceRoot, "scripts/lib/package-build.mjs"),
      join(compilerRoot, "package.json"),
      compiler,
      join(compilerRoot, "lib/tsc.js"),
      join(compilerRoot, "lib/_tsc.js"),
      join(packageRoot, "package.json"),
      join(packageRoot, "tsconfig.json"),
      join(packageRoot, "src"),
    ];
    const packages = new Map(
      readdirSync(join(workspaceRoot, "packages"), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(
              join(workspaceRoot, "packages", entry.name, "package.json"),
            ),
        )
        .map((entry) => {
          const path = join(workspaceRoot, "packages", entry.name);
          return [readJson(join(path, "package.json")).name, path];
        }),
    );
    for (const [name, version] of Object.entries({
      ...metadata.dependencies,
      ...metadata.devDependencies,
    })) {
      if (!version.startsWith("workspace:")) continue;
      const dependency = packages.get(name);
      if (!dependency || !existsSync(join(dependency, "dist")))
        throw new Error(
          `Build workspace dependency ${name} first (pnpm packages:build)`,
        );
      inputPaths.push(
        join(dependency, "package.json"),
        join(dependency, "dist"),
      );
    }
    for (const path of metadata.quantBuild?.inputs ?? [])
      inputPaths.push(inside(workspaceRoot, resolve(packageRoot, path)));
    const postBuild = metadata.quantBuild?.afterCompile;
    if (postBuild)
      inputPaths.push(inside(packageRoot, resolve(packageRoot, postBuild)));
    const inputHash = () =>
      createHash("sha256")
        .update(
          JSON.stringify([process.version, process.platform, process.arch]),
        )
        .update(fingerprint(inputPaths))
        .digest("hex");
    const before = inputHash();
    const outputHash = () => fingerprint([output], new Set([cachePath]));
    regularPath(output);
    regularPath(cachePath);
    let cached;
    try {
      cached = readJson(cachePath);
    } catch (error) {
      if (
        /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    if (
      !force &&
      cached?.version === 1 &&
      cached.input === before &&
      cached.output === outputHash()
    )
      return {
        name: metadata.name,
        status: "unchanged",
        elapsedMs: Date.now() - started,
      };

    // Only this package's generated output is replaced. A deleted source cannot
    // leave an obsolete executable behind, and failed compiles never get a cache receipt.
    inside(packageRoot, output);
    regularPath(output);
    if (existsSync(output)) fingerprint([output]); // Refuse linked descendants before recursive removal.
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    execFileSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
      cwd: packageRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    if (postBuild)
      execFileSync(process.execPath, [resolve(packageRoot, postBuild)], {
        cwd: packageRoot,
        stdio: "inherit",
        windowsHide: true,
      });
    for (const entry of [metadata.main, metadata.types].filter(Boolean))
      if (!existsSync(inside(output, resolve(packageRoot, entry))))
        throw new Error(`Package build did not emit ${entry}`);
    if (before !== inputHash())
      throw new Error(`Inputs changed during ${metadata.name} build; retry`);
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, input: before, output: outputHash() }),
    );
    return {
      name: metadata.name,
      status: "built",
      elapsedMs: Date.now() - started,
    };
  } finally {
    release();
  }
}
