import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  runtimeValidationHash,
  runtimeValidationSourcePaths,
} from "../../scripts/lib/runtime-validation-identity.mjs";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it("changing an actual distribution/binding adapter changes the existing validation identity; UI does not", async () => {
  const root = await mkdtemp(
    join(process.env.QUANT_DATA_DIR!, "validation-identity-"),
  );
  directories.push(root);
  for (const directory of [
    "packages/quant-performance/src",
    "src/server/alerts/inputs",
    "src/server/research",
  ])
    await mkdir(join(root, directory), { recursive: true });
  const paths = await runtimeValidationSourcePaths(root);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture-source\n");
  }
  const baseline = await runtimeValidationHash(root);
  // Any discovered execution source changes the identity; the list itself is
  // not frozen to a particular adapter file.
  const adapter = paths.find((path) => path.startsWith("src/server/"))!;
  await writeFile(join(root, adapter), "changed-adapter\n");
  expect(await runtimeValidationHash(root)).not.toBe(baseline);
  await writeFile(join(root, adapter), "fixture-source\n");
  await mkdir(join(root, "src/components"), { recursive: true });
  await writeFile(join(root, "src/components/unrelated.tsx"), "changed UI\n");
  expect(await runtimeValidationHash(root)).toBe(baseline);

  const nestedSource = "src/server/research/lifecycle/nested/new-source.ts";
  await mkdir(dirname(join(root, nestedSource)), { recursive: true });
  await writeFile(join(root, nestedSource), "new adapter\n");
  expect(await runtimeValidationSourcePaths(root)).toEqual(
    [...paths, nestedSource].sort(),
  );
  expect(await runtimeValidationHash(root)).not.toBe(baseline);
});
