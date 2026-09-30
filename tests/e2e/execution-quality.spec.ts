import { expect, test } from "@playwright/test";
import { waitForIdleServer } from "./helpers";

/** Opens the review of the synthetic `big` account (2222 fills, ths-big.txt). */
async function openReview(page: import("@playwright/test").Page) {
  await waitForIdleServer(page);
  await page.goto("/trade-review", { waitUntil: "networkidle" });
  await page.getByLabel("复盘账户别名").fill("big");
  await page.getByRole("button", { name: "查看复盘" }).click();
  await page
    .getByRole("table", { name: "逐笔执行质量" })
    .or(page.locator('[aria-label="逐笔执行质量"]'))
    .first()
    .waitFor({ timeout: 5 * 60 * 1000 });
}

test("a fill's evidence comes from the delivery statement and round-trips to its batch", async ({
  page,
}) => {
  await openReview(page);
  const execution = page.locator('section[aria-label="执行质量"]');
  const first = execution.getByRole("button", { name: "详情" }).first();
  const firstId = await first.getAttribute("id");
  await first.click();
  const detail = page.locator('section[aria-label="成交依据"]');
  await expect(detail).toContainText("交割单记录");
  await expect(detail).toContainText(
    /ths-big\.txt · 导入于 .* · 原始第 \d+ 行/,
  );
  await expect(detail).toContainText("当日日线原始 VWAP");
  await expect(detail).toContainText("费用分项");
  await expect(detail.getByRole("heading", { level: 3 })).toBeFocused();
  // To the import batch and back.
  await detail.getByRole("button", { name: "在导入批次中查看" }).click();
  const back = page.getByRole("button", { name: "返回执行质量" });
  await expect(back).toBeVisible();
  await expect(page.locator("#cash-delivery-workspace")).toContainText(
    "ths-big.txt",
  );
  await back.click();
  await expect(detail.getByRole("heading", { level: 3 })).toBeFocused();
  // Esc closes the detail and returns focus to the row's button.
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  if (firstId) await expect(page.locator(`[id="${firstId}"]`)).toBeFocused();
});

test("a group drills down to exactly its fills and export states its conditions", async ({
  page,
}) => {
  await openReview(page);
  const execution = page.locator('section[aria-label="执行质量"]');
  const groups = execution.locator('[aria-label="执行质量分组汇总"]');
  const firstGroup = await groups.getByRole("row").nth(1).innerText();
  const [code, count] = [
    firstGroup.match(/\d{6}/)?.[0],
    Number(firstGroup.split(/\s+/)[1]),
  ];
  await groups.getByRole("button", { name: "查看成交" }).first().click();
  await expect(
    execution.getByRole("button", { name: `代码 ${code} ×` }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  const rowCodes = await execution
    .locator('[aria-label="逐笔执行质量"]')
    .getByRole("row")
    .allInnerTexts();
  expect(rowCodes.slice(1).every((t) => t.includes(code!))).toBe(true);
  const download = page.waitForEvent("download");
  await execution.getByRole("button", { name: "导出 CSV" }).click();
  await download;
  await expect(
    execution.getByRole("status").filter({ hasText: "已导出" }),
  ).toContainText(`已导出 ${count} 笔（按点击时的条件：代码 ${code}`);
  // Removing the chip restores the full list.
  await execution.getByRole("button", { name: `代码 ${code} ×` }).click();
  await expect(
    execution.getByRole("button", { name: `代码 ${code} ×` }),
  ).toHaveCount(0);
});

test("the review page settles instead of growing (autoSize charts need a fixed height)", async ({
  page,
}) => {
  await openReview(page);
  await page.waitForLoadState("networkidle");
  const height = () => page.evaluate(() => document.body.scrollHeight);
  const before = await height();
  await page.waitForTimeout(2000);
  expect(await height()).toBe(before);
});
