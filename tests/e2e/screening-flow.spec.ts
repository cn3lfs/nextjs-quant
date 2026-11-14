import { expect, test } from "./workbench-test";
import { budgets, waitForJob } from "./helpers";

/** Runs a fixed formula on synthetic local securities and waits for this run. */
async function screen(page: import("@playwright/test").Page) {
  await page.goto("/screen", { waitUntil: "networkidle" });
  await page.getByLabel("公式源码", { exact: true }).fill("选股:C>0;");
  await page.getByRole("button", { name: "语法检查与未来函数门禁" }).click();
  await page.getByRole("button", { name: "全市场执行公式" }).click();
  await expect(page).toHaveURL((url) => !!url.searchParams.get("job"));
  const id = new URL(page.url()).searchParams.get("job")!;
  const job = await waitForJob(page, id);
  expect(job.type).toBe("screen");
  expect(job.isFormulaScreen).toBe(true);
  expect(job.status, job.error).toBe("completed");
  // The table re-renders with this run's candidates.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /只加入监控/ }).waitFor();
}
const candidateSymbols = (page: import("@playwright/test").Page) =>
  page
    .getByRole("table", { name: "候选结果", exact: true })
    .getByRole("row")
    .evaluateAll((rows) =>
      rows
        .map((r) => (r as HTMLElement).innerText.match(/(bj|sh|sz)\d{6}/i)?.[0])
        .filter((s): s is string => !!s)
        .map((s) => s.toLowerCase()),
    );

test("screening candidates open as an unsaved monitor draft", async ({
  page,
}) => {
  await screen(page);
  const symbols = (await candidateSymbols(page)).slice(0, 20);
  const started = Date.now();
  await page.getByRole("button", { name: /只加入监控/ }).click();
  const editor = page.locator('section[aria-label="订阅编辑"]');
  await editor.waitFor();
  expect(Date.now() - started).toBeLessThanOrEqual(
    budgets.monitorPrefillOpenMs,
  );
  await expect(editor).toContainText("未保存");
  const field = await editor
    .locator("input")
    .evaluateAll((inputs) =>
      inputs
        .map((i) => (i as HTMLInputElement).value)
        .find((v) => /^(bj|sh|sz)\d{6}/.test(v)),
    );
  expect(field?.split(/\s+/)).toEqual(symbols);
  // The prefill parameter is consumed, not left in the address bar.
  expect(page.url()).not.toContain("monitorNew");
});

test("PageUp/PageDown step through the list the chart was opened from", async ({
  page,
}) => {
  await screen(page);
  const symbols = await candidateSymbols(page);
  await page
    .getByRole("button", { name: /个股研究/ })
    .nth(1)
    .click();
  const status = page.getByRole("status").filter({ hasText: "选股候选" });
  await expect(status).toContainText(`2/${symbols.length}`);
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  const started = Date.now();
  for (let i = 0; i < 5; i++) await page.keyboard.press("PageDown");
  await expect(status).toContainText(`7/${symbols.length}`);
  await page.waitForLoadState("networkidle");
  expect(Date.now() - started).toBeLessThanOrEqual(budgets.browseStepMs * 5);
  // The chart shows the 7th candidate of the same run.
  await expect(page.locator(".chart-panel").first()).toContainText(
    symbols[6]!.slice(2),
  );
  for (let i = 0; i < 10; i++) await page.keyboard.press("PageUp");
  await expect(status).toContainText("已是第一只");
});
