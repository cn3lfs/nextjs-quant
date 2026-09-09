import { z } from "zod";
import { createHash } from "node:crypto";
import { sharedRead } from "./shared-read";

const date = z
  .string()
  .regex(/^\d{8}$/)
  .refine((v) => {
    const day = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`,
      time = Date.parse(day);
    return (
      Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day
    );
  });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const row = z
  .object({
    opDate: date,
    rzye: money,
    rzmre: money,
    rqylje: money,
    rzrqjyzl: money,
    stockCode: z.union([z.null(), z.literal("")]),
    securityAbbr: z.union([z.null(), z.literal("")]),
  })
  .refine(
    (r) =>
      Number.isSafeInteger(r.rzye + r.rqylje) &&
      r.rzye + r.rqylje === r.rzrqjyzl,
    "融资融券合计与分项不符",
  );
const pageSchema = z.object({
  actionErrors: z.array(z.unknown()).length(0),
  fieldErrors: z.record(z.unknown()).refine((v) => Object.keys(v).length === 0),
  beginDate: date,
  endDate: date,
  tabType: z.literal(""),
  stockCode: z.literal(""),
  isPagination: z.literal("true"),
  result: z.array(row).max(100),
  pageHelp: z.object({
    data: z.array(row).max(100),
    pageNo: z.number().int().min(1).max(10),
    pageSize: z.literal(100),
    pageCount: z.number().int().min(0).max(10),
    total: z.number().int().min(0).max(1000),
  }),
});
type Page = z.infer<typeof pageSchema>;
export const sseMarginVersion = "sse-margin-1";
export type SseMarginArchive = {
  version: typeof sseMarginVersion;
  start: string;
  end: string;
  fetchedAt: number;
  pages: Page[];
  hash: string;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const iso = (day: string) =>
  `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
function range(start: string, end: string) {
  date.parse(start);
  date.parse(end);
  if (
    start > end ||
    Date.parse(iso(end)) - Date.parse(iso(start)) > 400 * 86400000
  )
    throw new Error("上交所融资查询区间必须在400日以内");
}
export function parseSseMargin(
  pages: unknown[],
  start: string,
  end: string,
  fetchedAt: number,
): SseMarginArchive {
  range(start, end);
  if (
    !Number.isSafeInteger(fetchedAt) ||
    fetchedAt < 0 ||
    fetchedAt > Date.parse("9999-12-31T15:59:59Z")
  )
    throw new Error("采集时间非法");
  const parsed = pages.map((p) => pageSchema.parse(p)),
    total = parsed[0]?.pageHelp.total;
  if (
    total === undefined ||
    parsed.length !== Math.max(1, Math.ceil(total / 100))
  )
    throw new Error("融资分页不完整");
  const today = new Date(fetchedAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  if (end > today) throw new Error("融资查询截止日晚于采集日");
  let previous: string | undefined;
  for (const [i, p] of parsed.entries()) {
    const meta = p.pageHelp;
    if (
      p.beginDate !== start ||
      p.endDate !== end ||
      meta.total !== total ||
      meta.pageNo !== i + 1 ||
      (meta.pageCount !== Math.ceil(total / 100) &&
        !(total === 0 && meta.pageCount === 1)) ||
      p.result.length !== Math.min(100, total - i * 100) ||
      JSON.stringify(p.result) !== JSON.stringify(meta.data)
    )
      throw new Error("融资分页、查询范围或双份结果不一致");
    for (const r of p.result) {
      if (
        r.opDate < start ||
        r.opDate > end ||
        (previous !== undefined && r.opDate >= previous)
      )
        throw new Error("融资日期超范围、重复或非倒序");
      previous = r.opDate;
    }
  }
  const content = {
    version: sseMarginVersion,
    start,
    end,
    fetchedAt,
    pages: parsed,
  } as const;
  return { ...content, hash: hash(content) };
}
export function sseMarginRows(archive: SseMarginArchive) {
  const checked = parseSseMargin(
    archive.pages,
    archive.start,
    archive.end,
    archive.fetchedAt,
  );
  if (archive.version !== sseMarginVersion || checked.hash !== archive.hash)
    throw new Error("融资来源档案校验失败");
  return checked.pages
    .flatMap((p) => p.result)
    .map((r) => ({ date: iso(r.opDate), balance: r.rzye }))
    .reverse();
}
export async function fetchSseMargin(
  start: string,
  end: string,
  signal?: AbortSignal,
) {
  range(start, end);
  signal?.throwIfAborted();
  const pages: Page[] = [];
  for (let page = 1; page <= 10; page++) {
    signal?.throwIfAborted();
    const url = new URL(
      "https://query.sse.com.cn/marketdata/tradedata/queryMargin.do",
    );
    url.search = new URLSearchParams({
      isPagination: "true",
      beginDate: start,
      endDate: end,
      tabType: "",
      stockCode: "",
      "pageHelp.pageSize": "100",
      "pageHelp.pageNo": String(page),
      "pageHelp.beginPage": String(page),
      "pageHelp.cacheSize": "1",
      "pageHelp.endPage": String(page),
    }).toString();
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        Referer: "https://www.sse.com.cn/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("上交所融资来源请求失败");
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("融资响应超过2MB");
    const parsed = pageSchema.parse(JSON.parse(text));
    signal?.throwIfAborted();
    const total = parsed.pageHelp.total;
    if (
      parsed.pageHelp.pageNo !== page ||
      parsed.beginDate !== start ||
      parsed.endDate !== end ||
      (pages.length && pages[0]!.pageHelp.total !== total) ||
      parsed.result.length !== Math.min(100, total - (page - 1) * 100)
    )
      throw new Error("融资来源分页发生变化");
    pages.push(parsed);
    if (page * 100 >= total)
      return parseSseMargin(pages, start, end, Date.now());
  }
  throw new Error("融资来源超出10页预算");
}
const shared = sharedRead<SseMarginArchive>();
export async function querySseMargin(
  start: string,
  end: string,
  signal?: AbortSignal,
) {
  return shared(
    `${start}:${end}`,
    (s) =>
      fetchSseMargin(
        start,
        end,
        AbortSignal.any([s, AbortSignal.timeout(45000)]),
      ),
    signal,
  );
}
