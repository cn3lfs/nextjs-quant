import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("../../src/server/vault", () => ({
  saveSecret: async (id: string, value: unknown) => {
    store.set(id, value);
  },
  readSecret: async (id: string) => store.get(id),
}));

const {
  binanceCredentialStatus,
  clearBinanceCredential,
  preserveCryptoSettings,
  saveBinanceCredential,
  saveCryptoSettings,
} = await import("../../src/server/infra/crypto-connectivity");
const { settings, saveSettings } =
  await import("../../src/server/infra/settings");

const key = "A".repeat(60) + "WXYZ";
const secret = "b".repeat(64);

beforeEach(() => store.clear());

describe("Binance credentials", () => {
  it("stores the pair through the vault and only exposes a masked hint", async () => {
    await saveBinanceCredential({
      apiKey: key,
      apiSecret: secret,
      testnet: true,
    });
    const status = await binanceCredentialStatus();
    expect(status).toMatchObject({
      configured: true,
      testnet: true,
      keyHint: "…WXYZ",
    });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).not.toContain(key);
  });

  it("rejects malformed keys and non-HMAC secrets", async () => {
    await expect(
      saveBinanceCredential({
        apiKey: "short",
        apiSecret: secret,
        testnet: true,
      }),
    ).rejects.toThrow();
    await expect(
      saveBinanceCredential({
        apiKey: key,
        apiSecret: "-----BEGIN PRIVATE KEY-----",
        testnet: false,
      }),
    ).rejects.toThrow();
    expect(await binanceCredentialStatus()).toEqual({ configured: false });
  });

  it("clearing leaves no usable credential", async () => {
    await saveBinanceCredential({
      apiKey: key,
      apiSecret: secret,
      testnet: false,
    });
    await clearBinanceCredential();
    expect(await binanceCredentialStatus()).toEqual({ configured: false });
  });
});

describe("crypto settings ownership", () => {
  it("the generic settings save cannot overwrite the proxy set by the crypto panel", () => {
    const stale = settings();
    saveCryptoSettings({
      outboundProxy: "socks5://127.0.0.1:10808",
      binanceTestnet: false,
    });
    saveSettings(
      preserveCryptoSettings({
        ...stale,
        outboundProxy: "",
        binanceTestnet: true,
      }),
    );
    expect(settings()).toMatchObject({
      outboundProxy: "socks5://127.0.0.1:10808",
      binanceTestnet: false,
    });
  });

  it("rejects proxy addresses outside socks/http", () => {
    expect(() =>
      saveCryptoSettings({ outboundProxy: "ftp://x:1", binanceTestnet: true }),
    ).toThrow("代理地址格式无效");
  });
});
