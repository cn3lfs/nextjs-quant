import { beforeEach, afterEach, expect, it, vi, type Mock } from "vitest";
import { createServer, type Server } from "node:http";
import {
  MockTradingAdapter,
  reconcilePositions,
  type MockAccount,
} from "../src/server/mock-trading";
import { tradeInputSchema } from "../src/lib/trade-ledger";
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
        : url.pathname === "/pt_web_qy_stock"
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
  expect(requests.map((u) => u.pathname)).toEqual(["/pt_web_qy_stock"]);
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
