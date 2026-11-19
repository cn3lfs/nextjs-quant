import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Page } from "@playwright/test";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import { importDeliveryTable } from "../../src/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { DeliveryStore } from "../../src/server/db/delivery-store";
import { trpcHeaders } from "./helpers";

const workspaceLabels = [
  "今日交易",
  "行情看盘",
  "选股筛选",
  "策略回测",
  "持仓复盘",
  "资讯研报",
  "系统设置",
] as const;
const ribbonLabels = [
  "数据基准日",
  "持仓止损预警",
  "今日可计划候选",
  "进行中计划",
  "提醒模式",
  "本地模拟盘",
] as const;
const stageLabels = ["触发", "入队", "订阅", "资格", "投递", "回执"] as const;

/** Every request leaving loopback fails the acceptance run. */
function watchOutbound(page: Page) {
  const outbound: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (!/^(127\.0\.0\.1|localhost)$/.test(host)) outbound.push(request.url());
  });
  return outbound;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

/** The command palette searches the stored local directory, not a live scan. */
async function warmSecurityDirectory(page: Page) {
  const response = await page.request.get(
    "/api/trpc/securities?input=" +
      encodeURIComponent(JSON.stringify({ json: {} })),
    { headers: trpcHeaders },
  );
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.error).toBeUndefined();
}

/**
 * One broker fill and one manual trade on the same symbol make the two real
 * ledgers overlap. Values may stay unknown without certified corporate-action
 * coverage; the interval itself is what this browser check verifies.
 */
function seedOverlappingLedgers(database: Database.Database) {
  const account = "Wave5-券商";
  const date = "2026-10-09";
  const tradeId = randomUUID();
  const table = parseDeliveryTable(
    [
      "成交日期,证券代码,证券名称,买卖标志,成交价格,成交数量,成交金额,发生金额,成交编号",
      `${date},600000,P0_FIXTURE,买入,10,100,1000,-1000,WAVE5-D-1`,
    ].join("\n"),
  );
  const batch = new DeliveryStore(database).commitImport({
    account,
    source: "generic",
    fileHash: createHash("sha256").update(`${account}:${date}`).digest("hex"),
    fileName: "wave5-overlap.csv",
    importedAt: Date.now(),
    parsed: importDeliveryTable(table),
    rawRows: table.rows,
    sourceHeader: table.header,
    format: table.format,
    encoding: table.encoding,
  });
  database.prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)").run(
    tradeId,
    "sh600000",
    date,
    JSON.stringify({
      id: tradeId,
      symbol: "sh600000",
      date,
      side: "buy",
      price: 10,
      quantity: 100,
      lowerLimit: 1,
      upperLimit: 100,
      limitSource: "Wave5 合成验收",
      signalId: null,
      stop: 9,
      note: "合成重叠验收，不是真实成交",
      createdAt: Date.now(),
      methods: [],
      costs: defaultBacktestCosts,
      fees: { commission: 0, tax: 0, slippage: 0, total: 0 },
    }),
  );
  return {
    tradeId,
    remove() {
      database
        .prepare("DELETE FROM trade_fills WHERE batch_id=?")
        .run(batch.batchId);
      database
        .prepare("DELETE FROM cash_flows WHERE batch_id=?")
        .run(batch.batchId);
      database
        .prepare("DELETE FROM import_batches WHERE id=?")
        .run(batch.batchId);
      database.prepare("DELETE FROM trade_ledger WHERE id=?").run(tradeId);
    },
  };
}

test("七工作区、双层侧栏、全部页面与密度切换在 1440/1024 下可用", async ({
  page,
}) => {
  const outbound = watchOutbound(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "工作台导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(7);
  for (const label of workspaceLabels)
    await expect(
      navigation.getByRole("button", {
        name: new RegExp(`^${label}(?:\\s|$)`),
      }),
    ).toBeVisible();

  const ribbon = page.getByRole("group", { name: "今日交易摘要" });
  await expect(ribbon).toBeVisible();
  await expect(ribbon.locator("> *")).toHaveCount(6);
  for (const label of ribbonLabels)
    await expect(ribbon.getByText(label, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-density", "comfort");
  await page
    .getByRole("button", { name: "切换为紧凑视图", exact: true })
    .click();
  await expect(root).toHaveAttribute("data-density", "compact");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await page
    .getByRole("button", { name: "切换为舒适视图", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfort");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfort");

  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");

  // 双层侧栏：宽轨收起为图标窄轨后，「全部页面」弹窗才在该断点出现。
  await page.getByRole("button", { name: "展开全部页面导航" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "全部页面" })).toBeVisible();
  const allPages = dialog.getByRole("navigation", { name: "全部页面导航" });
  await expect(allPages.locator("section")).toHaveCount(7);
  for (const label of workspaceLabels)
    await expect(
      allPages.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expectNoHorizontalOverflow(page);

  expect(outbound).toEqual([]);
});

test("命令面板按页面与本机标的直达，Shift+F 进入并退出专注模式", async ({
  page,
}) => {
  const outbound = watchOutbound(page);
  await warmSecurityDirectory(page);
  await page.goto("/");
  // 全局快捷键在壳层水合后才挂载；data-density 由布局阶段写入，可作水合信号。
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    /comfort|compact/,
  );

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("combobox", {
    name: "搜索页面、快捷动作或本机标的",
  });
  await expect(palette).toBeVisible();
  await palette.fill("提醒与推送");
  await expect(
    page.getByRole("option", { name: /^提醒与推送/ }).first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/system\/notifications$/);
  const breadcrumb = page.getByRole("navigation", { name: "面包屑" });
  await expect(breadcrumb).toContainText("系统设置");
  await expect(breadcrumb).toContainText("提醒与推送");
  await expect(
    page.getByRole("region", { name: "提醒链路诊断" }),
  ).toBeVisible();

  await page.keyboard.press("Control+k");
  await page
    .getByRole("combobox", { name: "搜索页面、快捷动作或本机标的" })
    .fill("@600000");
  await expect(
    page.getByRole("option", { name: /P0_FIXTURE sh600000/ }),
  ).toBeVisible({ timeout: 15000 });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/scan\?symbol=sh600000$/);

  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  const shell = page.locator(".app-shell");
  await page.keyboard.press("Shift+f");
  await expect(shell).toHaveAttribute("data-zen", "true");
  await expect(page.getByText("专注模式 · Esc 退出")).toBeVisible();
  await expect(page.locator("aside.sidebar")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(shell).not.toHaveAttribute("data-zen", "true");
  await expect(page.locator("aside.sidebar")).toHaveCount(1);

  expect(outbound).toEqual([]);
});

test("提醒六阶段诊断、双账重叠与汇总视角只读切换且零外发", async ({ page }) => {
  const outbound = watchOutbound(page);
  const status = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await status.json()).result.data.json.settings;
  const parent = await realpath(
    resolve(process.env.E2E_DATA_DIR ?? ".test-data/wave-opt"),
  );
  const directory = await realpath(resolve(settings.tdxRoot, ".."));
  expect(directory.startsWith(parent + sep)).toBe(true);
  const database = new Database(resolve(directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  const seeded = seedOverlappingLedgers(database);
  try {
    await page.goto("/system/notifications");
    const panel = page.getByRole("region", { name: "提醒链路诊断" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("只读现有记录，不会发送或重试提醒");
    const stages = panel.locator("li");
    await expect(stages).toHaveCount(6);
    for (const [index, label] of stageLabels.entries())
      await expect(stages.nth(index)).toContainText(`${index + 1} ${label}`);
    await expect(panel).toContainText("此页面不会触发真实外发");

    await page.goto("/accounts");
    await expect(
      page.getByRole("heading", { name: /统一持仓与风险/ }),
    ).toBeVisible();
    const reconciliation = page.getByRole("region", { name: "双账重叠核对" });
    await expect(reconciliation).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "检测到 1 只标的同时存在于券商交割单与手工记账" }),
    ).toBeVisible();
    const view = page.getByRole("radiogroup", { name: "汇总视角" });
    await expect(
      view.getByRole("radio", { name: "含重叠上限", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(reconciliation).toContainText("去重区间 [下限, 上限]");
    await reconciliation
      .getByRole("button", { name: "展开重叠明细", exact: true })
      .click();
    const overlaps = reconciliation.getByRole("table");
    await expect(overlaps).toContainText("sh600000");
    await expect(overlaps).toContainText("去重区间");
    await view
      .getByRole("radio", { name: "券商优先预览", exact: true })
      .click();
    await expect(
      view.getByRole("radio", { name: "券商优先预览", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(reconciliation).toContainText("券商账本合计（预览）");
    await expect(
      reconciliation.getByRole("radio", { name: "手工优先预览", exact: true }),
    ).toBeVisible();

    expect(outbound).toEqual([]);
  } finally {
    seeded.remove();
    database.close();
  }
});
