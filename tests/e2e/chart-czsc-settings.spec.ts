import { expect, test } from "@playwright/test";
import { waitForIdleServer } from "./helpers";

test("缠论设置 drives the chart structure from the DLL option table", async ({
  page,
}) => {
  await waitForIdleServer(page);
  await page.goto("/market", { waitUntil: "networkidle" });
  const chart = page.getByTestId("market-chart").first();
  await chart.locator("canvas").first().waitFor();
  const status = page.getByTestId("czsc-status").first();
  await expect(status).toContainText(/笔 \d+/, { timeout: 120_000 });
  const before = await status.innerText();

  await page.getByRole("button", { name: "缠论设置" }).click();
  // Opening must not pop a tooltip by auto-focusing the first info icon.
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // Each row explains its choices; the selected one is spelled out below.
  await page.getByRole("button", { name: "笔算法说明" }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("独立K线");
  await expect(tip).toContainText("分型笔");
  await expect(tip).toContainText("上证指数样本端点数");
  await page.screenshot({ path: "test-results/czsc-settings-tooltip.png" });
  // Radix closes on pointermove outside its grace area; hover() jumps without moves.
  const away = (await page
    .getByRole("combobox", { name: "线段算法" })
    .boundingBox())!;
  await page.mouse.move(away.x + 50, away.y + 10, { steps: 20 });
  await expect(tip).toBeHidden();
  await expect(page.getByRole("dialog")).toContainText("最严格");
  await page.getByRole("combobox", { name: "笔算法" }).click();
  // Option labels and provenance come from czsc_config_options (api v7).
  await expect(page.getByRole("option", { name: /老笔|严格/ })).toBeVisible();
  await page.getByRole("option", { name: /分型笔（社区口径）/ }).click();
  await page.keyboard.press("Escape");

  await expect(status).not.toHaveText(before, { timeout: 120_000 });
  await expect(status).toContainText(/笔 \d+/);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nq-czsc-settings") ?? "{}"),
  );
  expect(stored.state.stroke).toBe(4);

  // Segment boundary (api v8) only applies to feature-sequence segments.
  await page.getByRole("button", { name: "缠论设置" }).click();
  const boundary = page.getByRole("combobox", { name: "线段分界点" });
  await expect(boundary).toBeEnabled();
  await page.getByRole("combobox", { name: "线段算法" }).click();
  await page.getByRole("option", { name: /启发式/ }).click();
  await expect(boundary).toBeDisabled();
  await page.getByRole("combobox", { name: "线段算法" }).click();
  await page.getByRole("option", { name: /特征序列/ }).click();
  await boundary.click();
  await page.getByRole("option", { name: /合并起始笔/ }).click();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("nq-czsc-settings")!).state.segmentEnd,
    ),
  ).toBe(1);

  // Persisted across reloads; restore the default for other specs.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "缠论设置" }).click();
  await expect(page.getByRole("combobox", { name: "笔算法" })).toContainText(
    "分型笔",
  );
  await page.getByRole("button", { name: "恢复默认" }).click();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("nq-czsc-settings")!).state.stroke,
    ),
  ).toBe(0);
});
