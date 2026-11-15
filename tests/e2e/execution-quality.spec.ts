import { expect, test } from "./workbench-test";
import { trpcCalls, waitForIdleServer } from "./helpers";

const sectionReads = new Set([
  "tradeReviewExecution",
  "tradeReviewPeriodPerformance",
  "tradeReviewRollingPerformance",
  "tradeReviewAdmission",
]);

test("review reads only the selected section and preserves hidden section drafts", async ({
  page,
}) => {
  await page.goto("/accounts/review", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: "账户复盘", exact: true }).click();
  await page.getByLabel("复盘账户别名").fill("big10k");
  const calls = await trpcCalls(page, async () => {
    await page.getByRole("button", { name: "查看复盘" }).click();
    await expect(
      page
        .getByRole("table", { name: "月度收益", exact: true })
        .getByRole("row")
        .nth(1),
    ).toBeVisible({ timeout: 30000 });
    await page.waitForLoadState("networkidle");
  });
  expect(calls).toContain("tradeReviewSnapshot");
  expect(
    calls.filter((name) => sectionReads.has(name)),
    "Hidden sections must not fetch after selecting an account",
  ).toEqual([]);
  const executionCalls = await trpcCalls(page, async () => {
    await page.getByRole("radio", { name: "执行质量", exact: true }).click();
    await expect(
      page.getByRole("table", { name: "逐笔执行质量" }).getByRole("row").nth(1),
    ).toBeVisible();
  });
  expect(executionCalls).toContain("tradeReviewExecution");
  await page.getByLabel("标的搜索", { exact: true }).fill("600001");
  await page.getByRole("radio", { name: "概览", exact: true }).click();
  await page.getByRole("radio", { name: "执行质量", exact: true }).click();
  await expect(page.getByLabel("标的搜索", { exact: true })).toHaveValue(
    "600001",
  );
  await page.waitForLoadState("networkidle");
  for (const [label, procedure, table] of [
    ["分段表现", "tradeReviewPeriodPerformance", "分段表现"],
    ["滚动表现", "tradeReviewRollingPerformance", "滚动绩效完整指标"],
    ["纪律与准入", "tradeReviewAdmission", "准入年度分指标"],
  ] as const) {
    const selectedCalls = await trpcCalls(page, async () => {
      await page.getByRole("radio", { name: label, exact: true }).click();
      await expect(
        page.getByRole("table", { name: table, exact: true }),
      ).toBeVisible();
      await page.waitForLoadState("networkidle");
    });
    expect(
      new Set(selectedCalls.filter((name) => sectionReads.has(name))),
      label,
    ).toEqual(new Set([procedure]));
  }
});

/** Uses big10k (9418 fills); big remains uncached for the 2222-fill budget. */
async function openReview(page: import("@playwright/test").Page) {
  await waitForIdleServer(page);
  await page.goto("/accounts/review", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: "账户复盘", exact: true }).click();
  await page.getByLabel("复盘账户别名").fill("big10k");
  await page.getByRole("button", { name: "查看复盘" }).click();
  await page.getByRole("radio", { name: "执行质量", exact: true }).click();
  await page
    .getByRole("table", { name: "逐笔执行质量" })
    .getByRole("row")
    .nth(1)
    .waitFor({ timeout: 30000 });
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
    /ths-big10k\.txt · 导入于 .* · 原始第 \d+ 行/,
  );
  await expect(detail).toContainText("当日日线原始 VWAP");
  await expect(detail).toContainText("费用分项");
  await expect(detail.getByRole("heading", { level: 3 })).toBeFocused();
  // Escape on another section must not close or focus the hidden detail.
  await page.getByRole("radio", { name: "概览", exact: true }).click();
  await expect(detail).toBeHidden();
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "执行质量", exact: true }).click();
  await expect(detail).toBeVisible();
  // To the import batch and back.
  await detail.getByRole("button", { name: "在导入批次中查看" }).click();
  const back = page.getByRole("button", { name: "返回执行质量" });
  await expect(back).toBeVisible();
  await expect(page.locator("#cash-delivery-workspace")).toContainText(
    "ths-big10k.txt",
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
