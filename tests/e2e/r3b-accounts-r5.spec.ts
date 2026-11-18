import { expect, test, type Page } from "@playwright/test";
import SuperJSON from "superjson";
import { trpcHeaders } from "./helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const account = "QA-r5-券商";
const pairA = "local:QA-r5-sameday-a";
const pairB = "local:QA-r5-sameday-b";
const delivery = (symbol: string) => `delivery:${account}:${symbol}`;
const detailHref = (id: string) =>
  `/accounts?position=${encodeURIComponent(id)}`;

type PositionRow = {
  id: string;
  quantity: number;
  price: number | null;
  value: number | null;
  stop: number | null;
  stopDistance: number | null;
  reasons: string[];
};
type TradeRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  date: string;
  price: number;
  quantity: number;
  strategyId: string | null;
  strategyVersion: number | null;
  sleeve: string;
  planId: string | null;
  alertKey: string | null;
};
type LinkResponse = {
  tradeId: string;
  strategyId: string;
  strategyVersion: number;
  sleeve: string;
  planId: string | null;
  alertKey: string | null;
  linkedAt: number;
  tradeFingerprint: string;
};

async function readTrpc<T>(
  page: Page,
  name: string,
  input?: unknown,
): Promise<T> {
  const query =
    input === undefined
      ? ""
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const response = await page.request.get(`/api/trpc/${name}${query}`, {
    headers: trpcHeaders,
  });
  expect(response.ok(), `${name} HTTP ${response.status()}`).toBe(true);
  const body = await response.json();
  const data = (Array.isArray(body) ? body[0] : body)?.result?.data;
  if (!data || !("json" in data)) throw new Error(`${name}: invalid result`);
  return SuperJSON.deserialize(data) as T;
}

function trackExternal(page: Page) {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      external.push(request.url());
  });
  return external;
}

function findLink(value: unknown): LinkResponse | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLink(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (
      typeof row.tradeId === "string" &&
      typeof row.strategyId === "string" &&
      typeof row.strategyVersion === "number" &&
      typeof row.sleeve === "string"
    )
      return row as unknown as LinkResponse;
    for (const item of Object.values(row)) {
      const found = findLink(item);
      if (found) return found;
    }
  }
  return null;
}
/** httpBatchStreamLink sends JSONL chunks; the confirmed link object is nested
 * inside one of them. Capture that real payload without re-running the write. */
function parseLinkResponse(text: string): LinkResponse {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const found = findLink(JSON.parse(line));
      if (found) return found;
    } catch {
      /* Stream lines that are not complete JSON. */
    }
  }
  throw new Error(`关联响应未找到: ${text.slice(0, 300)}`);
}

async function installLinkCapture(page: Page) {
  const responses: LinkResponse[] = [];
  let posts = 0;
  let delayMs = 0;
  let failNext = false;
  await page.route(/\/api\/trpc\/linkAccountTrade/, async (route) => {
    posts++;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 500, body: "injected link failure" });
      return;
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await route.fetch();
    const text = await response.text();
    responses.push(parseLinkResponse(text));
    await route.fulfill({ response, body: text });
  });
  return {
    responses,
    posts: () => posts,
    setDelay: (ms: number) => {
      delayMs = ms;
    },
    failOnce: () => {
      failNext = true;
    },
  };
}

test("R3b R5 A 两来源持仓、筛选后翻页与详情返回保持", async ({ page }) => {
  const external = trackExternal(page);
  await page.goto("/accounts");
  const holdings = page.getByRole("region", {
    name: "统一持仓",
    exact: true,
  });
  await expect(holdings).toBeVisible();

  // Actual account read: delivery values, an unknown quote and the manual
  // ledger's 3000-share position stay distinguishable in the same response.
  const positions = async (input: Record<string, unknown>) =>
    readTrpc<{ total: number; items: PositionRow[] }>(
      page,
      "accountPositions",
      input,
    );
  const base = {
    kind: "real",
    source: "all",
    market: "all",
    stopStatus: "all",
    group: "market",
    sleeve: "",
  };
  const first = await positions({ ...base, page: 0 });
  const second = await positions({ ...base, page: 1 });
  expect(first.total).toBe(23);
  const items = [...first.items, ...second.items];
  const valued = items.find((p) => p.id === delivery("sh600001"));
  expect(valued).toMatchObject({ quantity: 1000, price: 10, value: 10000 });
  const missing = items.find((p) => p.id === delivery("sh600020"));
  expect(missing?.price).toBeNull();
  expect(missing?.value).toBeNull();
  expect(missing?.reasons).toContain("缺原价日线");
  const manual = items.find((p) => p.id === "local:sh600000");
  expect(manual).toMatchObject({ quantity: 3000, stop: 90, value: 86100 });

  await page.getByRole("radio", { name: "券商交割单", exact: true }).click();
  await page.getByRole("radio", { name: "待核对", exact: true }).click();
  await expect(page.getByText(/共 21 条 · 第 1 \/ 2 页/)).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();

  const gets: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("accountPositions")
    )
      gets.push(request.url());
  });
  const before = gets.length;
  await page.getByRole("link", { name: /sh600020/ }).click();
  const detail = page.getByRole("region", { name: "持仓归因与衰减" });
  await expect(
    detail.getByRole("heading", { name: /sh600020/ }),
  ).toBeVisible();
  expect(gets.length, "进入详情不应新增统一持仓读取").toBe(before);
  await expect(detail.getByText("缺原价日线")).toBeVisible();
  await expect(detail.getByText("距止损 待核对")).toBeVisible();

  // Returning by link and by browser Back/Forward restores filter and page 2.
  await detail.getByRole("link", { name: "返回统一持仓" }).click();
  await expect(holdings).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "券商交割单", exact: true }),
  ).toBeChecked();
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();
  await page.goBack();
  await expect(detail.getByRole("heading", { name: /sh600020/ })).toBeVisible();
  await page.goForward();
  await expect(holdings).toBeVisible();
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();

  // Manual ledger + read price at the recorded stop explains 3000 shares,
  // the value and the in-row highlight.
  await page.getByRole("radio", { name: "手工账本", exact: true }).click();
  await page
    .getByRole("radio", { name: "所示价格已到止损位", exact: true })
    .click();
  await expect(page.getByText(/共 1 条/)).toBeVisible();
  const touched = holdings.getByRole("row").filter({ hasText: "sh600000" });
  await expect(touched.getByText("86100.00 CNY")).toBeVisible();
  await expect(touched.locator(".text-nc-bad").first()).toBeVisible();
  await touched.getByRole("link", { name: /sh600000/ }).click();
  await expect(
    detail.getByText(/数量 3000.000000 · 市值 86100.00 CNY/),
  ).toBeVisible();
  await expect(page.getByText("成交来源（第 1 页，共 30 笔）")).toBeVisible();
  await page.getByRole("button", { name: "下一页成交", exact: true }).click();
  await expect(page.getByText("成交来源（第 2 页，共 30 笔）")).toBeVisible();

  // The next detail starts its own trade page instead of inheriting page 2.
  // Only the ?position id changes, through Next's patched same-document
  // history API, so the reset comes from the position-keyed remount rather
  // than from a full document load.
  await page.evaluate(
    (href) => window.history.pushState(null, "", href),
    detailHref(delivery("sh600020")),
  );
  await expect(
    detail.getByRole("heading", { name: /sh600020/ }),
  ).toBeVisible();
  await expect(page.getByText("成交来源（第 1 页，共 1 笔）")).toBeVisible();

  // Re-enter the same detail by a real direct navigation so the default-list
  // assertion below still covers a cold entry.
  await page.goto(detailHref(delivery("sh600020")));
  await expect(
    detail.getByRole("heading", { name: /sh600020/ }),
  ).toBeVisible();

  // A direct detail link still returns to the default list.
  await detail.getByRole("link", { name: "返回统一持仓" }).click();
  await expect(holdings).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "全部来源", exact: true }),
  ).toBeChecked();
  await expect(page.getByText(/共 23 条 · 第 1 \/ 2 页/)).toBeVisible();

  // Injected first-read failure only: the detail offers the same return path.
  await page.route(/\/api\/trpc\/[^?]*accountPosition(?!s)/, (route) =>
    route.fulfill({ status: 500, body: "injected first read failure" }),
  );
  await page.goto(detailHref(delivery("sh600020")));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "返回统一持仓" }),
  ).toBeVisible();
  await page.unroute(/\/api\/trpc\/[^?]*accountPosition(?!s)/);
  await page.getByRole("link", { name: "返回统一持仓" }).click();
  await expect(holdings).toBeVisible();

  expect(external).toEqual([]);
});

test("R3b R5 B 真实建议/手工关联、单请求保护与回执保留", async ({ page }) => {
  const external = trackExternal(page);
  const links = await installLinkCapture(page);
  await page.goto("/accounts?tab=trades");
  await expect(page.getByText("成交来源（第 1 页")).toBeVisible();

  const row = (quantity: string) =>
    page.getByRole("row").filter({ hasText: quantity });
  const dialog = page.getByRole("dialog", { name: "手工关联成交来源" });

  // Suggestion link through the real mutation, then compare its response with
  // the local read API (id, strategy, original quantity/side/price).
  await row("110.000000")
    .getByRole("button", { name: /确认关联/ })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `成交编号 ${pairA}` }),
  ).toBeVisible();
  const suggestion = links.responses.at(-1)!;
  expect(suggestion).toMatchObject({
    tradeId: pairA,
    strategyId: "QA-r3b-decay",
    strategyVersion: 1,
    sleeve: "swing",
    planId: "QA-r5-plan",
  });
  const readA = await readTrpc<{ trades: TradeRow[] }>(
    page,
    "accountTrades",
    { page: 0, kind: "real", symbol: "sh600001", tradeId: pairA },
  );
  expect(readA.trades[0]).toMatchObject({
    id: pairA,
    quantity: 110,
    side: "buy",
    price: 10,
    strategyId: suggestion.strategyId,
    strategyVersion: suggestion.strategyVersion,
    sleeve: suggestion.sleeve,
    planId: suggestion.planId,
    alertKey: suggestion.alertKey,
  });

  // Manual link for the same-day, same-symbol peer. The delayed real request
  // exposes Esc, pagination protection and the single-POST guard.
  await row("120.000000").getByRole("button", { name: "手工关联" }).click();
  await dialog.getByLabel("策略ID").fill("QA-r3b-decay");
  await dialog.getByLabel("策略版本").fill("1");
  await dialog.getByLabel("分仓ID").fill("swing");
  await dialog.getByLabel("计划ID（可空）").fill("");
  // Injected same-key readback failure after the confirmed write: the success
  // receipt must stay visible even when the follow-up list read fails.
  let failReadback = true;
  const readback = /\/api\/trpc\/[^?]*accountTrades/;
  await page.route(readback, async (route) => {
    // Keep failing through the query's own retries; turn the injection off
    // explicitly before the manual retry.
    if (failReadback) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            json: {
              message: "injected readback failure",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  links.setDelay(700);
  const postsBefore = links.posts();
  const save = dialog.getByRole("button", { name: "保存人工关联" });
  // Two submits in one synchronous call stack, through the real form rather
  // than synthetic clicks: only the pending guard can collapse them.
  await page.evaluate(() => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((el) => el.textContent?.trim() === "保存人工关联");
    const form = button?.form;
    if (!form) throw new Error("保存人工关联按钮所属表单不存在");
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(
    dialog.getByRole("status").filter({ hasText: `成交编号 ${pairB}` }),
  ).toBeVisible();
  expect(links.posts() - postsBefore, "连续提交只发一个 POST").toBe(1);
  links.setDelay(0);
  const manual = links.responses.at(-1)!;
  expect(manual).toMatchObject({
    tradeId: pairB,
    planId: null,
    alertKey: null,
  });
  const manualReceipt = dialog
    .getByRole("status")
    .filter({ hasText: "关联已保存，审计记录保留。" });
  await expect(manualReceipt).not.toContainText(" · 计划 ");
  await expect(manualReceipt).not.toContainText(" · 提醒 ");
  const readB = await readTrpc<{ trades: TradeRow[] }>(
    page,
    "accountTrades",
    { page: 0, kind: "real", symbol: "sh600001", tradeId: pairB },
  );
  expect(readB.trades[0]).toMatchObject({
    id: pairB,
    quantity: 120,
    side: "buy",
    price: 10,
    strategyId: manual.strategyId,
    strategyVersion: manual.strategyVersion,
    sleeve: manual.sleeve,
    planId: null,
    alertKey: null,
  });

  // The injected same-key readback failure arrived after the real write. The
  // modal hides the background from the accessibility tree, so assert the
  // visible injected error text rather than its role.
  await expect(page.getByText("injected readback failure")).toBeVisible();
  await expect(manualReceipt).toBeVisible();
  failReadback = false;
  await page.unroute(readback);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Re-query after the injected failure so the list is usable again; the
  // confirmed receipt state survives the filter change.
  await page.getByRole("radio", { name: "全部", exact: true }).click();
  await page.getByRole("radio", { name: "真实", exact: true }).click();
  await expect(page.getByText("成交来源（第 1 页")).toBeVisible();

  // Pagination protection is observable while a suggestion request is in
  // flight and no modal hides the list.
  links.setDelay(700);
  const paginationPosts = links.posts();
  await row("110.000000")
    .getByRole("button", { name: /确认关联/ })
    .click();
  await expect(
    page.getByRole("button", { name: "下一页成交", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: `成交编号 ${pairA}` }),
  ).toBeVisible();
  expect(links.posts() - paginationPosts, "建议关联同样只发一个 POST").toBe(1);
  links.setDelay(0);

  // A newly opened dialog does not inherit the previous receipt.
  await page
    .getByRole("row")
    .filter({ hasText: "100.000000" })
    .first()
    .getByRole("button", { name: "手工关联" })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("关联已保存，审计记录保留。"),
  ).toHaveCount(0);
  await dialog.getByLabel("策略ID").fill("QA-r3b-decay");
  await dialog.getByLabel("策略版本").fill("1");
  await dialog.getByLabel("分仓ID").fill("swing");

  // Explicit injected write failure keeps the draft, and the retry succeeds.
  links.failOnce();
  await dialog.getByRole("button", { name: "保存人工关联" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("策略ID")).toHaveValue("QA-r3b-decay");
  await expect(dialog.getByLabel("分仓ID")).toHaveValue("swing");
  await dialog.getByRole("button", { name: "保存人工关联" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "关联已保存，审计记录保留。" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  expect(external).toEqual([]);
});

test("R3b R5 C 回执复制使用真实剪贴板，拒绝与迟到反馈不串行", async ({
  page,
}) => {
  const external = trackExternal(page);
  const links = await installLinkCapture(page);
  await page.goto("/accounts?tab=trades");
  await page.getByRole("button", { name: "下一页成交", exact: true }).click();
  await expect(page.getByText("成交来源（第 2 页")).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "手工关联成交来源" });
  const list = page.getByRole("region", { name: "成交来源", exact: true });

  const linkManual = async (rowIndex: number) => {
    await page
      .getByRole("row")
      .filter({ hasText: "100.000000" })
      .nth(rowIndex)
      .getByRole("button", { name: "手工关联" })
      .click();
    await dialog.getByLabel("策略ID").fill("QA-r3b-decay");
    await dialog.getByLabel("策略版本").fill("1");
    await dialog.getByLabel("分仓ID").fill("swing");
    await dialog.getByLabel("计划ID（可空）").fill("");
    await dialog.getByRole("combobox", { name: "关联提醒" }).click();
    await page.getByRole("option", { name: "无提醒", exact: true }).click();
    await dialog.getByRole("button", { name: "保存人工关联" }).click();
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: "关联已保存，审计记录保留。" }),
    ).toBeVisible();
    return links.responses.at(-1)!;
  };

  // Real Chromium clipboard, after the mutation ACK is on screen.
  const first = await linkManual(0);
  const receipt = dialog
    .getByRole("status")
    .filter({ hasText: "关联已保存，审计记录保留。" });
  await dialog.getByRole("button", { name: "复制关联回执" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "已复制关联回执。" }),
  ).toBeVisible();
  const pageText = (await receipt.innerText()).replace(/\s+/g, " ").trim();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(pageText);
  expect(copied).toContain(first.tradeId);
  expect(copied).toContain(first.strategyId);
  expect(copied).toContain(`v${first.strategyVersion}`);
  expect(copied).toContain(`分仓 ${first.sleeve}`);
  const read = await readTrpc<{ trades: TradeRow[] }>(
    page,
    "accountTrades",
    { page: 0, kind: "real", symbol: "sh600000", tradeId: first.tradeId },
  );
  const trade = read.trades[0]!;
  expect(copied).toContain(trade.symbol);
  expect(copied).toContain(trade.date);
  expect(copied).toContain(trade.side === "buy" ? "买入" : "卖出");
  // Manual link has empty plan/alert: absent optional fields are omitted, and
  // the fingerprint, account and other rows never enter the clipboard.
  expect(copied).not.toContain("null");
  expect(copied).not.toContain("计划 ");
  expect(copied).not.toContain("提醒 ");
  expect(copied).not.toContain("tradeFingerprint");
  expect(copied).not.toContain("fingerprint");
  expect(copied).not.toContain("手工账本");

  // Injected permission denial: readable original text and a retry that works.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    (window as unknown as { __r5Write: typeof original }).__r5Write = original;
    Object.defineProperty(clipboard, "writeText", {
      configurable: true,
      value: () =>
        Promise.reject(
          new DOMException("Write permission denied", "NotAllowedError"),
        ),
    });
  });
  await dialog.getByRole("button", { name: "复制关联回执" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "复制失败" }),
  ).toBeVisible();
  await expect(receipt).toHaveText(pageText);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: (window as unknown as { __r5Write: () => Promise<void> })
        .__r5Write,
    });
  });
  await dialog.getByRole("button", { name: "复制关联回执" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "已复制关联回执。" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Injected delayed copy from receipt A resolves after receipt B replaces it
  // in the list; B must not show A's late success, and remains manually usable.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    (window as unknown as { __r5Write: typeof original }).__r5Write = original;
    Object.defineProperty(clipboard, "writeText", {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          (window as unknown as { __r5Resolve: () => void }).__r5Resolve =
            resolve;
        }),
    });
  });
  await list.getByRole("button", { name: "复制关联回执" }).click();
  // A suggestion on another base row replaces the list receipt while A's copy
  // promise is still pending.
  const suggestionRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /确认关联/ }) })
    .first();
  await suggestionRow.getByRole("button", { name: /确认关联/ }).click();
  const receiptB = list
    .getByRole("status")
    .filter({ hasText: "关联已保存，审计记录保留。" });
  await expect(receiptB).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __r5Resolve: () => void }).__r5Resolve(),
  );
  await page.waitForTimeout(150);
  await expect(
    list.getByRole("status").filter({ hasText: "已复制关联回执。" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: (window as unknown as { __r5Write: () => Promise<void> })
        .__r5Write,
    });
  });
  await list.getByRole("button", { name: "复制关联回执" }).click();
  await expect(
    list.getByRole("status").filter({ hasText: "已复制关联回执。" }),
  ).toBeVisible();
  const listText = (await receiptB.innerText())
    .replace("最近一次：", "")
    .replace(/\s+/g, " ")
    .trim();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    listText,
  );

  expect(external).toEqual([]);
});
