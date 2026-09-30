import { expect, test } from "@playwright/test";
import { waitForIdleServer } from "./helpers";

/** TDX keys work with focus on the page, not only on the chart (was
 * tests/chart-keys-browser.mjs on synthetic bars). */
test("arrow keys walk the bar cursor from the page and Esc leaves it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await waitForIdleServer(page);
  await page.goto("/market", { waitUntil: "networkidle" });
  const chart = page.getByTestId("market-chart").first();
  await chart.locator("canvas").first().waitFor();
  const legend = () =>
    chart.getByTestId("chart-legend").locator("span").first().innerText();
  const latest = await legend();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // The first ← puts the cursor on the last visible bar, later ones step.
  await page.keyboard.press("ArrowLeft");
  expect(await legend()).toBe(latest);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  const back4 = await legend();
  expect(back4 < latest).toBe(true);
  await page.keyboard.press("ArrowRight");
  const back3 = await legend();
  expect(back3 > back4 && back3 < latest).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(legend).toBe(latest);
  expect(errors).toEqual([]);
});
