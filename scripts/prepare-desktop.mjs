import {
  cp as copyTree,
  mkdir as makeDirectory,
  readdir,
  realpath,
  lstat,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import { pathToFileURL } from "node:url";
import { assertDesktopClosed, preparationError } from "./desktop-guards.mjs";

const isEnvFile = (name) => /^\.env(?:\.|$)/i.test(name);
const excludeEnv = (path) => !isEnvFile(basename(path));
const moduleTrees = [
  "node_modules",
  ".next/node_modules",
  "runtime/node_modules",
];

async function assertRealDirectory(path, required = false) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  });
  if (info && !info.isDirectory())
    throw new Error(`Standalone destination must be a real directory: ${path}`);
  return !!info;
}

async function standaloneDirectory(root) {
  const next = join(await realpath(root), ".next");
  await assertRealDirectory(next, true);
  const path = join(next, "standalone");
  await assertRealDirectory(path, true);
  return path;
}

async function assertModuleDestinations(standalone, requireNext = false) {
  await assertRealDirectory(join(standalone, ".next"), requireNext);
  for (const directory of ["runtime", ...moduleTrees])
    await assertRealDirectory(join(standalone, directory));
}

async function assertCopyTree(path) {
  if (!(await assertRealDirectory(path))) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Link in standalone copy destination: ${child}`);
    if (entry.isDirectory()) await assertCopyTree(child);
  }
}

async function stripStandaloneEnv(standalone, rejectLinks = false) {
  async function walk(directory, remove) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (isEnvFile(entry.name)) {
        if (!remove) throw new Error(`Environment file in standalone: ${path}`);
        await rm(path, { recursive: entry.isDirectory(), force: true });
      } else if (entry.isDirectory()) {
        await walk(path, remove);
      } else if (rejectLinks && entry.isSymbolicLink()) {
        throw new Error(`Link in standalone: ${path}`);
      }
    }
  }
  await walk(standalone, true);
  await walk(standalone, false);
}

async function pruneSqlitePrebuilds(standalone) {
  for (const modules of ["node_modules", ".next/node_modules"]) {
    const directory = join(standalone, modules);
    const packages = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of packages) {
      if (
        !entry.isDirectory() ||
        !/^better-sqlite3(?:-[\da-f]+)?$/i.test(entry.name)
      )
        continue;
      const pkg = join(directory, entry.name);
      const prebuilds = join(pkg, "prebuilds");
      const binaries = await readdir(prebuilds, { withFileTypes: true });
      if (
        !binaries.some(
          (file) => file.isFile() && file.name === "win32-x64.node",
        )
      )
        throw new Error(`Windows x64 SQLite binding missing: ${pkg}`);

      for (const binary of binaries) {
        if (binary.name !== "win32-x64.node")
          await rm(join(prebuilds, binary.name), {
            recursive: binary.isDirectory(),
            force: true,
          });
      }
      for (const artifact of ["src", "deps", "build", "binding.gyp"])
        await rm(join(pkg, artifact), { recursive: true, force: true });
    }
  }
}

/** Turbopack native aliases can be absolute junctions into the checkout.
 * Ship real module files so moving the desktop folder cannot break resolution. */
export async function materializeStandaloneModules(root) {
  const workspace = await realpath(root);
  const standalone = await standaloneDirectory(workspace);
  await assertModuleDestinations(standalone);
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (isEnvFile(entry)) continue;
      const alias = join(directory, entry);
      const info = await lstat(alias);
      if (info.isSymbolicLink()) {
        const source = await realpath(alias);
        const sourceRelative = relative(workspace, source);
        if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative))
          throw new Error(`模块链接超出构建目录：${entry}`);
        const temporary = join(directory, `${entry}.preparing`);
        if (dirname(alias) !== directory || dirname(temporary) !== directory)
          throw new Error("模块输出路径无效");
        await rm(temporary, { recursive: true, force: true });
        try {
          await copyTree(source, temporary, {
            recursive: true,
            dereference: true,
            filter: excludeEnv,
          });
          await rm(alias, { recursive: true, force: true });
          await rename(temporary, alias);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      } else if (info.isDirectory()) await walk(alias);
    }
  }
  for (const tree of moduleTrees) await walk(join(standalone, tree));
}

export async function prepareDesktop({
  root = process.cwd(),
  guard = assertDesktopClosed,
  copy = copyTree,
} = {}) {
  await guard(root);
  const standalone = await standaloneDirectory(root);
  const buildId = await readFile(join(root, ".next/BUILD_ID"), "utf8");
  const next = join(standalone, ".next");
  await assertModuleDestinations(standalone, true);
  await assertRealDirectory(join(next, "static"));
  for (const directory of [
    "public",
    "runtime",
    "node-runtime",
    "third-party-notices",
  ])
    await assertCopyTree(join(standalone, directory));
  for (const modules of ["node_modules", ".next/node_modules"]) {
    const scope = join(standalone, modules, "@koromix");
    await assertRealDirectory(scope);
    await assertCopyTree(join(scope, "koffi-win32-x64"));
  }
  const marker = join(next, "desktop-prepared-build-id");
  await rm(marker, { force: true });
  // Always replace static assets so obsolete chunks cannot mask an incomplete copy.
  await rm(join(next, "static"), {
    recursive: true,
    force: true,
  });
  const cp = (source, destination, options) =>
    copy(
      resolve(root, source),
      join(standalone, destination),
      options?.recursive ? { ...options, filter: excludeEnv } : options,
    );
  await cp(".next/static", ".next/static", {
    recursive: true,
  });
  await cp("public", "public", { recursive: true });
  await cp("runtime", "runtime", { recursive: true });
  // Koffi loads its platform binary relative to its own package directory.
  // Turbopack's hashed aliases live in .next/node_modules, outside the worker
  // dependency tree; tracing only includes the native package manifest.
  for (const modules of ["node_modules", ".next/node_modules"])
    await cp(
      "runtime/node_modules/@koromix/koffi-win32-x64",
      `${modules}/@koromix/koffi-win32-x64`,
      { recursive: true, dereference: true },
    );
  await makeDirectory(join(standalone, "node-runtime"), { recursive: true });
  await cp(process.execPath, "node-runtime/node.exe");
  await makeDirectory(join(standalone, "third-party-notices"), {
    recursive: true,
  });
  await cp(
    join(dirname(process.execPath), "LICENSE"),
    "third-party-notices/Node-LICENSE",
  );
  await cp(
    "node_modules/lightweight-charts/LICENSE",
    "third-party-notices/Lightweight-Charts-LICENSE",
  );
  await cp("THIRD_PARTY_NOTICES.md", "third-party-notices/README.md");
  await cp(
    "docs/data-sources/public-factors/qlib-v0.9.7/LICENSE",
    "third-party-notices/Qlib-LICENSE",
  );
  await materializeStandaloneModules(root);
  await stripStandaloneEnv(standalone, true);
  await pruneSqlitePrebuilds(standalone);
  await writeFile(marker, buildId);
}

export async function runPrepare(options) {
  try {
    await prepareDesktop(options);
    return 0;
  } catch (error) {
    console.error(preparationError(error));
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === "--strip-env") {
    // Next copies loaded dotenv files independently of its tracing rules.
    await stripStandaloneEnv(await standaloneDirectory(process.cwd()));
  } else {
    process.exitCode = await runPrepare();
  }
}
