import { expect, test } from "./workbench-test";
import { waitForIdleServer } from "./helpers";

test("Escape cancels a drawing tool before the canvas receives focus", async ({
  page,
}) => {
  await waitForIdleServer(page);
  await page.goto("/scan", { waitUntil: "networkidle" });
  const workspace = page.getByTestId("chart-workspace").first();
  const drawings = workspace.locator("summary").filter({ hasText: "已画图形" });
  const before = await drawings.innerText();
  await workspace
    .getByRole("button", { name: "画线：浏览", exact: true })
    .click();
  const tools = page.getByRole("dialog", { name: "画线工具设置" });
  await tools.getByRole("button", { name: "趋势线", exact: true }).click();
  await expect(
    workspace.getByRole("button", { name: "画线：趋势线", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tools).toBeHidden();
  await expect(
    workspace.getByRole("button", { name: "画线：浏览", exact: true }),
  ).toBeVisible();
  await expect(drawings).toHaveText(before);
});

/** TDX keys work with focus on the page, not only on the chart (was
 * tests/chart-keys-browser.mjs on synthetic bars). */
test("arrow keys walk the bar cursor from the page and Esc leaves it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await waitForIdleServer(page);
  await page.goto("/scan", { waitUntil: "networkidle" });
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
