import { join } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: process.env.QUANT_DATA_DIR
    ? join(process.env.QUANT_DATA_DIR, "quant-backtest-vitest")
    : undefined,
  test: { fsModuleCache: true, include: ["tests/**/*.test.ts"] },
});
