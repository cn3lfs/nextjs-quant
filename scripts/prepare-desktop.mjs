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
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { assertDesktopClosed, preparationError } from "./desktop-guards.mjs";

/** Turbopack native aliases can be absolute junctions into the checkout.
 * Ship real module files so moving the desktop folder cannot break resolution. */
export async function materializeStandaloneModules(root) {
  const workspace = resolve(root);
  const directory = join(workspace, ".next/standalone/.next/node_modules");
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const alias = join(directory, entry);
    if (!(await lstat(alias)).isSymbolicLink()) continue;
    const source = await realpath(alias);
    const sourceRelative = relative(workspace, source);
    if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative))
      throw new Error(`原生模块链接超出构建目录：${entry}`);
    const temporary = join(directory, `${entry}.preparing`);
    // Both mutation targets are fixed children of the standalone alias directory.
    if (dirname(alias) !== directory || dirname(temporary) !== directory)
      throw new Error("原生模块输出路径无效");
    await rm(temporary, { recursive: true, force: true });
    try {
      await copyTree(source, temporary, { recursive: true, dereference: true });
      // rm removes the junction itself; it does not traverse its target.
      await rm(alias, { recursive: true, force: true });
      await rename(temporary, alias);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function prepareDesktop({
  root = process.cwd(),
  guard = assertDesktopClosed,
  copy = copyTree,
} = {}) {
  await guard(root);
  const buildId = await readFile(join(root, ".next/BUILD_ID"), "utf8");
  const marker = join(root, ".next/standalone/.next/desktop-prepared-build-id");
  await rm(marker, { force: true });
  // Always replace static assets so obsolete chunks cannot mask an incomplete copy.
  await rm(join(root, ".next/standalone/.next/static"), {
    recursive: true,
    force: true,
  });
  const cp = (source, destination, options) =>
    copy(resolve(root, source), resolve(root, destination), options);
  const mkdir = (path, options) => makeDirectory(resolve(root, path), options);
  await mkdir(".next/standalone/.next", { recursive: true });
  await cp(".next/static", ".next/standalone/.next/static", {
    recursive: true,
  });
  await cp("public", ".next/standalone/public", { recursive: true });
  await cp("runtime", ".next/standalone/runtime", { recursive: true });
  await mkdir(".next/standalone/node-runtime", { recursive: true });
  await cp(process.execPath, ".next/standalone/node-runtime/node.exe");
  await mkdir(".next/standalone/third-party-notices", { recursive: true });
  await cp(
    join(dirname(process.execPath), "LICENSE"),
    ".next/standalone/third-party-notices/Node-LICENSE",
  );
  await cp(
    "node_modules/lightweight-charts/LICENSE",
    ".next/standalone/third-party-notices/Lightweight-Charts-LICENSE",
  );
  await cp(
    "THIRD_PARTY_NOTICES.md",
    ".next/standalone/third-party-notices/README.md",
  );
  await cp(
    "docs/data-sources/public-factors/qlib-v0.9.7/LICENSE",
    ".next/standalone/third-party-notices/Qlib-LICENSE",
  );
  await materializeStandaloneModules(root);
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
  process.exitCode = await runPrepare();
}
