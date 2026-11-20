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

test("Candidate refresh failure keeps the last good read and pauses new plans until retry", async ({
  page,
}) => {
  // This test waits for one real 30 s poll while the plan form is open.
  test.setTimeout(120000);
  await page.goto("/");
  const tomorrow = page.getByRole("region", {
    name: "明日计划",
    exact: true,
  });
  await expect(tomorrow).toBeVisible();
  // Use the server-filtered key so the today batch is not reused.
  const markets = page.getByRole("radiogroup", {
    name: "候选市场",
    exact: true,
  });
  await markets.getByRole("radio", { name: "A 股", exact: true }).click();
  const table = page.getByRole("table", {
    name: "明日计划候选",
    exact: true,
  });
  const row = table.getByRole("row").filter({ hasText: "r3a-shadow-qa" });
  await expect(row).toHaveCount(1);
  await expect(
    row.getByRole("button", { name: "加入计划", exact: true }),
  ).toBeVisible();
  let failing = true;
  await page.route("**/api/trpc/**", async (route) => {
    const names =
      new URL(route.request().url()).pathname
        .split("/api/trpc/")[1]
        ?.split(",") ?? [];
    // Only the filtered candidate read fails; a batched today summary failure
    // would change the meaning of this scenario.
    if (
      failing &&
      names.includes("workspaceCandidates") &&
      !names.includes("todayWorkspace")
    )
      return route.abort("connectionrefused");
    return route.continue();
  });
  await page.getByRole("button", { name: "刷新候选", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "候选刷新失败" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("最近一次成功读取");
  // The same key's rows and chart link stay; new plans are paused.
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("link", { name: /打开图表/ })).toBeVisible();
  await expect(
    row.getByRole("button", { name: "加入计划", exact: true }),
  ).toHaveCount(0);
  // Retrying the same key recovers the plannable state in place.
  failing = false;
  await alert.getByRole("button", { name: "重试", exact: true }).click();
  await expect(alert).toHaveCount(0);
  const add = row.getByRole("button", { name: "加入计划", exact: true });
  await expect(add).toBeVisible();
  await add.click();
  await expect(page.getByLabel("计划止损", { exact: true })).toHaveValue(/\d/);
  // An already-open form keeps its draft when a later background refresh
  // fails; only new plans are paused.
  const rationale = page.getByLabel("入场理由", { exact: true });
  await rationale.fill("草稿保留核对");
  failing = true;
  // The modal hides the rest of the page from the accessibility tree, so the
  // background warning is matched by text rather than alert role here.
  await expect(page.locator("p", { hasText: "候选刷新失败" })).toBeVisible({
    timeout: 45000,
  });
  await expect(page.getByLabel("入场理由", { exact: true })).toHaveValue(
    "草稿保留核对",
  );
  await expect(page.getByLabel("计划止损", { exact: true })).toHaveValue(/\d/);
  await expect(
    page.getByRole("button", { name: "保存交易计划", exact: true }),
  ).toBeVisible();
  failing = false;
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "保存交易计划", exact: true }),
  ).toHaveCount(0);
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
    await expect(tomorrow).toContainText("观察前推 · 研究中");
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
    const planRail = page.getByRole("complementary", { name: "盘口与计划" });
    await expect(
      planRail.getByRole("tab", { name: "计划双价" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      planRail.getByText(/入场 .*止损 .*目标 .* · 原价/),
    ).toBeVisible();
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
    const navigateViaSidebar = async (label: string, groupLabel: string) => {
      const allPages = page.getByRole("button", {
        name: "展开全部页面导航",
        exact: true,
      });
      if (await allPages.isVisible()) {
        await allPages.click();
        await page
          .getByRole("navigation", { name: "全部页面导航" })
          .getByRole("link", { name: label, exact: true })
          .click();
        return;
      }
      const nav = page.getByRole("navigation", { name: "工作台导航" });
      const groupBtn = nav.getByRole("button", {
        name: groupLabel,
        exact: true,
      });
      if ((await groupBtn.getAttribute("aria-expanded")) === "false")
        await groupBtn.click();
      await nav.getByRole("link", { name: label, exact: true }).click();
    };
    await navigateViaSidebar("数字货币", "行情看盘");
    await expect(page).toHaveURL(/\/scan\?tab=crypto$/);
    await expect(
      page.getByText("数字货币行情读取失败", { exact: false }),
    ).toBeVisible();
    await navigateViaSidebar("A 股看盘", "行情看盘");
    await expect(page).toHaveURL(/\/scan$/);
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
