import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const studySourceRoots = [
  "src/server/market/bar-store",
  "src/lib/market",
  "packages/tstdx/src",
  "src/server/strategies/chan",
] as const;

/** Cache projections still execute readers on replay. Bind those transitive
 * adapters as well as the already-frozen strategy/portfolio/metric build. */
export async function studySourceIdentity() {
  const paths = [
    "scripts/lib/research-scale-sources.ts",
    "src/server/data-sources/tdx/local-financial-files.ts",
    "src/server/strategies/strategy-center-native.ts",
  ];
  for (const root of studySourceRoots) {
    for (const name of await readdir(root, { recursive: true }))
      if (/\.(ts|json)$/.test(name))
        paths.push(join(root, name).replaceAll("\\", "/"));
  }
  const hash = createHash("sha256"),
    files: { path: string; sha256: string }[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readFile(path);
    files.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    hash.update(path).update(bytes);
  }
  return { version: "r2a3-reader-identity-1", hash: hash.digest("hex"), files };
}
