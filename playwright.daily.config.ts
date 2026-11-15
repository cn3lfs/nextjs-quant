import { defineConfig } from "@playwright/test";
import p0 from "./playwright.p0.config";
const server = Array.isArray(p0.webServer) ? p0.webServer[0]! : p0.webServer!;
export default defineConfig({
  ...p0,
  testMatch: "r3a-daily-path.spec.ts",
  webServer: { ...server, env: { ...server.env, E2E_R3A: "1" } },
});
