import type { Page } from "@playwright/test";
import { expect, test } from "./workbench-test";
import { trpcHeaders, waitForIdleServer } from "./helpers";

const call = async (page: Page, name: string, input: unknown, post = false) => {
  const response = post
    ? await page.request.post(`/api/trpc/${name}`, {
        headers: { ...trpcHeaders, "content-type": "application/json" },
        data: { json: input },
      })
    : await page.request.get(
        `/api/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        { headers: trpcHeaders },
      );
  expect(response.ok()).toBe(true);
  return (await response.json()).result.data.json;
};

test("a drawing shared from the day chart shows on the week chart", async ({
  page,
}) => {
  await waitForIdleServer(page);
  await page.goto("/scan?symbol=sh600000", { waitUntil: "networkidle" });
  const chart = page.getByTestId("market-chart").first();
  await chart.locator("canvas").first().waitFor();
  const code = await page.locator(".chart-panel .eyebrow").first().innerText();
  const symbol = code.toLowerCase();
  const day = await call(page, "chartView", { symbol, period: "day" });
  const bars = await chart
    .getByTestId("chart-legend")
    .locator("span")
    .first()
    .innerText();
  const shared = {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "horizontal",
    a: { date: bars, price: 100 },
    b: { date: bars, price: 100 },
    color: "#22aaff",
    shared: true,
  };
  await call(
    page,
    "saveChartView",
    {
      symbol,
      period: "day",
      view: { ...day, drawings: [...day.drawings, shared] },
    },
    true,
  );
  try {
    await page.getByRole("combobox", { name: "行情周期", exact: true }).click();
    await page.getByRole("option", { name: "周线", exact: true }).click();
    await page.getByText("已画图形", { exact: false }).first().click();
    await expect(
      page.getByText("另有 1 个图形由其他周期共享而来", { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await call(
      page,
      "saveChartView",
      { symbol, period: "day", view: day },
      true,
    );
  }
  expect(
    await call(page, "chartSharedDrawings", { symbol, period: "week" }),
  ).toEqual([]);
});
