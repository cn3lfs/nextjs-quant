import { z } from "zod";
import { TdxSession } from "./tdx-quotes";
import { buildQuotesRequest, parseQuotes } from "./tdx-wire";
import { queryMcp } from "./mcp";
export type WorkflowPrice = {
  symbol: string;
  price: number;
  volume: number;
  source: string;
  fetchedAt: number;
};
function currentQuoteTime(time: string, now: number) {
  if (
    !/^\d{6}$/.test(time) ||
    Number(time.slice(0, 2)) > 23 ||
    Number(time.slice(2, 4)) > 59 ||
    Number(time.slice(4, 6)) > 59
  )
    return false;
  const wall = new Date(now + 8 * 3600000).toISOString();
  const current = Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
  const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(2, 4));
  const expected =
    current >= 690 && current < 780 ? 690 : Math.min(current, 900);
  return minute <= current && minute >= expected - 10;
}
const quoteSchema = z.object({
  BaseInfo: z.object({
    Code: z.string(),
    Setcode: z.coerce.number(),
    Unit: z.coerce.number().positive(),
  }),
  HQInfo: z.object({
    HQDate: z.string(),
    HQTime: z.string(),
    Now: z.coerce.number().positive(),
    Volume: z.coerce.number().nonnegative(),
  }),
});
export function parseWorkflowQuote(
  raw: unknown,
  symbol: string,
  date: string,
  now: number,
): WorkflowPrice {
  const result = quoteSchema.parse(raw);
  if (
    result.BaseInfo.Code !== symbol.slice(2) ||
    result.BaseInfo.Setcode !== (symbol.startsWith("sh") ? 1 : 0) ||
    result.HQInfo.HQDate !== date.replaceAll("-", "")
  )
    throw new Error("报价证券或交易日期不匹配");
  if (!/^\d{6}$/.test(result.HQInfo.HQTime)) throw new Error("报价时间无效");
  if (!currentQuoteTime(result.HQInfo.HQTime, now))
    throw new Error("报价尚未更新到本批次时段");
  return {
    symbol,
    price: result.HQInfo.Now,
    volume: result.HQInfo.Volume * result.BaseInfo.Unit,
    source: "tdx-mcp",
    fetchedAt: now,
  };
}
export function parseTencentWorkflowQuotes(
  text: string,
  symbols: string[],
  date: string,
  now: number,
) {
  const expected = new Set(symbols),
    prices: WorkflowPrice[] = [],
    seen = new Set<string>();
  for (const match of text.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)";/g)) {
    const symbol = match[1]!,
      fields = match[2]!.split("~"),
      stamp = fields[30] ?? "";
    if (!expected.has(symbol) || seen.has(symbol))
      throw new Error("腾讯批量报价证券重复或不属于请求");
    seen.add(symbol);
    if (
      fields[2] !== symbol.slice(2) ||
      fields[0] !== (symbol.startsWith("sh") ? "1" : "51") ||
      !/^\d{14}$/.test(stamp) ||
      stamp.slice(0, 8) !== date.replaceAll("-", "") ||
      !currentQuoteTime(stamp.slice(8), now)
    )
      continue;
    const price = Number(fields[3]),
      volume = Number(fields[6]);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      !fields[6]?.trim()
    )
      continue;
    prices.push({
      symbol,
      price,
      volume: volume * 100,
      source: "tencent-quotes",
      fetchedAt: now,
    });
  }
  return prices;
}
/** Direct protocol batches are capped at 80; failed rows use bounded MCP requests.
 * tdx_quotes is a single-security tool: comma-separated input silently returns only one.
 */
export async function workflowQuotes(
  symbols: string[],
  date: string,
  checkpoint: () => void = () => {},
) {
  const prices = new Map<string, WorkflowPrice>();
  let session: TdxSession | undefined;
  try {
    for (const host of ["180.153.18.170", "124.71.187.122"]) {
      try {
        session = await TdxSession.connect(host, 7709, 3000);
        for (let offset = 0; offset < symbols.length; offset += 80) {
          checkpoint();
          const batch = symbols.slice(offset, offset + 80);
          for (const q of parseQuotes(
            await session.request(buildQuotesRequest(batch)),
            batch,
          ))
            if (
              q.price > 0 &&
              currentQuoteTime(
                q.quoteTime.replaceAll(":", "").slice(0, 6),
                Date.now(),
              )
            )
              prices.set(q.symbol, {
                symbol: q.symbol,
                price: q.price,
                volume: q.volume * 100,
                source: "tdx-7709",
                fetchedAt: Date.now(),
              });
        }
        break;
      } catch {
        await session?.close();
        session = undefined;
      }
    }
  } finally {
    await session?.close();
  }
  const unresolved = symbols.filter((symbol) => !prices.has(symbol));
  let batchCursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(4, Math.ceil(unresolved.length / 80)) },
      async () => {
        while (batchCursor < unresolved.length) {
          const batch = unresolved.slice(batchCursor, (batchCursor += 80));
          checkpoint();
          try {
            const response = await fetch(
              `https://qt.gtimg.cn/q=${batch.join(",")}`,
              { signal: AbortSignal.timeout(10000) },
            );
            if (!response.ok) continue;
            const bytes = await response.arrayBuffer();
            if (bytes.byteLength > 1024 * 1024) continue;
            for (const price of parseTencentWorkflowQuotes(
              new TextDecoder("gb18030").decode(bytes),
              batch,
              date,
              Date.now(),
            ))
              prices.set(price.symbol, price);
          } catch {
            /* Only missing rows fall through to MCP. */
          }
        }
      },
    ),
  );
  const missing = symbols.filter((symbol) => !prices.has(symbol));
  let cursor = 0;
  const deadline = Date.now() + 90 * 1000;
  await Promise.all(
    Array.from({ length: Math.min(6, missing.length) }, async () => {
      while (cursor < missing.length && Date.now() < deadline) {
        checkpoint();
        const symbol = missing[cursor++]!;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const raw = await queryMcp("tdx_quotes", {
              code: symbol.slice(2),
              setcode: symbol.startsWith("sh") ? "1" : "0",
              hasCwInfo: "0",
            });
            prices.set(
              symbol,
              parseWorkflowQuote(raw, symbol, date, Date.now()),
            );
            break;
          } catch {
            /* Retain this symbol in the denominator; the caller flags reused prices. */
          }
        }
      }
    }),
  );
  return prices;
}
