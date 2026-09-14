import { createHash } from "node:crypto";
import { z } from "zod";
import { mcpTools, queryMcp } from "./tdx-mcp-disabled";
import { background } from "./jobs";
import { get } from "./db";
import type { Coverage } from "~/lib/domain";
import { isAStock } from "./tdx";
const payloadSchema = z.object({
  meta: z.object({
    code: z.number(),
    total: z.number().int().nonnegative(),
    pageNo: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    query: z.string().optional(),
    rang: z.string().optional(),
  }),
  headers: z.array(z.string()).max(100),
  data: z.array(z.record(z.unknown())).max(20),
  summary: z.string().optional(),
});
export function normalizeOnlineScreen(
  raw: unknown,
  query: string,
  page: number,
  schema: unknown,
) {
  const parsed = payloadSchema.parse(raw);
  if (
    parsed.meta.code !== 0 ||
    parsed.meta.pageNo !== page ||
    parsed.meta.pageSize !== 20 ||
    parsed.meta.rang !== "AG"
  )
    throw new Error("在线筛选状态、分页或市场范围与请求不一致");
  const warnings = [
    "在线自然语言条件由服务端解释，尚未逐项核验；区间指标与当日指标可能不同。",
    "在线结果与本地行情可能存在时点、复权及单位差异，不能直接用作历史回测信号。",
  ];
  const rows = parsed.data.map((row, index) => {
    const code = String(row.sec_code ?? ""),
      market = String(row.market ?? "");
    const inferred = /^(60|68)\d{4}$/.test(code)
      ? "sh"
      : /^(00|30)\d{4}$/.test(code)
        ? "sz"
        : /^(43|83|87|88|92)\d{4}$/.test(code)
          ? "bj"
          : null;
    const expectedMarket =
      inferred === "sh" ? "1" : inferred === "sz" ? "0" : "2";
    const symbol =
      inferred && market === expectedMarket && isAStock(inferred + code)
        ? inferred + code
        : null;
    return {
      index: (page - 1) * 20 + index + 1,
      symbol,
      name: String(row.sec_name ?? "名称待核验"),
      identityWarning: symbol
        ? null
        : "证券类型或市场标识不一致，禁止导入本地 A 股池",
      values: row,
    };
  });
  const columns = parsed.headers.map((key) => ({
    key,
    label: key.replace(/<br\s*\/?>/gi, " · "),
    dates: [...new Set(key.match(/\d{4}\.\d{2}\.\d{2}/g) ?? [])],
    unit: key.match(/[（(](元|手|股|%|倍)[）)]/)?.[1] ?? null,
    adjustment: key.includes("前复权")
      ? "前复权"
      : key.includes("后复权")
        ? "后复权"
        : "未声明",
  }));
  return {
    query,
    providerQuery: parsed.meta.query ?? null,
    page,
    pageSize: 20,
    total: parsed.meta.total,
    source: "tdx_screener",
    fetchedAt: Date.now(),
    sourceDates: [...new Set(columns.flatMap((c) => c.dates))],
    columns,
    rows,
    summary: parsed.summary ?? "",
    warnings,
    schema,
    payloadHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  };
}
export type OnlineScreenResult = ReturnType<typeof normalizeOnlineScreen> & {
  localCoverage: { symbol: string; day: boolean; minute: boolean }[];
};
export function onlineScreenJob(query: string, page: number) {
  return background(
    "online-screen",
    { query, page },
    async (_, signal): Promise<OnlineScreenResult> => {
      const tool = (await mcpTools()).find((t) => t.name === "tdx_screener");
      if (!tool) throw new Error("通达信服务未提供在线筛选工具");
      signal.throwIfAborted();
      const data = await queryMcp(
        "tdx_screener",
        { message: query, rang: "AG", pageNo: String(page), pageSize: "20" },
        signal,
      );
      const result = normalizeOnlineScreen(data, query, page, tool.inputSchema);
      const coverage = get<Coverage>("coverage");
      return {
        ...result,
        localCoverage: result.rows
          .filter((row) => row.symbol)
          .map((row) => ({
            symbol: row.symbol!,
            day: !!coverage?.securities.some(
              (s) => s.symbol === row.symbol && s.period === "day",
            ),
            minute: !!coverage?.securities.some(
              (s) => s.symbol === row.symbol && s.period === "5m",
            ),
          })),
      };
    },
    { query, page },
  );
}
