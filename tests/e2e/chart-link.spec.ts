import { expect, test } from "@playwright/test";
import { budgets, waitForIdleServer } from "./helpers";

const legendDate = (chart: import("@playwright/test").Locator) =>
  chart.getByTestId("chart-legend").locator("span").first().innerText();

test("a second period shares the crosshair both ways within the step budget", async ({
  page,
}) => {
  await waitForIdleServer(page);
  await page.goto("/market", { waitUntil: "networkidle" });
  const main = page.getByTestId("market-chart").first();
  await main.waitFor();
  await page.getByRole("combobox", { name: "联动周期" }).click();
  await page.getByRole("option", { name: "周线" }).click();
  const second = page.locator('section[aria-label="联动图：周线"]');
  await second.getByTestId("market-chart").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);

  // Main → week: the week bar that contains the hovered day.
  await main.scrollIntoViewIfNeeded();
  const box = (await main.locator("canvas").first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const script = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "ScriptDuration",
    )!.value;
  const steps = 40;
  const before = await script();
  for (let i = 0; i < steps; i++)
    await page.mouse.move(
      box.x + box.width * (0.3 + i * 0.01),
      box.y + box.height * 0.4,
    );
  const perStep = (((await script()) - before) * 1000) / steps;
  expect(perStep).toBeLessThanOrEqual(budgets.linkedCrosshairScriptMsPerStep);
  const day = await legendDate(main),
    week = await legendDate(second);
  expect(week >= day).toBe(true);
  expect(Date.parse(week) - Date.parse(day)).toBeLessThan(7 * 86400_000);

  // Week → main: a day inside the hovered week.
  await second.scrollIntoViewIfNeeded();
  const sb = (await second.locator("canvas").first().boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.85, sb.y + sb.height * 0.4);
  await expect
    .poll(async () => {
      const [d, w] = [await legendDate(main), await legendDate(second)];
      return w >= d && Date.parse(w) - Date.parse(d) < 7 * 86400_000;
    })
    .toBe(true);
});
