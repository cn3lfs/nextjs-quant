// Persistent R2 page-by-page review. Use only the isolated browser database.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r2/browser"),
);
const [name, phase] = process.argv.slice(2);
assert.ok(["before", "after"].includes(phase));
const labels = {
  connections: "数据与连接",
  signals: "信号与通知",
  screen: "条件选股",
  market: "行情图表",
};
assert.ok(name in labels || ["signal-ledger", "trade-ledger"].includes(name));
const destination = resolve("docs/review/r2-review", name);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1840, height: 1350 },
    timezoneId: "Asia/Shanghai",
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      requests.push({ blocked: true, host: url.hostname });
      return route.abort();
    }
    if (/testChannel|retryDelivery/.test(url.pathname))
      throw new Error("Notification delivery is forbidden in R2 review");
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:3215${name in labels ? "" : `/${name}`}`);
  if (name in labels)
    await page.getByRole("button", { name: labels[name], exact: true }).click();
  await page.waitForLoadState("networkidle");
  if (name === "trade-ledger" && phase === "before") {
    for (const [field, value] of Object.entries({
      symbol: "sh600519",
      date: "2026-09-09",
      price: "10",
      quantity: "100",
      lowerLimit: "9",
      upperLimit: "11",
      limitSource: "R2 合成验证数据，非真实成交",
      stop: "9.5",
      note: "R2 浏览器隔离夹具",
    })) {
      await page.locator(`form input[name="${field}"]`).first().fill(value);
    }
    await page
      .getByRole("button", { name: "仅保存本地交易", exact: true })
      .click();
    await page
      .getByText("交易已记入本地账本，未向外部下单", { exact: true })
      .waitFor();
    await page.reload();
    await page.waitForLoadState("networkidle");
  }
  await page.addStyleTag({ content: "nextjs-portal { visibility: hidden; }" });
  await page.screenshot({
    path: join(destination, `${phase}.png`),
    fullPage: true,
    animations: "disabled",
  });
  const controls = await page
    .locator(
      "input,select,textarea,button,[role=combobox],[role=checkbox],table",
    )
    .evaluateAll((elements) =>
      elements.map((el) => {
        const s = getComputedStyle(el),
          r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          slot: el.getAttribute("data-slot"),
          type: el.getAttribute("type"),
          label:
            el.getAttribute("aria-label") ??
            el.closest("label")?.textContent?.trim() ??
            el.textContent?.trim(),
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          color: s.color,
          background: s.backgroundColor,
          border: s.border,
          padding: s.padding,
          font: s.font,
          radius: s.borderRadius,
        };
      }),
    );
  const interactions = [];
  if (name === "connections") {
    const submissions = [];
    await page.route("**/api/trpc/saveSettings*", async (route) => {
      submissions.push(JSON.parse(route.request().postData()));
      await route.continue();
    });
    await page
      .getByLabel("通达信安装目录", { exact: true })
      .fill("D:\\R2-read-only-fixture");
    await page.getByText("交易日历覆盖", { exact: true }).click();
    await page.locator("textarea").first().fill("2026-09-09\n2026-09-10");
    const quiet = page.getByRole("checkbox", {
      name: "启用自定义静默时段",
      exact: true,
    });
    await quiet.check();
    assert.ok(await page.getByLabel("静默开始", { exact: true }).isEnabled());
    await page.getByLabel("静默开始", { exact: true }).fill("21:00");
    await quiet.uncheck();
    assert.ok(await page.getByLabel("静默开始", { exact: true }).isDisabled());
    const platform = page.getByLabel("平台", { exact: true });
    if (phase === "before") await platform.selectOption("telegram");
    else {
      await platform.click();
      await page
        .getByRole("option", { name: "Telegram Bot", exact: true })
        .click();
    }
    await page
      .getByLabel("Chat ID（私聊需先联系机器人）", { exact: true })
      .fill("r2-local-fixture");
    await page
      .getByRole("checkbox", { name: "启用此渠道接收订阅信号", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "启用此渠道接收订阅信号", exact: true })
      .uncheck();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.getByText("设置已保存", { exact: true }).waitFor();
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]["0"].json.tdxRoot, "D:\\R2-read-only-fixture");
    assert.deepEqual(submissions[0]["0"].json.calendar, [
      "2026-09-09",
      "2026-09-10",
    ]);
    assert.equal(
      submissions[0]["0"].json.notificationPolicy.quietEnabled,
      false,
    );
    assert.equal(
      submissions[0]["0"].json.notificationPolicy.quietStart,
      "21:00",
    );
    interactions.push(
      "目录填写与保存请求参数一致（仅隔离库）",
      "日历多行输入保持原分词",
      "自定义静默复选及时间字段禁用联动",
      "平台切换显示Telegram字段",
      "渠道复选可开关；未保存渠道、未调用测试通知",
    );
  }
  if (name === "signals" && phase === "after") {
    await page
      .getByLabel("监控名称", { exact: true })
      .fill("R2 本地无渠道订阅");
    await page
      .getByLabel("证券池（留空使用自选）", { exact: true })
      .fill("sh600519");
    await page.getByLabel("监控策略", { exact: true }).click();
    await page
      .getByRole("option", { name: "双突破（日线）", exact: true })
      .click();
    assert.ok(await page.getByLabel("周期", { exact: true }).isDisabled());
    await page.getByLabel("监控数据源", { exact: true }).click();
    await page
      .getByRole("option", {
        name: "本地通达信文件（需自行更新）",
        exact: true,
      })
      .click();
    await page
      .getByRole("checkbox", { name: "信号后附加 AI 解读", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "信号后附加 AI 解读", exact: true })
      .uncheck();
    const saved = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().includes("saveMonitor"),
    );
    await page.getByRole("button", { name: "启用监控", exact: true }).click();
    const payload = JSON.parse((await saved).postData())["0"].json;
    assert.deepEqual(payload.channels, []);
    assert.equal(payload.source, "local");
    assert.equal(payload.ai, false);
    assert.equal(payload.period, "day");
    assert.equal(payload.strategy.type, "dual-breakout");
    await page.getByText("R2 本地无渠道订阅", { exact: true }).waitFor();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "启用", exact: true }).waitFor();
    interactions.push(
      "订阅名称与证券池填写",
      "策略下拉锁定日线",
      "本地下拉选择",
      "AI复选开关",
      "隔离库保存并暂停无渠道本地订阅，核验提交参数",
    );
  }
  if (name === "trade-ledger" && phase === "after") {
    const localForm = page.locator("form").first();
    await page
      .getByRole("button", { name: "仅保存本地交易", exact: true })
      .click();
    assert.equal(
      await localForm.evaluate((form) => form.checkValidity()),
      false,
    );
    const formValues = () =>
      localForm.evaluate((form) => Object.fromEntries(new FormData(form)));
    assert.equal((await formValues()).side, "buy");
    assert.equal((await formValues()).signalId, "");
    const side = page.getByLabel("买卖", { exact: true });
    await side.click();
    await page.getByRole("option", { name: "卖出", exact: true }).click();
    assert.equal((await formValues()).side, "sell");
    await side.click();
    await page.getByRole("option", { name: "买入", exact: true }).click();
    await page.getByLabel("关联台账信号（可空）", { exact: true }).click();
    await page
      .getByRole("option", { name: "手动交易，不关联", exact: true })
      .click();
    assert.equal((await formValues()).signalId, "");
    assert.ok(
      (
        await page
          .getByRole("table", { name: "当前持仓", exact: true })
          .innerText()
      ).includes("sh600519"),
    );
    for (const [field, value] of Object.entries({
      symbol: "sz000001",
      date: "2026-09-09",
      price: "10",
      quantity: "100",
      lowerLimit: "9",
      upperLimit: "11",
      limitSource: "R2 合成验证数据，非真实成交",
      stop: "9.5",
      note: "R2 迁移后表单提交",
    })) {
      await localForm.locator(`input[name="${field}"]`).fill(value);
    }
    await page
      .getByRole("button", { name: "仅保存本地交易", exact: true })
      .click();
    await page
      .getByText("交易已记入本地账本，未向外部下单", { exact: true })
      .waitFor();
    await page.getByText("文档契约与实测契约差异", { exact: true }).click();
    assert.ok(
      await page
        .getByRole("table", { name: "文档契约与实测契约差异", exact: true })
        .isVisible(),
    );
    await page.getByText("文档契约与实测契约差异", { exact: true }).click();
    assert.equal(
      await page
        .getByRole("table", { name: "文档契约与实测契约差异", exact: true })
        .isVisible(),
      false,
    );
    interactions.push(
      "原生required校验仍阻止空表单",
      "默认买入及切换买卖的FormData值",
      "空关联选项可选且提交空字符串",
      "当前持仓DataTable显示原有记录",
      "隔离库本地成交提交成功",
      "契约表折叠开关；模拟盘保持关闭",
    );
  }
  if (name === "signal-ledger" && phase === "after") {
    const table = page.getByRole("table", { name: "聚合统计", exact: true });
    assert.deepEqual(
      await table.locator("tbody tr td:nth-child(3)").allTextContents(),
      ["T+5", "T+10", "T+20"],
    );
    assert.equal(await table.getByRole("button").count(), 0);
    const detail = page
      .locator('section[aria-label="台账明细"] details')
      .first();
    await detail.locator("summary").click();
    assert.ok(
      (await detail.innerText()).includes("R2 合成截图夹具，非真实信号"),
    );
    await detail.locator("summary").click();
    assert.equal(await detail.getAttribute("open"), null);
    const run = page.locator('section[aria-label="每日任务"] details').first();
    await run.locator("summary").click();
    assert.ok((await run.innerText()).includes("R2 合成截图夹具"));
    await run.locator("summary").click();
    interactions.push(
      "聚合表期限顺序T+5/T+10/T+20不变",
      "原页面无排序与分页，未新增",
      "台账和每日任务明细展开及收起",
      "已完成任务没有取消按钮，不伪造运行任务",
    );
  }
  if (name === "screen" && phase === "after") {
    const section = page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: "候选结果", exact: true }),
    });
    const table = page.getByRole("table", { name: "候选结果", exact: true });
    const queries = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("screenResults"))
        queries.push(JSON.parse(url.searchParams.get("input")));
    });
    assert.equal(await table.locator("tbody tr").count(), 50);
    await table.getByText("sh600000", { exact: true }).waitFor();
    await page.getByLabel("候选排序字段", { exact: true }).click();
    await page.getByRole("option", { name: "证券代码", exact: true }).click();
    await table.getByText("sh600122", { exact: true }).waitFor();
    await section
      .getByRole("button", { name: "下一页", exact: true })
      .first()
      .click();
    await table.getByText("sh600072", { exact: true }).waitFor();
    assert.equal(await table.locator("tbody tr").count(), 50);
    await page.getByLabel("候选排序方向", { exact: true }).click();
    await page.getByRole("option", { name: "从低到高", exact: true }).click();
    await table.getByText("sh600000", { exact: true }).waitFor();
    await page
      .getByLabel("筛选候选名称或代码", { exact: true })
      .fill("sh600010");
    await table.getByText("sh600010", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('table[aria-label="候选结果"] tbody tr')
          .length === 1,
    );
    const queryInputs = queries.flatMap((batch) =>
      Object.values(batch).map((value) => value.json),
    );
    assert.ok(
      queryInputs.some((input) => input.page === 1 && input.sort === "symbol"),
    );
    assert.ok(
      queryInputs.some(
        (input) => input.page === 0 && input.query === "sh600010",
      ),
    );
    await section
      .locator("summary")
      .filter({ hasText: "查看隔离原因" })
      .click();
    const excluded = section.locator("details").filter({
      has: page.locator("summary").filter({ hasText: "查看隔离原因" }),
    });
    await excluded.getByRole("button", { name: "下一页", exact: true }).click();
    const excludedTable = page.getByRole("table", {
      name: "隔离原因",
      exact: true,
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('table[aria-label="隔离原因"] tbody tr')
          .length === 3,
    );
    assert.ok((await excludedTable.innerText()).includes("sz000051"));
    await page
      .getByLabel("公式源码", { exact: true })
      .fill("选股:REFX(C,1)>0;");
    await page
      .getByRole("button", { name: "语法检查与未来函数门禁", exact: true })
      .click();
    assert.ok(
      await page
        .getByRole("button", { name: "保存公式", exact: true })
        .isDisabled(),
    );
    await page.getByLabel("公式源码", { exact: true }).fill("选股:C>0;");
    await page.getByLabel("公式参数 JSON", { exact: true }).fill("{}");
    await page.getByLabel("公式名称", { exact: true }).fill("R2 合成公式");
    await page
      .getByRole("button", { name: "语法检查与未来函数门禁", exact: true })
      .click();
    await page.getByRole("button", { name: "保存公式", exact: true }).click();
    await page.getByText("公式已保存", { exact: true }).waitFor();
    await page.getByLabel("已保存公式", { exact: true }).click();
    await page.getByRole("option", { name: "新公式", exact: true }).click();
    assert.ok(
      (
        await page.getByLabel("已保存公式", { exact: true }).innerText()
      ).includes("新公式"),
    );
    interactions.push(
      "123条候选服务端排序，当前页50条",
      "下一页请求page=1且保留sort=symbol",
      "排序方向变化回第一页",
      "搜索请求page=0，精确命中1条",
      "53条隔离记录第二页3条",
      "公式未来函数拒绝、有效公式本地保存、切回空选项新公式",
      "未执行在线查询或全市场公式任务",
    );
    await writeFile(
      join(destination, "server-queries.json"),
      JSON.stringify(queryInputs, null, 2),
    );
  }
  if (name === "market" && phase === "after") {
    const chart = page.getByTestId("market-chart");
    assert.ok((await chart.locator("canvas").count()) > 0);
    await page.getByRole("checkbox", { name: "BOLL", exact: true }).check();
    await page.getByRole("checkbox", { name: "BOLL", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "对数坐标", exact: true }).check();
    await page
      .getByRole("checkbox", { name: "对数坐标", exact: true })
      .uncheck();
    await page.getByRole("checkbox", { name: "加深背景", exact: true }).check();
    assert.equal(await chart.getAttribute("data-dark"), "true");
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => el.classList.contains("dark")),
      false,
    );
    await page
      .getByRole("checkbox", { name: "加深背景", exact: true })
      .uncheck();
    await page.getByLabel("副图组合", { exact: true }).click();
    const macdOption = page.getByRole("menuitemcheckbox", {
      name: "MACD",
      exact: true,
    });
    await macdOption.uncheck();
    await macdOption.check();
    await page.getByTestId("chart-legend").getByText(/MACD/).waitFor();
    await page
      .getByRole("menuitemcheckbox", { name: "成交量", exact: true })
      .uncheck();
    await page.getByLabel("副图组合", { exact: true }).click();
    await page.getByText("指标参数", { exact: true }).click();
    await page.getByLabel("MA 参数 1", { exact: true }).fill("7");
    await page.getByRole("button", { name: "应用参数", exact: true }).click();
    const request = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().includes("saveChartView"),
    );
    await page.getByRole("button", { name: "保存视图", exact: true }).click();
    const saved = JSON.parse((await request).postData())["0"].json;
    assert.equal(saved.view.parameters.ma[0], 7);
    assert.equal(saved.view.dark, false);
    await page.getByText("视图已保存", { exact: true }).waitFor();
    const search = page.getByRole("combobox", {
      name: "搜索品种名称或代码",
      exact: true,
    });
    await search.fill("sh600519");
    assert.equal(await search.getAttribute("aria-expanded"), "true");
    await search.press("Escape");
    assert.equal(await search.getAttribute("aria-expanded"), "false");
    interactions.push(
      "BOLL、对数坐标复选开关",
      "既有图表暗色开关仍只作用于图表，测试后关闭",
      "MACD/成交量副图自由组合",
      "MA参数表单提交并核验保存请求",
      "品种搜索输入与Escape收起；图表canvas保留",
    );
  }
  await writeFile(
    join(destination, `${phase}.json`),
    JSON.stringify(
      {
        controls,
        errors,
        requests,
        interactions,
        actualNotificationDeliveries: 0,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    `${name} ${phase}: screenshot captured; browser errors ${errors.length}`,
  );
} finally {
  await browser.close();
}
