import { defineConfig } from "@playwright/test";
import base from "./playwright.p0.config";

const server = base.webServer;
if (!server || Array.isArray(server))
  throw new Error("One isolated fixture server is required");
export default defineConfig({
  ...base,
  testMatch: "route-visual.spec.ts",
  use: {
    ...base.use,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
  webServer: {
    ...server,
    env: { ...server.env, E2E_FIXTURE_PROFILE: "pool", TZ: "Asia/Shanghai" },
  },
});
