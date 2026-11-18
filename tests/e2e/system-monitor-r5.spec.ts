import { expect, test, type Page } from "@playwright/test";

/** The applied signals filter: an explicit date that matches all 21 signals. */
const signalsFilter = {
  query: "",
  from: "2026-09-29",
  to: "2026-09-29",
};
/** The exact delivery scope opened from signal-fixture-00000. */
const scopeFilter = { query: "", signalId: "signal-fixture-00000" };
const params = (page: Page) => new URL(page.url()).searchParams;
const filterParam = (page: Page) =>
  JSON.parse(params(page).get("monitorFilters") ?? "{}") as unknown;

/**
 * Real Next + SQLite over the synthetic signal fixture: the signal detail's
 * related deliveries and the reverse signal link are both native same-route
 * history entries. No notification is sent and no record is written.
 */
test("系统 R5：信号投递双向历史、R4 原投递与投递刷新直达", async ({ page }) => {
  test.setTimeout(180000);
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing baseURL");
  const origin = new URL(baseURL).origin;
  const external: string[] = [];
  // Mutations travel as tRPC POSTs; this flow must never write.
  const writes: string[] = [];
  // Only the fixture's own origin (one localhost port) may be reached, and any
  // tRPC POST is recorded and blocked before release.
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    if (request.method() === "POST" && url.pathname.startsWith("/api/trpc/")) {
      writes.push(decodeURIComponent(url.href));
      return route.abort();
    }
    return route.continue();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const signalReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("signalWorkspaceDetail"))
      signalReads.push(decodeURIComponent(request.url()));
  });
  // A. Apply the date filter on the signals tab and page to the oldest signal.
  await page.goto("/system/notifications?monitorTab=signals");
  await expect(page.getByText("已应用关键词：全部")).toBeVisible();
  await page.getByLabel("创建起始日期").fill("2026-09-29");
  await page.getByLabel("创建截止日期").fill("2026-09-29");
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect(
    page.getByText("开始日期：2026-09-29 · 结束日期：2026-09-29"),
  ).toBeVisible();
  const signalsList = page.locator('div[aria-label="信号列表"]');
  await expect(signalsList.getByRole("button")).toHaveCount(20);
  await expect.poll(() => filterParam(page)).toEqual(signalsFilter);

  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(signalsList.getByRole("button")).toHaveCount(1);
  await expect(signalsList.getByText("SZ000001")).toBeVisible();
  await signalsList.getByRole("button").click();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("signal-fixture-00000");
  await expect.poll(() => filterParam(page)).toEqual(signalsFilter);

  // B. The related deliveries open as a real history entry with the exact
  // signal scope, no selected delivery and the first page.
  await page
    .getByRole("button", { name: "查看全部关联投递", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "投递" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => params(page).get("monitorTab")).toBe("deliveries");
  await expect.poll(() => params(page).get("monitorRecord")).toBeNull();
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);
  const deliveryList = page.locator('div[aria-label="投递列表"]');
  // 5 primary deliveries + 1 summary naming the signal + 1 manual resend.
  await expect(deliveryList.getByRole("button")).toHaveCount(7);
  await expect(deliveryList.getByText("合成通知 0-0")).toBeVisible();
  await expect(deliveryList.getByText("合成通知 1-4")).toBeVisible();
  await expect(deliveryList.getByText("合成人工重发 00000")).toBeVisible();
  // Unrelated summaries and other signals stay out of this scope.
  await expect(deliveryList.getByText("合成通知 2-4")).toHaveCount(0);
  await expect(deliveryList.getByText("合成通知 3-4")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看关联信号", exact: true }),
  ).toBeVisible();

  // C. The R4 path over the real records: resend -> original -> Back.
  await deliveryList
    .getByRole("button", { name: /合成人工重发 00000/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "合成人工重发 00000" }),
  ).toBeVisible();
  await expect(
    page.getByText("原投递：delivery-fixture-00000-0", { exact: true }),
  ).toBeVisible();
  // The reverse link stays usable on a narrow screen with a delivery selected,
  // where the list panel is hidden but the tab panel is still shown.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(
    page.getByRole("button", { name: "查看关联信号", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("delivery-fixture-resend-00000");
  await page.getByRole("button", { name: "查看原投递", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "合成通知 0-0" }),
  ).toBeVisible();
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("delivery-fixture-00000-0");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "合成人工重发 00000" }),
  ).toBeVisible();
  await expect(deliveryList.getByRole("button")).toHaveCount(7);
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);

  // D. Back restores the original signal page 2 and its detail; Forward
  // returns to the delivery scope.
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(
    page.getByText("开始日期：2026-09-29 · 结束日期：2026-09-29"),
  ).toBeVisible();
  await expect(signalsList.getByRole("button")).toHaveCount(1);
  expect(params(page).get("monitorTab")).toBe("signals");
  expect(params(page).get("monitorRecord")).toBe("signal-fixture-00000");
  expect(filterParam(page)).toEqual(signalsFilter);
  // A real refresh of the signal entry restores the applied filter, the
  // session cursor (page 2) and the exact selected record from the URL.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(signalsList.getByRole("button")).toHaveCount(1);
  expect(params(page).get("monitorRecord")).toBe("signal-fixture-00000");
  expect(filterParam(page)).toEqual(signalsFilter);
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "合成人工重发 00000" }),
  ).toBeVisible();
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);

  // E. The reverse link opens the same signal by exact id, reusing the
  // in-memory signals filter/page; Back and Forward keep both entries.
  const beforeReverseReads = signalReads.length;
  await page.getByRole("button", { name: "查看关联信号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect.poll(() => params(page).get("monitorTab")).toBe("signals");
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("signal-fixture-00000");
  await expect.poll(() => filterParam(page)).toEqual(signalsFilter);
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(signalsList.getByRole("button")).toHaveCount(1);
  const reverseReads = signalReads.slice(beforeReverseReads);
  expect(reverseReads.length).toBeGreaterThan(0);
  expect(
    reverseReads.every((url) => url.includes("signal-fixture-00000")),
  ).toBe(true);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "合成人工重发 00000" }),
  ).toBeVisible();
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  expect(params(page).get("monitorRecord")).toBe("signal-fixture-00000");

  // F. Reloading the delivery entry restores that scope directly; the reverse
  // link still opens the exact signal id even though the signals tab's
  // un-encoded date filter naturally falls back to its default after reload.
  await page.goBack();
  await expect.poll(() => params(page).get("monitorTab")).toBe("deliveries");
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);
  await page.reload();
  await expect(deliveryList.getByRole("button")).toHaveCount(7);
  await expect(deliveryList.getByText("合成通知 1-4")).toBeVisible();
  const beforeReloadReads = signalReads.length;
  await page.getByRole("button", { name: "查看关联信号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect.poll(() => params(page).get("monitorTab")).toBe("signals");
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("signal-fixture-00000");
  expect(filterParam(page)).toEqual({ query: "" });
  await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
  await expect(signalsList.getByRole("button")).toHaveCount(20);
  const reloadReads = signalReads.slice(beforeReloadReads);
  expect(reloadReads.length).toBeGreaterThan(0);
  expect(reloadReads.every((url) => url.includes("signal-fixture-00000"))).toBe(
    true,
  );

  // G. Manual apply on the deliveries tab: an unapplied draft has no entry,
  // while "查询历史" shows it with the exact scope and opens the same signal.
  await page.getByRole("tab", { name: "投递" }).click();
  const reverse = page.getByRole("button", {
    name: "查看关联信号",
    exact: true,
  });
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await expect(reverse).toHaveCount(0);
  await page.getByLabel("关联信号ID").fill("signal-fixture-00000");
  await expect(reverse).toHaveCount(0);
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect(
    page.getByText("信号ID：signal-fixture-00000", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => filterParam(page)).toEqual(scopeFilter);
  await expect(reverse).toBeVisible();
  await reverse.click();
  await expect(
    page.getByRole("heading", { name: "SZ000001 · 双均线趋势" }),
  ).toBeVisible();
  await expect
    .poll(() => params(page).get("monitorRecord"))
    .toBe("signal-fixture-00000");

  expect(writes).toEqual([]);
  expect(external).toEqual([]);
  expect(pageErrors).toEqual([]);
});
