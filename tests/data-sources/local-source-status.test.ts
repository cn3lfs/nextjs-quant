import { expect, it } from "vitest";
import { resolve } from "node:path";
import { screeningRouter } from "~/server/api/routers/screening";
import { settings, saveSettings } from "~/server/infra/settings";
import { localFinancialView } from "~/server/financial/local-financial-service";

it("keeps both membership RPS tasks unavailable until required paths are configured", async () => {
  const caller = screeningRouter.createCaller({ headers: new Headers() });
  for (const source of ["tdx", "blocks"] as const) {
    saveSettings({
      ...settings(),
      tdxRoot: "",
      industryMembershipSource: source,
      industryBlocksRoot: resolve("blocks"),
    });
    expect(await caller.industryRpsStatus()).toMatchObject({
      ready: false,
      tdxConfigured: false,
    });
    expect(await caller.conceptRpsStatus()).toMatchObject({
      ready: false,
      tdxConfigured: false,
    });
  }
  saveSettings({
    ...settings(),
    tdxRoot: resolve("tdx"),
    industryBlocksRoot: "",
  });
  expect(await caller.industryRpsStatus()).toMatchObject({
    ready: false,
    tdxConfigured: true,
  });
  saveSettings({ ...settings(), industryMembershipSource: "tdx" });
  expect(await caller.industryRpsStatus()).toMatchObject({ ready: true });
});

it("returns a setup prerequisite instead of a failure for unconfigured financial data", async () => {
  expect(await localFinancialView("", { symbol: "sh600519" })).toMatchObject({
    prerequisite: { code: "tdx-root-missing" },
  });
});
