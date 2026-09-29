/** Run only against an explicitly isolated production server. Writes its settings.
 * CONNECTIONS_ISOLATED=1 BASE=http://127.0.0.1:3218 node tests/connections-production-browser.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.equal(
  process.env.CONNECTIONS_ISOLATED,
  "1",
  "Explicit isolated server acknowledgment required",
);
const base = process.env.BASE ?? "http://127.0.0.1:3218";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Source selection behavior is independent of market availability; use a labeled synthetic snapshot.
  await page.route("**/api/trpc/snapshot", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          data: {
            json: {
              id: "settings-browser-fixture",
              symbol: "sh600519",
              period: "day",
              hash: "fixture",
              createdAt: Date.now(),
              source: "tdx-local",
              requestedSource: "local",
              adjustment: "none",
              bars: [
                {
                  date: "2026-09-25",
                  open: 10,
                  high: 12,
                  low: 9,
                  close: 11,
                  volume: 100,
                  amount: 1000,
                },
              ],
            },
          },
        },
      }),
    }),
  );
  await page.goto(`${base}/settings`);
  const root = page.getByLabel("通达信安装目录", { exact: true });
  await root.waitFor();
  const originalRoot = await root.inputValue();
  assert.match(originalRoot, /quant-connections-production[\\/]fixture$/);
  const settingsPanel = page.getByRole("region", {
    name: "行情数据配置",
    exact: true,
  });
  async function selectSource(label) {
    await settingsPanel.getByRole("combobox", { name: "行情数据源" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  }
  async function save() {
    if (
      await page
        .getByRole("button", { name: "保存设置", exact: true })
        .isDisabled()
    )
      return;
    const request = page.waitForResponse((response) =>
      response.url().includes("/api/trpc/saveSettings"),
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    assert.equal((await request).ok(), true);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-settings-state]")
          ?.getAttribute("data-settings-state") === "saved",
    );
  }
  await selectSource("通达信本地");
  await save();
  await page.getByRole("button", { name: "检查已保存配置" }).click();
  await page
    .getByText("目录可读，但未找到该证券与周期的行情文件", { exact: true })
    .waitFor();
  await root.fill(`${originalRoot}/does-not-exist`);
  await save();
  await page
    .getByText("以下为旧配置或旧选择的检查结果，请重新检查。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "检查已保存配置" }).click();
  await page.getByText("配置目录不存在", { exact: true }).waitFor();
  await root.fill(originalRoot);
  await save();
  await page.locator('a[href="/market"]').first().click();
  await page.waitForURL(`${base}/market`);
  const marketSource = page.getByRole("combobox", {
    name: "行情数据源",
    exact: true,
  });
  await marketSource.waitFor();
  assert.match(await marketSource.innerText(), /通达信本地/);
  await marketSource.click();
  await page.getByRole("option", { name: "腾讯自选股", exact: true }).click();
  await page.locator('a[href="/settings"]').first().click();
  await page.waitForURL(`${base}/settings`);
  await selectSource("tstdx");
  await save();
  await page.locator('a[href="/market"]').first().click();
  await page.waitForURL(`${base}/market`);
  assert.match(
    await marketSource.innerText(),
    /腾讯自选股/,
    "Explicit market choice wins over newly saved defaults",
  );
  await page.locator('a[href="/settings"]').first().click();
  await page.waitForURL(`${base}/settings`);
  await selectSource("自动");
  await save();
  await page.setViewportSize({ width: 900, height: 800 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(
      tmpdir(),
      "logs",
      "quant-connections",
      "production-settings.png",
    ),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS production settings: save, diagnose, recover, stale result, default source, explicit override, narrow layout",
  );
} finally {
  await browser.close();
}
