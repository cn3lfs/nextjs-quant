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

/** 只核对明确的结构字段，不从自然语言摘要推断日期，也不裁剪原表。 */
export function mxScopeWarnings(input: MxQueryInput, data: unknown[]) {
  if (input.kind !== "news" && input.kind !== "notice") return [];
  const range = input.timeRange.match(
    /^(\d{4}-\d{2}-\d{2})(?:至(\d{4}-\d{2}-\d{2}))?$/,
  );
  let outside = 0,
    mismatched = 0;
  for (const raw of data) {
    const parsed = mxTableSchema.safeParse(raw);
    if (!parsed.success) continue;
    const table = parsed.data;
    const dateColumn = table.columns.indexOf("发布时间");
    const typeColumn = table.columns.indexOf("信息类型");
    for (const row of table.items) {
      const date = String(row[dateColumn] ?? "").slice(0, 10);
      if (
        range &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        (date < range[1]! || date > (range[2] ?? range[1]!))
      )
        outside++;
      const type = String(row[typeColumn] ?? "");
      if (
        type &&
        (input.kind === "news" ? type === "NOTICE" : type !== "NOTICE")
      )
        mismatched++;
    }
  }
  return [
    ...(outside
      ? [`返回 ${outside} 条记录的发布时间不在请求区间内，原表已保留。`]
      : []),
    ...(mismatched
      ? [
          `返回 ${mismatched} 条记录的信息类型与所选查询类别不符，不能当作该类别结果。`,
        ]
      : []),
  ];
}
