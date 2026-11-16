import { it, expect } from "vitest";
import { appRouter } from "~/server/api/root";
import { settings, saveSettings } from "~/server/infra/settings";
import { accountReviewSettingsSchema } from "~/lib/portfolio/account-workspace";

it("an older general settings draft cannot overwrite newer account caps and decay settings", async () => {
  const caller = appRouter.createCaller({ headers: new Headers() }),
    original = settings(),
    stale = {
      ...original,
      accountReview: accountReviewSettingsSchema.parse({}),
    };
  saveSettings(stale);
  const current = {
    portfolioLimits: {
      enabled: true,
      symbolWeight: 0.12,
      heat: 0.04,
      industryWeight: 0.25,
    },
    caps: [
      {
        market: "cn-equity" as const,
        dimension: "symbol" as const,
        key: "sh600000",
        fraction: 0.15,
      },
    ],
    decayPercentile: 0.08,
    minimumSamples: 40,
    chaseFraction: 0.02,
  };
  try {
    await caller.saveAccountReviewSettings(current);
    await caller.saveSettings({ ...stale, codexModel: "QA-updated-model" });
    expect(settings().accountReview).toEqual(current);
    expect(settings().codexModel).toBe("QA-updated-model");
    expect(settings().alerts.mode).toBe(stale.alerts.mode);
  } finally {
    saveSettings(original);
  }
});
