import { get, put } from "../db";
import { evidenceEnvelope } from "../infra/evidence";
import type { Evidence } from "~/lib/domain";
import {
  datacenterQuery,
  dcDay,
  dcNum,
  dcText,
  type DatacenterRow,
} from "../data-sources/eastmoney/em-datacenter";

/**
 * 个股事件时间线：业绩预告、机构调研、股东增减持、回购、股权质押、限售解禁。
 * 全部来自东方财富数据中心（datacenter 限流组，串行）。报表与字段参考
 * simonlin1212/a-stock-data §14 / §3.6（Apache-2.0）。
 */
export const STOCK_EVENTS_VERSION = "stock-events-1";

export type StockEventType =
  | "forecast"
  | "survey"
  | "holder"
  | "buyback"
  | "pledge"
  | "unlock";
export type StockEvent = {
  date: string;
  type: StockEventType;
  title: string;
  detail: string | null;
  tone: "positive" | "negative" | "neutral";
};
export type StockEvents = {
  version: string;
  symbol: string;
  fetchedAt: number;
  /** 回看起点（含）与未来解禁截止日（含）。 */
  since: string;
  until: string;
  events: StockEvent[];
  /** 查询失败的事件类型；其余类型仍可用。 */
  failures: { type: StockEventType; message: string }[];
};

export const eventTypeLabels: Record<StockEventType, string> = {
  forecast: "业绩预告",
  survey: "机构调研",
  holder: "股东增减持",
  buyback: "股票回购",
  pledge: "股权质押",
  unlock: "限售解禁",
};

const POSITIVE_FORECAST = /预增|略增|扭亏|续盈/;
const NEGATIVE_FORECAST = /预减|略减|首亏|续亏|增亏/;
const BUYBACK_PROGRESS: Record<string, string> = {
  "001": "董事会预案",
  "002": "股东大会通过",
  "003": "股东大会否决",
  "004": "实施中",
  "005": "停止实施",
  "006": "完成实施",
};
const fmt = (v: number | null, digits = 2) =>
  v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const yi = (v: number | null) => (v == null ? "—" : `${fmt(v / 1e8)}亿`);

export function forecastEvents(rows: DatacenterRow[]): StockEvent[] {
  // One announcement spans several indicator rows; keep 归母净利润 when present.
  const groups = new Map<string, DatacenterRow[]>();
  for (const row of rows) {
    const key = `${dcDay(row, "NOTICE_DATE")}|${dcDay(row, "REPORT_DATE")}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => {
    const row =
      group.find((r) => /^归属.*净利润$|^净利润$/.test(dcText(r, "PREDICT_FINANCE") ?? "")) ??
      group[0]!;
    const date = dcDay(row, "NOTICE_DATE");
    if (!date) return [];
    const kind = dcText(row, "PREDICT_TYPE") ?? "预告";
    return [
      {
        date,
        type: "forecast" as const,
        title: `${dcDay(row, "REPORT_DATE") ?? ""} 业绩预告：${kind}`,
        detail: dcText(row, "PREDICT_CONTENT"),
        tone: POSITIVE_FORECAST.test(kind)
          ? ("positive" as const)
          : NEGATIVE_FORECAST.test(kind)
            ? ("negative" as const)
            : ("neutral" as const),
      },
    ];
  });
}

export function surveyEvents(rows: DatacenterRow[]): StockEvent[] {
  return rows.flatMap((row) => {
    const date = dcDay(row, "NOTICE_DATE");
    if (!date) return [];
    const way = dcText(row, "RECEIVE_WAY_EXPLAIN");
    return [
      {
        date,
        type: "survey" as const,
        title: `机构调研：${fmt(dcNum(row, "SUM"), 0)} 家${way ? `（${way}）` : ""}`,
        detail: `接待日 ${dcDay(row, "RECEIVE_START_DATE") ?? "—"}；接待人 ${dcText(row, "RECEPTIONIST") ?? "—"}`,
        tone: "neutral" as const,
      },
    ];
  });
}

export function holderEvents(rows: DatacenterRow[]): StockEvent[] {
  return rows.flatMap((row) => {
    const date = dcDay(row, "NOTICE_DATE");
    const direction = dcText(row, "DIRECTION");
    if (!date || !direction) return [];
    const shares = dcNum(row, "CHANGE_NUM_SYMBOL");
    return [
      {
        date,
        type: "holder" as const,
        title: `${dcText(row, "HOLDER_NAME") ?? "股东"}${direction} ${fmt(shares == null ? null : Math.abs(shares))} 万股`,
        // 东财 AFTER_CHANGE_RATE 实为本次变动占总股本比例。
        detail: `占总股本 ${fmt(dcNum(row, "AFTER_CHANGE_RATE"))}%；方式 ${dcText(row, "MARKET") ?? "—"}；变动后持股 ${fmt(dcNum(row, "HOLD_RATIO"))}%`,
        tone: direction === "增持" ? ("positive" as const) : ("negative" as const),
      },
    ];
  });
}

export function buybackEvents(rows: DatacenterRow[]): StockEvent[] {
  return rows.flatMap((row) => {
    const date = dcDay(row, "UPDATEDATE");
    if (!date) return [];
    const progress =
      BUYBACK_PROGRESS[dcText(row, "REPURPROGRESS") ?? ""] ?? "进度未知";
    return [
      {
        date,
        type: "buyback" as const,
        title: `股票回购：${progress}`,
        detail: `计划金额 ${yi(dcNum(row, "REPURAMOUNTLOWER"))}~${yi(dcNum(row, "REPURAMOUNTLIMIT"))}；价格上限 ${fmt(dcNum(row, "REPURPRICECAP"))}；已回购 ${yi(dcNum(row, "REPURAMOUNT"))}`,
        tone: progress === "股东大会否决" || progress === "停止实施" ? ("neutral" as const) : ("positive" as const),
      },
    ];
  });
}

export function pledgeEvents(rows: DatacenterRow[]): StockEvent[] {
  const row = rows[0];
  const date = row && dcDay(row, "TRADE_DATE");
  if (!row || !date) return [];
  const ratio = dcNum(row, "PLEDGE_RATIO");
  return [
    {
      date,
      type: "pledge",
      title: `股权质押比例 ${fmt(ratio)}%`,
      detail: `质押 ${fmt(dcNum(row, "PLEDGE_DEAL_NUM"), 0)} 笔，${fmt(dcNum(row, "REPURCHASE_BALANCE"))} 万股（中国结算周度统计）`,
      tone: ratio != null && ratio >= 30 ? "negative" : "neutral",
    },
  ];
}

export function unlockEvents(rows: DatacenterRow[]): StockEvent[] {
  return rows.flatMap((row) => {
    const date = dcDay(row, "FREE_DATE");
    if (!date) return [];
    const ratio = dcNum(row, "FREE_RATIO");
    return [
      {
        date,
        type: "unlock" as const,
        title: `限售解禁：${dcText(row, "FREE_SHARES_TYPE") ?? "类型未知"}`,
        detail: `实际可流通 ${fmt(dcNum(row, "ABLE_FREE_SHARES"))} 万股，占总股本 ${fmt(ratio == null ? null : ratio * 100)}%`,
        tone: ratio != null && ratio >= 0.05 ? ("negative" as const) : ("neutral" as const),
      },
    ];
  });
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const TTL_MS = 30 * 60000;

export async function stockEvents(
  symbol: string,
  signal?: AbortSignal,
  options: { lookbackDays?: number; forwardDays?: number } = {},
): Promise<StockEvents> {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) throw new Error("仅支持沪深北 A 股代码");
  const id = `stock-events:${symbol}`;
  const cached = get<StockEvents>(id);
  if (
    cached?.version === STOCK_EVENTS_VERSION &&
    Date.now() - cached.fetchedAt < TTL_MS
  )
    return cached;
  const code = symbol.slice(2);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const since = addDays(today, -(options.lookbackDays ?? 365));
  const until = addDays(today, options.forwardDays ?? 180);
  const sources: [StockEventType, () => Promise<StockEvent[]>][] = [
    [
      "forecast",
      async () =>
        forecastEvents(
          await datacenterQuery(
            {
              report: "RPT_PUBLIC_OP_NEWPREDICT",
              filter: `(SECURITY_CODE="${code}")(NOTICE_DATE>='${since}')`,
              sortColumns: "NOTICE_DATE",
              pageSize: 50,
            },
            signal,
          ),
        ),
    ],
    [
      "survey",
      async () =>
        surveyEvents(
          await datacenterQuery(
            {
              report: "RPT_ORG_SURVEYNEW",
              filter: `(SECURITY_CODE="${code}")(IS_SOURCE="1")(NUMBERNEW="1")(NOTICE_DATE>='${since}')`,
              sortColumns: "NOTICE_DATE",
              pageSize: 50,
            },
            signal,
          ),
        ),
    ],
    [
      "holder",
      async () =>
        holderEvents(
          await datacenterQuery(
            {
              report: "RPT_SHARE_HOLDER_INCREASE",
              filter: `(SECURITY_CODE="${code}")(NOTICE_DATE>='${since}')`,
              sortColumns: "NOTICE_DATE",
              pageSize: 50,
            },
            signal,
          ),
        ),
    ],
    [
      "buyback",
      async () =>
        buybackEvents(
          (
            await datacenterQuery(
              {
                report: "RPTA_WEB_GETHGLIST_NEW",
                filter: `(DIM_SCODE="${code}")`,
                sortColumns: "UPD",
                pageSize: 20,
              },
              signal,
            )
          ).filter((r) => (dcDay(r, "UPDATEDATE") ?? "") >= since),
        ),
    ],
    [
      "pledge",
      async () =>
        symbol.startsWith("bj")
          ? []
          : pledgeEvents(
              await datacenterQuery(
                {
                  report: "RPT_CSDC_LIST",
                  filter: `(SECURITY_CODE="${code}")`,
                  sortColumns: "TRADE_DATE",
                  pageSize: 1,
                },
                signal,
              ),
            ),
    ],
    [
      "unlock",
      async () =>
        unlockEvents(
          await datacenterQuery(
            {
              report: "RPT_LIFT_STAGE",
              filter: `(SECURITY_CODE="${code}")(FREE_DATE>='${since}')(FREE_DATE<='${until}')`,
              sortColumns: "FREE_DATE",
              pageSize: 50,
            },
            signal,
          ),
        ),
    ],
  ];
  const events: StockEvent[] = [];
  const failures: StockEvents["failures"] = [];
  for (const [type, load] of sources) {
    signal?.throwIfAborted();
    try {
      events.push(...(await load()));
    } catch (error) {
      signal?.throwIfAborted();
      failures.push({
        type,
        message: error instanceof Error ? error.message : "查询失败",
      });
    }
  }
  events.sort((a, b) => b.date.localeCompare(a.date));
  const result: StockEvents = {
    version: STOCK_EVENTS_VERSION,
    symbol,
    fetchedAt: Date.now(),
    since,
    until,
    events,
    failures,
  };
  if (failures.length < sources.length) put("stock-events", id, result);
  return result;
}

/** 研究证据：事件时间线压成一条文本证据，失败的类型显式标注不可推断。 */
export function stockEventsEvidence(data: StockEvents): Evidence {
  const today = new Date(data.fetchedAt + 8 * 3600000).toISOString().slice(0, 10);
  const lines = data.events.map(
    (e) =>
      `${e.date}${e.date > today ? "（未来）" : ""} [${eventTypeLabels[e.type]}] ${e.title}${e.detail ? `；${e.detail.slice(0, 160)}` : ""}`,
  );
  for (const f of data.failures)
    lines.push(`${eventTypeLabels[f.type]} 查询失败，不得推断该类事件是否存在。`);
  const text = lines.length ? lines.join("\n") : `${data.since} 以来无记录事件。`;
  const envelope = evidenceEnvelope(data.events, {
    source: "eastmoney/datacenter-events",
    symbol: data.symbol,
    type: "announcement",
    asOf: today,
    publishedAt: null,
    fetchedAt: data.fetchedAt,
    currency: "CNY",
    unit: { shares: "万股" },
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: data.failures.length ? "partial" : "validated",
    warnings: [
      "事件取自东方财富数据中心汇总，非公告原文；关键结论需回查公告。",
    ],
  });
  return {
    id: `evidence-${data.symbol}-stock-events-${envelope.payloadHash.slice(0, 16)}`,
    source: `东方财富数据中心 / 个股事件（${data.since} 起，含 ${data.until} 前待解禁）`,
    asOf: today,
    text: text.slice(0, 8000),
    envelope,
  };
}
