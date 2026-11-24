import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { LabDiagnoseRunInput } from "../../src/lib/research/diagnose-contract";
import type { ShortfallFrozenPlan } from "../../src/lib/portfolio/implementation-shortfall";
import { trpcHeaders, waitForJob } from "./helpers";

async function exportArchive(page: Page, archiveId: string) {
  const input = encodeURIComponent(
    JSON.stringify({ json: { archiveId, format: "json" } }),
  );
  const response = await page.request.get(
    `/api/trpc/strategyLabDiagnoseExport?input=${input}`,
    { headers: trpcHeaders },
  );
  expect(response.ok()).toBe(true);
  const archive = (await response.json()).result.data.json as {
    filename: string;
    content: string;
  };
  expect(archive.filename).toBe(`${archiveId}.json`);
  expect(JSON.parse(archive.content).summary.id).toBe(archiveId);
  return archive.content;
}

test("Alpha defaults to factor configuration, saves a composite and opens the evidence tab", async ({
  page,
}) => {
  await page.goto("/lab/analysis", { waitUntil: "networkidle" });
  const tabs = page.getByRole("radiogroup", { name: "研究分析", exact: true });
  const alpha = tabs.getByRole("radio", { name: "多因子 Alpha 实验室" });
  const evidence = tabs.getByRole("radio", { name: "证据解读" });
  const config = page.getByRole("region", { name: "组合配置", exact: true });
  const evidenceForm = page.getByRole("region", {
    name: "研究问题",
    exact: true,
  });
  await expect(alpha).toBeChecked();
  await expect(config).toBeVisible();
  await expect(evidenceForm).toBeHidden();

  const name = `E2E Alpha ${randomUUID()}`;
  await config.getByLabel("组合名称", { exact: true }).fill(name);
  await config
    .getByRole("button", { name: "短期反转 · 5 日", exact: true })
    .click();
  const direction = config.getByRole("combobox", {
    name: "短期反转 · 5 日 方向",
  });
  const weight = config.getByRole("spinbutton", {
    name: "短期反转 · 5 日 权重",
  });
  const weighting = config.getByRole("combobox", { name: "合成方法" });
  await direction.selectOption("-1");
  await weighting.selectOption("custom");
  await weight.fill("2");
  await config.getByRole("button", { name: "保存组合", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `已保存「${name}」。` }),
  ).toBeVisible();

  await evidence.click();
  await expect(page).toHaveURL("/lab/analysis?tab=evidence");
  await expect(evidence).toBeChecked();
  await expect(evidenceForm).toBeVisible();
  await expect(config).toBeHidden();
  await page.reload();
  await expect(evidence).toBeChecked();
  await expect(evidenceForm).toBeVisible();

  await alpha.click();
  await expect(config).toBeVisible();
  await page
    .getByRole("region", { name: "已保存组合", exact: true })
    .getByRole("button", { name: `加载 ${name}`, exact: true })
    .click();
  await expect(config.getByLabel("组合名称", { exact: true })).toHaveValue(
    name,
  );
  await expect(weighting).toHaveValue("custom");
  await expect(direction).toHaveValue("-1");
  await expect(weight).toHaveValue("2");
});

test("studio switches three views, resolves both legacy links and leaves the archive intact", async ({
  page,
}) => {
  const run = {
    mode: "per-symbol",
    strategyKey: "dual-ma",
    symbols: ["sh600000"],
    start: "2024-01-02",
    end: "2024-09-30",
    initial: 123456,
    costScenario: "base",
    scenarios: ["strict"],
    confirmed: true,
  } satisfies LabDiagnoseRunInput;
  const response = await page.request.post("/api/trpc/strategyLabDiagnoseRun", {
    headers: trpcHeaders,
    data: { json: run },
  });
  expect(response.ok()).toBe(true);
  const { id } = (await response.json()).result.data.json as { id: string };
  expect((await waitForJob(page, id, 60_000)).status).toBe("completed");
  const archiveId = `lab-${id}`;
  const before = await exportArchive(page, archiveId);
  expect(JSON.parse(before).allCells).toHaveLength(1);

  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/trpc/") && request.method() !== "GET")
      writes.push(path);
  });
  await page.goto("/lab/backtest", { waitUntil: "networkidle" });
  const studio = page.getByRole("region", { name: "研究工作室", exact: true });
  const tabs = studio.getByRole("tablist", { name: "研究工作室视图" });
  const compose = tabs.getByRole("tab", { name: "编排", exact: true });
  const result = tabs.getByRole("tab", { name: "结果", exact: true });
  const archive = tabs.getByRole("tab", { name: "归档", exact: true });
  const templates = studio.getByRole("combobox", {
    name: "研究模板",
    exact: true,
  });
  const details = studio.getByRole("region", { name: "诊断归档详情" });
  const archives = studio.getByRole("region", { name: "历史诊断档案和实验" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(compose).toHaveAttribute("aria-selected", "true");
  await expect(templates).toHaveValue("ma-baseline-5m");

  await result.click();
  await expect(page).toHaveURL("/lab/backtest?view=result");
  await expect(result).toHaveAttribute("aria-selected", "true");
  await expect(
    studio.getByText("请选择归档或运行回测以查看结果。"),
  ).toBeVisible();
  await expect(templates).toBeHidden();

  await archive.click();
  await expect(page).toHaveURL("/lab/backtest?view=archive");
  await expect(archive).toHaveAttribute("aria-selected", "true");
  await archives.getByRole("textbox", { name: "检索归档" }).fill(archiveId);
  const row = archives.getByRole("listitem").filter({ hasText: "sh600000" });
  await expect(row).toHaveCount(1);
  const destructive = /删除|移除|清空归档|清理归档|清除归档/;
  await expect(archives.getByRole("button", { name: destructive })).toHaveCount(
    0,
  );
  await expect(archives.getByRole("link", { name: destructive })).toHaveCount(
    0,
  );
  await row.getByRole("button").click();
  await expect(page).toHaveURL(
    `/lab/backtest?view=result&archive=${archiveId}`,
  );
  await expect(details).toContainText("策略 dual-ma · 标的 sh600000");
  await expect(details.getByRole("button", { name: destructive })).toHaveCount(
    0,
  );
  await expect(details.getByRole("link", { name: destructive })).toHaveCount(0);

  await compose.click();
  await expect(compose).toHaveAttribute("aria-selected", "true");
  await expect(templates).toBeVisible();
  await expect(details).toBeHidden();
  await page.goto(`/lab/backtest?archive=${archiveId}`);
  await expect(result).toHaveAttribute("aria-selected", "true");
  await expect(details).toContainText("策略 dual-ma · 标的 sh600000");
  await expect(
    details.getByRole("button", { name: "导出全量 JSON" }),
  ).toBeVisible();

  await page.goto("/lab/backtest?mode=object");
  await expect(compose).toHaveAttribute("aria-selected", "true");
  await expect(templates).toHaveValue("single");
  await expect(
    studio.getByRole("combobox", { name: "单策略引擎" }),
  ).toHaveValue("object");
  await expect(
    studio.getByRole("textbox", { name: "回测策略对象" }),
  ).toBeVisible();
  expect(await exportArchive(page, archiveId)).toBe(before);
  expect(writes).toEqual([]);
});

test("account risk shows the selected ledger and reconciles a frozen three-book shortfall", async ({
  page,
}) => {
  await page.goto("/accounts?tab=risk", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("tab", { name: "账户风控与实施缺口" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("radio", { name: "真实账户", exact: true }),
  ).toBeChecked();
  const dashboard = page.getByRole("region", { name: "账户级风控仪表盘" });
  const ledger = dashboard.getByRole("combobox", { name: "风控账本" });
  await expect(dashboard).toContainText("2 本账");
  await ledger.click();
  await page.getByRole("option", { name: "big", exact: true }).click();
  await expect(dashboard).toContainText("1 本账");
  for (const name of ["回撤熔断", "总止损敞口", "行业集中度分布"])
    await expect(
      dashboard.getByRole("region", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Wilder ATR(14) 定仓试算" }),
  ).toBeVisible();

  const shortfall = page.getByRole("region", {
    name: "三账实施缺口与纪律偏差",
  });
  await expect(
    shortfall.getByRole("combobox", { name: "实施缺口账本" }),
  ).toHaveText("big");
  const date = "2019-01-03";
  await shortfall.getByLabel("估值开始日期", { exact: true }).fill(date);
  await shortfall.getByLabel("估值结束日期", { exact: true }).fill(date);
  const query = shortfall.getByRole("button", {
    name: "查询实施缺口",
    exact: true,
  });
  const result = shortfall.getByRole("region", { name: "实施缺口结果" });
  const amounts = result.getByRole("table", { name: "五维实施缺口金额" });
  const total = amounts.getByRole("row", { name: /实施缺口合计/ });
  await query.click();
  await expect(result).toContainText(`big · ${date} 至 ${date} · CNY`);
  await expect(
    result.getByRole("list", { name: "实施缺口缺失原因" }),
  ).toContainText(
    "成交的策略来源关联不包含完整冻结指令、理论费用和次一合法到达基准",
  );
  await expect(total.getByRole("cell").nth(1)).toHaveText("—");
  await expect(result).toContainText("缺少对账证据，期末净值差无法校验。");

  // The workbench account's first fills are on January 2. The next day has
  // one frozen buy instruction and no actual fill.
  const frozenPlan = {
    openingNav: 10000,
    commonTerminalValue: 10000,
    terminalPrices: { sh600000: 25 },
    theoretical: [
      {
        id: "qa-missed-buy",
        symbol: "sh600000",
        side: "buy",
        signalAt: Date.parse("2019-01-02T15:00:00+08:00"),
        decisionPrice: 20,
        quantity: 100,
        fees: 2,
      },
    ],
    executable: [
      {
        instructionId: "qa-missed-buy",
        arrivalAt: Date.parse("2019-01-03T09:30:00+08:00"),
        arrivalPrice: 21,
        quantity: 100,
        fees: 3,
      },
    ],
  } satisfies ShortfallFrozenPlan;
  await shortfall.getByText("冻结计划证据（可选）", { exact: true }).click();
  await shortfall
    .getByLabel("冻结计划证据 JSON", { exact: true })
    .fill(JSON.stringify({ frozenPlan }));
  await query.click();
  const balance = result.getByRole("region", { name: "期末净值对平校验" });
  await expect(balance.getByRole("status")).toContainText("精确对平通过");
  await expect(balance.getByRole("status")).toContainText(
    "接口数值残差 0.000000000 CNY",
  );
  await expect(
    amounts
      .getByRole("row", { name: /漏单机会成本/ })
      .getByRole("cell")
      .nth(1),
  ).toHaveText("500.000000");
  await expect(
    amounts
      .getByRole("row", { name: /费用差/ })
      .getByRole("cell")
      .nth(1),
  ).toHaveText("-2.000000");
  await expect(total.getByRole("cell").nth(1)).toHaveText("498.000000");
  await expect(balance.locator("strong")).toHaveText([
    "10498.000000",
    "10397.000000",
    "10000.000000",
    "-498.000000",
  ]);
  const deviations = result.getByRole("table", { name: "指令与成交偏离明细" });
  const missed = deviations.getByRole("row", { name: /qa-missed-buy/ });
  await expect(missed).toContainText("100 / 100 / 0");
  await expect(missed).toContainText("无成交");
});
