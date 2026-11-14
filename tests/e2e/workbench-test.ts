import { test as base, expect } from "@playwright/test";
import { installOfflineVisualApi } from "./offline-visual-api";

// Only these reviewed local worker/configuration calls are added to the
// visual read policy. No subscriptions, model calls, notification or trading.
const localMutations = new Set([
  "checkFormula",
  "saveFormula",
  "formulaScreen",
  "factorEvaluate",
  "maBaseline",
  "cancel",
]);

export async function guardWorkbenchPage(
  page: import("@playwright/test").Page,
) {
  return installOfflineVisualApi(page, new Set(), undefined, localMutations);
}

export const test = base.extend<{ offlineGuard: void }>({
  offlineGuard: [
    async ({ page }, use) => {
      const api = await guardWorkbenchPage(page);
      await use();
      expect([...api.unknown], "Unclassified application requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
