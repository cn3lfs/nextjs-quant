import { defineConfig } from "@playwright/test";
import base from "./playwright.p0.config";

const server = base.webServer;
const loaded = process.env.E2E_P1_ACCEPTANCE === "1";
if (!server || Array.isArray(server))
  throw new Error("One isolated fixture server is required");
export default defineConfig({
  ...base,
  testMatch: loaded ? "p1-acceptance.spec.ts" : "route-visual.spec.ts",
  timeout: loaded ? 180000 : base.timeout,
  snapshotPathTemplate: "{testDir}/baselines/p1/{arg}{ext}",
  use: {
    ...base.use,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    actionTimeout: 15000,
  },
  webServer: {
    ...server,
    timeout: loaded ? 120000 : server.timeout,
    env: {
      ...server.env,
      E2E_FIXTURE_PROFILE: loaded ? "workbench" : "pool",
      TZ: "Asia/Shanghai",
      E2E_P1_ACCEPTANCE: loaded ? "1" : "0",
    },
  },
});
