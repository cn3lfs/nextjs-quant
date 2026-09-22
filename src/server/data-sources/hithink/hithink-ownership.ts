import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "../tdx/tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "../../infra/evidence";
import { sharedRead } from "../../infra/shared-read";

export const ownershipProfiles = ["control", "annual-capital"] as const;
export type OwnershipProfile = (typeof ownershipProfiles)[number];
const responseSchema = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  datas: z.array(z.record(z.unknown())).length(1),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string().optional(),
        type: z.string().optional(),
        unit: z.string().optional(),
        timestamp: z.string().optional(),
      }),
    )
    .min(1),
});
function identity(symbol: string, year: number, profile: OwnershipProfile) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9998
  )
    throw new Error("股权资料需要A股证券及明确年度");
  z.enum(ownershipProfiles).parse(profile);
}
export function ownershipEvidence(
  symbol: string,
  year: number,
  profile: OwnershipProfile,
  query: string,
  raw: unknown,
  fetchedAt: number,
): Evidence {
  identity(symbol, year, profile);
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
  )
    throw new Error("股权资料年度尚未结束");
  const response = responseSchema.parse(raw),
    row = response.datas[0]!;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("股权资料证券身份不匹配");
  validateHithinkColumns(row, response.columns);
  const selected = new Set(["股票代码"]);
  const field = (
    key: string,
    index: string,
    type: string,
    unit?: string,
    timestamp?: string,
  ) => {
    const column = response.columns.find(
      (c) =>
        c.key === key &&
        c.index_name === index &&
        c.type === type &&
        (unit === undefined || c.unit === unit) &&
        (timestamp === undefined || c.timestamp === timestamp),
    );
    if (!column) throw new Error(`股权字段口径不匹配：${key}`);
    selected.add(key);
    return row[key];
  };
  const text = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value === "--")
      throw new Error("股权文本资料缺失");
    return value;
  };
  const numeric = (value: unknown, min: number, max: number) => {
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
        String(value).trim(),
      ) ||
      !Number.isFinite(Number(value)) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error("股权数值资料无效");
    return Number(value);
  };
  const period = `${year}1231`;
  let facts: Record<string, unknown>;
  if (profile === "control") {
    const types = field("类型", "机构持股类型(虚拟表)", "ARRAY");
    if (!Array.isArray(types) || !types.includes("控股股东"))
      throw new Error("来源未明确标识控股股东");
    const holdingDate = text(field("截止日期", "交易日期", "DATE"));
    const date = Date.parse(
      `${holdingDate.slice(0, 4)}-${holdingDate.slice(4, 6)}-${holdingDate.slice(6, 8)}T00:00:00+08:00`,
    );
    if (date > fetchedAt) throw new Error("股东持仓日期晚于抓取时点");
    facts = {
      controllingShareholder: text(
        field("股东名称", "持股机构名称明细", "STR"),
      ),
      actualController: text(field("实际控制人", "实际控制人(虚拟表)", "STR")),
      enterpriseNature: text(field("企业性质", "企业性质", "STR")),
      holdingDate,
      floatingSharePercent: numeric(
        field(
          `持股占流通股比例[${holdingDate}]`,
          "机构本期持股占流通股比例明细",
          "DOUBLE",
          "%",
          holdingDate,
        ),
        0,
        100,
      ),
      controlIdentityAsOf: null,
    };
  } else {
    const totalShares = numeric(
      field(`总股本[${period}]`, "总股本", "DOUBLE", "股", period),
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (!Number.isSafeInteger(totalShares))
      throw new Error("总股本必须为可精确表示的整数股");
    facts = {
      period,
      totalShares,
      topTenSharePercent: numeric(
        field(
          `持股比例[${period}]`,
          "前十大股东持股比例合计(报告期)",
          "DOUBLE",
          "%",
          period,
        ),
        0,
        100,
      ),
    };
  }
  const payload = {
    version: "ownership-1",
    symbol,
    year,
    profile,
    query,
    response: {
      ...response,
      columns: response.columns.filter((c) => selected.has(c.key)),
      datas: [
        Object.fromEntries(
          Object.entries(row).filter(([key]) => selected.has(key)),
        ),
      ],
    },
    facts,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-management-query",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      payload.response.columns
        .filter((c) => c.unit)
        .map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: profile === "annual-capital" ? period : null,
    quality: "partial",
    warnings: [
      "资料来源：同花顺问财；控股身份/实控人当前抓取时点与股东持仓日期分别保留，不等同公告日。",
      "占流通股比例与占总股本比例口径不同，不能直接比较或相加。年度总股本不是当前股本，不能自动填入每股估值。",
      "股权结构不等同治理质量；没有覆盖董事履历、关联交易、质押、发行及违法违规事件，不证明没有风险。",
      "仅当前研究使用，不能把当前股权身份回填历史回测；不从股本变化推断有无新股发行。",
    ],
  });
  return {
    id: `ownership-${envelope.payloadHash}`,
    source: "同花顺问财 / 股东股本",
    asOf:
      profile === "annual-capital"
        ? `${period}报告期，披露日未核验`
        : "控股资料当前抓取，身份生效日未核验",
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryOwnership(
  symbol: string,
  year: number,
  profile: OwnershipProfile,
  signal?: AbortSignal,
) {
  identity(symbol, year, profile);
  return shared(
    `${symbol}:${year}:${profile}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      upstream.throwIfAborted();
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const query = `${code} 股票代码 股票简称 ${profile === "control" ? "控股股东 实际控制人 企业性质" : `${year}年 前十大股东持股比例 总股本`}`;
      const response = await request(
        "hithink-management-query",
        query,
        upstream,
      );
      upstream.throwIfAborted();
      return ownershipEvidence(
        symbol,
        year,
        profile,
        query,
        response,
        Date.now(),
      );
    },
    signal,
  );
}
