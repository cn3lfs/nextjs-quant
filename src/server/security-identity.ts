import { queryMcp, mcpConfigured } from "./mcp";
import { searchTencentIdentity } from "./tencent-identity";
import { get, put } from "./db";
import { mergeVerifiedSecurityName } from "./securities";
import { symbolSchema } from "~/lib/domain";
import { isAStock } from "./tdx";
export function checkTdxIdentity(data: unknown, symbol: string) {
  const rows = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(rows))
    return {
      status: "unavailable" as const,
      reason: "通达信身份返回结构未识别",
    };
  const matches = rows.filter(
    (
      row,
    ): row is {
      code: string;
      name: string;
      type: string;
      setcode: string | number;
    } =>
      !!row &&
      typeof row === "object" &&
      String((row as { code?: unknown }).code) === symbol.slice(2),
  );
  if (matches.length !== 1)
    return {
      status: "unavailable" as const,
      reason: "通达信没有唯一同代码记录",
    };
  const row = matches[0]!,
    expected = symbol.startsWith("sh") ? 1 : symbol.startsWith("sz") ? 0 : 2;
  return {
    status:
      row.type === "A股代码" && Number(row.setcode) === expected
        ? ("confirmed" as const)
        : ("conflict" as const),
    name: String(row.name ?? ""),
    reportedMarket: String(row.setcode),
    reportedType: String(row.type),
    reason:
      row.type === "A股代码" && Number(row.setcode) === expected
        ? "代码、A股类型和市场一致"
        : "同代码的证券类型或市场标识冲突",
  };
}
export type IdentityCheck = {
  symbol: string;
  status: "confirmed" | "partial" | "conflict" | "unavailable";
  name?: string;
  checkedAt: number;
  tencent?: Awaited<ReturnType<typeof searchTencentIdentity>>;
  tdx?: ReturnType<typeof checkTdxIdentity>;
  reason: string;
};
const inflight = new Map<string, Promise<IdentityCheck>>();
export async function verifySecurityIdentity(
  symbol: string,
): Promise<IdentityCheck> {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股身份核验");
  const cached = get<IdentityCheck>(`identity-${symbol}`);
  if (
    cached &&
    Date.now() - cached.checkedAt <
      (cached.status === "confirmed" ? 86400000 : 3600000)
  ) {
    if (
      cached.name &&
      (cached.status === "confirmed" || cached.status === "partial")
    )
      await mergeVerifiedSecurityName(symbol, cached.name);
    return cached;
  }
  const active = inflight.get(symbol);
  if (active) return active;
  const pending = (async () => {
    let result: IdentityCheck = {
      symbol,
      status: "unavailable",
      checkedAt: Date.now(),
      reason: "未完成身份核验",
    };
    try {
      const tencent = await searchTencentIdentity(symbol);
      let tdx: ReturnType<typeof checkTdxIdentity> = {
        status: "unavailable",
        reason: "通达信 MCP 未配置",
      };
      if (await mcpConfigured()) {
        try {
          tdx = checkTdxIdentity(
            await queryMcp("tdx_lookup_stock", {
              query: symbol.slice(2),
              range: "AG",
            }),
            symbol,
          );
        } catch {
          tdx = { status: "unavailable", reason: "通达信交叉核验失败" };
        }
      }
      const namesConflict =
        tdx.status === "confirmed" && tdx.name !== tencent.name;
      const status =
        tdx.status === "conflict" || namesConflict
          ? "conflict"
          : tdx.status === "confirmed"
            ? "confirmed"
            : "partial";
      result = {
        symbol,
        name: tencent.name,
        status,
        tencent,
        tdx,
        checkedAt: Date.now(),
        reason: namesConflict
          ? "两来源名称不一致，保留冲突待核验"
          : status === "partial"
            ? "腾讯身份已确认，通达信交叉核验未完成"
            : tdx.reason,
      };
      if (status === "confirmed" || status === "partial")
        await mergeVerifiedSecurityName(symbol, tencent.name);
    } catch (error) {
      result.reason =
        error instanceof Error ? error.message : "腾讯身份核验失败";
    }
    return put("security-identity", `identity-${symbol}`, result);
  })();
  inflight.set(symbol, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(symbol) === pending) inflight.delete(symbol);
  }
}
