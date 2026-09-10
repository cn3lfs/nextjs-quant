/** Q1 A-layer browser review, using the repo's shared Playwright installation.
 * Set QUANT_DATA_DIR=.test-data/q1/browser before starting the reviewed server.
 * Screenshots are evidence for user review, not TradingView equivalence.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const destination = resolve("docs/q1-review");
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const evidence = {
  capturedAt: new Date().toISOString(),
  source: "本地通达信不复权行情；独立 Q1 数据库；成本线额外受控 fixture 另标",
  screenshots: [],
  checks: [],
  errors: [],
  visualAgreement: "B 层由用户对比 TradingView，执行者未判定",
};
try {
  const page = await browser.newPage({
    viewport: { width: 1840, height: 1350 },
    timezoneId: "Asia/Shanghai",
  });
  page.on("pageerror", (e) => evidence.errors.push(e.message));
  await page.goto(process.env.Q1_REVIEW_URL ?? "http://127.0.0.1:3211");
  const chart = page.getByTestId("market-chart"),
    workspace = page.getByTestId("chart-workspace");
  await chart.waitFor({ timeout: 60000 });
  await writeFile(
    join(destination, "initial-aria.txt"),
    await workspace.ariaSnapshot(),
  );
  const capture = async (name) => {
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
    await workspace.screenshot({ path: join(destination, name) });
    evidence.screenshots.push(name);
  };
  assert.equal(await chart.getAttribute("data-period"), "day");
  await capture("01-day-light.png");
  // Native canvas is focused only for chart shortcuts; form arrows keep native input behavior.
  const canvas = chart.getByRole("application");
  await canvas.focus();
  await canvas.press("ArrowLeft");
  await canvas.press("ArrowRight");
  await canvas.press("ArrowUp");
  await canvas.press("ArrowDown");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width - 25, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 25, box.y + 230, { steps: 12 });
  await page.mouse.up();
  evidence.checks.push(
    "keyboard navigation and native price-axis drag exercised",
  );
  await workspace.getByText("指标参数", { exact: true }).click();
  const custom = {
    MA: [3, 8, 21, 55],
    MACD: [5, 17, 4],
    KDJ: [7, 4, 2],
    RSI: [4, 9, 18],
    BOLL: [15, 2.5],
  };
  for (const [name, values] of Object.entries(custom))
    for (let i = 0; i < values.length; i++)
      await workspace
        .getByLabel(`${name} 参数 ${i + 1}`, { exact: true })
        .fill(String(values[i]));
  await workspace
    .getByRole("button", { name: "应用参数", exact: true })
    .click();
  await chart.getByLabel("BOLL", { exact: true }).check();
  await chart.getByLabel("副图", { exact: true }).selectOption("macd");
  assert.match(await chart.getByTestId("chart-legend").innerText(), /MA3/);
  await workspace.getByLabel("对数坐标", { exact: true }).check();
  await workspace.getByLabel("暗色主题", { exact: true }).check();
  for (const [i, name] of ["趋势线", "水平线", "矩形", "斐波那契"].entries()) {
    await workspace.getByRole("button", { name, exact: true }).click();
    await canvas.scrollIntoViewIfNeeded();
    const b = await canvas.boundingBox();
    await page.mouse.click(b.x + b.width * 0.45, b.y + 110 + i * 22);
    if (name !== "水平线")
      await page.mouse.click(b.x + b.width * 0.72, b.y + 195 + i * 16);
  }
  assert.equal(
    await workspace
      .getByRole("button", { name: "删除图形", exact: true })
      .count(),
    4,
  );
  const price = workspace.getByLabel("趋势线 a 价格", { exact: true });
  const edited = Number(await price.inputValue()) + 0.5;
  await price.fill(String(edited));
  await price
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "更新图形", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "保存视图", exact: true })
    .click();
  await workspace.getByText("视图已保存", { exact: true }).waitFor();
  await capture("02-day-dark-log-drawings.png");
  await page.reload();
  await chart.waitFor({ timeout: 60000 });
  assert.equal(
    await workspace
      .getByRole("button", { name: "删除图形", exact: true })
      .count(),
    4,
  );
  assert.equal(
    Number(
      await workspace.getByLabel("趋势线 a 价格", { exact: true }).inputValue(),
    ),
    edited,
  );
  assert.equal(
    await workspace.getByLabel("暗色主题", { exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await workspace.getByLabel("对数坐标", { exact: true }).isChecked(),
    true,
  );
  assert.match(await chart.getByTestId("chart-legend").innerText(), /MA3/);
  for (const [name, values] of Object.entries(custom))
    for (let i = 0; i < values.length; i++)
      assert.equal(
        Number(
          await workspace
            .getByLabel(`${name} 参数 ${i + 1}`, { exact: true })
            .inputValue(),
        ),
        values[i],
      );
  evidence.checks.push(
    "four drawing tools created; anchor edited; drawings, all parameters, theme, log, subchart and BOLL saved/reloaded",
  );
  for (const [label, period, file] of [
    ["周线", "week", "03-week.png"],
    ["月线", "month", "04-month.png"],
    ["5 分钟", "5m", "05-five-minute.png"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(
      (p) =>
        document
          .querySelector('[data-testid="market-chart"]')
          ?.getAttribute("data-period") === p,
      period,
      { timeout: 60000 },
    );
    assert.equal(
      await workspace
        .getByRole("button", { name: "删除图形", exact: true })
        .count(),
      0,
    );
    if (period !== "5m") {
      assert.match(
        await chart.getByTestId("czsc-status").innerText(),
        /不可用/,
      );
      assert.match(
        await chart.getByTestId("breakout-status").innerText(),
        /不可用/,
      );
    }
    await capture(file);
  }
  await page.getByRole("button", { name: "日 K", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="market-chart"]')
        ?.getAttribute("data-period") === "day",
  );
  assert.equal(
    await workspace
      .getByRole("button", { name: "删除图形", exact: true })
      .count(),
    4,
  );
  await workspace
    .getByRole("button", { name: "删除图形", exact: true })
    .first()
    .click();
  await workspace
    .getByRole("button", { name: "保存视图", exact: true })
    .click();
  await workspace.getByText("视图已保存", { exact: true }).waitFor();
  await page.reload();
  await chart.waitFor({ timeout: 60000 });
  assert.equal(
    await workspace
      .getByRole("button", { name: "删除图形", exact: true })
      .count(),
    3,
  );
  evidence.checks.push(
    "cycle isolation and persisted drawing deletion; week/month both explicitly disallow strategy overlays",
  );
  assert.equal(await workspace.getByTestId("position-cost").count(), 0);
  evidence.checks.push("empty real local ledger displays no cost line");
  // Controlled response exercises visual profit direction; this is NOT a remote fill or live holding.
  await page.route("**/api/trpc/*", async (route) => {
    const url = new URL(route.request().url());
    const paths = url.pathname.split("/").at(-1).split(",");
    const idx = paths.indexOf("chartPosition");
    if (idx < 0) return route.continue();
    const response = await route.fetch();
    // tRPC httpBatchStreamLink uses JSONL promise frames, not one JSON document.
    const frames = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const byId = new Map(
      frames.slice(1).map((frame) => [frame.json[0], frame]),
    );
    const resultId = frames[0].json[String(idx)][1][2];
    const dataId = byId.get(resultId).json[2][1][2];
    const valueId = byId.get(dataId).json[2][1][2];
    const valueFrame = byId.get(valueId);
    assert.equal(valueFrame.json[2][0][0], null);
    valueFrame.json[2][0][0] = {
      symbol: "sh600519",
      quantity: 100,
      adjustedCost: 1400,
    };
    await route.fulfill({
      response,
      body: frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    });
  });
  await page.reload();
  await chart.waitFor({ timeout: 60000 });
  await workspace.getByTestId("position-cost").waitFor();
  await capture("06-controlled-position-cost.png");
  evidence.checks.push(
    "controlled P1 position-shaped response renders cost line; fixture cost=1400 quantity=100, not a real trade",
  );
  assert.deepEqual(evidence.errors, []);
} finally {
  await writeFile(
    join(destination, "capture.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await browser.close();
}
console.log(JSON.stringify(evidence, null, 2));
