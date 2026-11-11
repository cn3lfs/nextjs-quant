import { readFile } from "node:fs/promises";
import { csiHash } from "./csi800-factor-data.js";
export async function classicCodeHashes() {
  const files = [
    "packages/trading-strategies/src/study-decision.ts",
    "packages/trading-strategies/src/csi800-model.ts",
    "packages/trading-strategies/src/ma-cross.ts",
    "packages/quant-backtest/src/csi800-study.ts",
    "packages/trading-strategies/src/csi800-position-risk.ts",
    "packages/trading-strategies/src/csi800-signal.ts",
    "packages/trading-strategies/src/csi800-factors.ts",
    "packages/trading-strategies/src/csi800-composite.ts",
    "packages/quant-backtest/package.json",
    "scripts/lib/csi800-factor-data.ts",
    "scripts/lib/csi800-factor-matrix.ts",
    "scripts/lib/csi800-trade-evaluation.ts",
    "scripts/lib/csi800-factor-diagnostics.ts",
    "scripts/lib/csi800-research-manifest.ts",
    "scripts/research-csi800-factors.ts",
    "scripts/run-prepared-csi800-factors.ts",
    "scripts/run-csi800-factors.ps1",
    "src/server/data-sources/tdx/local-financial-files.ts",
    "packages/trading-strategy-core/src/financial/metrics.ts",
    "packages/trading-strategy-core/src/factors/catalog.ts",
    "packages/trading-strategy-core/src/factors/market-style.ts",
    "packages/trading-strategy-core/src/factors/trend.ts",
    "packages/trading-strategy-core/src/factors/statistics.ts",
    "packages/trading-strategy-core/src/indicators.ts",
    "packages/trading-strategy-core/src/money.ts",
    "packages/tstdx/src/local/financial-files.ts",
    "packages/tstdx/src/financial.ts",
    "packages/tstdx/src/financial-data/model.ts",
    "packages/tstdx/src/financial-data/catalog.ts",
    "packages/tstdx/src/financial-data/catalog-source.ts",
    "packages/tstdx/src/financial-series.ts",
    "packages/quant-performance/src/performance.ts",
    "packages/quant-performance/src/trades.ts",
    "packages/quant-performance/src/report.ts",
    "packages/quant-performance/package.json",
    "pnpm-lock.yaml",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, csiHash(await readFile(file))]),
    ),
  );
}
