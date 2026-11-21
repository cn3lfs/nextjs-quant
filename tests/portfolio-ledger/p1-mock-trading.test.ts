import { beforeEach, afterEach, expect, it, vi, type Mock } from "vitest";
import { createServer, type Server } from "node:http";
import {
  MockTradingAdapter,
  reconcilePositions,
  type MockAccount,
} from "../../src/server/portfolio/mock/mock-trading";
import { tradeInputSchema } from "../../src/lib/portfolio/trade-ledger";
let server: Server,
  baseUrl: string,
  requests: URL[],
  enabled: boolean,
  account: MockAccount | undefined;
let response: (url: URL) => unknown;
let adapter: MockTradingAdapter,
  read: Mock<() => Promise<MockAccount | undefined>>;
const ready: MockAccount = {
  username: "skill_1234567890123",
  state: "ready",
  account: "123",
  shareholders: [{ gddm: "fake-sh", scdm: "2" }],
};
const order = () =>
  tradeInputSchema.parse({
    id: crypto.randomUUID(),
    symbol: "sh600519",
    date: "2026-09-10",
    side: "buy",
    price: 10,
    quantity: 100,
    lowerLimit: 9,
    upperLimit: 11,
    limitSource: "controlled",
  });
beforeEach(async () => {
  requests = [];
  enabled = false;
  account = undefined;
  response = (url) =>
    url.pathname === "/pt_add_user"
      ? { errorcode: 0, errormsg: "123" }
      : url.pathname === "/pt_qry_stkaccount_dklc"
        ? { errorcode: "0", result: ready.shareholders }
        : url.pathname === "/pt_web_qry_stock"
          ? {
              errorcode: 0,
              data: [{ zqdm: "600519", gpsl: 200, kysl: 100, gpcb: "10.5" }],
            }
          : { errorcode: 0, result: {} };
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(response(url)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  read = vi.fn(async () => account);
  adapter = new MockTradingAdapter({
    enabled: () => enabled,
    baseUrl,
    read,
    save: async (a) => {
      account = a;
    },
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("default off: ACTUAL controlled HTTP request count is zero across open/query/order and no credential read", async () => {
  await expect(adapter.open()).rejects.toThrow("未开启");
  await expect(adapter.positions()).rejects.toThrow("未开启");
  await expect(adapter.order(order(), true)).rejects.toThrow("未开启");
  expect(requests).toHaveLength(0);
  expect(read).toHaveBeenCalledTimes(0);
});
it("enabled negative control reaches the actual server; account identity is reused and exact contract fields sent", async () => {
  enabled = true;
  await adapter.open();
  expect(requests.map((u) => u.pathname)).toEqual([
    "/pt_add_user",
    "/pt_qry_stkaccount_dklc",
  ]);
  expect(requests[0]!.searchParams.get("usrname")).toMatch(/^skill_\d{13}$/);
  expect(account?.state).toBe("ready");
  await adapter.open();
  expect(requests).toHaveLength(2);
  await adapter.order(order(), true);
  expect(Object.fromEntries(requests[2]!.searchParams)).toMatchObject({
    datatype: "json",
    usrid: "123",
    zqdm: "600519",
    gddh: "fake-sh",
    scdm: "2",
    yybd: "997376",
    wtjg: "10",
    wtsl: "100",
    mmlb: "B",
  });
});
it("unconfirmed order never sends HTTP even when enabled", async () => {
  enabled = true;
  account = ready;
  await expect(adapter.order(order(), false)).rejects.toThrow("界面确认");
  expect(requests).toHaveLength(0);
});
it("remote sell checks actual sellable, rejects T+1 excess before placing an order", async () => {
  enabled = true;
  account = ready;
  await expect(
    adapter.order({ ...order(), side: "sell", quantity: 200 }, true),
  ).rejects.toThrow("T+1");
  expect(requests.map((u) => u.pathname)).toEqual(["/pt_web_qry_stock"]);
  await adapter.order({ ...order(), side: "sell" }, true);
  expect(requests.at(-1)!.searchParams.get("mmlb")).toBe("S");
});
it("invalid remote data and server errors never leak credentials", async () => {
  enabled = true;
  account = ready;
  response = () => ({ errorcode: -1, errormsg: `secret=${ready.username}` });
  await expect(adapter.positions()).rejects.toThrow("模拟盘请求失败");
  try {
    await adapter.positions();
  } catch (e) {
    expect(String(e)).not.toContain(ready.username);
  }
  response = () => ({
    errorcode: 0,
    data: [{ zqdm: "600519", gpsl: "bad", kysl: 100, gpcb: "10" }],
  });
  await expect(adapter.positions()).rejects.toThrow("格式无效");
});
it("ambiguous creation persists pending identity and never automatically opens another account", async () => {
  enabled = true;
  response = () => ({ errorcode: -1 });
  await expect(adapter.open()).rejects.toThrow();
  expect(account?.state).toBe("creating");
  await expect(adapter.open()).rejects.toThrow("禁止自动重复开户");
  expect(requests).toHaveLength(1);
});
it("disabling during credential read still prevents the HTTP request", async () => {
  enabled = true;
  account = ready;
  read.mockImplementation(async () => {
    enabled = false;
    return account;
  });
  await expect(adapter.positions()).rejects.toThrow("未开启");
  expect(requests).toHaveLength(0);
});
it("reconciliation returns explicit differences and does not mutate either side", async () => {
  enabled = true;
  account = ready;
  const remote = await adapter.positions();
  const copy = structuredClone(remote);
  const diff = reconcilePositions([], remote);
  expect(diff[0]).toMatchObject({
    symbol: "sh600519",
    localQuantity: 0,
    remoteQuantity: 200,
    quantityDifference: -200,
    remoteSellable: 100,
    remoteCost: 10.5,
  });
  expect(remote).toEqual(copy);
});

it("retains failed shareholder fields and masked original response without recreating", async () => {
  enabled = true;
  account = { ...ready, state: "creating" };
  response = () => ({
    errorcode: 0,
    result: [{ usrid: ready.account, gddm: "", scdm: "2" }],
    note: ready.username,
  });
  await expect(adapter.refreshShareholders()).rejects.toThrow("契约");
  expect(requests.map((u) => u.pathname)).toEqual(["/pt_qry_stkaccount_dklc"]);
  const entry = adapter.diagnostics()[0]!;
  expect(entry.failures).toContainEqual({
    field: "result.0.gddm",
    reason: "too_small",
  });
  expect(entry.rawBody).toContain('"gddm":""');
  expect(JSON.stringify(entry)).not.toContain(ready.username);
  expect(entry.rawBody).not.toContain(ready.account!);
  expect(entry.httpStatus).toBe(200);
  expect(entry.envelope.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(account.state).toBe("creating");
});
it("keeps only the last twenty request records and returns detached diagnostics", async () => {
  enabled = true;
  account = ready;
  for (let i = 0; i < 22; i++) await adapter.positions();
  expect(adapter.diagnostics()).toHaveLength(20);
  adapter.diagnostics()[0]!.rawBody = "changed";
  expect(adapter.diagnostics()[0]!.rawBody).not.toBe("changed");
});
it("observed gdzh contract preserves all market codes, retains success evidence and orders only documented market", async () => {
  enabled = true;
  account = { ...ready, state: "creating" };
  response = (url) =>
    url.pathname === "/pt_qry_stkaccount_dklc"
      ? {
          errorcode: 0,
          result: ["9", "8", "2", "1", ":"].map((scdm) => ({
            gdzh: `share-${scdm}`,
            scdm,
          })),
        }
      : { errorcode: 0 };
  await adapter.refreshShareholders();
  expect(account.shareholders?.map((s) => s.scdm)).toEqual([
    "9",
    "8",
    "2",
    "1",
    ":",
  ]);
  expect(adapter.diagnostics()[0]!.rawBody).toContain("gdzh");
  expect(adapter.diagnostics()[0]!.failures).toEqual([]);
  await adapter.order(order(), true);
  expect(requests.at(-1)!.searchParams.get("scdm")).toBe("2");
  expect(requests.at(-1)!.searchParams.get("gddh")).toBe("share-2");
});
it("conflicting document and observed account fields are rejected without retry", async () => {
  enabled = true;
  account = { ...ready, state: "creating" };
  response = () => ({
    errorcode: 0,
    result: [{ gddm: "a", gdzh: "b", scdm: "9" }],
  });
  await expect(adapter.refreshShareholders()).rejects.toThrow("契约");
  expect(requests).toHaveLength(1);
  expect(account.state).toBe("creating");
});
it("funds and today's trades use their documented success envelopes and sanitize returned identity", async () => {
  enabled = true;
  account = ready;
  response = (url) =>
    url.pathname === "/pt_qry_fund_t"
      ? {
          errormsg: "",
          result: {
            list: [{ usrid: "123", zjye: "1000", kyje: "900", dje: "100" }],
          },
        }
      : {
          ret: {
            code: "0",
            item: [
              {
                zqdm: "600519",
                mmlb: "B",
                cjg: "10",
                cje: "1000",
                cjsj: "10:01:00",
                fee: "5",
              },
            ],
          },
        };
  expect(await adapter.funds()).toEqual([{ zjye: 1000, kyje: 900, dje: 100 }]);
  expect(await adapter.todayTrades()).toHaveLength(1);
  expect(requests.map((u) => u.pathname)).toEqual([
    "/pt_qry_fund_t",
    "/pt_qry_busin_nocache",
  ]);
});

it("Q0 observed query contract retains frozen shares and blocks a same-day sell without submitting", async () => {
  enabled = true;
  account = ready;
  response = (url) =>
    url.pathname === "/pt_web_qry_stock"
      ? {
          errorcode: 0,
          result: [
            { zqdm: "601398", gpsl: 0, kysl: 0, djsl: 100, gpcb: "8.073" },
          ],
        }
      : url.pathname === "/pt_qry_fund_t"
        ? {
            errorcode: 0,
            result: {},
            list: [
              {
                usrid: ready.account,
                zjye: "200000",
                kyje: "199192.74",
                djje: "0",
              },
            ],
          }
        : {
            errorcode: 0,
            result: [
              {
                zqdm: "601398",
                mmlb: "买入",
                cjjg: "8.07",
                cjje: "807",
                cjsl: "100",
                cjsj: "10:23:03",
                fee: "0.26",
                gdzh: "secret",
              },
            ],
          };
  expect(await adapter.positions()).toEqual([
    { symbol: "sh601398", quantity: 100, sellable: 0, cost: 8.073 },
  ]);
  expect(await adapter.funds()).toEqual([
    { zjye: 200000, kyje: 199192.74, dje: 0 },
  ]);
  expect(await adapter.todayTrades()).toEqual([
    {
      zqdm: "601398",
      mmlb: "买入",
      cjg: 8.07,
      cje: 807,
      cjsl: 100,
      cjsj: "10:23:03",
      fee: 0.26,
      tradeNo: null,
      entrustNo: null,
    },
  ]);
  expect(requests[1]!.searchParams.get("usrid")).toBe(ready.account);
  expect(requests[1]!.searchParams.has("usid")).toBe(false);
  expect(requests[2]!.searchParams.get("usrname")).toBe(ready.account);
  await expect(
    adapter.order({ ...order(), symbol: "sh601398", side: "sell" }, true),
  ).rejects.toThrow("T+1 可卖数量不足");
  expect(requests.some((u) => u.pathname === "/pt_stk_weituo_dklc")).toBe(
    false,
  );
  expect(adapter.diagnostics()).toHaveLength(4);
  expect(adapter.diagnostics().every((e) => e.failures.length === 0)).toBe(
    true,
  );
});

it("Q0 observed malformed queries are not treated as empty portfolios, balances or fills", async () => {
  enabled = true;
  account = ready;
  response = () => ({
    errorcode: 0,
    result: [{ zqdm: "601398", gpsl: 0, kysl: 0, gpcb: "8.073" }],
  });
  await expect(adapter.positions()).rejects.toThrow("契约");
  response = () => ({ errorcode: 0, result: {}, list: false });
  await expect(adapter.funds()).rejects.toThrow("契约");
  response = () => ({
    errorcode: 0,
    result: [{ ERRORCODE: -1, ERRORMSG: "用户不存在" }],
  });
  await expect(adapter.todayTrades()).rejects.toThrow("契约");
  expect(adapter.diagnostics().every((e) => e.failures.length > 0)).toBe(true);
  expect(requests).toHaveLength(3);
});

it("order receipt collects entrust numbers from result/list without duplicates or credential leakage", async () => {
  enabled = true;
  account = ready;
  response = (url) =>
    url.pathname === "/pt_stk_weituo_dklc"
      ? {
          errorcode: 0,
          usrid: ready.account,
          result: [
            { entrust_no: "1001", usrid: ready.account },
            { entrust_no: 1002 },
            { entrust_no: "1001" },
          ],
          list: [{ entrustNo: "1003" }, { note: "no entrust number" }],
        }
      : { errorcode: 0 };
  const receipt = await adapter.order(order(), true);
  expect(receipt).toMatchObject({
    message: "委托请求已受理，不等于成交；请人工核对成交后另行记入本地账本",
    entrustNos: ["1001", "1002", "1003"],
    tradeDate: "2026-09-10",
  });
  expect(receipt.credentialRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(receipt)).not.toContain(ready.account!);
});

it("order without an entrust number still succeeds but cannot be attributed", async () => {
  enabled = true;
  account = ready;
  response = (url) =>
    url.pathname === "/pt_stk_weituo_dklc"
      ? { errorcode: 0, result: [{ accepted: true }] }
      : { errorcode: 0 };
  expect(await adapter.order(order(), true)).toMatchObject({ entrustNos: [] });
});

it("both observed trade shapes carry optional entrust numbers without loosening required fields", async () => {
  enabled = true;
  account = ready;
  response = () => ({
    ret: {
      code: "0",
      item: [
        {
          zqdm: "600519",
          mmlb: "B",
          cjg: "10",
          cje: "1000",
          cjsj: "10:01:00",
          fee: "5",
          entrustNo: 55,
        },
      ],
    },
  });
  expect((await adapter.todayTrades())[0]!.entrustNo).toBe("55");
  response = (url) =>
    url.pathname === "/pt_qry_busin_nocache"
      ? {
          errorcode: 0,
          result: [
            {
              zqdm: "600519",
              mmlb: "买入",
              cjjg: "10",
              cjje: "1000",
              cjsl: "100",
              cjsj: "10:01:00",
              fee: "5",
              entrust_no: "A1",
            },
          ],
        }
      : { errorcode: 0 };
  expect((await adapter.todayTrades())[0]!.entrustNo).toBe("A1");
});

it("order status attributes only exact entrust numbers and never guesses from symbol or size", async () => {
  enabled = true;
  account = ready;
  const tradeRow = (entrust_no?: string) => ({
    zqdm: "600519",
    mmlb: "买入",
    cjjg: "10",
    cjje: "1000",
    cjsl: "100",
    cjsj: "10:01:00",
    fee: "5",
    ...(entrust_no ? { entrust_no } : {}),
  });
  // An unattributable row could be the target order: the result is unknown,
  // even though the exact entrust-number match is still reported.
  response = () => ({
    errorcode: 0,
    result: [tradeRow("A1"), tradeRow("A2"), tradeRow()],
  });
  expect(await adapter.orderStatus(["A1", "missing"])).toMatchObject({
    attributable: false,
    fillStatus: "unknown",
    rows: [{ entrustNo: "A1" }],
  });
  expect((await adapter.orderStatus([])).rows).toEqual([]);
  expect(await adapter.orderStatus([])).toMatchObject({
    fillStatus: "unknown",
    attributable: false,
  });
  // No matched row and no ambiguous rows: the refs are queryable and unfilled.
  response = () => ({ errorcode: 0, result: [tradeRow("A2")] });
  expect(await adapter.orderStatus(["A1"])).toEqual({
    attributable: false,
    fillStatus: "unfilled",
    rows: [],
  });
  // A fully attributable match.
  response = () => ({
    errorcode: 0,
    result: [tradeRow("A1"), tradeRow("A2")],
  });
  expect(await adapter.orderStatus(["A1"])).toEqual({
    attributable: true,
    fillStatus: "matched",
    rows: [expect.objectContaining({ entrustNo: "A1" })],
  });
  response = () => ({ errorcode: 0, result: [tradeRow(), tradeRow()] });
  expect(await adapter.orderStatus(["A1"])).toEqual({
    attributable: false,
    fillStatus: "unknown",
    rows: [],
  });
});

it("entrust numbers are rejected when they echo credentials or are not short identifiers", async () => {
  enabled = true;
  account = ready;
  const tradeRow = (entrust_no: string) => ({
    zqdm: "600519",
    mmlb: "买入",
    cjjg: "10",
    cjje: "1000",
    cjsl: "100",
    cjsj: "10:01:00",
    fee: "5",
    entrust_no,
  });
  const rowsOf = (values: string[]) => () => ({
    errorcode: 0,
    result: values.map(tradeRow),
  });
  // Equal to the fund account and username, internal prefix, spaces, Chinese
  // text and overlong values are all discarded rather than treated as refs.
  for (const value of [
    ready.account!,
    ready.username,
    "skill_999",
    "SKILL_999",
    "-1",
    "A 1",
    "委托1",
    "A".repeat(25),
  ]) {
    response = rowsOf([value, "A1"]);
    const trades = await adapter.todayTrades();
    expect(trades.map((t) => t.entrustNo)).toEqual([null, "A1"]);
  }
  // A legitimate identifier that merely contains the account digits is kept;
  // only an exact credential echo is rejected.
  const containingAccount = `E${ready.account}-01`;
  response = rowsOf([containingAccount]);
  expect((await adapter.todayTrades())[0]!.entrustNo).toBe(containingAccount);
  // The order receipt applies the same snapshot filter.
  response = (url) =>
    url.pathname === "/pt_stk_weituo_dklc"
      ? {
          errorcode: 0,
          result: [
            { entrust_no: ready.account },
            { entrust_no: ready.username },
            { entrust_no: "A1" },
          ],
        }
      : { errorcode: 0 };
  expect(await adapter.order({ ...order(), side: "buy" }, true)).toMatchObject({
    entrustNos: ["A1"],
  });
});

it("ret.item trade rows expose entrust numbers so the observed shape stays attributable", async () => {
  enabled = true;
  account = ready;
  response = () => ({
    ret: {
      code: "0",
      item: [
        {
          zqdm: "600519",
          mmlb: "B",
          cjg: "10",
          cje: "1000",
          cjsj: "10:01:00",
          fee: "5",
          entrust_no: "A7",
          trade_no: "T1",
        },
      ],
    },
  });
  expect(await adapter.todayTrades()).toEqual([
    {
      zqdm: "600519",
      mmlb: "B",
      cjg: 10,
      cje: 1000,
      cjsj: "10:01:00",
      fee: 5,
      tradeNo: "T1",
      entrustNo: "A7",
    },
  ]);
  expect(await adapter.orderStatus(["A7"])).toEqual({
    attributable: true,
    fillStatus: "matched",
    rows: [expect.objectContaining({ entrustNo: "A7", tradeNo: "T1" })],
  });
});

it("trade numbers come only from explicit response fields", async () => {
  enabled = true;
  account = ready;
  response = () => ({
    errorcode: 0,
    result: [
      {
        zqdm: "600519",
        mmlb: "买入",
        cjjg: "10",
        cjje: "1000",
        cjsl: "50",
        cjsj: "10:01:00",
        fee: "5",
        entrust_no: "A1",
        cjbh: "C9",
      },
    ],
  });
  expect((await adapter.todayTrades())[0]).toMatchObject({
    tradeNo: "C9",
    entrustNo: "A1",
  });
  // No explicit trade number: remain null instead of inventing one.
  response = () => ({
    errorcode: 0,
    result: [
      {
        zqdm: "600519",
        mmlb: "买入",
        cjjg: "10",
        cjje: "1000",
        cjsl: "50",
        cjsj: "10:01:00",
        fee: "5",
        entrust_no: "A1",
      },
    ],
  });
  expect((await adapter.todayTrades())[0]!.tradeNo).toBeNull();
});
