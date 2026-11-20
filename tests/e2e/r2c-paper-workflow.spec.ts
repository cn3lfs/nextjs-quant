import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
for (const width of [1440, 1024]) {
  test(`R2c ${width}: full-height sidebar, unclipped scan and paper account flow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const candidates = page.getByRole("region", {
      name: "明日计划",
      exact: true,
    });
    await expect(
      candidates.getByRole("columnheader", { name: "入场 / 止损 / 目标" }),
    ).toBeVisible();
    await candidates.getByRole("link", { name: /sh600000 · 打开图表/ }).click();
    await expect(
      page.getByRole("application", { name: /行情图：/ }),
    ).toBeVisible();
    const quoteRail = page.getByRole("complementary", { name: "盘口指标" });
    await expect(quoteRail).toBeVisible();
    await expect(page.getByRole("tab", { name: "计划双价" })).toHaveCount(0);
    const levels = page.getByText(/入场 .*止损 .*目标 .* · 原价/);
    await expect(levels).toBeVisible();
    const geometry = await quoteRail.evaluate((element) => {
      const workspace = element.closest(".nc-market-terminal")!;
      const rect = workspace.getBoundingClientRect();
      const sidebar = document.querySelector(".sidebar")!;
      const shell = document.querySelector(".app-shell")!;
      return {
        workspaceWidth: rect.width,
        workspaceRight: rect.right,
        viewport: window.innerWidth,
        clip: element.scrollWidth - element.clientWidth,
        sidebarHeight: sidebar.getBoundingClientRect().height,
        pageHeight: shell.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    const levelsClip = await levels.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(geometry.workspaceWidth).toBeGreaterThan(width === 1440 ? 900 : 600);
    expect(geometry.clip).toBeLessThanOrEqual(1);
    expect(levelsClip).toBeLessThanOrEqual(1);
    expect(geometry.workspaceRight).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.sidebarHeight).toBeGreaterThanOrEqual(
      geometry.pageHeight - 1,
    );
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    const screens = resolve(
      process.env.E2E_DATA_DIR ?? ".test-data/r2c/e2e-paper",
      "..",
      "screens",
    );
    await mkdir(screens, { recursive: true });
    await page.screenshot({
      path: resolve(screens, `paper-scan-${width}.png`),
      fullPage: true,
    });
    await page.goto("/accounts?tab=paper");
    const panel = page.getByRole("region", {
      name: "纸面模拟账户",
      exact: true,
    });
    await expect(panel).toContainText("合计默认不包含模拟资金");
    await panel.getByRole("button", { name: /模拟 · QA-r2c/ }).click();
    await expect(
      panel.getByRole("table", { name: "模拟成交与触发" }),
    ).toContainText("BTCUSDT");
    await panel.getByRole("radio", { name: "每日权益", exact: true }).click();
    await expect(
      panel.getByRole("img", { name: "当前页权益曲线（时间升序）" }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(screens, `paper-accounts-${width}.png`),
      fullPage: true,
    });
    await panel.getByRole("link", { name: "纸面账户设置" }).click();
    await expect(
      page.getByRole("heading", { name: "纸面账户设置", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "paper:QA-r2c模拟镜像" }),
    ).toContainText("镜像关闭");
    // The fixture registers the manually shadowed candidate before startup.
    // Repeating registration must retain exactly one account at either width.
    const registered = page.getByText("模拟 · paper:r3a-shadow-qa:v1", {
      exact: true,
    });
    await expect(registered).toHaveCount(1);
    await page
      .getByRole("button", { name: "按冻结规则登记候选", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "已登记 0 个新模拟账户" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "按冻结规则登记候选", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "已登记 0 个新模拟账户" }),
    ).toBeVisible();
    await expect(registered).toHaveCount(1);
    await page.goto("/lab");
    await expect(
      page.getByRole("region", { name: "候选纸面前推状态" }),
    ).toContainText("QA-r2c");
  });
}
