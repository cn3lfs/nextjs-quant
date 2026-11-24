import { execFileSync } from "node:child_process";
import { build, version as esbuildVersion } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import {
  mkdir,
  cp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeValidationHash } from "./lib/runtime-validation-identity.mjs";
import { performance } from "node:perf_hooks";

// Keep the cache outside the worker tree, which is traced and shipped as-is.
/** @typedef {{input: string, contents: string, files?: string[]}} RuntimeArtifact */
/** @typedef {import('esbuild').BuildOptions & {outfile: string}} BundleOptions */
/** @typedef {BundleOptions & {metafile: true, write: false}} InMemoryBundleOptions */
/** @typedef {(options: InMemoryBundleOptions) => Promise<import('esbuild').BuildResult<InMemoryBundleOptions>>} BuildOutput */

const cachePath = "node_modules/.cache/quant-runtime-build.json";
/** @type {Record<string, RuntimeArtifact>} */
let cached = {};
/** @type {Record<string, RuntimeArtifact>} */
const artifacts = {};
let reused = 0;
let rebuilt = 0;
const require = createRequire(import.meta.url);

/** @param {import('node:crypto').BinaryLike} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} path */
function fileHash(path) {
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    )
      return null;
    throw error;
  }
}

/** @param {string} path */
function outputHash(path) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile()
    ? fileHash(path)
    : null;
}

/** @param {string} root */
function treeHash(root, followLinks = false) {
  const hash = createHash("sha256");
  const stat = followLinks ? statSync : lstatSync;
  /** @param {string} path @param {string} name */
  function visit(path, name) {
    const info = stat(path, { throwIfNoEntry: false });
    hash.update(JSON.stringify([name, info?.isDirectory(), info?.isFile()]));
    if (info?.isDirectory())
      for (const entry of readdirSync(path).sort())
        visit(join(path, entry), `${name}/${entry}`);
    if (info?.isFile()) {
      const contents = fileHash(path);
      if (contents === null)
        throw new Error(`Runtime file disappeared: ${path}`);
      hash.update(contents);
    }
  }
  visit(root, "");
  return hash.digest("hex");
}

/** @param {string} path @returns {Promise<Record<string, RuntimeArtifact>>} */
async function readJsonCache(path) {
  try {
    const cache = JSON.parse(await readFile(path, "utf8"));
    return cache?.version === 1 ? (cache.artifacts ?? {}) : {};
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      return {};
    throw error;
  }
}

/** @param {string} path @param {string | Uint8Array} bytes */
async function writeChanged(path, bytes) {
  if (outputHash(path) === sha256(bytes)) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @param {string} output @param {string} input @param {string | null} contents */
function isCurrent(output, input, contents) {
  const previous = cached[output];
  if (previous?.input !== input || previous.contents !== contents) return false;
  artifacts[output] = previous;
  reused++;
  return true;
}

/** @param {string} source @param {string} output */
async function copyArtifact(source, output, directory = false) {
  const fingerprint = directory ? treeHash : outputHash;
  const hashSource = () =>
    directory ? treeHash(source, true) : fileHash(source);
  /** @param {string | null} sourceHash */
  const hashInput = (sourceHash) =>
    sha256(JSON.stringify([fileHash("pnpm-lock.yaml"), source, sourceHash]));
  const sourceHash = hashSource();
  const input = hashInput(sourceHash);
  if (isCurrent(output, input, fingerprint(output))) return;
  if (directory) {
    await rm(output, { recursive: true, force: true });
    await cp(source, output, { recursive: true, dereference: true });
  } else {
    await writeChanged(output, await readFile(source));
  }
  const contents = fingerprint(output);
  if (contents === null || contents !== sourceHash)
    throw new Error(`Runtime copy changed while building: ${output}`);
  if (hashInput(hashSource()) === input)
    artifacts[output] = { input, contents };
  rebuilt++;
}

function bundleContext() {
  const projectTrees = ["src", "electron", "scripts/lib"];
  const projectConfig = [
    "package.json",
    "tsconfig.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "pnpm-lock.yaml",
    "scripts/build-runtime.mjs",
  ];
  for (const pkg of readdirSync("packages", { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const root = `packages/${pkg.name}`;
    projectTrees.push(`${root}/src`, `${root}/dist`);
    projectConfig.push(`${root}/package.json`, `${root}/tsconfig.json`);
  }
  // A new .ts file can shadow a .js import absent from the previous metafile.
  return [
    process.version,
    esbuildVersion,
    ...projectConfig.map((path) => [path, fileHash(path)]),
    ...projectTrees.map((path) => [
      path,
      readdirSync(path, { recursive: true, withFileTypes: true })
        .map((entry) => relative(path, join(entry.parentPath, entry.name)))
        .sort(),
    ]),
  ];
}

/** @param {BundleOptions} options @param {string[]} inputs */
function bundleInputHash(options, inputs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(bundleContext())).update(JSON.stringify(options));
  for (const path of inputs) {
    hash.update(JSON.stringify([path, fileHash(path)]));
  }
  return hash.digest("hex");
}

/** @param {import('esbuild').Metafile} metafile */
function bundleInputs(metafile) {
  const files = new Set(Object.keys(metafile.inputs));
  for (const path of [...files]) {
    // Package metadata participates in esbuild's exports/main resolution.
    for (
      let dir = dirname(path);
      dir !== "." && dir !== dirname(dir);
      dir = dirname(dir)
    ) {
      files.add(join(dir, "package.json"));
    }
  }
  return [...files].sort();
}

/**
 * @param {BundleOptions} config
 * @param {string[]} [previousInputs]
 * @param {BuildOutput} [buildOutput]
 */
export async function buildRuntimeBundle(
  config,
  previousInputs,
  buildOutput = build,
) {
  async function run() {
    const { metafile, outputFiles } = await buildOutput({
      ...config,
      metafile: true,
      write: false,
    });
    const output = outputFiles[0];
    if (outputFiles.length !== 1 || !output)
      throw new Error(
        `Expected one output from runtime bundle: ${config.outfile}`,
      );
    return { files: bundleInputs(metafile), output: output.contents };
  }

  // Cold builds first discover the dependency graph without publishing it.
  let inputs = previousInputs ?? (await run()).files;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = bundleInputHash(config, inputs);
    const { files, output } = await run();
    const after = bundleInputHash(config, files);
    if (before === after && JSON.stringify(inputs) === JSON.stringify(files)) {
      const contents = sha256(output);
      await writeChanged(config.outfile, output);
      return { contents, entry: { files, input: after, contents } };
    }
    inputs = files;
  }
  throw new Error(`Runtime bundle inputs did not stabilize: ${config.outfile}`);
}

/** @param {BundleOptions} params */
async function bundle({ outfile, ...options }) {
  /** @type {BundleOptions} */
  const config = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    ...options,
    outfile,
  };
  const cachedFiles = cached[outfile]?.files;
  const previousInputs =
    Array.isArray(cachedFiles) &&
    cachedFiles.every((path) => typeof path === "string")
      ? cachedFiles
      : undefined;
  const contents = outputHash(outfile);
  if (
    contents &&
    previousInputs &&
    isCurrent(outfile, bundleInputHash(config, previousInputs), contents)
  )
    return contents;

  const result = await buildRuntimeBundle(config, previousInputs);
  artifacts[outfile] = result.entry;
  rebuilt++;
  return result.contents;
}

async function buildRuntime() {
  const started = performance.now();
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/build-tdx-import.ps1",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  cached = await readJsonCache(cachePath);
  await bundle({
    entryPoints: ["src/server/data-sources/westock/westock-preload.ts"],
    outfile: "runtime/westock-preload.mjs",
    format: "esm",
  });
  await bundle({
    entryPoints: ["src/server/portfolio/discipline-worker.ts"],
    outfile: "runtime/discipline-worker.cjs",
  });
  await bundle({
    entryPoints: ["src/server/jobs/workflow-runner.ts"],
    outfile: "runtime/workflow-runner.cjs",
    external: ["better-sqlite3", "koffi"],
  });
  await bundle({
    entryPoints: ["src/server/screening/rps-worker.ts"],
    outfile: "runtime/rps-worker.cjs",
    external: ["better-sqlite3"],
  });
  const koffiMain = require.resolve("koffi");
  const koffiRequire = createRequire(koffiMain);
  // The native workers are independent Node entrypoints. Carry both the JS loader and
  // its optional native package; Next tracing cannot infer koffi's dynamic load.
  await copyArtifact(dirname(koffiMain), "runtime/node_modules/koffi", true);
  await copyArtifact(
    dirname(koffiRequire.resolve("@koromix/koffi-win32-x64")),
    "runtime/node_modules/@koromix/koffi-win32-x64",
    true,
  );
  await copyArtifact("vendor/czsc/CZSC64.dll", "runtime/czsc/CZSC64.dll");
  await bundle({
    entryPoints: ["src/server/strategies/chan/czsc-worker.ts"],
    outfile: "runtime/czsc-worker.cjs",
    external: ["koffi"],
  });
  await bundle({
    entryPoints: ["src/server/data-sources/thsdk/thsdk-worker.ts"],
    outfile: "runtime/thsdk-worker.cjs",
    external: ["koffi"],
  });
  const maEngineHash = createHash("sha256");
  for (const file of [
    ...(await readdir("packages/quant-backtest/src", { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(
        (file) => `packages/quant-backtest/src/${file.replaceAll("\\", "/")}`,
      ),
    ...(await readdir("packages/quant-execution/src", { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(
        (file) => `packages/quant-execution/src/${file.replaceAll("\\", "/")}`,
      ),
    ...(await readdir("packages/trading-strategies/src", { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(
        (file) =>
          `packages/trading-strategies/src/${file.replaceAll("\\", "/")}`,
      ),
    "packages/trading-strategy-core/src/indicators.ts",
    "packages/trading-strategy-core/src/money.ts",
    "packages/trading-strategy-core/src/costs.ts",
    "packages/trading-strategy-core/src/market-rules.ts",
    ...(
      await readdir("packages/trading-strategy-core/src/factors", {
        recursive: true,
      })
    )
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(
        (file) =>
          `packages/trading-strategy-core/src/factors/${file.replaceAll("\\", "/")}`,
      ),
    "pnpm-lock.yaml",
  ]) {
    maEngineHash.update(file).update(await readFile(file));
  }
  const validationBuildHash = await runtimeValidationHash();
  const portfolioExecutionHash = maEngineHash.digest("hex");
  const workerSha256 = await bundle({
    entryPoints: ["src/server/jobs/worker.ts"],
    define: {
      __MA_BASELINE_BUILD_HASH__: JSON.stringify(portfolioExecutionHash),
      __RESEARCH_VALIDATION_BUILD_HASH__: JSON.stringify(validationBuildHash),
    },
    external: ["better-sqlite3"],
    outfile: "runtime/worker.cjs",
  });
  const { strategyBuildHash } = await import("trading-strategies");
  await writeChanged(
    "runtime/research-validation-identity.json",
    JSON.stringify({
      version: "runtime-execution-1",
      hash: validationBuildHash,
      engineHash: portfolioExecutionHash,
      strategyHash: strategyBuildHash,
      workerSha256,
    }),
  );
  await bundle({
    entryPoints: ["electron/main.ts"],
    outfile: "desktop/main.cjs",
    external: ["electron"],
  });
  await bundle({
    entryPoints: ["electron/preload.ts"],
    outfile: "desktop/preload.cjs",
    external: ["electron"],
  });
  const icon = "desktop/icon.png";
  const iconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#287f96"/><path d="M10 38h12l6-20 10 32 6-20h10" fill="none" stroke="white" stroke-width="4"/></svg>';
  const sharpPath = require.resolve("sharp", {
    paths: [require.resolve("next/package.json")],
  });
  const hashIconInput = () =>
    sha256(
      JSON.stringify([
        fileHash("pnpm-lock.yaml"),
        fileHash("scripts/build-runtime.mjs"),
        iconSvg,
        sharpPath,
        fileHash(sharpPath),
      ]),
    );
  const iconInput = hashIconInput();
  const iconContents = outputHash(icon);
  if (!iconContents || !isCurrent(icon, iconInput, iconContents)) {
    const sharp = require(sharpPath);
    const png = await sharp(Buffer.from(iconSvg)).png().toBuffer();
    await writeChanged(icon, png);
    if (hashIconInput() === iconInput)
      artifacts[icon] = { input: iconInput, contents: sha256(png) };
    rebuilt++;
  }

  // The paused intraday regression starts this exact runtime bundle.
  await bundle({
    entryPoints: ["src/server/monitoring/intraday-worker.ts"],
    outfile: "runtime/intraday-worker.cjs",
    external: ["better-sqlite3", "koffi"],
  });

  // Drop stale bundles of retired workers from incremental packages.
  await rm("runtime/signal-ledger-worker.cjs", { force: true });
  await rm("runtime/research-worker.cjs", { force: true });
  await writeChanged(cachePath, JSON.stringify({ version: 1, artifacts }));
  console.log(
    `[runtime] ${rebuilt} rebuilt, ${reused} unchanged (${Math.round(performance.now() - started)} ms)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildRuntime();
