import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3230";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q0-fixture.json"), "utf8"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const width of [1440, 1024, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      acceptDownloads: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
    await page.bringToFront();
    await page.getByLabel("复盘账户别名").fill(fixture.account);
    await page.getByRole("button", { name: "查看复盘", exact: true }).click();
    const cash = page.getByRole("region", { name: "现金核对", exact: true });
    await cash
      .getByRole("region", { name: "逐日现金核对", exact: true })
      .locator("tbody tr")
      .first()
      .waitFor({ timeout: 60000 });
    await cash.getByLabel("现金起始日期", { exact: true }).fill("2020-01-01");
    await cash.getByLabel("现金结束日期", { exact: true }).fill("2020-01-01");
    await cash
      .getByRole("button", { name: "查询现金日期", exact: true })
      .click();
    const trigger = cash.getByRole("button", {
      name: "2020-01-01",
      exact: true,
    });
    await trigger.waitFor();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const detail = cash.getByRole("region", {
      name: "现金核对详情",
      exact: true,
    });
    await detail
      .getByRole("button", { name: "查看逐行证据", exact: true })
      .waitFor();
    await detail
      .getByRole("button", { name: "查看逐行证据", exact: true })
      .click();
    const rows = detail.getByRole("region", {
      name: "结构化余额证据",
      exact: true,
    });
    await rows.locator("tbody tr").first().waitFor();
    assert.equal(await rows.locator("tbody tr").count(), 20);
    assert.equal(
      await rows
        .locator("tbody tr")
        .first()
        .locator("td")
        .first()
        .textContent(),
      "1",
    );
    await rows
      .getByRole("navigation", { name: "逐行证据分页" })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          'section[aria-label="结构化余额证据"] tbody tr td',
        )?.textContent === "21",
    );
    await rows
      .getByRole("button", { name: "打开交割单批次", exact: true })
      .click();
    await page
      .getByRole("button", { name: "返回现金核对证据", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "返回现金核对证据", exact: true })
      .click();
    assert.equal(
      await rows
        .locator("tbody tr")
        .first()
        .locator("td")
        .first()
        .textContent(),
      "21",
    );
    assert.ok(
      await rows
        .getByRole("button", { name: "打开交割单批次", exact: true })
        .evaluate((element) => element === document.activeElement),
    );
    await page.keyboard.press("Escape");
    await rows.waitFor({ state: "detached" });
    assert.ok(
      await detail
        .getByRole("button", { name: "查看逐行证据", exact: true })
        .evaluate((element) => element === document.activeElement),
    );
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "detached" });
    assert.ok(
      await trigger.evaluate((element) => element === document.activeElement),
    );
    assert.equal(
      await cash.getByLabel("现金起始日期", { exact: true }).inputValue(),
      "2020-01-01",
    );
    const downloadEvent = page.waitForEvent("download");
    await cash
      .getByRole("button", { name: "导出全部日期证据", exact: true })
      .click();
    const download = await downloadEvent;
    const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(exported.account, fixture.account);
    assert.equal(exported.evidence.days.length, 1000);
    assert.equal(exported.evidence.days[0].evidence[0].rows.length, 20000);
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify(exported.evidence))
        .digest("hex"),
      exported.evidenceHash,
    );
    await cash
      .getByRole("button", { name: "期初依据 · 1", exact: true })
      .click();
    await detail.getByRole("navigation", { name: "期初依据分页" }).waitFor();
    assert.ok(
      await cash.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    );
    await detail.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await page.screenshot({ path: join(logs, `q2-cash-${width}.png`) });
    await detail.getByRole("button", { name: "返回日期列表" }).click();
    const nodes = await cash.locator("*").count();
    assert.ok(nodes < 2000, `cash summary leaked evidence DOM: ${nodes}`);
    assert.deepEqual(errors, []);
    results.push({
      width,
      nodes,
      errors,
      exportedDays: exported.evidence.days.length,
      exportedRows: exported.evidence.days[0].evidence[0].rows.length,
    });
    await page.close();
  }
  writeFileSync(
    join(logs, "q2-browser.json"),
    JSON.stringify(
      { build: readFileSync(".next/BUILD_ID", "utf8").trim(), results },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
