import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const adapters = [
  "src/lib/backtest/backtest-overfit.ts",
  "src/lib/backtest/multiple-testing.ts",
  "src/lib/backtest/daily-performance.ts",
  "src/lib/backtest/portfolio-forward-distribution.ts",
  "src/lib/market/crypto-aggregation.ts",
  "src/lib/market/close-scan-window.ts",
  "src/server/research/index-context.ts",
  "src/server/research/forward-identity.ts",
  "src/server/strategies/strategy-center-native.ts",
  "src/server/strategies/drivers/paper.ts",
  "src/server/strategies/drivers/evaluation.ts",
  "src/server/strategies/drivers/watch.ts",
  "src/server/data-sources/tdx/local-financial-files.ts",
  "src/server/paper/assessment.ts",
  "src/server/paper/advance.ts",
  "src/server/paper/advance-clock.ts",
  "src/server/paper/decisions.ts",
  "src/server/paper/inputs.ts",
  "src/server/paper/registration.ts",
  "src/server/db/forward-reference-repository.ts",
  "src/server/db/strategy-lab.ts",
  "src/server/portfolio/account-expectation-service.ts",
  "scripts/lib/runtime-validation-identity.mjs",
  "pnpm-lock.yaml",
];
export async function runtimeValidationSourcePaths(root = process.cwd()) {
  const paths = [...adapters];
  for (const directory of [
    "packages/quant-performance/src",
    "src/server/research",
  ]) {
    const files = (
      await readdir(join(root, directory), { recursive: true })
    ).filter(
      (file) =>
        file.endsWith(".ts") &&
        (directory.startsWith("packages/") || file.startsWith("validation-")),
    );
    paths.push(
      ...files.map((file) => `${directory}/${file.replaceAll("\\", "/")}`),
    );
  }
  return [...new Set(paths)].sort();
}
export async function runtimeValidationHash(root = process.cwd()) {
  const hash = createHash("sha256");
  for (const path of await runtimeValidationSourcePaths(root))
    hash.update(path).update(await readFile(join(root, path)));
  return hash.digest("hex");
}
