import { get, put } from "./db";
import {
  TDX_HOSTS,
  parseHosts,
  createTdxClient,
  createQuotesPool as createPool,
} from "tstdx";
export { TDX_HOSTS, PORT, TdxSession, parseHosts } from "tstdx";

/**
 * 行情服务器可以覆盖：环境变量 `TDX_HOSTS`（逗号分隔）优先，其次本地配置里的
 * `tdx-hosts`，最后才是内置列表。公共服务器随时可能失效，写死一份是不够的。
 *
 * 这里刻意不进 settingsSchema：那份 schema 是全项目共用的，单独存一条配置
 * 既能让界面按需读写，也不会和别处对配置定义的改动互相争抢。
 */
export const TDX_HOSTS_KEY = "tdx-hosts";
/** 读取生效的服务器列表；配置为空或读取失败时回落到内置列表。 */
export function configuredHosts(): readonly string[] {
  const fromEnv = parseHosts(process.env.TDX_HOSTS);
  if (fromEnv.length) return fromEnv;
  try {
    const stored = get<{ hosts?: string[] }>(TDX_HOSTS_KEY)?.hosts;
    if (Array.isArray(stored) && stored.length)
      return parseHosts(stored.join(","));
  } catch {
    // 配置不可读时不该让行情整体不可用，回落到内置列表。
  }
  return TDX_HOSTS;
}

/** 保存自定义服务器列表；传空数组即恢复内置列表。 */
export function saveHosts(hosts: string[]) {
  const checked = parseHosts(hosts.join(","));
  put(TDX_HOSTS_KEY, TDX_HOSTS_KEY, { hosts: checked });
  void client.close();
  return checked;
}

export function createQuotesPool(hosts?: readonly string[], port?: number) {
  return createPool(hosts ?? configuredHosts, port);
}
const client = createTdxClient({ hosts: configuredHosts });
export const {
  securityQuotes,
  transactionPage,
  historyTransactionPage,
  barPage,
  indexBarPage,
  minutes,
  historyMinutes,
  xdxr,
  finance,
  companyInfoCategories,
  companyInfoContent,
} = client;
export const closeQuotes = client.close;
