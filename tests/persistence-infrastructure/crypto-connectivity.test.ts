import { describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("../../src/server/vault", () => ({
  saveSecret: async (id: string, value: unknown) => {
    store.set(id, value);
  },
  readSecret: async (id: string) => store.get(id),
}));

const { preserveCryptoSettings, saveCryptoSettings } =
  await import("../../src/server/infra/crypto-connectivity");
const { settings, saveSettings } =
  await import("../../src/server/infra/settings");

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
