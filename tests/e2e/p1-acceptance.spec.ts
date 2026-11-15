import {
  expect,
  test,
  type Page,
  type Locator,
  type CDPSession,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { navItems } from "../../src/components/workbench/navigation";
import { installOfflineVisualApi } from "./offline-visual-api";
import {
  newsFixtureAnalysis,
  newsFixtureCutoff,
} from "../helpers/news-workspace-fixture";
import { trpcCalls, trpcHeaders, waitForJob } from "./helpers";
import { defaultChartView } from "../../src/lib/chart/chart-view";

const fixedTime = new Date("2026-11-14T04:00:00Z");
const routes = [
  ...navItems.map((item) => item.href),
  "/system/ui-gallery",
  "/lab/reports/report/p1-report",
];
const zoomSessions = new WeakMap<Page, CDPSession>();
async function setZoomedViewport(
  page: Page,
  viewport: { width: number; height: number },
  zoom: number,
) {
  const cssViewport = {
    width: Math.floor(viewport.width / zoom),
    height: Math.floor(viewport.height / zoom),
  };
  await page.setViewportSize(cssViewport);
  let session = zoomSessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    zoomSessions.set(page, session);
  }
  await session.send("Emulation.setDeviceMetricsOverride", {
    ...cssViewport,
    deviceScaleFactor: zoom,
    mobile: false,
  });
  expect(await page.evaluate(() => devicePixelRatio)).toBe(zoom);
}

async function ready(page: Page, path: string) {
  await page.clock.setFixedTime(fixedTime);
  await page.goto(
    path === "/scan"
      ? "/scan?symbol=sh600519&source=local"
      : path === "/intel"
        ? `/intel?newsQuery=${encodeURIComponent(JSON.stringify({ cutoff: newsFixtureCutoff, query: "", historical: true }))}`
        : path,
  );
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  if (path === "/intel")
    await expect(page.getByText("合成新闻1", { exact: true })).toBeVisible();
}

async function fits(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(sizes.content, JSON.stringify(sizes)).toBeLessThanOrEqual(
    sizes.viewport + 1,
  );
}

async function dismiss(page: Page, trigger: Locator, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
}

async function checkOverlays(page: Page) {
  const triggers = page.locator(
    'main button[aria-haspopup="dialog"]:visible, main button[aria-haspopup="listbox"]:visible, main button[aria-haspopup="menu"]:visible',
  );
  const count = await triggers.count();
  for (let index = 0; index < count; index++) {
    const trigger = triggers.nth(index);
    if (await trigger.isDisabled()) continue;
    await trigger.click();
    const type = await trigger.getAttribute("aria-haspopup");
    let popup = page.getByRole("dialog").last();
    if (type === "listbox") popup = page.getByRole("listbox").last();
    if (type === "menu") popup = page.getByRole("menu").last();
    await dismiss(page, trigger, popup);
  }
}

async function exploreViews(
  page: Page,
  states: string[],
  seen = new Set<string>(),
) {
  const groups = page.locator(
    'main [role="tablist"]:visible, main [role="radiogroup"]:visible, main [aria-label="报告视图"]:visible',
  );
  const signatures = await groups.evaluateAll((elements) =>
    elements.map((el) => el.textContent ?? ""),
  );
  for (const signature of signatures) {
    if (seen.has(signature)) continue;
    seen.add(signature);
    const group = groups.filter({ hasText: signature }).first();
    const choices = group.locator('[role="tab"], [role="radio"], button');
    const labels = await choices.allTextContents();
    for (const label of labels) {
      const choice = choices.filter({ hasText: label }).first();
      if (await choice.isDisabled()) continue;
      await choice.click();
      await page.waitForLoadState("networkidle");
      await fits(page);
      states.push(label.trim());
      await checkOverlays(page);
      await exploreViews(page, states, seen);
    }
  }
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const failed = new Set<string>();
  const api = await installOfflineVisualApi(
    page,
    failed,
    undefined,
    new Set(["maBaseline", "checkFormula", "formulaScreen"]),
  );
  // Assertions belong in afterEach even when a preceding interaction fails.
  guards.set(page, { errors, api, failed });
});
const guards = new WeakMap<
  Page,
  {
    errors: string[];
    api: Awaited<ReturnType<typeof installOfflineVisualApi>>;
    failed: Set<string>;
  }
>();
test.afterEach(async ({ page }) => {
  const guard = guards.get(page)!;
  expect(guard.errors).toEqual([]);
  expect([...guard.api.unknown]).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  for (const zoom of [1, 1.25, 1.5]) {
    for (const path of routes) {
      test(`C1/C3 ${viewport.width} ${zoom * 100}% ${path}`, async ({
        page,
      }, info) => {
        await setZoomedViewport(page, viewport, zoom);
        await ready(page, path);
        await fits(page);
        await expect(page.locator("main")).toBeVisible();
        await expect(page.locator("main")).not.toContainText(
          /NaN|Infinity|undefined/,
        );
        await checkOverlays(page);
        const states: string[] = [];
        // Visit every reachable top-level tab/segmented view once, then discover
        // its child tabs. No mutations, exports, cleanup or model actions.
        await exploreViews(page, states);
        // Ctrl+K and Tab enter the navigation with visible keyboard focus.
        const search = page.getByRole("combobox", {
          name: "搜索页面",
          exact: true,
        });
        if (path === "/system/ui-gallery") {
          await page
            .getByRole("link", { name: "← 返回工作台", exact: true })
            .focus();
        } else {
          await page.keyboard.press("Control+k");
          await expect(search).toBeFocused();
          await page.keyboard.press("Escape");
        }
        await page.keyboard.press("Tab");
        const focus = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const css = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            ring: css.boxShadow,
            outline: css.outlineStyle,
            width: box.width,
            height: box.height,
          };
        });
        expect(focus.tag).not.toBe("BODY");
        expect(focus.width * focus.height).toBeGreaterThan(0);
        expect(focus.outline !== "none" || focus.ring !== "none").toBe(true);
        await writeFile(
          info.outputPath("states.json"),
          JSON.stringify(
            {
              path,
              viewport,
              zoom,
              states,
              alerts: await page.getByRole("alert").allTextContents(),
            },
            null,
            2,
          ),
        );
      });
    }
  }
}

test("C2/C3 collapsed navigation tooltip opens from keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await ready(page, "/");
  const link = page
    .getByRole("navigation", { name: "工作台导航", exact: true })
    .getByRole("link", { name: "行情图表", exact: true });
  await expect(link).toHaveCSS("display", "flex");
  await page.keyboard.press("Tab");
  await link.focus();
  await expect(
    page.getByRole("tooltip", { name: "行情图表", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("C1 partial news identifies completed and unfinished counts", async ({
  page,
}) => {
  await ready(page, `/intel?analysis=${newsFixtureAnalysis(0).id}`);
  await expect(page.getByText("部分完成：", { exact: false })).toContainText(
    "已完成 5 条，未完成 5 条",
  );
  await expect(
    page.getByRole("heading", { name: "新闻分析依据", exact: true }),
  ).toBeVisible();
});

test("C2 loaded news original returns focus to its list action", async ({
  page,
}) => {
  await ready(page, "/intel");
  const article = page.locator("main article").first();
  const headline = await article.locator("strong").first().innerText();
  const read = article.getByRole("button", { name: "阅读原文", exact: true });
  await read.click();
  await expect(
    page.getByRole("heading", { name: "新闻原文", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: headline, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回新闻列表", exact: true }).click();
  await expect(read).toBeFocused();
});

test("C2 strategy hidden views do not request their data", async ({ page }) => {
  const initial = await trpcCalls(page, () => ready(page, "/lab"));
  expect(initial).not.toContain("strategyCenterMethods");
  expect(initial).not.toContain("strategyCenterHistory");
  const methods = await trpcCalls(page, async () => {
    await page.getByRole("radio", { name: "方法登记", exact: true }).click();
    await page.waitForLoadState("networkidle");
  });
  expect(methods).toContain("strategyCenterMethods");
  expect(methods).not.toContain("strategyCenterHistory");
  const history = await trpcCalls(page, async () => {
    await page.getByRole("radio", { name: "运行与比较", exact: true }).click();
    await page.waitForLoadState("networkidle");
  });
  expect(history).toContain("strategyCenterHistory");
  expect(history).not.toContain("strategyCenterMethods");
});

test("C1 financial units and true read failure remain explicit", async ({
  page,
}) => {
  await ready(page, "/scan");
  await page.getByRole("tab", { name: "财务资料", exact: true }).click();
  const financial = page.getByRole("region", {
    name: "本地财务工作台",
    exact: true,
  });
  await expect(financial).toContainText("报告期 2026-09-30");
  await expect(
    financial.getByText("资产负债率", { exact: true }).locator(".."),
  ).toContainText("11.90%");
  await financial
    .getByRole("tab", { name: "成长/单季/TTM", exact: true })
    .click();
  await expect(
    financial.locator("summary").filter({ hasText: "流动比率" }),
  ).toContainText(/\d+\.\d{2}倍/);
  await financial
    .getByRole("tab", { name: "三表与全部字段", exact: true })
    .click();
  for (const unit of ["元", "万元", "亿元"]) {
    await financial
      .getByRole("combobox", { name: "财务金额显示单位", exact: true })
      .click();
    await page.getByRole("option", { name: unit, exact: true }).click();
    await expect(
      financial.getByRole("table", { name: "本地财务字段", exact: true }),
    ).toContainText(unit);
  }
  guards.get(page)!.failed.add("localFinancialView");
  await financial
    .getByRole("button", { name: "刷新本地数据", exact: true })
    .click();
  const failure = financial
    .getByRole("alert")
    .filter({ hasText: "本地财务读取失败" });
  const colors = await failure.evaluate((el) => {
    const reference = document.createElement("span");
    reference.style.color = "var(--nc-bad)";
    el.append(reference);
    const result = {
      actual: getComputedStyle(el).color,
      expected: getComputedStyle(reference).color,
    };
    reference.remove();
    return result;
  });
  expect(colors.actual).toBe(colors.expected);
  await expect(failure).toContainText("以下仍为上次读取的财报");
});

test("C2 CLS loaded report visits four views without hidden reads", async ({
  page,
}) => {
  await ready(page, "/intel/review");
  const select = page
    .locator('[aria-label="报告列表"]')
    .getByRole("button")
    .first();
  const reads = await trpcCalls(page, async () => {
    await select.click();
    await expect(
      page.locator("pre").filter({ hasText: "合成报告" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
  });
  expect(reads).not.toContain("clsReviewFactPage");
  expect(reads).not.toContain("clsReviewReportSamples");
  for (const label of [
    "事实核对",
    "固定样本与价格观察",
    "报告信息",
    "报告原文",
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForLoadState("networkidle");
    await fits(page);
  }
  await page.getByRole("button", { name: "报告信息", exact: true }).click();
  const remove = page.getByRole("button", { name: "清理此版本", exact: true });
  await remove.click();
  await dismiss(
    page,
    remove,
    page.getByRole("dialog", { name: "清理报告版本", exact: true }),
  );
});

test("C2 chart popovers return focus and Escape closes only the top layer", async ({
  page,
}) => {
  await ready(page, "/scan");
  await expect(page.getByTestId("market-chart").first()).toBeVisible();
  for (const name of [/^指标设置/, /叠加对比（/, /^画线：/]) {
    const trigger = page.getByRole("button", { name }).first();
    await trigger.click();
    await dismiss(page, trigger, page.getByRole("dialog").last());
  }
  const indicator = page.getByRole("button", { name: /^指标设置/ });
  await indicator.click();
  const indicators = page.getByRole("dialog", {
    name: "指标设置",
    exact: true,
  });
  const parameters = indicators.getByRole("button", {
    name: "MA 参数",
    exact: true,
  });
  await parameters.click();
  const editor = page.getByRole("dialog", { name: "MA 参数", exact: true });
  await editor.getByRole("spinbutton").first().focus();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(indicators).toBeVisible();
  await expect(parameters).toBeFocused();
  await indicators.getByRole("button", { name: "RPS", exact: true }).click();
  await dismiss(page, indicator, indicators);
  const rps = page.getByRole("button", { name: "RPS 设置", exact: true });
  await rps.click();
  await dismiss(
    page,
    rps,
    page.getByRole("dialog", { name: "RPS 设置", exact: true }),
  );
  const settings = page.getByRole("button", { name: "缠论设置", exact: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "缠论结构 · 输入" });
  const select = dialog.getByRole("combobox").first();
  await select.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await dismiss(page, settings, dialog);
});

test("C1 actual formula result retains counts, date and source", async ({
  page,
}) => {
  await ready(page, "/scan?tab=formula");
  // Same full universe; a selective rule avoids publishing thousands of
  // unneeded chart snapshots for a presentation/interaction check.
  await page.getByLabel("公式源码", { exact: true }).fill("选股:C<30;");
  await page
    .getByRole("button", { name: "语法检查与未来函数门禁", exact: true })
    .click();
  await page
    .getByRole("button", { name: "全市场执行公式", exact: true })
    .click();
  await expect(page).toHaveURL((url) => !!url.searchParams.get("job"));
  const id = new URL(page.url()).searchParams.get("job")!;
  expect((await waitForJob(page, id)).status).toBe("completed");
  await expect(
    page
      .getByRole("table", { name: "候选结果", exact: true })
      .getByRole("row")
      .nth(1),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("2026-11-12");
  await expect(page.locator("main")).toContainText("本地已完成日线");
  await checkOverlays(page);
  await fits(page);
});

test("C1/C2 loaded account review visits every analysis view", async ({
  page,
}) => {
  await ready(page, "/accounts/review");
  await page.getByRole("radio", { name: "账户复盘", exact: true }).click();
  await page.getByLabel("复盘账户别名").fill("big");
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await expect(
    page
      .getByRole("table", { name: "月度收益", exact: true })
      .getByRole("row")
      .nth(1),
  ).toBeVisible({ timeout: 30000 });
  const states: string[] = [];
  await exploreViews(page, states);
  for (const label of [
    "概览",
    "交易轮次",
    "分段表现",
    "滚动表现",
    "持仓风险",
    "执行质量",
    "现金核对",
    "纪律与准入",
  ])
    expect(states).toContain(label);
});

test("C1/C2 actual baseline report visits four tabs and their popovers", async ({
  page,
}) => {
  await ready(page, "/lab/backtest");
  await page.getByLabel("基线证券代码").fill("sh600000");
  await page.getByRole("button", { name: "读取本地覆盖", exact: true }).click();
  await expect(page.getByLabel("基线结束日期")).toHaveValue("2026-10-12");
  await page.getByLabel("基线开始日期").fill("2026-10-12");
  await page.getByRole("button", { name: "开始回测", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "实验报告", exact: true }),
  ).toContainText("已完成", { timeout: 30000 });
  const states: string[] = [];
  await exploreViews(page, states);
  for (const label of ["概览", "绩效评价", "成交与订单", "复现依据"])
    expect(states).toContain(label);
});

test("C2 strategy comparison reads two actual local experiments", async ({
  page,
}) => {
  await ready(page, "/lab");
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post("/api/trpc/strategyCenterRun", {
      headers: trpcHeaders,
      data: {
        json: {
          strategyId: "ma",
          symbol: "sh600000",
          start: "2026-10-09",
          end: "2026-10-12",
          initial: 1000000,
        },
      },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const id = body.result.data.json.id as string;
    expect((await waitForJob(page, id)).status).toBe("completed");
    ids.push(id);
  }
  await page.getByRole("radio", { name: "运行与比较", exact: true }).click();
  const choices = page.getByRole("checkbox", { name: "加入比较", exact: true });
  await expect(choices).toHaveCount(2);
  await choices.nth(0).check();
  await choices.nth(1).check();
  await page
    .getByRole("button", { name: "比较所选（2/12）", exact: true })
    .click();
  const comparison = page.locator("section").filter({
    has: page.getByRole("heading", { name: "同口径比较", exact: true }),
  });
  await expect(comparison.getByRole("row")).toHaveCount(3);
  for (const id of ids) await expect(comparison).toContainText(id);
  await checkOverlays(page);
  await fits(page);
});

test("C3 primary actions are reachable in forward Tab order at 150 percent", async ({
  page,
}, info) => {
  const results: {
    path: string;
    width: number;
    tabs: number;
    action: string;
  }[] = [];
  for (const width of [1440, 1024]) {
    await setZoomedViewport(
      page,
      { width, height: width === 1440 ? 900 : 768 },
      1.5,
    );
    for (const path of routes) {
      await ready(page, path);
      const buttons = page.locator(
        'main button.button:visible:not(:disabled):not([tabindex="-1"])',
      );
      const primary = (await buttons.count())
        ? buttons.first()
        : page
            .locator(
              'main input:visible:not(:disabled):not([type="radio"]):not([type="checkbox"]):not([aria-label="搜索页面"]), main textarea:visible:not(:disabled), main a[href]:visible',
            )
            .first();
      const action =
        (await primary.getAttribute("aria-label")) ??
        (await primary.innerText()).trim();
      if (path === "/system/ui-gallery")
        await page
          .getByRole("link", { name: "← 返回工作台", exact: true })
          .focus();
      else {
        await page.keyboard.press("Control+k");
        await expect(
          page.getByRole("combobox", { name: "搜索页面", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
      }
      let tabs = 0;
      while (
        tabs < 80 &&
        !(await primary.evaluate((el) => el === document.activeElement))
      ) {
        await page.keyboard.press("Tab");
        tabs++;
      }
      await expect(primary, `${path}: ${action}`).toBeFocused();
      const bounds = await primary.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
        page.viewportSize()!.width + 1,
      );
      results.push({ path, width, tabs, action });
    }
  }
  await writeFile(
    info.outputPath("keyboard.json"),
    JSON.stringify(results, null, 2),
  );
});

test("C3 CSS zoom keeps centered settings dialogs inside the viewport", async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.zoom = "1.5";
    });
  });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
    await ready(page, "/scan");
    const trigger = page.getByRole("button", { name: "缠论设置", exact: true });
    await trigger.click();
    await dismiss(
      page,
      trigger,
      page.getByRole("dialog", { name: "缠论结构 · 输入", exact: true }),
    );
  }
});

test("C4 representative stable fixture baselines", async ({
  page,
  browser,
}, info) => {
  const reset = await page.request.post("/api/trpc/saveChartView", {
    headers: trpcHeaders,
    data: {
      json: { symbol: "sh600519", period: "day", view: defaultChartView },
    },
  });
  expect(reset.ok()).toBe(true);
  expect((await reset.json()).error).toBeUndefined();
  for (const [name, path] of [
    ["market", "/scan"],
    ["reports", "/lab/reports/report/p1-report"],
    ["news", "/intel"],
    ["pool", "/scan?tab=pool"],
  ]) {
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
      await ready(page, path!);
      if (path === "/scan")
        await expect(page.getByTestId("market-chart").first()).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`${name}-${width}.png`, {
        animations: "disabled",
        caret: "hide",
        mask: [
          page.locator(".sidebar .nav-badge"),
          page.locator('[data-testid="chart-legend"]'),
          page.locator(".source-line"),
        ],
        maxDiffPixels: 0,
      });
    }
  }
  await writeFile(
    info.outputPath("environment.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        dpr: await page.evaluate(() => devicePixelRatio),
        font: await page.evaluate(
          () => getComputedStyle(document.body).fontFamily,
        ),
        clock: fixedTime.toISOString(),
        zoom: "Matrix: CSS viewport=physical viewport/zoom, DPR=zoom; baseline DPR=1; centered-dialog regression also uses CSS zoom=1.5",
      },
      null,
      2,
    ),
  );
});
