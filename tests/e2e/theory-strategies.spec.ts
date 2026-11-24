import { expect, test } from "@playwright/test";
import { theoryDefinitions } from "../../packages/trading-strategies/src/theory-catalog";
import { trpcHeaders, waitForJob } from "./helpers";

// Uses the workbench project's existing isolated long-history fixture and server.
// This is UI/worker acceptance on synthetic data, never a strategy-profit claim.
for (const width of [1440, 1024]) {
  test(`theory catalogue and actual local study at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/lab?tab=catalog", { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "策略目录", exact: true }).click();
    await page.getByLabel("搜索策略", { exact: true }).fill("theory-");
    const list = page.getByLabel("策略列表", { exact: true });
    await expect(list.getByRole("button")).toHaveCount(
      theoryDefinitions.length + 3,
    );
    expect(theoryDefinitions).toHaveLength(34);
    const details = page.getByRole("region", { name: "策略详情", exact: true });
    for (const definition of theoryDefinitions) {
      await list
        .getByRole("button", { name: definition.name, exact: false })
        .click();
      await expect(
        details.getByRole("heading", { name: definition.name, exact: true }),
      ).toBeVisible();
      await expect(details).toContainText(`${definition.id} · 规则版本`);
      await expect(details).toContainText(definition.rule);
      await expect(details).toContainText("历史验证：规则自检，未认证可信业绩");
      await expect(
        details.getByRole("button", { name: "创建本地日线实验", exact: true }),
      ).toBeVisible();
    }
    const orbName = "ORB·UTC 5分钟收盘代理";
    await list.getByRole("button", { name: orbName, exact: false }).click();
    await expect(
      details.getByRole("heading", { name: orbName, exact: true }),
    ).toBeVisible();
    // The new F04.05 proxy is crypto-only; the CN daily experiment stays closed.
    await expect(details).toContainText("仅 BTC/ETH 现货");
    await expect(
      details.getByRole("button", { name: "创建本地日线实验", exact: true }),
    ).toHaveCount(0);
    const orbLink = details.getByRole("link", {
      name: "打开 UTC 5分钟收盘代理 ORB 回测（BTC/ETH 现货）",
      exact: true,
    });
    await expect(orbLink).toBeVisible();
    await expect(orbLink).toHaveAttribute(
      "href",
      "/lab/backtest?mode=object&preset=utc-orb",
    );
    const selected = theoryDefinitions.find(
      (d) => d.id === "theory-nr4-close",
    )!;
    await list.getByRole("button", { name: selected.name }).click();
    await details
      .getByRole("combobox", { name: "搜索实验证券", exact: true })
      .fill("sh600000");
    await page
      .getByRole("option", { name: /sh600000|600000/ })
      .first()
      .click();
    await details.getByLabel("开始日期", { exact: true }).fill("2024-06-01");
    await details.getByLabel("结束日期", { exact: true }).fill("2025-03-07");
    await details
      .getByRole("button", { name: "创建本地日线实验", exact: true })
      .click();
    const created = page.getByText(/^任务已创建：/);
    await expect(created).toBeVisible();
    const id = (await created.innerText()).replace("任务已创建：", "").trim();
    const job = await waitForJob(page, id, 15000);
    expect(job.status, JSON.stringify(job)).toBe("completed");
    const completed = page
      .locator("div.rounded.border")
      .filter({ hasText: "sh600000 · theory-nr4-close · completed" })
      .first();
    await expect(completed).toBeVisible();
    await completed
      .getByRole("button", { name: "查看绩效", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: `绩效评价 · ${id}`, exact: true }),
    ).toBeVisible();
    // The actual worker's exported archive carries the research limitations;
    // inspect the existing read-only endpoint rather than fabricating a report.
    const archiveResponse = await page.request.get(
      `/api/trpc/strategyCenterExport?input=${encodeURIComponent(JSON.stringify({ json: id }))}`,
      { headers: trpcHeaders },
    );
    expect(archiveResponse.ok()).toBe(true);
    const archive = await archiveResponse.json();
    expect(archive.error).toBeUndefined();
    expect(JSON.stringify(archive)).toContain("规则自检");
    expect(errors, "Browser console/page errors").toEqual([]);
  });
}
