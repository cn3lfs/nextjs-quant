import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { trpcHeaders } from "./helpers";
import { resolve } from "node:path";

test.afterEach(async ({ request }) => {
  const response = await request.get(
    "/api/trpc/alertPlans?input=" +
      encodeURIComponent(JSON.stringify({ json: { page: 0 } })),
    { headers: trpcHeaders },
  );
  expect(response.status()).toBe(200);
  const plans: { id: string; strategyId: string; status: string }[] = (
    await response.json()
  ).result.data.json.items;
  for (const plan of plans.filter(
    (row) => row.strategyId === "r3a-shadow-qa" && row.status === "open",
  )) {
    const cancelled = await request.post("/api/trpc/cancelAlertPlan", {
      headers: trpcHeaders,
      data: { json: plan.id },
    });
    expect(cancelled.status()).toBe(200);
  }
});

for (const width of [1440, 1024]) {
  test(`Lifecycle daily path ${width}: stop tasks → inline plan in two activations, then chart`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
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
    const screens = resolve(
      process.env.E2E_DATA_DIR ?? ".test-data/r3a/e2e-daily",
      "..",
      "screens",
    );
    await mkdir(screens, { recursive: true });
    await page.screenshot({
      path: resolve(screens, `today-${width}.png`),
      fullPage: true,
    });
    const tasks = page.getByRole("region", { name: "设置或调整止损单" });
    await expect(tasks).toContainText("QA-lifecycle-stop-plan");
    await expect(tasks).toContainText("设置止损");
    await expect(tasks).toContainText("9.27");
    const candidate = tomorrow
      .getByRole("row")
      .filter({ hasText: "r3a-shadow-qa" });
    await expect(candidate).toHaveCount(1);
    const add = candidate.getByRole("button", {
      name: "加入计划",
      exact: true,
    });
    await add.focus();
    // The main path uses two explicit activations and stays on Today.
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
    await expect(page).toHaveURL(/\/$/);
    const openPlans = page.getByRole("table", {
      name: "未完成交易计划",
      exact: true,
    });
    await expect(openPlans).toContainText("r3a-shadow-qa");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      ),
    ).toBe(false);
    await page.screenshot({
      path: resolve(screens, `today-plan-${width}.png`),
      fullPage: true,
    });
    const plans = await page.request.get(
      "/api/trpc/alertPlans?input=" +
        encodeURIComponent(JSON.stringify({ json: { page: 0 } })),
      { headers: trpcHeaders },
    );
    const plan = (await plans.json()).result.data.json.items.find(
      (p: { status: string; strategyId: string }) =>
        p.status === "open" && p.strategyId === "r3a-shadow-qa",
    );
    expect(plan.status).toBe("open");
    expect(plan.quantity).toBeGreaterThan(0);
    expect(plan.sizingAudit.overridden).toBe(false);
    expect(plan.exposureAudit.overridden).toBe(false);
    expect(plan.protection.matchesStrategy).toBe(true);
    await page.request.post("/api/trpc/cancelAlertPlan", {
      headers: trpcHeaders,
      data: { json: plan.id },
    });
    const link = candidate.getByRole("link", { name: /sh600000 · 打开图表/ });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/scan\?.*candidate=/);
    await expect(
      page.getByRole("application", { name: /行情图：/ }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "候选图表" })).toContainText(
      "参考线均为原价",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      ),
    ).toBe(false);
    await page.screenshot({
      path: resolve(screens, `scan-${width}.png`),
      fullPage: true,
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
