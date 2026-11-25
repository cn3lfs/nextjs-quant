import { join } from "node:path";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetch as mockTradingFetch } from "undici";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ParallelAccountsHub } from "~/components/portfolio/parallel-accounts-hub";
import { SimOrderForm } from "~/components/portfolio/sim-order-form";
import type { FuturesSimAccountSummary } from "~/lib/portfolio/futures-sim";
import type { SimAccountDetail } from "~/lib/portfolio/sim-accounts";
import { simAccountsRouter } from "~/server/api/routers/sim-accounts";
import { sqlite } from "~/server/db";
import { setGlobalAutoLiveEnabled } from "~/server/db/deployment-repository";
import { pipelineLiveVaultId } from "~/server/execution/venue-router";
import {
  readMockAccountMeta,
  setMockEnabled,
} from "~/server/portfolio/mock/mock-trading-service";
import {
  listThsLiveAccounts,
  readThsLiveAccountSnapshot,
  saveThsLiveAccount,
} from "~/server/portfolio/ths-live-account-service";
import { readSecret, saveSecret } from "~/server/vault";
import { createQueryClient } from "~/trpc/query-client";
import { api as trpc, TRPCReactProvider } from "~/trpc/react";

const vault = vi.hoisted(() => new Map<string, unknown>());
vi.mock("~/server/vault", () => ({
  readSecret: vi.fn(async (id: string) => vault.get(id)),
  saveSecret: vi.fn(async (id: string, value: unknown) => {
    vault.set(id, value);
  }),
  deleteSecret: vi.fn(async (id: string) => vault.delete(id)),
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected THS mock network request");
  }),
}));

const route = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(route.search),
}));

const liveFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("Unexpected THS live network request");
});
const account = {
  name: "Wave 7 live fixture",
  accountId: "wave7-live",
  endpointUrl: "https://ths-bridge.example.test",
  token: "wave7-test-token",
};
const recordKind = "ths-live-account";
let db: ReturnType<typeof sqlite> | undefined;

beforeAll(() => {
  // Vitest creates and cleans a temporary QUANT_DATA_DIR per test file.
  const dataDir = process.env.QUANT_DATA_DIR;
  if (!dataDir) throw new Error("THS tests require an isolated QUANT_DATA_DIR");
  db = sqlite();
  expect(db.name).toBe(join(dataDir, "quant.sqlite"));
});

beforeEach(() => {
  route.search = "";
  sqlite().prepare("DELETE FROM records WHERE kind = ?").run(recordKind);
  setGlobalAutoLiveEnabled(false);
  vault.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", liveFetch);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => db?.close());

function renderWithQueryClient(node: ReactElement, queryClient: QueryClient) {
  const client = trpc.createClient({ links: [] });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(trpc.Provider, {
        client,
        queryClient,
        children: node,
      }),
    }),
  );
}

it.each([
  "https://user:pass@ths-bridge.example.test/account",
  "https://ths-bridge.example.test/account?mode=read",
])(
  "rejects an unsafe THS live endpoint %s before writing account data",
  async (endpointUrl) => {
    await expect(
      saveThsLiveAccount({ ...account, endpointUrl }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["endpointUrl"] }),
      ]),
    });
    expect(await listThsLiveAccounts()).toEqual([]);
    expect(saveSecret).not.toHaveBeenCalled();
  },
);

it("persists live metadata in SQLite and exposes only credential presence", async () => {
  const saved = await saveThsLiveAccount(account);
  const rows = sqlite()
    .prepare<[string], { payload: string }>(
      "SELECT payload FROM records WHERE kind = ?",
    )
    .all(recordKind);
  const metadata = {
    id: "ths-live-account:wave7-live",
    name: account.name,
    accountId: account.accountId,
    endpointUrl: account.endpointUrl,
    createdAt: expect.any(Number),
    updatedAt: expect.any(Number),
  };
  expect(rows.map(({ payload }) => JSON.parse(payload))).toEqual([metadata]);
  expect(
    sqlite()
      .prepare("SELECT id FROM records WHERE instr(payload, ?) > 0")
      .all(account.token),
  ).toEqual([]);

  const vaultId = pipelineLiveVaultId({
    kind: "cn_broker_live",
    broker: "ths_live",
    accountId: account.accountId,
  });
  expect(saveSecret).toHaveBeenCalledExactlyOnceWith(vaultId, {
    token: account.token,
    endpointUrl: account.endpointUrl,
    allowedOrigin: "https://ths-bridge.example.test",
  });

  const listed = await listThsLiveAccounts();
  const publicAccount = {
    ...metadata,
    hasCredential: true,
    liveKillSwitchEnabled: false,
  };
  expect(saved).toEqual(publicAccount);
  expect(listed).toEqual([publicAccount]);
  expect(JSON.stringify([saved, listed])).not.toContain(account.token);

  vault.delete(vaultId);
  await expect(listThsLiveAccounts()).resolves.toEqual([
    { ...publicAccount, hasCredential: false },
  ]);
});

it.each(["name", "endpointUrl"] as const)(
  "rejects an edit that puts the existing token in %s with a blank token input",
  async (field) => {
    const api = simAccountsRouter.createCaller({ headers: new Headers() });
    const saved = await api.thsLiveAccountSave(account);
    const readRow = sqlite().prepare<[string], { payload: string }>(
      "SELECT payload FROM records WHERE id = ?",
    );
    const original = readRow.get(saved.id);
    expect(original?.payload).not.toContain(account.token);

    await expect(
      api.thsLiveAccountSave({
        ...account,
        id: saved.id,
        token: "",
        [field]:
          field === "name"
            ? `Live account ${account.token}`
            : `https://other-bridge.example.test/${account.token}`,
      }),
    ).rejects.toThrow("账户公开字段不能包含鉴权凭证");

    expect(readRow.get(saved.id)).toEqual(original);
    const listed = await api.thsLiveAccountsList();
    expect(listed).toEqual([saved]);
    expect(JSON.stringify(listed)).not.toContain(account.token);
    expect(saveSecret).toHaveBeenCalledTimes(1);
  },
);

it("blocks a live snapshot before accessing credentials or the bridge when autoLiveEnabled is false", async () => {
  const saved = await saveThsLiveAccount(account);
  expect(saved.hasCredential).toBe(true);
  vi.mocked(readSecret).mockClear();

  await expect(readThsLiveAccountSnapshot(saved.id)).rejects.toThrow(
    /^live-kill-switch-off.*实盘总开关未开启/,
  );
  expect(readSecret).not.toHaveBeenCalled();
  expect(liveFetch).not.toHaveBeenCalled();
});

it("reads an enabled live snapshot with one GET /account and strips extra bridge fields", async () => {
  setGlobalAutoLiveEnabled(true);
  const saved = await saveThsLiveAccount(account);
  const position = {
    symbol: "sh600519",
    quantity: 100,
    sellable: 100,
    lastPrice: 1500,
  };
  const state = {
    cash: 10000,
    equity: 160000,
    drawdownPct: null,
  };
  liveFetch.mockResolvedValueOnce(
    Response.json({
      ...state,
      positions: [{ ...position, note: account.token }],
      error: `Authorization: Bearer ${account.token}`,
    }),
  );

  await expect(readThsLiveAccountSnapshot(saved.id)).resolves.toEqual({
    ...state,
    positions: [position],
    fetchedAt: expect.any(Number),
  });
  expect(liveFetch).toHaveBeenCalledExactlyOnceWith(
    `${account.endpointUrl}/account`,
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({
        Authorization: `Bearer ${account.token}`,
      }),
    }),
  );
  expect(liveFetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
});

it("rejects a position that echoes the token actually sent to the live bridge", async () => {
  setGlobalAutoLiveEnabled(true);
  const saved = await saveThsLiveAccount(account);
  const vaultId = pipelineLiveVaultId({
    kind: "cn_broker_live",
    broker: "ths_live",
    accountId: account.accountId,
  });
  vault.set(vaultId, {
    token: ` ${account.token} `,
    endpointUrl: account.endpointUrl,
    allowedOrigin: account.endpointUrl,
  });
  liveFetch.mockResolvedValueOnce(
    Response.json({
      cash: 10000,
      equity: 160000,
      drawdownPct: null,
      positions: [
        {
          symbol: `echo:${account.token}`,
          quantity: 100,
          sellable: 100,
          lastPrice: 1500,
        },
      ],
    }),
  );

  await expect(readThsLiveAccountSnapshot(saved.id)).rejects.toThrow(
    /^同花顺实盘账户查询失败，请检查桥接服务$/,
  );
  expect(liveFetch).toHaveBeenCalledExactlyOnceWith(
    `${account.endpointUrl}/account`,
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: `Bearer ${account.token}`,
      }),
    }),
  );
});

it("keeps an echoed authorization header out of live bridge errors", async () => {
  setGlobalAutoLiveEnabled(true);
  const saved = await saveThsLiveAccount(account);
  liveFetch.mockRejectedValueOnce(
    new Error(`Bridge rejected Authorization: Bearer ${account.token}`),
  );

  await expect(readThsLiveAccountSnapshot(saved.id)).rejects.toThrow(
    /^同花顺实盘账户查询失败，请检查桥接服务$/,
  );
  expect(liveFetch).toHaveBeenCalledExactlyOnceWith(
    `${account.endpointUrl}/account`,
    expect.objectContaining({ method: "GET" }),
  );
});

it("reports a disabled, unconfigured THS mock account without network requests", async () => {
  setMockEnabled(false);

  await expect(readMockAccountMeta()).resolves.toEqual({
    enabled: false,
    hasAccount: false,
    yybid: null,
    marketCodes: [],
  });
  expect(mockTradingFetch).not.toHaveBeenCalled();
  expect(liveFetch).not.toHaveBeenCalled();
});

it("reports only recognized market codes for a configured mock account without network requests", async () => {
  setMockEnabled(true);
  const username = "wave7-mock-user";
  const zjzh = "123456789012";
  const gdzh = "A987654321";
  vault.set("mock-trading-account", {
    state: "ready",
    username,
    account: zjzh,
    zjzh,
    shareholders: [
      { gddm: gdzh, gdzh, scdm: "1" },
      { gddm: gdzh, scdm: "2" },
      { gddm: gdzh, scdm: "1" },
      ...[username, zjzh, gdzh, "SH", "SZ", "BJ", "9", "8", ":"].map(
        (scdm) => ({
          gddm: gdzh,
          scdm,
        }),
      ),
    ],
  });

  await expect(readMockAccountMeta()).resolves.toEqual({
    enabled: true,
    hasAccount: true,
    yybid: "997376",
    marketCodes: ["1", "2"],
  });
  expect(mockTradingFetch).not.toHaveBeenCalled();
  expect(liveFetch).not.toHaveBeenCalled();
});

it("renders all four account tabs and selects Local Sim by default", () => {
  const html = renderToStaticMarkup(
    createElement(TRPCReactProvider, {
      children: createElement(ParallelAccountsHub),
    }),
  );
  const tabs = [
    ...html.matchAll(
      /<button\b(?=[^>]*\brole="tab")(?=[^>]*\baria-selected="(true|false)")[^>]*>([^<]+)<\/button>/g,
    ),
  ];
  expect(tabs.map(([, selected, label]) => [label, selected])).toEqual([
    ["本地模拟账户", "true"],
    ["同花顺模拟账户", "false"],
    ["同花顺实盘账户", "false"],
    ["期货模拟账户", "false"],
  ]);
  expect(html).toContain("尚无活跃模拟账户");
});

it("shows the ledger's futures cost basis and provides a next page for older fills", () => {
  route.search = "tab=paper&channel=futures-sim";
  const position = {
    symbol: "fuHG00Y",
    name: "COMEX 铜",
    contractMultiplier: 25000,
    quantity: 3,
    side: "long" as const,
    avgEntryPrice: "4.0015",
    costBasis: "300112.5598",
    margin: "30011.26",
    marginRate: "0.10",
  };
  const futures: FuturesSimAccountSummary = {
    id: "futures-fixture",
    name: "期货模拟样本",
    currency: "USD",
    initialCapital: "100000.00",
    cash: "69988.74",
    frozenMargin: position.margin,
    realizedPnl: "0.00",
    positions: [position],
    trades: Array.from({ length: 21 }, (_, index) => ({
      id: `fill-${index + 1}`,
      clientRequestId: `request-${index + 1}`,
      symbol: position.symbol,
      name: `成交样本 ${index + 1}`,
      action: "buy_open",
      quantity: 1,
      ...(index > 0 ? { contractMultiplier: position.contractMultiplier } : {}),
      price: position.avgEntryPrice,
      notional: "100037.50",
      marginDelta: "10003.75",
      fee: "10.00",
      realizedPnl: "0.00",
      executedAt: 1795564800000 - index * 1000,
    })),
    createdAt: 1795564780000,
    updatedAt: 1795564800000,
  };
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    getQueryKey(trpc.futuresSimAccountsList, undefined, "query"),
    [futures],
  );
  const html = renderWithQueryClient(
    createElement(ParallelAccountsHub),
    queryClient,
  );
  expect(html).toContain("25,000 磅/手");
  expect(html).toContain('title="300,112.5598">300,112.56');
  expect(html).toContain("占用保证金");
  expect(html).toMatch(/role="cell"[^>]*>—<\/div>/);
  expect(html).toContain("共 21 笔");
  expect(html).toContain("成交样本 20");
  expect(html).not.toContain("成交样本 21");
  expect(html).toMatch(/<button\b(?![^>]* disabled="")[^>]*>下一页<\/button>/);
});

it("lets a 100% crypto sale use the final eight-decimal unit", () => {
  const accountId = "crypto-precision-fixture";
  const symbol = "cxETHUSDT";
  const detail: SimAccountDetail = {
    account: {
      id: accountId,
      name: "数字货币模拟样本",
      market: "crypto",
      currency: "USDT",
      initialCapital: "1000.00",
      cash: "1000.00",
      status: "active",
      revision: 0,
      createdAt: 1795564800000,
      updatedAt: 1795564800000,
      archivedAt: null,
    },
    cash: "1000.00",
    currentTradeDate: "2026-11-25",
    positions: [
      {
        symbol,
        quantity: "0.00000001",
        sellableQuantity: "0.00000001",
        costBasis: "0.00003",
        averageCost: "3000.00",
      },
    ],
    cashFlows: [],
    trades: [],
    nextCashFlowCursor: null,
    nextTradeCursor: null,
  };
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    getQueryKey(trpc.simAccountsList, undefined, "query"),
    [detail.account],
  );
  queryClient.setQueryData(
    getQueryKey(trpc.simAccountDetail, { accountId, limit: 1 }, "query"),
    detail,
  );
  const html = renderWithQueryClient(
    createElement(SimOrderForm, {
      defaults: { accountId, symbol, side: "sell", price: "3000" },
    }),
    queryClient,
  );
  expect(html).toMatch(/<button\b[^>]* disabled=""[^>]*>25%<\/button>/);
  expect(html).toMatch(/<button\b[^>]* disabled=""[^>]*>50%<\/button>/);
  expect(html).toMatch(/<button\b(?![^>]* disabled="")[^>]*>100%<\/button>/);
});
