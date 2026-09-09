import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "./tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";

export const capitalEventProfiles = ["placement", "rights"] as const;
type Profile = (typeof capitalEventProfiles)[number];
const definitions = {
  placement: {
    预案公告日: ["增发预案日", "DATE", ""],
    进度: ["增发进度", "STR", ""],
    发行数量: ["增发发行数量", "LONG", "股"],
    上市日: ["增发上市日", "DATE", ""],
    最新公告日: ["增发最新公告日期", "DATE", ""],
  },
  rights: {
    预案公告日: ["历史配股预案公告日", "DATE", ""],
    进度: ["历史配股进度", "STR", ""],
    每股配股数量: ["历史每股配股数", "DOUBLE", "股"],
    股权登记日: ["历史配股股权登记日", "DATE", ""],
    上市日: ["历史配股上市日", "DATE", ""],
    除权日: ["历史配股除权日", "DATE", ""],
  },
} as const;
const pageSchema = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().min(0).max(1),
  row_count: z.number().int().nonnegative().optional(),
  datas: z.array(z.record(z.unknown())).max(10),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string().optional(),
        type: z.string().optional(),
        unit: z.string().optional(),
      }),
    )
    .min(1),
});
function identity(symbol: string, year: number, profile: Profile) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9998
  )
    throw new Error("资本事件需要A股证券与明确年度");
  z.enum(capitalEventProfiles).parse(profile);
}
export function capitalEventsEvidence(
  symbol: string,
  year: number,
  profile: Profile,
  query: string,
  rawPages: unknown[],
  fetchedAt: number,
): Evidence {
  identity(symbol, year, profile);
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
  )
    throw new Error("资本事件年度尚未结束");
  const today = new Date(fetchedAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const pages = z.array(pageSchema).min(1).max(20).parse(rawPages);
  if (
    pages.at(-1)!.datas.length === 10 ||
    pages.slice(0, -1).some((p) => p.datas.length !== 10)
  )
    throw new Error("资本事件分页未读完或不连续");
  const totals = new Set(
    pages.map((page) => page.row_count).filter((value) => value !== undefined),
  );
  if (
    totals.size > 1 ||
    (totals.size === 1 &&
      pages.reduce((sum, page) => sum + page.datas.length, 0) !==
        [...totals][0])
  )
    throw new Error("资本事件源端记录数与分页结果不一致");
  const fields = definitions[profile],
    selected = new Set(["股票代码", ...Object.keys(fields)]);
  const events: {
    planDate: string | null;
    listingDate: string | null;
    progress: string | null;
    issuedShares: number | null;
    rightsPerShare: number | null;
    listedInYear: boolean | null;
    sourceImplemented: boolean;
  }[] = [];
  const keys = new Set<string>();
  let emptyRows = 0;
  for (const page of pages) {
    const columns = page.columns.filter((c) => selected.has(c.key));
    if (
      JSON.stringify(columns) !==
      JSON.stringify(pages[0]!.columns.filter((c) => selected.has(c.key)))
    )
      throw new Error("资本事件分页字段发生变化");
    for (const [key, [index, type, unit]] of Object.entries(fields)) {
      const column = columns.find((c) => c.key === key);
      if (
        !column ||
        column.index_name !== index ||
        column.type !== type ||
        (column.unit ?? "") !== unit
      )
        throw new Error("资本事件字段定义或单位不匹配");
    }
    for (const row of page.datas) {
      if (
        row["股票代码"] !==
        `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
      )
        throw new Error("资本事件证券身份不匹配");
      validateHithinkColumns(row, page.columns);
      const values: Record<string, string | number | null> = {};
      for (const [key, [, type]] of Object.entries(fields)) {
        const value = row[key];
        if (value == null || value === "--") {
          values[key] = null;
          continue;
        }
        if (type === "DATE") {
          const day = String(value),
            date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
          const time = Date.parse(date);
          if (
            !/^\d{8}$/.test(day) ||
            !Number.isFinite(time) ||
            new Date(time).toISOString().slice(0, 10) !== date
          )
            throw new Error("资本事件日期无效");
          if (["预案公告日", "最新公告日"].includes(key) && day > today)
            throw new Error("公告日期晚于采集时点");
          values[key] = day;
        } else if (type === "STR") {
          if (typeof value !== "string" || !value.trim())
            throw new Error("资本事件进度无效");
          values[key] = value;
        } else {
          const numeric = Number(value);
          if (
            (typeof value !== "number" && typeof value !== "string") ||
            !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
              String(value).trim(),
            ) ||
            !Number.isFinite(numeric) ||
            numeric < 0 ||
            (type === "LONG" && !Number.isSafeInteger(numeric))
          )
            throw new Error("资本事件股数无效");
          values[key] = numeric;
        }
      }
      if (Object.values(values).every((v) => v === null)) {
        emptyRows++;
        continue;
      }
      const key = JSON.stringify(values);
      if (keys.has(key)) throw new Error("资本事件记录重复，不能推断分页完整");
      keys.add(key);
      const listingDate = values["上市日"] as string | null;
      if (
        listingDate &&
        values["预案公告日"] &&
        String(values["预案公告日"]) > listingDate
      )
        throw new Error("资本事件上市日早于预案公告日");
      events.push({
        planDate: values["预案公告日"] as string | null,
        listingDate,
        progress: values["进度"] as string | null,
        issuedShares:
          profile === "placement"
            ? (values["发行数量"] as number | null)
            : null,
        rightsPerShare:
          profile === "rights"
            ? (values["每股配股数量"] as number | null)
            : null,
        listedInYear:
          listingDate === null
            ? null
            : listingDate >= `${year}0101` &&
              listingDate <= `${year}1231` &&
              listingDate <= today,
        sourceImplemented: values["进度"] === "已实施",
      });
    }
  }
  const missing = [
    "源端事件覆盖和原始公告尚未完整核验，不能据无记录证明全年未发行新股",
    "上市日不是发行完成日；预案、配股比例、期末股本均不能替代实际全年发行股数",
  ];
  if (!events.length)
    missing.push("响应没有可用的资本事件字段，不能视为已核验的零事件");
  if (events.some((e) => e.listedInYear === null))
    missing.push("部分事件上市日缺失，无法归入年度上市统计");
  const payload = {
    version: "capital-events-1",
    symbol,
    year,
    profile,
    query,
    pages: pages.map((page) => ({
      ...page,
      columns: page.columns.filter((c) => selected.has(c.key)),
      datas: page.datas.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => selected.has(key)),
        ),
      ),
    })),
    facts: {
      events,
      emptyRows,
      listedInYearCount: events.filter(
        (e) => e.listedInYear && e.sourceImplemented,
      ).length,
      absenceVerified: false,
      noEquityOffering: null,
      missing,
    },
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-event-query",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      Object.entries(fields)
        .filter(([, d]) => d[2])
        .map(([key, d]) => [key, d[2]]),
    ),
    adjustment: "not-applicable",
    reportPeriod: `${year}1231`,
    quality: "partial",
    warnings: [
      "资料来源：同花顺问财。增发与配股分开，公告日、登记日、除权日、上市日保留各自含义。",
      "当前事件档案不证明当时数据可用，不倒填历史回测；不计算F-Score未增发得分或治理评级。",
      "股数与每股配股比例不同，不能将配股比例当作实际发行总股数。",
    ],
  });
  return {
    id: `capital-events-${envelope.payloadHash}`,
    source: "同花顺问财 / 资本事件",
    asOf: `${year}年度上市事件复核，覆盖未核验`,
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryCapitalEvents(
  symbol: string,
  year: number,
  profile: Profile,
  signal?: AbortSignal,
) {
  identity(symbol, year, profile);
  return shared(
    `${symbol}:${year}:${profile}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      const deadline = AbortSignal.any([upstream, AbortSignal.timeout(60000)]);
      const query = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()} 股票代码 股票简称 ${year}年 ${profile === "placement" ? "增发" : "配股"}`;
      const pages: unknown[] = [],
        seen = new Set<string>();
      for (let page = 1; page <= 20; page++) {
        deadline.throwIfAborted();
        const raw = pageSchema.parse(
          await request("hithink-event-query", query, deadline, page, 10),
        );
        deadline.throwIfAborted();
        const selected = new Set([
          "股票代码",
          ...Object.keys(definitions[profile]),
        ]);
        const key = JSON.stringify(
          raw.datas.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([k]) => selected.has(k)),
            ),
          ),
        );
        if (seen.has(key)) throw new Error("资本事件分页重复");
        seen.add(key);
        pages.push(raw);
        if (raw.datas.length < 10)
          return capitalEventsEvidence(
            symbol,
            year,
            profile,
            query,
            pages,
            Date.now(),
          );
      }
      throw new Error("资本事件超过分页上限，未返回截断资料");
    },
    signal,
  );
}
