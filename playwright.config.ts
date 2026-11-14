import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fixtureDirectory } from "./tests/e2e/fixture-directory";

/**
 * Browser acceptance against a production build (`pnpm build && pnpm
 * desktop:prepare`) served from an isolated data directory — never the
 * user's database. Each run creates fresh synthetic daily data and the
 * `big` / `big10k` accounts (2222 / 9418 fills). Unknown existing services
 * are never reused. All outputs stay under the validated task directory.
 *   pnpm e2e
 */
const port = Number(process.env.E2E_PORT ?? 3217);
const directory = fixtureDirectory(
  process.env.E2E_DATA_DIR ?? ".test-data/workbench-acceptance",
);
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // Fixed P0 fixtures use their own fresh server via playwright.p0.config.ts.
  testIgnore: [
    "p0-workflow.spec.ts",
    "stock-pool.spec.ts",
    "route-visual.spec.ts",
    "p1-acceptance.spec.ts",
  ],
  timeout: 3 * 60 * 1000,
  // One server, shared state (jobs, cache): run specs one at a time.
  workers: 1,
  outputDir: fixtureDirectory(resolve(directory, "results")),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(directory, "report.json") }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e/p0-server.ts",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      PORT: String(port),
      E2E_DATA_DIR: directory,
      E2E_FIXTURE_PROFILE: "workbench",
    },
  },
});
