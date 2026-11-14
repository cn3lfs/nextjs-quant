import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fixtureDirectory } from "./tests/e2e/fixture-directory";

const port = Number(process.env.E2E_PORT ?? 3917);
const directory = fixtureDirectory(
  process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance",
);
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "p0-workflow.spec.ts",
  outputDir: fixtureDirectory(resolve(directory, "results")),
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e/p0-server.ts",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: String(port),
      E2E_DATA_DIR: directory,
      E2E_FIXTURE_PROFILE: "core",
    },
  },
});
