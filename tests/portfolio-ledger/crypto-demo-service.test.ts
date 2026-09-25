import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: string[] = [];
let network: "demo" | "testnet" = "testnet";
vi.mock("../../src/server/infra/crypto-connectivity", () => ({
  readBinanceSimCredential: async () => {
    calls.push("credential");
    return { apiKey: "k".repeat(20), apiSecret: "s".repeat(20), network };
  },
}));
vi.mock("../../src/server/data-sources/binance/binance-private", () => {
  class BinanceApiError extends Error {
    constructor(message: string, readonly status: number | null, readonly outcomeUnknown: boolean) {
      super(message);
    }
  }
  class BinanceSimClient {
    account = async () => {
      calls.push("account");
      return { balances: [{ asset: "USDT", free: "1000", locked: "0" }, { asset: "BTC", free: "0", locked: "0" }] };
    };
    openOrders = async () => [];
    exchangeInfo = async () => ({
      symbols: [{
        symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT",
        filters: [{ filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" }],
      }],
    });
    price = async () => ({ price: "80000" });
    newOrder = async () => {
      calls.push("order");
      if (network === "demo") throw new BinanceApiError("socket hang up", null, true);
      return { orderId: 1, status: "NEW" };
    };
  }
  return { BinanceSimClient, BinanceApiError };
});

process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "crypto-demo-"));
const service = await import("../../src/server/portfolio/crypto-demo-service");
const order = { symbol: "cxBTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.001", price: "80000" };

beforeEach(() => {
  calls.length = 0;
  network = "testnet";
  service.setCryptoDemoEnabled(false);
});

it("is off by default and sends nothing while disabled", async () => {
  expect(service.cryptoDemoEnabled()).toBe(false);
  await expect(service.cryptoDemoAccount()).rejects.toThrow("未开启");
  await expect(service.previewCryptoDemoOrder(order)).rejects.toThrow("未开启");
  expect(calls).toEqual([]);
});

it("confirms a preview exactly once, then refuses it", async () => {
  service.setCryptoDemoEnabled(true);
  const preview = await service.previewCryptoDemoOrder(order);
  expect(preview.problems).toEqual([]);
  expect(preview.id).toMatch(/^crypto-demo-order-/);
  await expect(service.confirmCryptoDemoOrder(preview.id!)).resolves.toMatchObject({ outcome: "accepted" });
  await expect(service.confirmCryptoDemoOrder(preview.id!)).rejects.toThrow("已确认或已过期");
  expect(calls.filter((c) => c === "order")).toHaveLength(1);
});

it("reports problems without issuing a preview id", async () => {
  service.setCryptoDemoEnabled(true);
  const preview = await service.previewCryptoDemoOrder({ ...order, quantity: "1" });
  expect(preview.id).toBeNull();
  expect(preview.problems).toContain("可用 USDT 不足（需约 80000.0000）");
});

it("reports an uncertain send as unknown and does not retry", async () => {
  service.setCryptoDemoEnabled(true);
  network = "demo";
  const preview = await service.previewCryptoDemoOrder(order);
  await expect(service.confirmCryptoDemoOrder(preview.id!)).resolves.toMatchObject({ outcome: "unknown" });
  expect(calls.filter((c) => c === "order")).toHaveLength(1);
});

it("refuses to send when the key network changed after the preview", async () => {
  service.setCryptoDemoEnabled(true);
  const preview = await service.previewCryptoDemoOrder(order);
  network = "demo";
  await expect(service.confirmCryptoDemoOrder(preview.id!)).rejects.toThrow("网络已变化");
  expect(calls).not.toContain("order");
});
