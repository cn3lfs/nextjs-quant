import { defineConfig } from "@playwright/test";
import base from "./playwright.p0.config";

const server = base.webServer;
if (!server || Array.isArray(server))
  throw new Error("Acceptance requires one isolated fixture server");

export default defineConfig({
  ...base,
  testMatch: ["stock-pool.spec.ts", "chart-shared-drawings.spec.ts"],
  webServer: {
    ...server,
    env: { ...server.env, E2E_FIXTURE_PROFILE: "pool" },
  },
});
