import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { beijingClock } from "../../src/lib/market/market-session";
import {
  getOrCreatePipelineRun,
  insertOrderIntents,
} from "../../src/server/db/pipeline-repository";
import { fixtureDirectory } from "./fixture-directory";
import { trpcHeaders } from "./helpers";

const symbol = "sh600000";
const strategyId = "qa-wave4-double-breakout";
const deploymentName = "隔离验收 · 本地模拟部署";

// Seed only the downstream approval. Strategy deployment, pool edits and
// alert mutations go through the real web application.
function seedPendingApproval(outputDir: string, deploymentId: string) {
  const root = fixtureDirectory(dirname(outputDir));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("fixture-")) continue;
    const file = join(fixtureDirectory(join(root, entry.name)), "quant.sqlite");
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const db = new Database(file, { fileMustExist: true });
    try {
      const deployment = db
        .prepare("SELECT id FROM strategy_deployments WHERE id = ?")
        .get(deploymentId);
      if (!deployment) continue;
      return db.transaction(() => {
        db.prepare(
          "UPDATE strategy_deployments SET status = 'active', execution_mode = 'manual_confirm' WHERE id = ?",
        ).run(deploymentId);
        const date = beijingClock(Date.now()).date;
        const { run } = getOrCreatePipelineRun(
          {
            deploymentId,
            decisionDate: date,
            executeDate: date,
            triggerKind: "manual",
          },
          db,
        );
        insertOrderIntents(
          run.id,
          [
            {
              runId: run.id,
              deploymentId,
              venueKind: "local_sim",
              symbol,
              side: "BUY",
              phase: 2,
              quantity: 100,
              referencePrice: 10,
            },
          ],
          db,
        );
        return run;
      })();
    } finally {
      db.close();
    }
  }
  throw new Error("找不到刚创建部署所属的 Playwright 夹具数据库");
}

test("策略库部署进入运行台，监控池与审批外链可用，盘中预警可配置", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const account = await request.post("/api/trpc/simAccountCreate", {
    headers: trpcHeaders,
    data: {
      json: {
        name: "运行台测试账户",
        market: "cn-equity",
        initialCapital: "100000",
      },
    },
  });
  expect(account.ok()).toBe(true);
  const strategy = await request.post("/api/trpc/strategyLabRegister", {
    headers: trpcHeaders,
    data: {
      json: {
        id: strategyId,
        version: 1,
        market: "cn-equity",
        period: "day",
        sleeve: "swing",
        universe: { kind: "symbols", symbols: [symbol] },
        entry: { kind: "double-breakout", side: "entry" },
        exit: {},
        sizing: { kind: "weight", weight: 0.1 },
      },
    },
  });
  expect(strategy.ok(), await strategy.text()).toBe(true);

  await page.goto("/lab");
  await page
    .getByRole("link", { name: `double-breakout · ${strategyId} v1` })
    .click();
  await page.getByRole("button", { name: "部署到运行台", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("策略名称", { exact: true });
  await expect(name).toHaveValue(`${strategyId} v1 · 运行台`);
  await expect(dialog.getByLabel("市场", { exact: true })).toHaveValue(
    "cn-equity",
  );
  await expect(dialog.getByLabel("策略类型", { exact: true })).toHaveValue(
    "double-breakout",
  );
  await expect(dialog.getByLabel("模拟通道", { exact: true })).toHaveValue(
    "local_sim",
  );
  await expect(
    dialog
      .getByLabel("本地模拟账户", { exact: true })
      .locator("option:checked"),
  ).toHaveText("运行台测试账户");
  await name.fill(deploymentName);
  await dialog.getByRole("button", { name: "创建部署", exact: true }).click();

  await page.getByRole("link", { name: "前往策略运行台查看" }).click();
  await expect(page).toHaveURL(/\/\?tab=pipeline&deployment=[^&]+$/);
  await expect(page.getByText(deploymentName, { exact: true })).toBeVisible();
  await expect(page.getByText("今日待办", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "模式", exact: true }),
  ).toHaveValue("shadow");

  await page.getByLabel("手动加票代码").fill(symbol);
  await page.getByRole("button", { name: "加票入池" }).click();
  const poolRow = page.getByRole("listitem").filter({ hasText: symbol });
  await expect
    .soft(
      poolRow.getByRole("link", { name: "看K线" }),
      "监控池标的应提供看盘链接",
    )
    .toHaveAttribute("href", `/scan?symbol=${symbol}`, { timeout: 8000 });

  const deploymentId = new URL(page.url()).searchParams.get("deployment")!;
  const run = seedPendingApproval(testInfo.project.outputDir, deploymentId);
  await page.goto("/?tab=pipeline");
  const approval = page
    .getByRole("region", { name: "待人工审批意图" })
    .getByRole("listitem")
    .filter({ hasText: deploymentName });
  await expect
    .soft(
      approval.getByRole("link", { name: "看K线" }),
      "今日待办应提供审批标的看盘链接",
    )
    .toHaveAttribute("href", `/scan?symbol=${symbol}`, { timeout: 8000 });
  await expect
    .soft(
      approval.getByRole("link", { name: "去模拟账户" }),
      "今日待办应提供对应模拟账户链接",
    )
    .toHaveAttribute("href", "/accounts?tab=paper", { timeout: 8000 });
  const englishStatus = /\b(shadow|live|incomplete)\b/i;
  await expect(page.locator("main")).not.toContainText(englishStatus);

  await page.goto(`/?tab=pipeline&deployment=${deploymentId}`);
  const runLink = page.getByRole("link", { name: "查看次日调仓计划" });
  await expect(runLink).toBeVisible();
  await runLink.click();
  await expect(page).toHaveURL(/#rebalance-tickets$/);
  const url = new URL(page.url());
  expect(url.hash).toBe("#rebalance-tickets");
  expect(url.searchParams.get("ticketScope")).toBe("paper");
  expect(url.searchParams.get("ticketRunId")).toBe(run.id);
  expect(url.searchParams.get("ticketDate")).toBe(run.decisionDate);
  const tickets = page.locator("#rebalance-tickets");
  await expect(tickets.getByRole("radio", { name: "纸面账本" })).toBeChecked();
  await expect(
    tickets.getByText(`关联运行 ${run.id} · 决策日 ${run.decisionDate}`),
  ).toBeVisible();

  await page.goto("/?tab=intraday-alerts");
  const enabled = page.getByRole("checkbox", { name: "开启盘中预警" });
  const detect = page.getByRole("button", { name: "立即检测一次" });
  await expect(detect).toBeDisabled();
  await enabled.click();
  await page.getByRole("button", { name: "保存预警设置" }).click();
  await expect(page.getByText("盘中预警设置已保存。")).toBeVisible();
  await page.reload();
  await expect(enabled).toBeChecked();
  // A target-free run exercises the real manual mutation without remote quotes.
  await detect.click();
  await expect(
    page.getByText(/没有需要检测的标的|当前(?:休市|午休)，本次未检测/),
  ).toBeVisible();

  await page.getByLabel("预警规则证券代码").fill(symbol);
  await page.getByLabel("预警规则触发价").fill("999");
  await page.getByLabel("预警规则备注").fill("隔离测试阈值");
  await page.getByRole("button", { name: "新增规则" }).click();
  const remove = page.getByRole("button", {
    name: `删除 ${symbol} 价格阈值规则`,
  });
  await expect(page.getByText("隔离测试阈值", { exact: true })).toBeVisible();
  await remove.click();
  await expect(page.getByText("价格阈值规则已删除。")).toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(englishStatus);
  expect(errors).toEqual([]);
});
