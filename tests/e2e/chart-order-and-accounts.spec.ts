import { expect, test, type Page } from "@playwright/test";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import SuperJSON from "superjson";
import { z } from "zod";
import type { Snapshot } from "../../src/lib/domain";
import { trpcHeaders } from "./helpers";

const gold: Snapshot = {
  id: "fixture-comex-gold",
  symbol: "fuGC00Y",
  name: "COMEX 黄金",
  market: "futures",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: Date.UTC(2026, 9, 12),
  bars: [
    {
      date: "2026-10-09",
      open: 1995,
      high: 2005,
      low: 1990,
      close: 1998,
      volume: 100,
      amount: 0,
    },
    {
      date: "2026-10-12",
      open: 1998,
      high: 2010,
      low: 1996,
      close: 2000,
      volume: 200,
      amount: 0,
    },
  ],
  hash: "fixture-comex-gold",
};

async function installFuturesMarketFixture(page: Page) {
  const t = initTRPC.create({ transformer: SuperJSON });
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const names = decodeURIComponent(
      url.pathname.split("/api/trpc/")[1]!,
    ).split(",");
    if (
      !names.some((name) =>
        ["futuresQuotes", "snapshot", "chartBars", "macroRates"].includes(name),
      )
    ) {
      await route.continue();
      return;
    }
    const isMutation = request.method() === "POST";
    const procedures = Object.fromEntries(
      names.map((name) => {
        const procedure = t.procedure.input(z.unknown());
        async function resolve({ input }: { input: unknown }) {
          const chart = input as
            { symbol?: string; snapshotId?: string } | undefined;
          if (name === "futuresQuotes") return [];
          if (name === "macroRates")
            return {
              fetchedAt: gold.createdAt,
              treasury: [],
              repo: [],
              lpr: [],
              failures: [],
            };
          if (name === "snapshot" && chart?.symbol === gold.symbol) return gold;
          if (name === "chartBars" && chart?.snapshotId === gold.id)
            return gold;
          const target = new URL(`/api/trpc/${name}`, url.origin);
          const data = SuperJSON.serialize(input);
          const response = isMutation
            ? await page.request.post(target.toString(), {
                headers: trpcHeaders,
                data,
              })
            : await page.request.get(target.toString(), {
                headers: trpcHeaders,
                ...(input !== undefined && {
                  params: { input: JSON.stringify(data) },
                }),
              });
          const body = await response.json();
          if (!response.ok() || !body.result?.data)
            throw new Error(`夹具转发失败 ${name} (${response.status()})`);
          return SuperJSON.deserialize(body.result.data);
        }
        return [
          name,
          isMutation ? procedure.mutation(resolve) : procedure.query(resolve),
        ];
      }),
    );
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        ...(isMutation && { body: request.postData() }),
      }),
      router: t.router(procedures),
      createContext: () => ({}),
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}

test("图表模拟下单重新试算后成交，A 股和期货持仓分别记账", async ({
  page,
  request,
}) => {
  // Exercise the supported state where this initialized ledger has no account.
  // A brand-new ledger auto-creates one on its first read.
  const accounts = await request.get("/api/trpc/simAccountsList", {
    headers: trpcHeaders,
  });
  expect(accounts.ok()).toBe(true);
  const initial = z
    .array(z.object({ id: z.string(), name: z.string() }))
    .parse(SuperJSON.deserialize((await accounts.json()).result.data));
  expect(initial.map(({ name }) => name)).toEqual(["A股默认模拟账户"]);
  const cleared = await request.post("/api/trpc/simAccountDelete", {
    headers: trpcHeaders,
    data: { json: { accountId: initial[0]!.id } },
  });
  expect(cleared.ok()).toBe(true);
  await page.route("https://www.cls.cn/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>隔离行情夹具</title>",
    }),
  );
  await page.goto("/scan?symbol=sh600000");
  await page.getByRole("button", { name: "模拟下单", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /模拟下单/ })).toBeVisible();
  await dialog.getByRole("button", { name: "一键创建默认模拟账户" }).click();
  await dialog.getByLabel("数量", { exact: true }).fill("100");
  await dialog.getByLabel("交易日期", { exact: true }).fill("2026-10-12");
  const price = dialog.getByLabel("价格", { exact: true });
  await price.fill("10");
  const preview = dialog.getByRole("button", { name: "预览模拟成交" });
  const confirm = dialog.getByRole("button", { name: "确认模拟成交" });
  await preview.click();
  await expect(confirm).toBeEnabled();
  await price.fill("11");
  await expect(confirm).toBeDisabled();
  await preview.click();
  await expect(dialog.getByLabel("委托试算预览")).toContainText(/1,100|1100/);
  await confirm.click();
  await expect(dialog.getByText(/已记录买入 sh600000 × 100/)).toBeVisible();
  await dialog
    .getByRole("link", { name: /前往模拟账户查看持仓与成交/ })
    .click();
  await expect(page).toHaveURL(/\/accounts\?tab=paper$/);
  await page.getByRole("tab", { name: "持仓总览", exact: true }).click();
  const holdings = page.getByRole("region", { name: "统一持仓", exact: true });
  await holdings.getByRole("radio", { name: "全部", exact: true }).click();
  const equity = holdings
    .getByRole("row")
    .filter({ hasText: /sh600000|P0_FIXTURE/i });
  await expect(equity).toContainText("本地模拟");
  await equity
    .getByRole("link", { name: "sh600000 · A股", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "持仓归因与衰减" }),
  ).toContainText(/数量 100(?:\.0+)? ·/);

  // Only external market data is synthetic. Account creation, preview,
  // execution and both position views use the actual backend and SQLite.
  await installFuturesMarketFixture(page);
  const quoteLoaded = page.waitForResponse(
    (response) =>
      response.url().includes("/api/trpc/snapshot") &&
      response.request().postData()?.includes(gold.symbol) === true &&
      response.ok(),
  );
  await page.goto("/scan?tab=futures");
  await quoteLoaded;
  await page.getByRole("button", { name: "模拟下单", exact: true }).click();
  await expect(dialog).toContainText(gold.name!);
  await dialog.getByRole("button", { name: "一键创建期货模拟账户" }).click();
  await dialog.getByRole("radio", { name: "开多", exact: true }).click();
  await dialog.getByLabel("手数", { exact: true }).fill("1");
  await expect(dialog.getByLabel("价格", { exact: true })).toHaveValue(
    /^2000(?:\.0)?$/,
  );
  await dialog.getByRole("button", { name: "预览模拟委托" }).click();
  await expect(dialog.getByLabel("期货模拟委托预览")).toContainText(
    /20,?000(?:\.00)? USD/,
  );
  await confirm.click();
  await expect(dialog.getByText(/已记录 COMEX 黄金 · 开多 1 手/)).toBeVisible();
  await page.keyboard.press("Escape");

  const strip = page.getByRole("region", { name: "期货模拟持仓" });
  await expect(
    strip.getByRole("button", { name: /COMEX 黄金 · 多 1 手/ }),
  ).toBeVisible();
  await expect(strip).toContainText(/USD 保证金 20,?000/);
  await expect(strip).not.toContainText("CNY 保证金");
  await strip.getByRole("link").click();
  await expect(page).toHaveURL(/\/accounts\?tab=paper&channel=futures-sim$/);
  const channels = page.getByRole("tablist", { name: "交易账户通道" });
  await expect(channels.getByRole("tab")).toHaveCount(4);
  await expect(
    channels.getByRole("tab", { name: "期货模拟账户" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("冻结保证金", { exact: true }).locator(".."),
  ).toContainText(/20,?000(?:\.00)? USD/);
  const position = page
    .getByRole("row")
    .filter({ hasText: gold.name! })
    .filter({ hasText: "多仓" });
  await expect(
    position.getByRole("cell", { name: "1", exact: true }),
  ).toBeVisible();
  await expect(position).toContainText(/20,?000/);
});
