import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "./tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";

export const businessProfiles = ["segments", "customers"] as const;
export type BusinessProfile = (typeof businessProfiles)[number];
const pageSchema = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  datas: z.array(z.record(z.unknown())).max(10),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string().optional(),
        unit: z.string().optional(),
        timestamp: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .min(1),
});
function identity(symbol: string, year: number) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9998
  )
    throw new Error("经营资料需要A股证券及明确年度");
}
export function businessEvidence(
  symbol: string,
  year: number,
  profile: BusinessProfile,
  query: string,
  rawPages: unknown[],
  fetchedAt: number,
): Evidence {
  identity(symbol, year);
  z.enum(businessProfiles).parse(profile);
  const period = `${year}1231`;
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
  )
    throw new Error("经营资料年度尚未结束");
  const pages = z.array(pageSchema).min(1).max(20).parse(rawPages);
  if (
    pages.at(-1)!.datas.length === 10 ||
    pages.slice(0, -1).some((p) => p.datas.length !== 10)
  )
    throw new Error("经营资料分页未完整结束");
  const rows = pages.flatMap((p) => p.datas);
  if (!rows.length) throw new Error("经营资料为空");
  const keys = new Set<string>();
  const canonicalColumns = JSON.stringify(pages[0]!.columns);
  for (const page of pages) {
    if (JSON.stringify(page.columns) !== canonicalColumns)
      throw new Error("经营资料分页字段不一致");
    for (const row of page.datas) {
      if (
        row["股票代码"] !==
        `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
      )
        throw new Error("经营资料证券身份不匹配");
      validateHithinkColumns(row, page.columns);
      if (profile === "segments") {
        if (
          row["报告期截止日"] !== period ||
          !["行业", "产品", "地区"].includes(String(row["分类标准"])) ||
          typeof row["项目名称"] !== "string" ||
          !row["项目名称"].trim()
        )
          throw new Error("主营构成年度或分类项目不明确");
        const key = JSON.stringify([period, row["分类标准"], row["项目名称"]]);
        if (keys.has(key))
          throw new Error("主营构成明细重复，不能推断分页完整");
        keys.add(key);
        for (const [field, unit] of [
          ["业务收入", "元"],
          ["收入占比", "%"],
        ]) {
          const column = page.columns.find(
            (c) => c.key === field && c.unit === unit && c.type === "DOUBLE",
          );
          const value = row[field!];
          if (
            !column ||
            (typeof value !== "number" && typeof value !== "string") ||
            String(value).trim() === "" ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0 ||
            (field === "收入占比" && Number(value) > 100)
          )
            throw new Error("主营构成收入或占比单位、数值缺失");
        }
      }
    }
  }
  if (profile === "customers") {
    const column = pages[0]!.columns.find(
      (c) =>
        c.index_name === "客户销售额合计占比(前五大)" &&
        c.key === `销售额占比[${period}]` &&
        c.timestamp === period &&
        c.unit === "%",
    );
    const value = column ? rows[0]![column.key] : undefined;
    if (
      rows.length !== 1 ||
      !column ||
      (typeof value !== "number" && typeof value !== "string") ||
      String(value).trim() === "" ||
      !Number.isFinite(Number(value)) ||
      Number(value) < 0 ||
      Number(value) > 100
    )
      throw new Error("前五大客户销售占比口径或数值缺失");
  }
  // Retain declared financial columns and the observed row-level report date only.
  const allowed = new Set([
    ...pages[0]!.columns.map((c) => c.key),
    "股票代码",
    "报告期截止日",
  ]);
  const payload = {
    version: "business-1",
    symbol,
    year,
    profile,
    query,
    pages: pages.map((p) => ({
      ...p,
      datas: p.datas.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => allowed.has(key)),
        ),
      ),
    })),
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-business-query",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      pages[0]!.columns.filter((c) => c.unit).map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: period,
    quality: "partial",
    warnings: [
      "资料来源：同花顺问财。年度为报告期，不是公告日，不能用于历史时点回测。",
      "行业、产品、地区为不同分类，禁止跨分类累加收入；元单位不自动证明币种。",
      "按页读取至不足10行；证券计数不代表明细数，源端遗漏无法独立证明不存在。",
      "客户占比不是客户名单；当前接口附带报价没有可靠时点，不用于估值或覆盖日线价格。",
    ],
  });
  return {
    id: `business-${envelope.payloadHash}`,
    source: "同花顺问财 / 经营资料",
    asOf: `${period}报告期，披露日未核验`,
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryBusiness(
  symbol: string,
  year: number,
  profile: BusinessProfile,
  signal?: AbortSignal,
) {
  identity(symbol, year);
  return shared(
    `${symbol}:${year}:${profile}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      const deadline = AbortSignal.any([upstream, AbortSignal.timeout(60000)]);
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const query = `${code} 股票代码 股票简称 ${year}年 ${profile === "segments" ? "主营业务构成" : "前五大客户销售占比"}`;
      const pages: unknown[] = [];
      for (let page = 1; page <= 20; page++) {
        deadline.throwIfAborted();
        const raw = await request(
          "hithink-business-query",
          query,
          deadline,
          page,
          10,
        );
        deadline.throwIfAborted();
        const parsed = pageSchema.parse(raw);
        pages.push(parsed);
        if (parsed.datas.length < 10)
          return businessEvidence(
            symbol,
            year,
            profile,
            query,
            pages,
            Date.now(),
          );
        // Fail repeated pages immediately instead of burning all remaining requests.
        if (
          pages
            .slice(0, -1)
            .some(
              (p) =>
                JSON.stringify(pageSchema.parse(p).datas) ===
                JSON.stringify(parsed.datas),
            )
        )
          throw new Error("经营资料接口重复返回同页");
      }
      throw new Error("经营资料超过分页上限，未采用不完整数据");
    },
    signal,
  );
}
