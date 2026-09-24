import { get, put } from "../db";
import { evidenceEnvelope } from "../infra/evidence";
import type { Evidence } from "~/lib/domain";
import {
  datacenterQuery,
  dcDay,
  dcNum,
  dcText,
} from "../data-sources/eastmoney/em-datacenter";

/**
 * 个股资金面：融资融券、大宗交易、股东户数、龙虎榜。东方财富数据中心，串行限流。
 * 报表与字段参考 simonlin1212/a-stock-data §3.5 / §4.1–4.3（Apache-2.0）。
 * 金额单位元，股数单位股。
 */
export const CAPITAL_PROFILE_VERSION = "capital-profile-1";

export type CapitalProfile = {
  version: string;
  symbol: string;
  fetchedAt: number;
  margin: {
    date: string;
    financingBalance: number | null;
    financingNetBuy: number | null;
    lendingBalance: number | null;
    /** 融资余额占流通市值 %。 */
    financingRatio: number | null;
  }[];
  blockTrades: {
    date: string;
    price: number | null;
    /** 相对收盘价的溢价率 %。 */
    premiumPct: number | null;
    amount: number | null;
    buyer: string | null;
    seller: string | null;
  }[];
  holders: {
    date: string;
    count: number | null;
    changePct: number | null;
    avgShares: number | null;
  }[];
  billboard: {
    date: string;
    reason: string | null;
    netBuy: number | null;
    changePct: number | null;
  }[];
  failures: { part: "margin" | "blockTrades" | "holders" | "billboard"; message: string }[];
};

const TTL_MS = 30 * 60000;
const addDays = (days: number) =>
  new Date(Date.now() + 8 * 3600000 + days * 86400000).toISOString().slice(0, 10);

export async function capitalProfile(
  symbol: string,
  signal?: AbortSignal,
): Promise<CapitalProfile> {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) throw new Error("仅支持沪深北 A 股代码");
  const id = `capital-profile:${symbol}`;
  const cached = get<CapitalProfile>(id);
  if (
    cached?.version === CAPITAL_PROFILE_VERSION &&
    Date.now() - cached.fetchedAt < TTL_MS
  )
    return cached;
  const code = symbol.slice(2);
  const result: CapitalProfile = {
    version: CAPITAL_PROFILE_VERSION,
    symbol,
    fetchedAt: Date.now(),
    margin: [],
    blockTrades: [],
    holders: [],
    billboard: [],
    failures: [],
  };
  const parts: [CapitalProfile["failures"][number]["part"], () => Promise<void>][] = [
    [
      "margin",
      async () => {
        const rows = await datacenterQuery(
          { report: "RPTA_WEB_RZRQ_GGMX", filter: `(SCODE="${code}")`, sortColumns: "DATE", pageSize: 20 },
          signal,
        );
        result.margin = rows.flatMap((r) => {
          const date = dcDay(r, "DATE");
          return date
            ? [{
                date,
                financingBalance: dcNum(r, "RZYE"),
                financingNetBuy: dcNum(r, "RZJME"),
                lendingBalance: dcNum(r, "RQYE"),
                financingRatio: dcNum(r, "RZYEZB"),
              }]
            : [];
        });
      },
    ],
    [
      "blockTrades",
      async () => {
        const rows = await datacenterQuery(
          {
            report: "RPT_DATA_BLOCKTRADE",
            filter: `(SECURITY_CODE="${code}")(TRADE_DATE>='${addDays(-180)}')`,
            sortColumns: "TRADE_DATE",
            pageSize: 20,
          },
          signal,
        );
        result.blockTrades = rows.flatMap((r) => {
          const date = dcDay(r, "TRADE_DATE");
          const premium = dcNum(r, "PREMIUM_RATIO");
          return date
            ? [{
                date,
                price: dcNum(r, "DEAL_PRICE"),
                premiumPct: premium == null ? null : premium * 100,
                amount: dcNum(r, "DEAL_AMT"),
                buyer: dcText(r, "BUYER_NAME"),
                seller: dcText(r, "SELLER_NAME"),
              }]
            : [];
        });
      },
    ],
    [
      "holders",
      async () => {
        const rows = await datacenterQuery(
          { report: "RPT_HOLDERNUM_DET", filter: `(SECURITY_CODE="${code}")`, sortColumns: "END_DATE", pageSize: 8 },
          signal,
        );
        result.holders = rows.flatMap((r) => {
          const date = dcDay(r, "END_DATE");
          return date
            ? [{
                date,
                count: dcNum(r, "HOLDER_NUM"),
                changePct: dcNum(r, "HOLDER_NUM_RATIO"),
                avgShares: dcNum(r, "AVG_HOLD_NUM"),
              }]
            : [];
        });
      },
    ],
    [
      "billboard",
      async () => {
        const rows = await datacenterQuery(
          {
            report: "RPT_DAILYBILLBOARD_DETAILSNEW",
            filter: `(SECURITY_CODE="${code}")(TRADE_DATE>='${addDays(-365)}')`,
            sortColumns: "TRADE_DATE",
            pageSize: 20,
          },
          signal,
        );
        result.billboard = rows.flatMap((r) => {
          const date = dcDay(r, "TRADE_DATE");
          return date
            ? [{
                date,
                reason: dcText(r, "EXPLANATION"),
                netBuy: dcNum(r, "BILLBOARD_NET_AMT"),
                changePct: dcNum(r, "CHANGE_RATE"),
              }]
            : [];
        });
      },
    ],
  ];
  for (const [part, load] of parts) {
    signal?.throwIfAborted();
    try {
      await load();
    } catch (error) {
      signal?.throwIfAborted();
      result.failures.push({ part, message: error instanceof Error ? error.message : "查询失败" });
    }
  }
  if (result.failures.length < parts.length) put("capital-profile", id, result);
  return result;
}

const yi = (v: number | null) => (v == null ? "—" : `${(v / 1e8).toFixed(2)}亿`);
const partLabels = { margin: "融资融券", blockTrades: "大宗交易", holders: "股东户数", billboard: "龙虎榜" };

/** 研究证据：资金面摘要，缺失部分显式标注。 */
export function capitalProfileEvidence(data: CapitalProfile): Evidence {
  const asOf = new Date(data.fetchedAt + 8 * 3600000).toISOString().slice(0, 10);
  const lines: string[] = [];
  const [m0] = data.margin;
  const m5 = data.margin[5];
  if (m0)
    lines.push(
      `融资余额 ${yi(m0.financingBalance)}（${m0.date}，占流通市值 ${m0.financingRatio?.toFixed(2) ?? "—"}%）${m5 ? `，较 ${m5.date} ${yi((m0.financingBalance ?? 0) - (m5.financingBalance ?? 0))}` : ""}`,
    );
  for (const h of data.holders.slice(0, 4))
    lines.push(`股东户数 ${h.date}：${h.count ?? "—"}（环比 ${h.changePct?.toFixed(2) ?? "—"}%）`);
  for (const b of data.blockTrades.slice(0, 5))
    lines.push(`大宗交易 ${b.date}：${yi(b.amount)}，溢价 ${b.premiumPct?.toFixed(2) ?? "—"}%，买方 ${b.buyer ?? "—"}`);
  for (const b of data.billboard.slice(0, 5))
    lines.push(`龙虎榜 ${b.date}：${b.reason ?? ""}，净买入 ${yi(b.netBuy)}`);
  for (const f of data.failures)
    lines.push(`${partLabels[f.part]} 查询失败，不得推断。`);
  const envelope = evidenceEnvelope(data, {
    source: "eastmoney/datacenter-capital",
    symbol: data.symbol,
    type: "quote-financial",
    asOf,
    publishedAt: null,
    fetchedAt: data.fetchedAt,
    currency: "CNY",
    unit: { amount: "元" },
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: data.failures.length ? "partial" : "validated",
    warnings: ["东方财富数据中心汇总数据，非交易所原始披露。"],
  });
  return {
    id: `evidence-${data.symbol}-capital-${envelope.payloadHash.slice(0, 16)}`,
    source: "东方财富数据中心 / 资金面（两融、大宗、股东户数、龙虎榜）",
    asOf,
    text: lines.join("\n") || "无资金面记录。",
    envelope,
  };
}
