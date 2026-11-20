import { securityQuotes } from "../data-sources/tdx/tdx-quotes";

/**
 * 大盘总览实时报价（主要指数 + 自选股）。
 *
 * 主源使用腾讯实时行情（qt.gtimg.cn，单次 HTTP 批量获取，支持沪/深/北交所，
 * 秒级时间戳）；若有沪深标的漏缺或腾讯接口异常，自动回退到通达信 TCP 行情补齐。
 */
export type OverviewQuote = {
  symbol: string;
  price: number;
  preClose: number;
  amount: number;
  quoteTime: string | null;
};

export type OverviewQuoteSource =
  "腾讯实时" | "通达信实时" | "腾讯实时+通达信实时";

export type OverviewQuotesResult = {
  quotes: OverviewQuote[];
  source: OverviewQuoteSource;
  fetchedAt: number;
};

type TdxQuoteLike = {
  symbol: string;
  price: number;
  preClose: number;
  amount: number;
  quoteTime?: string | null;
};

const A_SHARE_SYMBOL = /^(sh|sz|bj)\d{6}$/;
const TDX_SUPPORTED_SYMBOL = /^(sh|sz)\d{6}$/;
const MARKET_PREFIX: Record<string, string> = {
  sh: "1",
  sz: "51",
  bj: "62",
};

function formatTencentTime(stamp: string): string | null {
  if (!/^\d{14}$/.test(stamp)) return null;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
}

function parseAmountYuan(fields: string[]): number {
  const triple = fields[35]?.split("/");
  if (triple && triple.length >= 3) {
    const exactYuan = Number(triple[2]);
    if (Number.isFinite(exactYuan) && exactYuan >= 0) return exactYuan;
  }
  const tenThousand = Number(fields[37]);
  if (Number.isFinite(tenThousand) && tenThousand >= 0)
    return tenThousand * 10000;
  return 0;
}

export function parseTencentOverviewQuotes(
  text: string,
  symbols: readonly string[],
): OverviewQuote[] {
  const expected = new Set(symbols);
  const seen = new Set<string>();
  const results: OverviewQuote[] = [];

  for (const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"\r\n]*)";/g)) {
    const symbol = match[1]!;
    if (!expected.has(symbol) || seen.has(symbol)) continue;
    const fields = match[2]!.split("~");
    const prefix = symbol.slice(0, 2);
    if (fields[0] !== MARKET_PREFIX[prefix] || fields[2] !== symbol.slice(2))
      continue;
    const price = Number(fields[3]);
    const preClose = Number(fields[4]);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(preClose) || preClose < 0) continue;
    seen.add(symbol);
    results.push({
      symbol,
      price,
      preClose,
      amount: parseAmountYuan(fields),
      quoteTime: formatTencentTime(fields[30] ?? ""),
    });
  }
  return results;
}

async function fetchTencentBatch(
  symbols: readonly string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OverviewQuote[]> {
  const out: OverviewQuote[] = [];
  for (let offset = 0; offset < symbols.length; offset += 80) {
    const batch = symbols.slice(offset, offset + 80);
    const timeout = AbortSignal.timeout(8000);
    const response = await fetcher(`https://qt.gtimg.cn/q=${batch.join(",")}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
      throw new Error(`腾讯实时行情请求失败（HTTP ${response.status}）`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024)
      throw new Error("腾讯实时行情响应体积超出上限");
    const text = new TextDecoder("gb18030").decode(bytes);
    out.push(...parseTencentOverviewQuotes(text, batch));
  }
  return out;
}

export async function fetchOverviewQuotes(
  rawSymbols: readonly string[],
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    tdxFallback?: (symbols: string[]) => Promise<TdxQuoteLike[]>;
  } = {},
): Promise<OverviewQuotesResult> {
  const symbols = [
    ...new Set(
      rawSymbols
        .map((s) => s.trim().toLowerCase())
        .filter((s) => A_SHARE_SYMBOL.test(s)),
    ),
  ];
  const now = Date.now();
  if (symbols.length === 0)
    return { quotes: [], source: "腾讯实时", fetchedAt: now };

  const bySymbol = new Map<string, OverviewQuote>();
  let tencentError: unknown = null;
  let usedTencent = false;
  let usedTdx = false;

  try {
    const tencentQuotes = await fetchTencentBatch(
      symbols,
      options.signal,
      options.fetcher,
    );
    for (const quote of tencentQuotes) bySymbol.set(quote.symbol, quote);
    usedTencent = tencentQuotes.length > 0;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    tencentError = error;
  }

  const missingForTdx = symbols.filter(
    (s) => !bySymbol.has(s) && TDX_SUPPORTED_SYMBOL.test(s),
  );
  let tdxError: unknown = null;
  if (missingForTdx.length > 0) {
    try {
      const tdxQuotes = await (options.tdxFallback ?? securityQuotes)(
        missingForTdx,
      );
      for (const q of tdxQuotes) {
        if (!Number.isFinite(q.price) || q.price <= 0) continue;
        bySymbol.set(q.symbol, {
          symbol: q.symbol,
          price: q.price,
          preClose:
            Number.isFinite(q.preClose) && q.preClose >= 0 ? q.preClose : 0,
          amount: Number.isFinite(q.amount) && q.amount >= 0 ? q.amount : 0,
          quoteTime: q.quoteTime ?? null,
        });
        usedTdx = true;
      }
    } catch (error) {
      tdxError = error;
    }
  }

  if (bySymbol.size === 0 && (tencentError || tdxError)) {
    const reason =
      tencentError instanceof Error
        ? tencentError.message
        : tdxError instanceof Error
          ? tdxError.message
          : "行情服务暂不可用";
    throw new Error(`实时行情获取失败：${reason}`);
  }

  const source: OverviewQuoteSource =
    usedTencent && usedTdx
      ? "腾讯实时+通达信实时"
      : usedTdx
        ? "通达信实时"
        : "腾讯实时";

  return {
    quotes: symbols
      .map((symbol) => bySymbol.get(symbol))
      .filter((quote): quote is OverviewQuote => quote !== undefined),
    source,
    fetchedAt: Date.now(),
  };
}
