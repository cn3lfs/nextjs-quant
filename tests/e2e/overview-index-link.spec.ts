import { expect, test } from "@playwright/test";
import { waitForIdleServer } from "./helpers";

test("an overview index opens that index even after the default chart loaded", async ({
  page,
}) => {
  await waitForIdleServer(page);
  // The overview initialises the workbench with the default security first.
  await page.goto("/", { waitUntil: "networkidle" });
  const pulse = page.getByTestId("market-pulse");
  await pulse.waitFor();
  await pulse.locator('a[href="/market?symbol=sh000001"]').click();
  await expect(page).toHaveURL(/\/market\?symbol=sh000001$/);
  await expect(
    page.getByRole("combobox", { name: "搜索品种名称或代码" }),
  ).toHaveValue(/SH000001/i, { timeout: 60_000 });
});
