import { expect, test } from "./workbench-test";
import { budgets, waitForJob } from "./helpers";

/** Runs a fixed formula on synthetic local securities and waits for this run. */
async function screen(page: import("@playwright/test").Page) {
  await page.goto("/scan?tab=formula", { waitUntil: "networkidle" });
  const expand = page.getByRole("button", {
    name: "展开编辑公式",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
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
  await expect(
    page.getByRole("button", { name: "查看监控名单", exact: true }),
  ).toBeEnabled();
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
  await page.getByRole("button", { name: "查看监控名单", exact: true }).click();
  const preview = page.getByRole("list", { name: "带入监控的候选" });
  await preview.waitFor();
  const previewSymbols = await preview
    .getByRole("listitem")
    .evaluateAll((rows) =>
      rows
        .map((r) => (r as HTMLElement).innerText.match(/(bj|sh|sz)\d{6}/i)?.[0])
        .filter((s): s is string => !!s)
        .map((s) => s.toLowerCase()),
    );
  expect(previewSymbols).toEqual(symbols);
  const started = Date.now();
  await page.getByRole("button", { name: "打开监控草稿", exact: true }).click();
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

test("candidate buttons step the frozen chart within the confirmed page", async ({
  page,
}) => {
  await screen(page);
  const symbols = await candidateSymbols(page);
  await page
    .getByRole("button", { name: /个股研究/ })
    .nth(1)
    .click();
  const position = page.getByRole("status").filter({ hasText: "本页" });
  await expect(position).toContainText(`本页 2/${symbols.length}`);
  const next = page.getByRole("button", { name: "下一只", exact: true });
  const previous = page.getByRole("button", { name: "上一只", exact: true });
  for (let i = 0; i < 5; i++) {
    await next.click();
    await expect(position).toContainText(`本页 ${3 + i}/${symbols.length}`);
  }
  // The chart shows the 7th candidate of the same run.
  await expect(page.locator(".chart-panel").first()).toContainText(
    symbols[6]!.slice(2),
  );
  // A stale normal list must not hijack the frozen candidate with PageDown.
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("PageDown");
  await expect(position).toContainText(`本页 7/${symbols.length}`);
  await expect(page.locator(".chart-panel").first()).toContainText(
    symbols[6]!.slice(2),
  );
  for (let i = 0; i < 6; i++) {
    await previous.click();
    await expect(position).toContainText(`本页 ${6 - i}/${symbols.length}`);
  }
  await expect(previous).toBeDisabled();
});

test("frozen evidence survives a failed ordinary snapshot and browser back", async ({
  page,
}) => {
  await screen(page);
  const symbols = await candidateSymbols(page);
  const symbol = symbols[0]!;
  await page
    .getByRole("button", { name: /个股研究/ })
    .first()
    .click();
  const frozen = page.getByRole("status", {
    name: "冻结候选证据",
    exact: true,
  });
  await expect(frozen).toBeVisible();
  await expect(frozen).toContainText(symbol.toUpperCase());
  const frozenUrl = page.url();
  const snapshotId = new URL(frozenUrl).searchParams.get("screenSnapshot");
  expect(snapshotId).toBeTruthy();

  // Fail only the first ordinary snapshot mutation; the retry falls through to
  // the existing offline guard and the real local fixture.
  let ordinarySnapshots = 0;
  await page.route("**/api/trpc/**", async (route) => {
    const names = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/api/trpc/")[1] ?? "",
    ).split(",");
    if (route.request().method() !== "POST" || !names.includes("snapshot"))
      return route.fallback();
    ordinarySnapshots++;
    if (ordinarySnapshots === 1) return route.abort("failed");
    return route.fallback();
  });

  await page
    .getByRole("button", { name: "在普通行情中查看", exact: true })
    .click();
  await expect(page).not.toHaveURL(/screenSnapshot/);
  const loadFailure = page
    .getByRole("alert")
    .filter({ hasText: "所选数据源读取失败" });
  await expect(loadFailure).toBeVisible();
  // The failed ordinary read must leave the archived chart and its evidence.
  await expect(frozen).toBeVisible();
  await expect(frozen).toContainText(symbol.toUpperCase());
  await expect(page.locator(".chart-panel").first()).toContainText(
    symbol.toUpperCase(),
  );
  expect(ordinarySnapshots).toBe(1);

  await loadFailure.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => ordinarySnapshots).toBe(2);
  await expect(frozen).toHaveCount(0);
  await expect(loadFailure).toHaveCount(0);
  await expect(page.locator(".chart-panel").first()).toContainText(
    symbol.toUpperCase(),
  );

  await page.goBack();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("screenSnapshot") === snapshotId,
  );
  await expect(frozen).toBeVisible();
  await expect(frozen).toContainText(symbol.toUpperCase());
});
