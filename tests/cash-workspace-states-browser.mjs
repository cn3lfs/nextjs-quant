import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const base = process.env.BASE ?? "http://127.0.0.1:3231";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.getByLabel("复盘账户别名").fill(fixture.accounts.stress);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  const table = cash.getByRole("region", { name: "逐日现金核对", exact: true });
  const detail = cash.getByRole("region", {
    name: "现金核对详情",
    exact: true,
  });
  await table.locator("tbody tr").first().waitFor({ timeout: 60000 });
  const summary = await cash
    .locator('[aria-label="全账户现金汇总"]')
    .innerText();
  for (const label of ["日末现金相等", "存在差异", "待核对", "来源冲突"]) {
    await cash.getByRole("combobox", { name: "现金核对状态筛选" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await cash
      .getByRole("button", { name: "查询现金日期", exact: true })
      .click();
    await page.waitForFunction((label) => {
      const rows = [
        ...document.querySelectorAll(
          'section[aria-label="逐日现金核对"] tbody tr',
        ),
      ];
      return (
        rows.length === 20 &&
        rows.every((row) => row.textContent.includes(label)) &&
        !rows[0].closest("fieldset").disabled
      );
    }, label);
    assert.equal(
      await cash.locator('[aria-label="全账户现金汇总"]').innerText(),
      summary,
    );
    await cash.getByText(/当前筛选匹配 2500 天/).waitFor();
    await table.locator("tbody tr").first().getByRole("button").click();
    await detail.getByText(`${label} · 人民币 / 元`, { exact: true }).waitFor();
    if (label === "存在差异")
      await detail.getByText("+0.01", { exact: true }).waitFor();
    if (label === "待核对") {
      // This imported row exists but has no balance; it is not an absent source.
      await detail
        .getByText("该日存在缺失或非法资金余额，不能认定日末余额", {
          exact: true,
        })
        .waitFor();
      await detail.getByText("柜台来源 · 1 份", { exact: true }).waitFor();
      assert.ok(
        (await detail.locator("dd").allTextContents()).includes("未知"),
      );
    }
    if (label === "来源冲突") {
      await detail.getByText("柜台来源 · 2 份", { exact: true }).waitFor();
      assert.equal(
        await detail
          .getByRole("button", { name: "查看逐行证据", exact: true })
          .count(),
        2,
      );
    }
    await detail
      .getByRole("button", { name: "返回日期列表", exact: true })
      .click();
  }
  // Global first difference remains usable outside the current conflict filter.
  await cash
    .getByRole("button", { name: "首次差异 2000-01-02", exact: true })
    .click();
  await detail
    .getByRole("heading", { name: "2000-01-02 现金核对", exact: true })
    .waitFor();
  await detail.getByText("+0.01", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "cash-first-difference",
  );
  assert.ok(
    (await table.locator("tbody tr").first().innerText()).includes("来源冲突"),
  );
  await cash
    .getByRole("button", { name: "导入证据待核对 · 0", exact: true })
    .click();
  await detail.getByText("没有待核对诊断。", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await cash.getByLabel("现金起始日期", { exact: true }).fill("2030-01-02");
  await cash.getByLabel("现金结束日期", { exact: true }).fill("2030-01-01");
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  await cash
    .getByRole("alert")
    .filter({ hasText: "起始日期不能晚于结束日期" })
    .waitFor();
  await cash.getByLabel("现金结束日期", { exact: true }).fill("2030-01-03");
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  await cash.getByText(/当前筛选匹配 0 天/).waitFor();
  assert.equal(
    await cash.locator('[aria-label="全账户现金汇总"]').innerText(),
    summary,
  );
  await cash.getByRole("button", { name: "重置现金筛选", exact: true }).click();
  await cash.getByText(/当前筛选匹配 10000 天/).waitFor();
  await page.getByLabel("复盘账户别名").fill(fixture.accounts.sources);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await cash
    .getByRole("button", { name: "期初依据 · 1000", exact: true })
    .click();
  const pager = detail.getByRole("navigation", { name: "期初依据分页" });
  await pager.getByText("第 1 / 50 页 · 共 1000 项", { exact: true }).waitFor();
  assert.equal(await detail.locator("li").count(), 20);
  await pager.getByRole("button", { name: "下一页", exact: true }).click();
  await pager.getByText("第 2 / 50 页 · 共 1000 项", { exact: true }).waitFor();
  assert.equal(await detail.locator("li").count(), 20);
  assert.deepEqual(errors, []);
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    fourStates: true,
    globalSummaryStable: true,
    firstDifferenceOutsideFilter: true,
    missingBalanceAndConflict: true,
    emptyDiagnostics: true,
    invalidAndNoMatchDates: true,
    thousandOpeningsPaged: true,
    errors,
  };
  writeFileSync(
    join(logs, "final-states.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
