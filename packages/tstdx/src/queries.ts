import { createHash } from "node:crypto";
import * as catalog from "./catalog-wire.js";
import {
  adjustBars,
  assertVolumeCoverage,
  classifyFundFlow,
  computePriceLimits,
  isAStock,
  isIndexSymbol,
  marketStatistics,
  type PriceLimitInput,
} from "./analytics.js";
import {
  splitSymbol,
  type KlineName,
  type TdxBar,
  type TdxQuote,
  type TdxTransaction,
  type TdxXdxr,
} from "./wire.js";

export type QuerySender = <T>(
  build: () => Buffer,
  parse: (body: Buffer) => T,
  reusable?: boolean,
) => Promise<T>;
export interface CoreQueries {
  barPage(
    symbol: string,
    period: KlineName,
    start: number,
    count: number,
  ): Promise<TdxBar[]>;
  indexBarPage(
    symbol: string,
    period: KlineName,
    start: number,
    count: number,
  ): Promise<TdxBar[]>;
  securityQuotes(symbols: string[]): Promise<TdxQuote[]>;
  transactionPage(
    symbol: string,
    start: number,
    count: number,
  ): Promise<TdxTransaction[]>;
  historyTransactionPage(
    symbol: string,
    date: number,
    start: number,
    count: number,
  ): Promise<TdxTransaction[]>;
  xdxr(symbol: string): Promise<TdxXdxr[]>;
}
export type RangeOptions = {
  kind?: "stock" | "index" | "auto";
  maxPages?: number;
  pageSize?: number;
};
export type BatchResult<T> =
  | { symbol: string; status: "data" | "empty"; data: T }
  | { symbol: string; status: "error"; error: string };
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export interface BatchWorker {
  barsRange(
    symbol: string,
    period: KlineName,
    begin: number,
    end: number,
  ): Promise<TdxBar[]>;
  close(): Promise<void>;
}
export function createExtendedQueries(
  core: CoreQueries,
  send: QuerySender,
  createWorker?: () => BatchWorker,
) {
  function securityCount(market: catalog.TdxMarket) {
    return send(
      () => catalog.buildSecurityCountRequest(market),
      catalog.parseSecurityCount,
    );
  }
  function securityList(market: catalog.TdxMarket, start = 0) {
    return send(
      () => catalog.buildSecurityListRequest(market, start),
      (b) => catalog.parseSecurityList(b, market),
      false,
    );
  }
  async function stocks(market: catalog.TdxMarket) {
    const count = await securityCount(market),
      rows: catalog.TdxSecurity[] = [],
      seen = new Set<string>();
    while (rows.length < count) {
      const page = await securityList(market, rows.length);
      if (!page.length)
        throw new Error(`证券列表提前结束：${rows.length}/${count}`);
      for (const row of page) {
        if (seen.has(row.symbol)) throw new Error("证券列表分页重复");
        seen.add(row.symbol);
        rows.push(row);
      }
      if (rows.length > count)
        throw new Error("证券数量在分页期间变化，请重新查询");
    }
    return rows;
  }
  async function allStocks(options: { withIndustry?: boolean } = {}) {
    // BJ list is an explicit separate request; never silently claim a full three-market universe.
    const rows = [...(await stocks("sh")), ...(await stocks("sz"))].filter(
      (s) => isAStock(s.symbol),
    );
    if (options.withIndustry) {
      const mapping = await industryMap();
      for (const row of rows) Object.assign(row, mapping.get(row.symbol));
    }
    return rows;
  }
  function companyInfoCategories(symbol: string) {
    return send(
      () => catalog.buildCompanyCategoryRequest(symbol),
      catalog.parseCompanyCategories,
    );
  }
  async function companyInfoContent(
    symbol: string,
    filename: string,
    start: number,
    length: number,
  ) {
    catalog.uint(length, "length", 8 * 1024 * 1024, 1);
    catalog.uint(start, "start", 0xffffffff);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < length) {
      const requested = Math.min(65535, length - offset);
      const part = await send(
        () =>
          catalog.buildCompanyContentRequest(
            symbol,
            filename,
            start + offset,
            requested,
          ),
        catalog.parseCompanyContent,
      );
      if (!part.length || part.length !== requested)
        throw new Error(`F10 内容不完整：${offset + part.length}/${length}`);
      chunks.push(part);
      offset += part.length;
    }
    return catalog.decodeGbk(Buffer.concat(chunks));
  }
  async function f10(symbol: string) {
    const result: (catalog.TdxCompanyCategory & { content: string })[] = [];
    for (const category of await companyInfoCategories(symbol)) {
      result.push({
        ...category,
        content: category.length
          ? await companyInfoContent(
              symbol,
              category.filename,
              category.start,
              category.length,
            )
          : "",
      });
    }
    return result;
  }
  function blockMeta(filename: string) {
    return send(
      () => catalog.buildBlockMetaRequest(filename),
      catalog.parseBlockMeta,
    );
  }
  async function fileChunk(filename: string, start: number, length = 30000) {
    const part = await send(
      () => catalog.buildFileChunkRequest(filename, start, length),
      catalog.parseFileChunk,
    );
    if (part.length > length) throw new Error("文件分片超过请求长度");
    return part;
  }
  async function download(
    filename: string,
    size?: number,
    maxBytes = 8 * 1024 * 1024,
  ) {
    catalog.uint(maxBytes, "maxBytes", 64 * 1024 * 1024, 1);
    if (size !== undefined && size > maxBytes)
      throw new Error("文件超过 maxBytes");
    const chunks: Buffer[] = [],
      seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 256; page++) {
      if (size !== undefined && offset === size) return Buffer.concat(chunks);
      const requested = Math.min(
        30000,
        size === undefined ? 30000 : size - offset,
      );
      const part = await fileChunk(filename, offset, requested);
      if (!part.length) {
        if (size !== undefined)
          throw new Error(`文件提前结束：${offset}/${size}`);
        return Buffer.concat(chunks);
      }
      if (offset + part.length > maxBytes) throw new Error("文件超过 maxBytes");
      const signature = hash(part);
      if (seen.has(signature)) throw new Error("文件返回重复分片");
      seen.add(signature);
      chunks.push(part);
      offset += part.length;
      if (size === undefined && part.length < requested)
        return Buffer.concat(chunks);
    }
    throw new Error("文件超过 256 个分片，未取得完整文件");
  }
  async function reportFile(filename: string, maxBytes?: number) {
    return download(filename, undefined, maxBytes);
  }
  async function blockInfo(filename = "block_gn.dat") {
    const meta = await blockMeta(filename);
    if (!meta.size) return [];
    const bytes = await download(filename, meta.size);
    if (meta.md5 && createHash("md5").update(bytes).digest("hex") !== meta.md5)
      throw new Error("板块文件 MD5 不符");
    return catalog.parseBlockFile(bytes, filename);
  }
  async function blockMembers(filename = "block_gn.dat") {
    return (await blockInfo(filename)).flatMap((block) =>
      block.codes.map((code) => ({
        block: block.name,
        type: block.type,
        code,
      })),
    );
  }
  async function industryMap() {
    const file = await reportFile("tdxhy.cfg");
    if (!file.length) throw new Error("行业文件为空");
    return catalog.parseIndustryFile(file);
  }
  function bars(
    symbol: string,
    period: KlineName = "day",
    start = 0,
    count = 800,
  ) {
    return isIndexSymbol(symbol)
      ? core.indexBarPage(symbol, period, start, count)
      : core.barPage(symbol, period, start, count);
  }
  async function barsRange(
    symbol: string,
    period: KlineName,
    begin: number,
    end: number,
    options: RangeOptions = {},
  ) {
    const from = catalog.dateNumber(begin),
      to = catalog.dateNumber(end);
    if (begin > end) throw new Error("开始日期晚于结束日期");
    const size = catalog.uint(options.pageSize ?? 800, "pageSize", 800, 1);
    const max = catalog.uint(options.maxPages ?? 256, "maxPages", 256, 1);
    const read =
      options.kind === "index"
        ? core.indexBarPage
        : options.kind === "stock"
          ? core.barPage
          : bars;
    const rows = new Map<string, TdxBar>(),
      seen = new Set<string>();
    let start = 0,
      oldest = "9999";
    for (let page = 0; page < max; page++) {
      catalog.uint(start, "start");
      const result = await read(symbol, period, start, size);
      if (!result.length)
        return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
      const signature = JSON.stringify(result);
      if (seen.has(signature)) throw new Error("K 线分页重复");
      seen.add(signature);
      const first = result.reduce(
        (min, b) => (b.date < min ? b.date : min),
        "9999",
      );
      if (first >= oldest) throw new Error("K 线分页没有向历史推进");
      oldest = first;
      for (const bar of result) {
        const day = bar.date.slice(0, 10);
        if (day < from || day > to) continue;
        const previous = rows.get(bar.date);
        if (previous && JSON.stringify(previous) !== JSON.stringify(bar))
          throw new Error("K 线跨页数据冲突");
        rows.set(bar.date, bar);
      }
      if (first.slice(0, 10) <= from || result.length < size)
        return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
      start += result.length;
    }
    throw new Error("K 线区间超过分页上限，未返回不完整结果");
  }
  const k = (symbol: string, begin: number, end: number) =>
    barsRange(symbol, "day", begin, end);
  const indexBarsRange = (
    symbol: string,
    period: KlineName,
    begin: number,
    end: number,
    options: RangeOptions = {},
  ) => barsRange(symbol, period, begin, end, { ...options, kind: "index" });
  async function barsBatch(
    symbols: readonly string[],
    period: KlineName,
    begin: number,
    end: number,
    parallel = 4,
  ): Promise<BatchResult<TdxBar[]>[]> {
    catalog.uint(parallel, "parallel", 8, 1);
    symbols.forEach(splitSymbol);
    const output: BatchResult<TdxBar[]>[] = new Array(symbols.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(parallel, symbols.length) }, async () => {
        const worker = createWorker?.();
        try {
          while (next < symbols.length) {
            const i = next++,
              symbol = symbols[i]!;
            try {
              const data = await (worker?.barsRange ?? barsRange)(
                symbol,
                period,
                begin,
                end,
              );
              output[i] = {
                symbol,
                status: data.length ? "data" : "empty",
                data,
              };
            } catch (error) {
              output[i] = { symbol, status: "error", error: message(error) };
            }
          }
        } finally {
          await worker?.close();
        }
      }),
    );
    return output;
  }
  const kBatch = (
    symbols: readonly string[],
    begin: number,
    end: number,
    parallel = 4,
  ) => barsBatch(symbols, "day", begin, end, parallel);
  async function kAdjusted(
    symbol: string,
    mode: "qfq" | "hfq",
    begin: number,
    end: number,
  ) {
    const from = catalog.dateNumber(begin),
      to = catalog.dateNumber(end);
    if (begin > end) throw new Error("开始日期晚于结束日期");
    const raw = await barsRange(symbol, "day", 19900101, end);
    return adjustBars(raw, await core.xdxr(symbol), mode).filter(
      (b) => b.date >= from && b.date <= to,
    );
  }
  async function marketStat() {
    const quotes = await core.securityQuotes(["sh880005"]);
    if (!quotes[0]) throw new Error("市场统计行情为空");
    return marketStatistics(quotes[0]);
  }
  async function priceLimits(
    symbol: string,
    preClose: number,
    options: PriceLimitInput = {},
  ) {
    let listedDays = options.listedDays;
    if (listedDays === undefined && isAStock(symbol)) {
      const recent = await core.barPage(symbol, "day", 0, 6);
      if (!recent.length) throw new Error("无法确认上市交易天数");
      listedDays = recent.length;
    }
    return computePriceLimits(symbol, preClose, { ...options, listedDays });
  }
  async function transactionsAll(symbol: string, date?: number) {
    splitSymbol(symbol);
    if (date !== undefined) catalog.dateNumber(date);
    const rows: TdxTransaction[] = [],
      seen = new Set<string>();
    let start = 0;
    while (start <= 65535) {
      const page =
        date === undefined
          ? await core.transactionPage(symbol, start, 800)
          : await core.historyTransactionPage(symbol, date, start, 800);
      if (!page.length) return rows;
      const signature = JSON.stringify(page);
      if (seen.has(signature)) throw new Error("成交分页重复");
      seen.add(signature);
      // Minute-resolution records cannot reliably identify identical boundary trades.
      if (
        rows.length &&
        page.length &&
        JSON.stringify(page.at(-1)) === JSON.stringify(rows[0])
      )
        throw new Error("成交页边界重叠，分钟精度不足以安全去重");
      rows.unshift(...page);
      start += page.length;
    }
    throw new Error("成交超过 uint16 分页范围，覆盖不完整");
  }
  async function fundFlow(symbol: string, lotSize = 100) {
    if (!isAStock(symbol)) throw new Error("资金流默认仅支持 A 股成交量口径");
    const quote = (await core.securityQuotes([symbol]))[0];
    if (!quote) throw new Error("无法取得成交量参照");
    const records = await transactionsAll(symbol);
    if (!records.length)
      throw new Error("成交覆盖不完整：成交为空，不能构造零资金流");
    assertVolumeCoverage(records, quote.volume);
    return {
      ...classifyFundFlow(records, lotSize),
      referenceVolume: quote.volume,
      referenceTime: quote.quoteTime,
    };
  }
  function historyFundFlowPage(symbol: string, start = 0, count = 3) {
    return send(
      () => catalog.buildHistoryFlowRequest(symbol, start, count),
      catalog.parseHistoryFlow,
    );
  }
  async function historyFundFlow(
    symbol: string,
    start = 0,
    count = 3,
  ): Promise<catalog.TdxHistoricalFlow[]> {
    if (!isAStock(symbol)) throw new Error("资金流默认仅支持 A 股成交量口径");
    catalog.uint(start, "start");
    catalog.uint(count, "count", 800, 1);
    let fallbackReason = "category22-empty";
    try {
      const direct = await historyFundFlowPage(symbol, start, count);
      if (direct.length) return direct;
    } catch (error) {
      fallbackReason = message(error);
    }
    const days = await core.barPage(symbol, "day", start, count),
      rows: catalog.TdxHistoricalFlow[] = [];
    if (!days.length)
      throw new Error(`历史资金流缺少 K 线日期：${fallbackReason}`);
    for (const bar of days) {
      const date = Number(bar.date.slice(0, 10).replaceAll("-", ""));
      const records = await transactionsAll(symbol, date);
      if (!records.length) throw new Error("历史成交为空，不能构造零资金流");
      assertVolumeCoverage(records, bar.volume);
      rows.push({
        ...classifyFundFlow(records),
        date: bar.date.slice(0, 10),
        source: "transactions",
        fallbackReason,
      });
    }
    return rows;
  }
  return {
    securityCount,
    securityList,
    stocks,
    allStocks,
    companyInfoCategories,
    companyInfoContent,
    f10,
    blockMeta,
    fileChunk,
    reportFile,
    blockInfo,
    blockMembers,
    industryMap,
    bars,
    barsRange,
    indexBarsRange,
    k,
    barsBatch,
    kBatch,
    kAdjusted,
    marketStat,
    priceLimits,
    transactionsAll,
    fundFlow,
    historyFundFlowPage,
    historyFundFlow,
  };
}
