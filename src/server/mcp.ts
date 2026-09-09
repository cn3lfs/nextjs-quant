import { ConnectionPool } from "./connection-pool";
import { readMcpSession } from "./mcp-session";
import { recordMcpHealth } from "./mcp-health";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readSecret, saveSecret } from "./vault";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
type Config = { url: string; token?: string };
const allowed = new Set([
  "tdx_quotes",
  "tdx_kline",
  "tdx_lookup_stock",
  "tdx_indicator_select",
  "tdx_screener",
  "wenda_notice_query",
  "wenda_report_query",
  "wenda_news_query",
]);
export async function importLocalMcp() {
  const document = parse(
    await readFile(join(homedir(), ".codex", "config.toml"), "utf8"),
  ) as unknown as {
    mcp_servers?: Record<string, { args?: string[]; url?: string }>;
  };
  const source = document.mcp_servers?.["tdx-finance"];
  if (!source) throw new Error("未找到本机通达信 MCP 配置");
  const args = source.args ?? [],
    value = (flag: string) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };
  const url = source.url ?? value("--url");
  if (!url || new URL(url).hostname !== "txmcp.tdx.com.cn")
    throw new Error("本机配置不是已支持的通达信服务地址");
  let token: string | undefined;
  const tokenFile = value("--token-file");
  if (tokenFile) {
    const raw = (await readFile(tokenFile, "utf8")).trim();
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      token = String(data.access_token ?? data.token ?? "");
    } catch {
      token = raw;
    }
  }
  await saveSecret("mcp", { url, token });
  await closeMcp();
  return { configured: true };
}
export async function mcpConfigured() {
  return Boolean(
    process.env.TDX_MCP_URL || (await readSecret<Config>("mcp"))?.url,
  );
}
async function connectMcp(): Promise<Client> {
  const config = process.env.TDX_MCP_URL
    ? { url: process.env.TDX_MCP_URL, token: process.env.TDX_MCP_TOKEN }
    : await readSecret<Config>("mcp");
  if (!config) throw new Error("请先导入本机通达信 MCP 配置");
  const url = new URL(config.url);
  if (url.protocol !== "https:") throw new Error("MCP 仅允许 HTTPS");
  const headers: Record<string, string> = config.token
      ? { Authorization: `Bearer ${config.token}` }
      : {},
    client = new Client({ name: "quant-workbench", version: "0.1.0" });
  try {
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
        { timeout: 20000 },
      );
    } catch (error) {
      if ([401, 403].includes(Number((error as { code?: number })?.code)))
        throw error;
      await client.close().catch(() => {});
      await client.connect(
        new SSEClientTransport(url, {
          requestInit: { headers },
          eventSourceInit: {
            fetch: (input, init) =>
              fetch(input, {
                ...init,
                headers: {
                  ...headers,
                  ...Object.fromEntries(new Headers(init?.headers)),
                },
              }),
          },
        }),
        { timeout: 20000 },
      );
    }
    client.onclose = () => pool.disconnected(client);
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error("通达信 MCP 连接失败，请检查认证有效期和网络");
  }
}
const shared = globalThis as typeof globalThis & {
  quantMcpPool?: ConnectionPool<Client>;
};
const pool = (shared.quantMcpPool ??= new ConnectionPool(connectMcp));
export const closeMcp = () => pool.close();
export async function withMcp<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  try {
    return await pool.use(fn);
  } catch {
    // Do not replay arbitrary callbacks or retry authentication/parameter failures.
    throw new Error("通达信 MCP 连接或查询失败，请检查认证有效期、网络和参数");
  }
}
export async function mcpTools() {
  const startedAt = Date.now();
  try {
    const tools = await readMcp(async (client) =>
      (await client.listTools(undefined, { timeout: 25000 })).tools.filter(
        (t) => allowed.has(t.name),
      ),
    );
    recordMcpHealth(startedAt, tools);
    return tools;
  } catch (error) {
    recordMcpHealth(startedAt);
    throw error;
  }
}
async function readMcp<T>(
  request: (client: Client) => Promise<T>,
  signal?: AbortSignal,
) {
  try {
    return await readMcpSession(pool, request, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error("通达信 MCP 连接或查询失败，请检查认证有效期、网络和参数");
  }
}
export function cleanMcpResult(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(cleanMcpResult);
  if (result && typeof result === "object")
    return Object.fromEntries(
      Object.entries(result)
        .filter(
          ([key]) =>
            !/(token|authorization|api.?key|request|dataCard|dataFunction|surface|_meta|presentation)/i.test(
              key,
            ),
        )
        .map(([k, v]) => [k, cleanMcpResult(v)]),
    );
  if (typeof result === "string")
    return result.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return result;
}
export async function queryMcp(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!allowed.has(name)) throw new Error("未授权的数据工具");
  const result = await readMcp(
    (client) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: 25000,
        signal,
      }),
    signal,
  );
  if (result.isError) throw new Error("通达信数据工具返回错误");
  const data =
    result.structuredContent ??
    (Array.isArray(result.content)
      ? result.content.filter(
          (c) =>
            c.type === "text" &&
            typeof c.text === "string" &&
            !c.text.includes("[MCP App候选元数据]"),
        )
      : result);
  return cleanMcpResult(data);
}
