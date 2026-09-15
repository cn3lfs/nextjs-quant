import { z } from "zod";

// Keep the persisted "pytdx" key compatible; its display name is tstdx.
export const marketSourceSchema = z.enum([
  "auto",
  "local",
  "pytdx",
  "eastmoney",
  "tencent",
]);
export type MarketSource = z.infer<typeof marketSourceSchema>;
export const marketSourceLabels: Record<MarketSource, string> = {
  auto: "自动",
  local: "通达信本地",
  pytdx: "tstdx",
  tencent: "腾讯自选股",
  eastmoney: "东方财富",
};
export function marketSourceLabel(source: string) {
  return (
    (
      {
        "tdx-local": "本地文件（vipdoc）",
        "tdx-7709": "tstdx（自定义 TDX）",
        "tencent/westock-data": "westock-data（腾讯自选股）",
        "eastmoney-online": "东方财富",
        "tdx-mcp": "已停用来源（历史快照）",
      } as Record<string, string>
    )[source] ?? source
  );
}
