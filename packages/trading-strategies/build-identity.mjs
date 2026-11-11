import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(packageRoot, "../..");
async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesAt(location);
      return /\.(ts|json)$/.test(entry.name) ? [location] : [];
    }),
  );
  return files.flat();
}
const files = (
  await Promise.all(
    [
      "packages/trading-strategies/src",
      "packages/trading-strategy-core/src",
      "packages/quant-backtest/src",
      "packages/tstdx/src",
      "packages/quant-rps/src",
    ].map((directory) => filesAt(path.join(workspaceRoot, directory))),
  )
).flat();
files.push(
  path.join(workspaceRoot, "pnpm-lock.yaml"),
  fileURLToPath(import.meta.url),
);
files.sort((a, b) =>
  path
    .relative(workspaceRoot, a)
    .replaceAll("\\", "/")
    .localeCompare(path.relative(workspaceRoot, b).replaceAll("\\", "/"), "en"),
);
const hash = createHash("sha256");
for (const file of files) {
  const name = path.relative(workspaceRoot, file).replaceAll("\\", "/");
  // Ignore checkout line endings; paths and file lengths keep boundaries unambiguous.
  const content = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  hash.update(JSON.stringify([name, content]));
}
const digest = hash.digest("hex");
await writeFile(
  path.join(packageRoot, "dist/build-identity.js"),
  `export const strategyBuildHash = ${JSON.stringify(digest)};\n`,
);
await writeFile(
  path.join(packageRoot, "dist/build-identity.d.ts"),
  "export declare const strategyBuildHash: string;\n",
);
