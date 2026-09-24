import { z } from "zod";
import { emFetch } from "./em-fetch";

/**
 * 东方财富涨停板行情中心四个池（push2ex，与 push2 同属 quote 限流组）。
 * 端点与参数参考 simonlin1212/a-stock-data §8.1（Apache-2.0）。
 * 价格原始值 ×1000；金额单位元；非交易日 data 为 null。
 */
export type LimitPoolKind = "zt" | "zb" | "dt" | "yzt";
const endpoints: Record<LimitPoolKind, { path: string; sort: string }> = {
  zt: { path: "getTopicZTPool", sort: "fbt:asc" },
  zb: { path: "getTopicZBPool", sort: "fbt:asc" },
  dt: { path: "getTopicDTPool", sort: "fund:asc" },
  yzt: { path: "getYesterdayZTPool", sort: "zs:desc" },
};
const UT = "7eea3edcaed734bea9cbfc24409ed989";

const num = z.number().nullish();
const rowSchema = z.object({
  c: z.string(),
  m: z.number(),
  n: z.string(),
  p: z.number(),
  zdp: num,
  amount: num,
  ltsz: num,
  hs: num,
  hybk: z.string().nullish(),
  // 涨停池
  lbc: num,
  fbt: num,
  lbt: num,
  fund: num,
  zbc: num,
  zttj: z.object({ days: z.number(), ct: z.number() }).nullish(),
  // 炸板 / 昨涨停
  ztp: num,
  zf: num,
  // 跌停
  days: num,
  oc: num,
  // 昨涨停
  yfbt: num,
  ylbc: num,
});
const envelopeSchema = z.object({
  rc: z.number(),
  data: z.object({ pool: z.array(rowSchema) }).nullable(),
});

export type LimitPoolRow = {
  symbol: string;
  name: string;
  price: number;
  changePct: number | null;
  amount: number | null;
  floatCap: number | null;
  turnover: number | null;
  industry: string;
  /** 连板数（涨停池）/ 昨日连板数（昨涨停池）/ 连续跌停天数（跌停池）。 */
  streak: number | null;
  /** 首次封板时间 HH:MM:SS；昨涨停池为昨日首封时间。 */
  firstSeal: string | null;
  lastSeal: string | null;
  /** 封板资金（涨停）/ 封单资金（跌停），元。 */
  sealFund: number | null;
  /** 炸板次数（涨停/炸板）/ 开板次数（跌停）。 */
  breaks: number | null;
  limitPrice: number | null;
  /** 「N 天 M 板」。 */
  stat: string | null;
};

const clock = (value: number | null | undefined) => {
  if (value == null || value <= 0) return null;
  const s = String(Math.trunc(value)).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
};
const market = (m: number, code: string) =>
  m === 1 ? "sh" : /^[48]|^92/.test(code) ? "bj" : "sz";

export function parseLimitPool(
  raw: unknown,
  kind: LimitPoolKind,
): LimitPoolRow[] | null {
  const checked = envelopeSchema.safeParse(raw);
  if (!checked.success) throw new Error("东方财富涨停池格式无效");
  if (!checked.data.data) return null;
  return checked.data.data.pool.map((r) => ({
    symbol: `${market(r.m, r.c)}${r.c}`,
    name: r.n,
    price: r.p / 1000,
    changePct: r.zdp ?? null,
    amount: r.amount ?? null,
    floatCap: r.ltsz ?? null,
    turnover: r.hs ?? null,
    industry: r.hybk ?? "",
    streak:
      kind === "zt" ? (r.lbc ?? null) : kind === "yzt" ? (r.ylbc ?? null) : kind === "dt" ? (r.days ?? null) : null,
    firstSeal: clock(kind === "yzt" ? r.yfbt : r.fbt),
    lastSeal: clock(r.lbt),
    sealFund: r.fund ?? null,
    breaks: kind === "dt" ? (r.oc ?? null) : (r.zbc ?? null),
    limitPrice: r.ztp ? r.ztp / 1000 : null,
    stat: r.zttj ? `${r.zttj.days}天${r.zttj.ct}板` : null,
  }));
}

/** date = YYYY-MM-DD。返回 null 表示非交易日或当日无数据。 */
export async function fetchLimitPool(
  kind: LimitPoolKind,
  date: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const { path, sort } = endpoints[kind];
  const url = new URL(`https://push2ex.eastmoney.com/${path}`);
  url.search = new URLSearchParams({
    ut: UT,
    dpt: "wz.ztzt",
    Pageindex: "0",
    pagesize: "10000",
    sort,
    date: date.replaceAll("-", ""),
  }).toString();
  const response = await emFetch(url, { signal }, fetcher);
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  return parseLimitPool(await response.json(), kind);
}
