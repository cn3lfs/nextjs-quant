import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { proxyDispatcher, resetOutboundRoutes } from "./outbound";
import { saveSettings, settings } from "./settings";

/**
 * Settings owned by the 数字货币 panel. The generic settings save keeps these
 * values, so an older copy of the whole settings form cannot overwrite them.
 */
export const cryptoSettingsSchema = z.object({
  outboundProxy: z
    .string()
    .trim()
    .max(200)
    .regex(/^$|^(socks5h?|socks4|https?):\/\/[^\s/]+$/, "代理地址格式无效"),
  binanceTestnet: z.boolean(),
});
export function saveCryptoSettings(input: unknown) {
  const value = cryptoSettingsSchema.parse(input);
  saveSettings({ ...settings(), ...value });
  resetOutboundRoutes();
  return value;
}
export function preserveCryptoSettings<T extends object>(input: T) {
  const current = settings();
  return {
    ...input,
    outboundProxy: current.outboundProxy,
    binanceTestnet: current.binanceTestnet,
  };
}

export const CONNECTIVITY_HOSTS = [
  {
    host: "data-api.binance.vision",
    use: "币安公开行情",
    path: "/api/v3/time",
  },
  {
    host: "api.binance.com",
    use: "币安实盘（仅行情备用）",
    path: "/api/v3/time",
  },
  {
    host: "demo-api.binance.com",
    use: "币安 Demo 模拟盘",
    path: "/api/v3/time",
  },
  { host: "testnet.binance.vision", use: "币安测试网", path: "/api/v3/time" },
  { host: "www.okx.com", use: "OKX 公开行情", path: "/api/v5/public/time" },
  { host: "api.gateio.ws", use: "Gate.io 公开行情", path: "/api/v4/spot/time" },
  {
    host: "api.exchange.coinbase.com",
    use: "Coinbase 公开行情",
    path: "/time",
  },
  { host: "api.bybit.com", use: "Bybit 公开行情", path: "/v5/market/time" },
] as const;

export type ProbeResult = {
  ok: boolean;
  status?: number;
  ms: number;
  message: string;
};

async function probe(
  host: string,
  path: string,
  proxy?: string,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await undiciFetch(`https://${host}${path}`, {
      signal: AbortSignal.timeout(8000),
      ...(proxy ? { dispatcher: proxyDispatcher(proxy) } : {}),
    });
    const ms = Date.now() - started;
    const text = await response.text();
    if (response.ok)
      return { ok: true, status: response.status, ms, message: "可用" };
    return {
      ok: false,
      status: response.status,
      ms,
      message:
        response.status === 451 || response.status === 403
          ? "出口所在地区受该平台限制"
          : `HTTP ${response.status}${text ? `：${text.slice(0, 80)}` : ""}`,
    };
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      ok: false,
      ms: Date.now() - started,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "超时"
          : (cause ?? (error instanceof Error ? error.message : "连接失败")),
    };
  }
}

/** Probe each exchange host both directly and through the configured proxy. */
export async function checkCryptoConnectivity(
  proxy = settings().outboundProxy,
) {
  const rows = await Promise.all(
    CONNECTIVITY_HOSTS.map(async ({ host, use, path }) => ({
      host,
      use,
      direct: await probe(host, path),
      proxy: proxy ? await probe(host, path, proxy) : null,
    })),
  );
  return { proxy, checkedAt: Date.now(), rows };
}
