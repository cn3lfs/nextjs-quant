import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { readSecret, saveSecret } from "../vault";
import { proxyDispatcher, resetOutboundRoutes } from "./outbound";
import type {
  BinanceSimCredential,
  BinanceSimNetwork,
} from "../data-sources/binance/binance-private";
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
  { host: "data-api.binance.vision", use: "币安公开行情", path: "/api/v3/time" },
  { host: "api.binance.com", use: "币安实盘（仅行情备用）", path: "/api/v3/time" },
  { host: "demo-api.binance.com", use: "币安 Demo 模拟盘", path: "/api/v3/time" },
  { host: "testnet.binance.vision", use: "币安测试网", path: "/api/v3/time" },
  { host: "www.okx.com", use: "OKX 公开行情", path: "/api/v5/public/time" },
  { host: "api.gateio.ws", use: "Gate.io 公开行情", path: "/api/v4/spot/time" },
  { host: "api.exchange.coinbase.com", use: "Coinbase 公开行情", path: "/time" },
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

/**
 * Binance HMAC API key pair for simulated trading (Demo Mode or Spot
 * Testnet), stored with Windows DPAPI; never returned. Live keys are not
 * accepted: the private client only knows the two simulated hosts.
 */
const SECRET_ID = "binance-api";
export const binanceCredentialSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/, "API Key 格式无效"),
  apiSecret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/, "Secret 格式无效（目前只支持 HMAC 密钥）"),
  network: z.enum(["demo", "testnet"]),
});
type StoredCredential = {
  apiKey: string;
  apiSecret: string;
  /** Present on keys saved before simulated networks were split. */
  testnet?: boolean;
  network?: BinanceSimNetwork;
  savedAt: number;
};
export async function saveBinanceCredential(input: unknown) {
  const value = binanceCredentialSchema.parse(input);
  await saveSecret(SECRET_ID, { ...value, savedAt: Date.now() });
  return { configured: true };
}
export async function clearBinanceCredential() {
  await saveSecret(SECRET_ID, null);
  return { configured: false };
}
/** Network of a stored key; a legacy live key maps to `live` and is refused. */
const networkOf = (value: StoredCredential): BinanceSimNetwork | "live" =>
  value.network ?? (value.testnet === false ? "live" : "testnet");
/** The simulated-trading credential, or an explanation of why there is none. */
export async function readBinanceSimCredential(): Promise<BinanceSimCredential> {
  const value = await readSecret<StoredCredential | null>(SECRET_ID);
  if (!value) throw new Error("尚未保存币安模拟盘 Key");
  const network = networkOf(value);
  if (network === "live")
    throw new Error("已保存的是实盘 Key，模拟盘不使用实盘 Key，请改存 Demo 或测试网 Key");
  return { apiKey: value.apiKey, apiSecret: value.apiSecret, network };
}
/** Public status only: whether a key exists, for which network, and a masked key. */
export async function binanceCredentialStatus() {
  const value = await readSecret<StoredCredential | null>(SECRET_ID);
  return value
    ? {
        configured: true as const,
        network: networkOf(value),
        keyHint: `…${value.apiKey.slice(-4)}`,
        savedAt: value.savedAt,
      }
    : { configured: false as const };
}
