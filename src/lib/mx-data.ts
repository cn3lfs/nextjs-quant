import { z } from "zod";

export const mxKinds = {
  ashare: { label: "A股", tool: "mx_ashare_finance_data" },
  fund: { label: "基金 / ETF", tool: "mx_fund_finance_data" },
  bond: { label: "债券", tool: "mx_bond_finance_data" },
  index: { label: "指数 / 板块", tool: "mx_index_block_finance_data" },
  hk: { label: "港股", tool: "mx_hk_finance_data" },
  us: { label: "美股", tool: "mx_us_finance_data" },
  comprehensive: {
    label: "其他主体 / 非上市企业",
    tool: "mx_comprehensive_finance_data",
  },
  macro: { label: "宏观 / 行业经济", tool: "mx_macro_data" },
  screener: { label: "同品种证券筛选", tool: "mx_stocks_screener" },
  news: { label: "新闻 / 研报", tool: "mx_finance_search_news" },
  notice: { label: "公告 / 披露", tool: "mx_finance_search_notice" },
} as const;
export type MxKind = keyof typeof mxKinds;
export const mxQuerySchema = z
  .object({
    kind: z.enum([
      "ashare",
      "fund",
      "bond",
      "index",
      "hk",
      "us",
      "comprehensive",
      "macro",
      "screener",
      "news",
      "notice",
    ]),
    subjects: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(500)
      .refine((values) => new Set(values).size === values.length, "标的重复"),
    request: z.string().trim().min(1).max(2000),
    timeRange: z.string().trim().min(1).max(120),
  })
  .strict();
export type MxQueryInput = z.infer<typeof mxQuerySchema>;
export const mxTableSchema = z.object({
  sheetName: z.string(),
  columns: z.array(z.string()).min(1),
  items: z.array(
    z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  ),
});
export function mxQueryPlan(input: MxQueryInput) {
  const value = mxQuerySchema.parse(input);
  return {
    tool: mxKinds[value.kind].tool,
    query: `查询类别：${mxKinds[value.kind].label}。标的或范围：${value.subjects.join("、")}。时间范围：${value.timeRange}。查询内容：${value.request}`,
  };
}
