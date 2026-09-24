import { get, put } from "../../db";
import { datacenterQuery, dcDay, dcNum } from "../eastmoney/em-datacenter";

/**
 * 宏观利率：中债国债收益率曲线（中央结算公司）、银行间回购定盘利率 FR（中国货币网）、
 * LPR（东方财富数据中心）。端点参考 simonlin1212/a-stock-data §11.3–11.5（Apache-2.0）。
 * 单位均为 %。
 */
export const MACRO_RATES_VERSION = "macro-rates-1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const TENORS = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"] as const;
export type Tenor = (typeof TENORS)[number];
export type CurvePoint = { date: string } & Record<Tenor, number | null>;
export type RepoFixing = {
  date: string;
  fr001: number;
  fr007: number;
  fr014: number;
};
export type LprPoint = { date: string; lpr1y: number; lpr5y: number | null };
export type MacroRates = {
  version: string;
  fetchedAt: number;
  treasury: CurvePoint[];
  repo: RepoFixing[];
  lpr: LprPoint[];
  failures: { part: "treasury" | "repo" | "lpr"; message: string }[];
};

const HEADER = ["曲线名称", "日期", "3月", "6月", "1年", "3年", "5年", "7年", "10年", "30年"];
const cellText = (html: string) => html.replace(/<[^>]+>|\s+/g, "");
const toNum = (v: string) => {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : null;
};

/** 中债历史查询页面的最后一张表；表头变化即拒绝解析。 */
export function parseChinabondHtml(html: string): CurvePoint[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  const tables = text.split("<table");
  if (tables.length < 3) return [];
  const rows = [...tables.at(-1)!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(
    (m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]!)),
  );
  if (!rows.length) return [];
  if (rows[0]!.join() !== HEADER.join()) throw new Error("中债收益率页面表头改变");
  return rows.slice(1).map((r) => {
    if (r.length !== HEADER.length || !/^\d{4}-\d{2}-\d{2}$/.test(r[1]!))
      throw new Error("中债收益率行格式改变");
    return {
      date: r[1]!,
      ...Object.fromEntries(TENORS.map((t, i) => [t, toNum(r[i + 2]!)])),
    } as CurvePoint;
  });
}

/** 货币网 CSV：「日期,,,,,,隔夜,7天,14天」，中间五列恒为空。 */
export function parseRepoCsv(text: string): RepoFixing[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const p = line.split(",");
      if (p.length !== 9 || p.slice(1, 6).some((v) => v.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(p[0]!))
        throw new Error("货币网定盘利率 CSV 格式改变");
      const [a, b, c] = [p[6], p[7], p[8]].map((v) => toNum(v!.trim()));
      if (a == null || b == null || c == null) return null;
      return { date: p[0]!, fr001: a, fr007: b, fr014: c };
    })
    .filter((r): r is RepoFixing => r !== null)
    .sort((x, y) => x.date.localeCompare(y.date));
}

const day = (offset: number) =>
  new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

async function text(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, ...(init.headers as Record<string, string>) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const TTL_MS = 60 * 60000;
const CACHE_ID = "macro-rates";

export async function macroRates(signal?: AbortSignal): Promise<MacroRates> {
  const cached = get<MacroRates>(CACHE_ID);
  if (cached?.version === MACRO_RATES_VERSION && Date.now() - cached.fetchedAt < TTL_MS)
    return cached;
  const result: MacroRates = {
    version: MACRO_RATES_VERSION,
    fetchedAt: Date.now(),
    treasury: [],
    repo: [],
    lpr: [],
    failures: [],
  };
  const parts: [MacroRates["failures"][number]["part"], () => Promise<void>][] = [
    [
      "treasury",
      async () => {
        const url = new URL("https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery");
        url.search = new URLSearchParams({
          startDate: day(-359), // 官网单次超过一年会静默返回 0 行
          endDate: day(0),
          gjqx: "0",
          qxId: "hzsylqx",
          locale: "cn_ZH",
        }).toString();
        result.treasury = parseChinabondHtml(await text(url.toString(), {}, signal)).sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        if (!result.treasury.length) throw new Error("中债近一年无数据");
      },
    ],
    [
      "repo",
      async () => {
        const all = parseRepoCsv(
          await text(
            "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/frr-chrt.csv",
            { headers: { referer: "https://www.chinamoney.com.cn/chinese/bkfrr/" } },
            signal,
          ),
        );
        result.repo = all.slice(-250);
      },
    ],
    [
      "lpr",
      async () => {
        const rows = await datacenterQuery(
          {
            report: "RPTA_WEB_RATE",
            columns: "TRADE_DATE,LPR1Y,LPR5Y",
            sortColumns: "TRADE_DATE",
            pageSize: 36,
          },
          signal,
        );
        // 同一报表混有旧贷款基准利率行，LPR1Y 为空，剔除。
        result.lpr = rows
          .flatMap((r) => {
            const date = dcDay(r, "TRADE_DATE");
            const lpr1y = dcNum(r, "LPR1Y");
            return date && lpr1y != null ? [{ date, lpr1y, lpr5y: dcNum(r, "LPR5Y") }] : [];
          })
          .reverse();
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
  if (result.failures.length < parts.length) put("macro-rates", CACHE_ID, result);
  return result;
}
