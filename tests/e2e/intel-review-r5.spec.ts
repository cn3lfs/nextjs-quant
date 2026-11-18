import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { trpcHeaders } from "./helpers";

const report = (index: number) =>
  `cls-review-report:fixture-${String(index).padStart(5, "0")}`;
const title = (index: number) => `合成报告 ${index}`;

type SavedVerification = { date: string; hash: string; checkedAt: number };
function readVerification(
  database: string,
  date: string,
  hashPrefix?: string,
): SavedVerification | null {
  const db = new Database(database, { readonly: true });
  try {
    const row = (
      hashPrefix
        ? db
            .prepare(
              "SELECT payload FROM records WHERE kind='cls-review-verification' AND json_extract(payload,'$.date')=? AND json_extract(payload,'$.hash') LIKE ?",
            )
            .get(date, `${hashPrefix}%`)
        : db
            .prepare(
              "SELECT payload FROM records WHERE kind='cls-review-verification' AND json_extract(payload,'$.date')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
            )
            .get(date)
    ) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as SavedVerification) : null;
  } finally {
    db.close();
  }
}

/** Real /intel/review prices flow over the synthetic CLS fixture. */
test("新闻情报 R5：跨报告日锚点、真实核对回执与证据身份、清理占位", async ({
  page,
}) => {
  test.setTimeout(180000);
  const baseURL = testInfoBaseURL();
  const external: string[] = [];
  // Only the loopback fixture server may be reached.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(baseURL)) external.push(url);
  });
  const detailRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("clsReviewVerificationDetail"))
      detailRequests.push(decodeURIComponent(request.url()));
  });

  const statusResponse = await page.request.get("/api/trpc/databaseStatus", {
    headers: trpcHeaders,
  });
  expect(statusResponse.ok()).toBe(true);
  const database = (
    (await statusResponse.json()) as {
      result: { data: { json: { database: string } } };
    }
  ).result.data.json.database;
  expect(database).toContain("fixture-");

  await page.goto("/intel/review");
  const list = page.locator('section[aria-label="已导入报告"]');
  const prices = page.locator('section[aria-label="固定样本与价格观察"]');
  const day = prices.locator('input[type="date"]');
  const params = () => new URL(page.url()).searchParams;

  // A. Title filter, second page, and an explicit cross-report day jump.
  await page.locator("#cls-report-title").fill("合成报告");
  await list.getByRole("button", { name: "查询报告", exact: true }).click();
  await expect(list.getByText(/已应用：合成报告/)).toBeVisible();
  await list.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(list.getByText("第 2 页", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: /^合成报告 1 · 版本2/ }).click();
  await expect(page.getByRole("heading", { name: title(1) })).toBeVisible();
  await page
    .getByRole("button", { name: "固定样本与价格观察", exact: true })
    .click();
  // The report's own sample is selected first; wait for it so the automatic
  // default cannot overwrite the explicit day typed below.
  await expect(day).toHaveValue("2020-01-02");
  await day.fill("2020-01-01");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  await prices
    .getByRole("button", { name: "查看样本所属报告", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: title(0) })).toBeVisible();
  await expect(
    prices.getByText("归属：当前报告", { exact: true }),
  ).toBeVisible();
  await expect(day).toHaveValue("2020-01-01");
  expect(params().get("clsReport")).toBe(report(0));
  expect(params().get("clsSample")).toBe("2020-01-01");

  // Back restores report 1 with the same day, filter and page; Forward and a
  // deep-link refresh restore report 0 on the same day.
  await page.goBack();
  await expect(page.getByRole("heading", { name: title(1) })).toBeVisible();
  await expect(day).toHaveValue("2020-01-01");
  await expect(
    prices.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  await expect(list.getByText(/已应用：合成报告/)).toBeVisible();
  await expect(list.getByText("第 2 页", { exact: true })).toBeVisible();
  expect(params().get("clsReport")).toBe(report(1));
  expect(params().get("clsSample")).toBe("2020-01-01");
  await page.goForward();
  await expect(page.getByRole("heading", { name: title(0) })).toBeVisible();
  await expect(day).toHaveValue("2020-01-01");
  await page.reload();
  await expect(page.getByRole("heading", { name: title(0) })).toBeVisible();
  await expect(day).toHaveValue("2020-01-01");

  // B. A real verification writes a persisted version; the receipt mirrors it.
  await page.goBack();
  await expect(page.getByRole("heading", { name: title(1) })).toBeVisible();
  await day.fill("2020-01-02");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("归属：当前报告", { exact: true }),
  ).toBeVisible();
  const receipt = prices.getByText(/最近一次成功核对/);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await expect(receipt).toBeVisible({ timeout: 30000 });
  const saved = readVerification(database, "2020-01-02");
  expect(saved).not.toBeNull();
  expect(saved!.date).toBe("2020-01-02");
  expect(saved!.hash).toMatch(/^[a-f0-9]{64}$/);
  const hashShort = saved!.hash.slice(0, 10);
  const savedAt = new Date(saved!.checkedAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  await expect(receipt).toContainText("2020-01-02");
  await expect(receipt).toContainText(hashShort);
  await expect(receipt).toContainText(`保存于 ${savedAt}`);
  // Completing the receipt alone must not read the detail.
  expect(detailRequests).toHaveLength(0);

  // The saved version is on page 1; page 2 cannot contain this hash.
  await prices.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(prices.getByText("第 2 页", { exact: true })).toBeVisible();
  const combobox = prices.getByRole("combobox", { name: "价格核对版本" });
  await expect(combobox).toContainText(/[0-9a-f]{10}$/);
  await expect(combobox).not.toContainText(hashShort);
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(
    prices.getByText(`所查核对：日期 2020-01-02 · 版本 ${hashShort}`),
  ).toBeVisible();
  await expect(prices.locator("pre")).toContainText(saved!.hash);
  expect(detailRequests.at(-1)).toContain("2020-01-02");
  expect(detailRequests.at(-1)).toContain(saved!.hash);

  // The in-page history entry switches the evidence identity to that version.
  const historyShort = (await combobox.innerText())
    .trim()
    .match(/([0-9a-f]{10})$/)?.[1];
  expect(historyShort).toBeTruthy();
  expect(historyShort).not.toBe(hashShort);
  const history = readVerification(database, "2020-01-02", historyShort!);
  expect(history).not.toBeNull();
  await prices
    .getByRole("button", { name: "读取完整核对证据", exact: true })
    .click();
  await expect(
    prices.getByText(`所查核对：日期 2020-01-02 · 版本 ${historyShort}`),
  ).toBeVisible();
  await expect(prices.locator("pre")).toContainText(history!.hash);
  expect(detailRequests.at(-1)).toContain(history!.hash);

  // C. Removing report 0 keeps the sample-day placeholder on report 1 and
  // hides both actions.
  await list.getByRole("button", { name: /^合成报告 0 · 版本1/ }).click();
  await expect(page.getByRole("heading", { name: title(0) })).toBeVisible();
  await page.getByRole("button", { name: "报告信息", exact: true }).click();
  await page.getByRole("button", { name: "清理此版本", exact: true }).click();
  await page
    .getByRole("button", { name: "确认清理报告及关联证据", exact: true })
    .click();
  await expect(
    page.getByText("此版本及关联证据已清理，样本日期占位保留，不能重新选样。", {
      exact: true,
    }),
  ).toBeVisible();
  await list.getByRole("button", { name: /^合成报告 1 · 版本2/ }).click();
  await expect(page.getByRole("heading", { name: title(1) })).toBeVisible();
  // The receipt belonged to the previous ClsReviewPrices instance only.
  await expect(receipt).toHaveCount(0);
  await page
    .getByRole("button", { name: "固定样本与价格观察", exact: true })
    .click();
  await expect(day).toHaveValue("2020-01-02");
  await day.fill("2020-01-01");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("所属报告已清理，样本日期占位保留。", { exact: true }),
  ).toBeVisible();
  await expect(
    prices.getByRole("button", { name: "查看样本所属报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    prices.getByRole("button", { name: "读取行情并核对", exact: true }),
  ).toHaveCount(0);

  expect(external).toEqual([]);
});

function testInfoBaseURL() {
  const base = test.info().project.use.baseURL;
  if (typeof base !== "string") throw new Error("Missing baseURL");
  return base;
}
