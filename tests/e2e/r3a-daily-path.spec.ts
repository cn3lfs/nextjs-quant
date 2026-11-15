import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { trpcHeaders } from "./helpers";
import { resolve } from "node:path";

for (const width of [1440, 1024]) {
  test(`R3a daily path ${width}: today → tomorrow → chart → plan, keyboard accessible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const tomorrow = page.getByRole("region", {
      name: "明日计划",
      exact: true,
    });
    await expect(tomorrow).toBeVisible();
    // Tomorrow is on the landing screen: zero interactions, budget <=3.
    await expect(tomorrow).toContainText("影子前推中 · 研究中");
    await expect(
      page.getByRole("navigation", { name: "工作台导航" }).getByRole("link"),
    ).toHaveCount(6);
    await mkdir(resolve(".test-data/r3a/screens"), { recursive: true });
    await page.screenshot({
      path: resolve(`.test-data/r3a/screens/today-${width}.png`),
      fullPage: true,
    });
    const link = tomorrow.getByRole("link", { name: /sh600000 · 打开图表/ });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/scan\?.*candidate=/);
    await expect(
      page.getByRole("application", { name: /行情图：/ }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "候选图表" })).toContainText(
      "参考线均为原价",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: resolve(`.test-data/r3a/screens/scan-${width}.png`),
      fullPage: true,
    });
    const add = page.getByRole("button", { name: "加入计划", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("计划止损", { exact: true })).toHaveValue(
      /\d/,
    );
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().includes("createAlertPlan") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "保存交易计划", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(
      page.getByRole("status").filter({ hasText: "已保存交易计划" }),
    ).toBeVisible();
    const plans = await page.request.get(
      "/api/trpc/alertPlans?input=" +
        encodeURIComponent(JSON.stringify({ json: { page: 0 } })),
      { headers: trpcHeaders },
    );
    const plan = (await plans.json()).result.data.json.items.find(
      (p: { status: string }) => p.status === "open",
    );
    expect(plan.status).toBe("open");
    expect(plan.quantity).toBeGreaterThan(0);
    await page.request.post("/api/trpc/cancelAlertPlan", {
      headers: trpcHeaders,
      data: { json: plan.id },
    });
    // An absent crypto source is exercised without contacting a real venue.
    await page.route("**/api/trpc/**", async (route) => {
      if (
        new URL(route.request().url()).pathname
          .split("/api/trpc/")[1]
          ?.split(",")
          .includes("snapshot")
      )
        return route.abort("connectionrefused");
      return route.continue();
    });
    const markets = page.getByRole("radiogroup", {
      name: "扫描市场",
      exact: true,
    });
    await markets.getByRole("radio", { name: "A 股", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/\/scan\?tab=crypto$/);
    await expect(
      page.getByText("数字货币行情读取失败", { exact: false }),
    ).toBeVisible();
    await markets
      .getByRole("radio", { name: "BTC / ETH", exact: true })
      .focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      markets.getByRole("radio", { name: "A 股", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("application", { name: /行情图：/ }),
    ).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索页面" }).fill("今日");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(tomorrow).toBeVisible();
  });
}
