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
  const paths = await runtimeValidationSourcePaths();
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture-source\n");
  }
  const baseline = await runtimeValidationHash(root);
  for (const path of [
    "src/lib/backtest/portfolio-forward-distribution.ts",
    "src/server/paper/assessment.ts",
    "src/server/paper/registration.ts",
    "src/server/db/forward-reference-repository.ts",
    "src/server/research/forward-identity.ts",
  ]) {
    expect(paths).toContain(path);
    await writeFile(join(root, path), "changed-adapter\n");
    expect(await runtimeValidationHash(root)).not.toBe(baseline);
    await writeFile(join(root, path), "fixture-source\n");
  }
  await mkdir(join(root, "src/components"), { recursive: true });
  await writeFile(join(root, "src/components/unrelated.tsx"), "changed UI\n");
  expect(await runtimeValidationHash(root)).toBe(baseline);
});
