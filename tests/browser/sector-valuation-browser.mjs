/** 板块估值：真实组件 + 受控 tRPC 传输，验证申万层级、下钻、筛选、排序和刷新。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery,useQueryClient} from '@tanstack/react-query';

const fixture = window.sectorValuationFixture = {requests: []};
const asOfDate = '2026-11-24';
function row(swCode, name, pe, pePct, parentL1 = null) {
  return {
    code: 'pt01' + swCode, swCode, name, level: parentL1 ? 'l2' : 'l1',
    parentL1, endDate: pe === null ? null : asOfDate, pe, pePct,
    pePrevM: null, pePrevY: null, pb: null, pbPct: null, pbPrevM: null,
    pbPrevY: null, div: null, divPct: null, divPrevM: null, divPrevY: null,
    missing: pe === null,
  };
}
const bank = row('801780', '银行', 8, 65);
const electronics = row('801080', '电子', 24, 10);
const property = row('801180', '房地产', -5, null);
const steel = row('801040', '钢铁', null, null);
const l2Rows = [
  row('801081', '半导体', 38, 12, '电子'),
  row('801083', '元件', 21, 23, '电子'),
  row('801782', '国有大型银行', 7, 43, '银行'),
];

function read(input) {
  fixture.requests.push(structuredClone(input));
  if (input.refresh) l2Rows[0].pe = 39.5;
  const l1Rows = input.sort === 'pe' && !input.descending
    ? [bank, electronics, property, steel]
    : [electronics, bank, property, steel];
  const rows = (input.level === 'l1' ? l1Rows : l2Rows)
    .filter(({parentL1}) => !input.parentL1 || parentL1 === input.parentL1)
    .filter(({name, swCode}) => name.includes(input.search) || swCode.includes(input.search));
  return {
    version: 'sw-sector-valuation-1', source: 'tencent/westock-data', available: true,
    reason: null, ...input, parentL1: input.parentL1 ?? null, counts: {l1: 31, l2: 123},
    l1Names: ['电子', '银行', '房地产', '钢铁'], asOfDate, fetchedAt: 1795478400000,
    cached: false, missingCount: rows.filter(({missing}) => missing).length,
    warning: null, rows, total: rows.length,
  };
}
const key = (input) => ['swSectorValuation', input];
export const api = {
  swSectorValuation: {
    useQuery: (input, options) => useQuery({
      ...options, queryKey: key(input), queryFn: async () => read(input),
    }),
  },
  useUtils: () => {
    const client = useQueryClient();
    return {
      swSectorValuation: {
        invalidate: () => client.invalidateQueries({queryKey: ['swSectorValuation']}),
        fetch: (input) => Promise.resolve(read(input)),
        setData: (input, data) => client.setQueryData(key(input), data),
      },
    };
  },
};
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {SectorValuationView} from './src/components/market/sector-valuation-view';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><SectorValuationView/></QueryClientProvider>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "controlled-sector-valuation-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: transport,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const css = await postcss([tailwind()]).process(
  readFileSync("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/sector-valuation");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/sector-valuation");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const region = page.getByRole("region", { name: "板块估值" });
  const table = region.getByRole("table", { name: "申万行业估值" });
  const levels = region.getByRole("radiogroup", { name: "行业层级" });
  const l1 = levels.getByRole("radio", { name: "申万一级 31" });
  const l2 = levels.getByRole("radio", { name: "申万二级 123" });
  const parent = region.getByRole("combobox", { name: "筛选一级行业" });
  const search = region.getByRole("textbox", { name: "搜索行业" });
  const last = () =>
    page.evaluate(() => window.sectorValuationFixture.requests.at(-1));
  const l1Names = () => table.getByRole("button").allTextContents();
  const status = (description) =>
    region.getByRole("status").filter({ hasText: description }).waitFor();

  await status("申万一级行业 · 共 4 个");
  assert.equal(await l1.getAttribute("aria-checked"), "true");
  assert.equal(await parent.count(), 0);
  assert.deepEqual(await last(), {
    level: "l1",
    parentL1: undefined,
    search: "",
    sort: "pePct",
    descending: false,
  });
  assert.deepEqual(await l1Names(), ["电子", "银行", "房地产", "钢铁"]);
  const lossRow = table.getByRole("row").filter({ hasText: "房地产" });
  assert.equal(
    await lossRow.getByText("亏损(-5.00)", { exact: true }).count(),
    1,
  );
  assert.equal(await lossRow.getByRole("cell").nth(2).innerText(), "不可得");
  const missingRow = table.getByRole("row").filter({ hasText: "钢铁" });
  assert.equal(
    await missingRow.getByText("不可得", { exact: true }).count(),
    3,
  );
  assert.equal(await missingRow.getByText("0.00%", { exact: true }).count(), 0);

  await region.getByRole("combobox", { name: "板块估值排序" }).click();
  await page.getByRole("option", { name: "PE-TTM", exact: true }).click();
  await status("排序：PE-TTM（升序）");
  assert.equal((await last()).sort, "pe");
  assert.deepEqual(await l1Names(), ["银行", "电子", "房地产", "钢铁"]);
  await region.getByRole("radio", { name: "降序" }).click();
  await status("排序：PE-TTM（降序）");
  assert.equal((await last()).descending, true);
  assert.deepEqual(await l1Names(), ["电子", "银行", "房地产", "钢铁"]);

  await l2.click();
  await status("申万二级行业 · 共 3 个");
  assert.equal((await last()).level, "l2");
  assert.equal((await last()).parentL1, undefined);
  assert.equal(await parent.innerText(), "全部一级");
  await table.getByText("国有大型银行", { exact: true }).waitFor();
  await l1.click();
  await status("申万一级行业 · 共 4 个");

  // 一级行点击直接下钻，并清空一级搜索词。
  await search.fill("电子");
  await status("申万一级行业 · 共 1 个");
  await table.getByRole("button", { name: "电子", exact: true }).click();
  await status("申万二级行业 · 共 2 个");
  assert.equal(await l2.getAttribute("aria-checked"), "true");
  assert.equal(await parent.innerText(), "电子");
  assert.equal(await search.inputValue(), "");
  assert.equal((await last()).parentL1, "电子");
  assert.equal((await last()).search, "");
  assert.equal(
    await table.getByText("国有大型银行", { exact: true }).count(),
    0,
  );

  await parent.click();
  await page.getByRole("option", { name: "银行", exact: true }).click();
  await table.getByText("国有大型银行", { exact: true }).waitFor();
  assert.equal((await last()).parentL1, "银行");
  assert.equal(await table.getByText("半导体", { exact: true }).count(), 0);
  await parent.click();
  await page.getByRole("option", { name: "电子", exact: true }).click();
  await status("申万二级行业 · 共 2 个");
  await search.fill(" 801081 ");
  await status("申万二级行业 · 共 1 个");
  assert.equal((await last()).search, "801081");
  await table.getByText("半导体", { exact: true }).waitFor();
  assert.equal(await table.getByText("元件", { exact: true }).count(), 0);

  // 刷新沿用筛选和排序，返回值写回当前普通查询键。
  await region.getByRole("button", { name: "刷新", exact: true }).click();
  await table.getByText("39.50", { exact: true }).waitFor();
  const refreshRequests = await page.evaluate(() =>
    window.sectorValuationFixture.requests.filter((input) => input.refresh),
  );
  assert.deepEqual(refreshRequests, [
    {
      level: "l2",
      parentL1: "电子",
      search: "801081",
      sort: "pe",
      descending: true,
      refresh: true,
    },
  ]);
  assert.deepEqual(await last(), {
    level: "l2",
    parentL1: "电子",
    search: "801081",
    sort: "pe",
    descending: true,
  });
  assert.equal(await table.getByText("38.00", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
