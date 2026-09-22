import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  mxKinds,
  mxQueryPlan,
  mxScopeWarnings,
  type MxQueryInput,
} from "~/lib/mx-data";

export const MX_VERSION = "mx-data-2";
const endpoint = "https://mxapi.eastmoney.com/mxds/mcp";

// Consume only connection fields from the existing local configuration. Never execute its command.
export function mxConnection(
  document: unknown,
  env: Record<string, string | undefined> = process.env,
) {
  const config = z
    .object({ mcp_servers: z.record(z.unknown()) })
    .parse(document);
  const entry = z
    .object({
      enabled: z.boolean().optional(),
      url: z.string().optional(),
      args: z.array(z.string()).optional(),
      http_headers: z.record(z.string()).optional(),
      env_http_headers: z.record(z.string()).optional(),
      bearer_token_env_var: z.string().optional(),
    })
    .parse(config.mcp_servers["mx-ds-mcp"]);
  if (entry.enabled === false) throw new Error("东方财富 MCP 已在本地配置停用");
  const args = entry.args ?? [];
  const position = args.indexOf("--url");
  if (
    (entry.url ?? (position >= 0 ? args[position + 1] : undefined)) !== endpoint
  )
    throw new Error("东方财富 MCP 地址不在支持范围内");
  const headers: Record<string, string> = {};
  function add(name: string, value: string) {
    const key = name.trim().toLowerCase();
    if (["em_api_key", "authorization"].includes(key) && value.trim())
      headers[key] = value.trim();
  }
  for (const [name, value] of Object.entries(entry.http_headers ?? {}))
    add(name, value);
  for (const [name, variable] of Object.entries(entry.env_http_headers ?? {}))
    add(name, env[variable] ?? "");
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--header") {
      const value = args[i + 1] ?? "",
        colon = value.indexOf(":");
      if (colon > 0) add(value.slice(0, colon), value.slice(colon + 1));
    }
  if (entry.bearer_token_env_var && env[entry.bearer_token_env_var])
    add("authorization", `Bearer ${env[entry.bearer_token_env_var]}`);
  if (!Object.keys(headers).length)
    throw new Error("东方财富 MCP 缺少可用授权，请在 Codex 本地完成配置");
  return { url: endpoint, headers };
}
async function connection() {
  try {
    return mxConnection(
      parse(await readFile(join(homedir(), ".codex", "config.toml"), "utf8")),
    );
  } catch {
    throw new Error(
      "东方财富 MCP 配置不可用，请检查 Codex 的 mx-ds-mcp 地址、启用状态与授权",
    );
  }
}
export async function mxDataStatus() {
  try {
    await connection();
    return { configured: true };
  } catch {
    return { configured: false };
  }
}

export function parseMxResponse(raw: unknown) {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .parse(raw);
  if (result.isError) throw new Error("东方财富 MCP 工具执行失败");
  if (
    result.content.length !== 1 ||
    result.content[0]?.type !== "text" ||
    !result.content[0].text
  )
    throw new Error("东方财富 MCP 响应结构不支持");
  const text = result.content[0].text;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("东方财富 MCP 响应超过2MB限制");
  // The live server omits message on success; retain supplied messages and the original data.
  const payload = z
    .object({
      message: z.string().default(""),
      data: z.array(z.unknown()).max(1000),
    })
    .parse(JSON.parse(text));
  return {
    status: payload.data.length
      ? payload.message
        ? "with-message"
        : "ok"
      : payload.message
        ? "error"
        : "empty",
    ...payload,
  };
}
type Execute = (
  tool: string,
  query: string,
  signal?: AbortSignal,
) => Promise<unknown>;
export async function executeMx(
  tool: string,
  query: string,
  signal?: AbortSignal,
) {
  if (
    !Object.values(mxKinds).some((entry) => entry.tool === tool) ||
    !query.trim()
  )
    throw new Error("东方财富 MCP 工具或问句不在支持范围内");
  const config = await connection();
  const client = new Client({ name: "quant-mx-data", version: MX_VERSION });
  const deadline = AbortSignal.timeout(65000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const abort = () => {
    void client.close().catch(() => {});
  };
  active.addEventListener("abort", abort, { once: true });
  try {
    active.throwIfAborted();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers, signal: active },
      }),
      { timeout: 15000 },
    );
    active.throwIfAborted();
    return await client.callTool(
      { name: tool, arguments: { query } },
      undefined,
      { timeout: 50000, signal: active },
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("东方财富 MCP 查询超时");
    if (error instanceof StreamableHTTPError && error.code === 401)
      throw new Error("东方财富 MCP 授权失效，请在 Codex 更新授权；本次不重试");
    throw new Error("东方财富 MCP 连接或请求失败，本次未重试");
  } finally {
    active.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
export async function queryMxData(
  input: MxQueryInput,
  signal?: AbortSignal,
  execute: Execute = executeMx,
) {
  const plan = mxQueryPlan(input);
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const raw = await execute(plan.tool, plan.query, signal);
  signal?.throwIfAborted();
  let parsed: ReturnType<typeof parseMxResponse>;
  try {
    parsed = parseMxResponse(raw);
  } catch {
    throw new Error("东方财富 MCP 返回错误或无法识别的数据，未转换为行情");
  }
  const scopeWarnings = mxScopeWarnings(input, parsed.data);
  return {
    ...parsed,
    scopeWarnings,
    status:
      scopeWarnings.length && parsed.status === "ok"
        ? ("with-message" as const)
        : parsed.status,
    source: "eastmoney/mx-ds-mcp" as const,
    version: MX_VERSION,
    tool: plan.tool,
    query: plan.query,
    startedAt,
    fetchedAt: Date.now(),
    hash: createHash("sha256")
      .update(
        JSON.stringify({
          version: MX_VERSION,
          ...plan,
          ...parsed,
          scopeWarnings,
        }),
      )
      .digest("hex"),
    limitation:
      "服务端自然语言查询结果，可能取整或包含额外指标；复权和单位以原表为准，未接入K线拼接、RPS或策略计算。",
  };
}
