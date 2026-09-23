import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { readSecret, saveSecret } from "../vault";
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
  { host: "data-api.binance.vision", use: "公开行情" },
  { host: "api.binance.com", use: "账户与下单（实盘）" },
  { host: "testnet.binance.vision", use: "账户与下单（测试网）" },
] as const;

export type ProbeResult = {
  ok: boolean;
  status?: number;
  ms: number;
  message: string;
};

async function probe(host: string, proxy?: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await undiciFetch(`https://${host}/api/v3/time`, {
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
          ? "出口所在地区受币安限制"
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

/** Probe each Binance host both directly and through the configured proxy. */
export async function checkCryptoConnectivity(
  proxy = settings().outboundProxy,
) {
  const rows = await Promise.all(
    CONNECTIVITY_HOSTS.map(async ({ host, use }) => ({
      host,
      use,
      direct: await probe(host),
      proxy: proxy ? await probe(host, proxy) : null,
    })),
  );
  return { proxy, checkedAt: Date.now(), rows };
}

/** Binance HMAC API key pair, stored with Windows DPAPI; never returned. */
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
  testnet: z.boolean(),
});
export type BinanceCredential = z.infer<typeof binanceCredentialSchema> & {
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
export function readBinanceCredential() {
  return readSecret<BinanceCredential | null>(SECRET_ID);
}
/** Public status only: whether a key exists, for which network, and a masked key. */
export async function binanceCredentialStatus() {
  const value = await readBinanceCredential();
  return value
    ? {
        configured: true,
        testnet: value.testnet,
        keyHint: `…${value.apiKey.slice(-4)}`,
        savedAt: value.savedAt,
      }
    : { configured: false as const };
}
