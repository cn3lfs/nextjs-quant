import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const adapters = [
  "src/lib/backtest/backtest-overfit.ts",
  "src/lib/backtest/multiple-testing.ts",
  "src/lib/backtest/daily-performance.ts",
  "src/lib/backtest/portfolio-forward-distribution.ts",
  "src/lib/backtest/economic-fills.ts",
  "src/lib/market/crypto-aggregation.ts",
  "src/lib/market/market-session.ts",
  "src/lib/market/close-scan-window.ts",
  "src/server/research/index-context.ts",
  "src/server/research/forward-identity.ts",
  "src/server/strategies/strategy-center-native.ts",
  "src/server/strategies/drivers/paper.ts",
  "src/server/strategies/drivers/evaluation.ts",
  "src/server/strategies/drivers/watch.ts",
  "src/server/strategies/drivers/book.ts",
  "src/server/alerts/inputs.ts",
  "src/server/db/paper-repository.ts",
  "src/server/research/lifecycle-score.ts",
  "src/server/research/lifecycle-source.ts",
  "src/server/research/lifecycle-candidate.ts",
  "src/server/research/corporate-actions.ts",
  "scripts/lib/research/lifecycle-menu.ts",
  "scripts/lib/research/lifecycle-runner.ts",
  "research/configs/l3.json",
  "src/server/data-sources/tdx/local-financial-files.ts",
  "src/server/paper/assessment.ts",
  "src/server/paper/advance.ts",
  "src/server/paper/advance-clock.ts",
  "src/server/paper/decisions.ts",
  "src/server/paper/inputs.ts",
  "src/server/paper/cn-book-context.ts",
  "src/server/research/lifecycle-low-zone.ts",
  "scripts/lib/csi800-factor-data.ts",
  "src/server/market/industry-blocks.ts",
  "src/server/market/bar-store/corporate-actions.ts",
  "src/server/market/bar-store/read-bars.ts",
  "src/server/market/bar-store/local-source.ts",
  "src/server/market/bar-store/binance-archive-source.ts",
  "src/server/data-sources/binance/public-data.ts",
  "src/server/data-sources/binance/public-data-store.ts",
  "src/server/market/data-health.ts",
  "packages/tstdx/src/local/gbbq.ts",
  "packages/tstdx/src/local/gbbq-key.ts",
  "packages/tstdx/src/local/quotes.ts",
  "packages/tstdx/src/local/files.ts",
  "packages/tstdx/src/local/calendar.ts",
  "packages/tstdx/src/local/financial-files.ts",
  "packages/tstdx/src/financial.ts",
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
    const base = join(root, directory);
    for (const entry of await readdir(base, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = relative(
        base,
        join(entry.parentPath, entry.name),
      ).replaceAll("\\", "/");
      if (
        directory.startsWith("packages/") ||
        file.startsWith("validation-") ||
        file.startsWith("lifecycle/")
      ) {
        paths.push(`${directory}/${file}`);
      }
    }
  }
  return [...new Set(paths)].sort();
}
export async function runtimeValidationHash(root = process.cwd()) {
  const hash = createHash("sha256");
  for (const path of await runtimeValidationSourcePaths(root))
    hash.update(path).update(await readFile(join(root, path)));
  return hash.digest("hex");
}
