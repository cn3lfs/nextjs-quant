import { defineConfig } from "@playwright/test";

/**
 * Browser acceptance against a production build (`pnpm build && pnpm
 * desktop:prepare`) served from an isolated data directory — never the
 * user's database. E2E_DATA_DIR defaults to .test-data/wb-baseline, which
 * holds a scanned TDX index, a loaded snapshot and the synthetic `big` /
 * `big10k` delivery accounts (scripts/gen-ths-fixture.ts). Specs may add
 * records (jobs, research usage) to that directory.
 *   pnpm e2e
 */
const port = Number(process.env.E2E_PORT ?? 3217);
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 10 * 60 * 1000,
  // One server, shared state (jobs, cache): run specs one at a time.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1600, height: 1000 },
  },
  webServer: {
    command: "node scripts/start.mjs",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 120 * 1000,
    env: {
      PORT: String(port),
      QUANT_DATA_DIR:
        process.env.E2E_DATA_DIR ?? `${process.cwd()}/.test-data/wb-baseline`,
    },
  },
});
