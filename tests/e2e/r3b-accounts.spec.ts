import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
for (const width of [1440, 1024])
  test(`R3b 今日到风险持仓归因与衰减 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") writes.push(r.url());
    });
    await page.goto("/");
    const risk = page.getByRole("link", {
      name: "复盘风险持仓 sh600000 · 手工账本 · 真实",
      exact: true,
    });
    await expect(risk).toBeVisible();
    await risk.click(); // One interaction from Today to full attribution and decay.
    const detail = page.getByRole("region", { name: "持仓归因与衰减" });
    await expect(detail.getByText("归因与衰减", { exact: true })).toBeVisible();
    await expect(detail.getByText("衰减已标记", { exact: true })).toBeVisible();
    await expect(detail.getByText(/提醒前推：30 样本/)).toBeVisible();
    await expect(detail.getByText(/距止损/).first()).toBeVisible();
    if (width === 1440) {
      await expect(
        page
          .getByRole("navigation", { name: "工作台导航" })
          .getByRole("link", { name: "手工记账", exact: true }),
      ).toHaveAttribute("href", "/accounts?tab=ledger");
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const screens = resolve(
      process.env.E2E_DATA_DIR ?? ".test-data/r3b/e2e-accounts",
      "..",
      "screens",
    );
    await mkdir(screens, { recursive: true });
    await page.screenshot({
      path: resolve(screens, `position-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByText("衰减已标记", { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await page.goto("/accounts");
    await expect(
      page.getByRole("region", { name: "统一持仓", exact: true }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "本地模拟", exact: true }).click();
    await expect(page.getByText("暂无数据。", { exact: true })).toBeVisible();
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "IntersectionObserver");
    });
    await page.goto("/accounts?tab=trades");
    const trades = page.getByRole("region", { name: "成交来源明细" });
    await expect(trades.getByText("已加载 20 / 共 30 条")).toBeVisible();
    await trades.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(trades.getByText("已全部加载 · 共 30 条")).toBeVisible();
    await trades
      .getByRole("row")
      .nth(21)
      .getByRole("button", { name: "手工关联", exact: true })
      .click();
    await page
      .getByRole("button", { name: "保存人工关联", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "关联已保存，审计记录保留。" }),
    ).toBeVisible();
    await page.goto("/system?tab=account-risk");
    await expect(
      page.getByRole("heading", { name: "账户敞口与复盘设置", exact: true }),
    ).toBeVisible();
  });
