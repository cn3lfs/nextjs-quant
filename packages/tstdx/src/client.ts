import { Socket } from "node:net";
import { ConnectionPool } from "./connection-pool.js";
import { isAStock, isIndexSymbol } from "./analytics.js";
import { createExtendedQueries, type BatchWorker } from "./queries.js";
import {
  buildSecurityCountRequest,
  buildSecurityListRequest,
  parseSecurityList,
  parseSecurityCount,
  type TdxMarket,
  uint,
} from "./catalog-wire.js";
import {
  FRAME_HEADER_SIZE,
  PAGE_LIMIT,
  QUOTES_BATCH_LIMIT,
  SETUP_FRAMES,
  buildBarsRequest,
  buildFinanceRequest,
  buildHistoryMinuteRequest,
  buildHistoryTransactionsRequest,
  buildMinuteRequest,
  buildQuotesRequest,
  buildTransactionsRequest,
  buildXdxrRequest,
  inflateBody,
  parseBars,
  parseFinance,
  parseFrameHeader,
  parseMinutes,
  parseQuotes,
  parseTransactions,
  parseXdxr,
  priceDivisor,
  type KlineName,
  type TdxBar,
  type TdxFinance,
  type TdxMinute,
  type TdxQuote,
  type TdxTransaction,
  type TdxXdxr,
} from "./wire.js";

/**
 * 通达信 7709 行情的连接层：一条 TCP 连接、请求串行化、失败换服务器。
 *
 * 这些是公共行情服务器，不承诺可用性，也不构成 SLA；协议只做行情查询，
 * 不登录、不下单，也不读写通达信本地目录。实时快照仅供盘中观察，
 * 不能与本地 vipdoc 历史混用做回测信号。
 */

/** 内置的公开通达信行情服务器；顺序即故障转移顺序。 */
export const TDX_HOSTS = [
  "180.153.18.170",
  "124.71.187.122",
  "180.153.18.171",
  "180.153.18.172",
  "119.147.212.81",
  "115.238.56.198",
  "115.238.90.165",
  "218.75.126.9",
  "47.107.75.159",
  "59.175.238.38",
] as const;
export const PORT = 7709;
const TIMEOUT_MS = 15000;

const hostPattern = /^[a-zA-Z0-9.-]{1,253}$/;

export function parseHosts(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",") : [];
  const hosts = list.map((host) => host.trim()).filter(Boolean);
  if (hosts.some((host) => !hostPattern.test(host)))
    throw new Error("行情服务器地址含非法字符");
  return hosts;
}

export class TdxSession {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting?: {
    size: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  /** 协议是有状态的请求-响应，同一连接上的调用必须首尾相接。 */
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly socket: Socket,
    readonly host: string,
  ) {}

  static async connect(host: string, port = PORT, timeoutMs = TIMEOUT_MS) {
    const socket = new Socket();
    socket.setNoDelay(true);
    const session = new TdxSession(socket, host);
    socket.on("data", (chunk) => session.receive(chunk));
    socket.on("error", (error) => session.fail(error));
    socket.on("close", () =>
      session.fail(new Error(`行情连接被 ${host} 关闭`)),
    );
    socket.setTimeout(timeoutMs, () =>
      session.fail(new Error(`行情服务器 ${host} 响应超时`)),
    );
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", connected);
        socket.off("error", failed);
        socket.off("close", closed);
      };
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () =>
        failed(new Error(`行情服务器 ${host} 建连中断或超时`));
      socket.once("connect", connected);
      socket.once("error", failed);
      socket.once("close", closed);
      socket.connect(port, host);
    });
    try {
      for (const frame of SETUP_FRAMES) await session.exchange(frame);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /**
   * 先让挂起的读取立刻失败，再尝试正常发出 FIN。
   * 不能等 `end` 的回调：socket 已经被销毁时那个回调永远不会来，close 会挂死。
   */
  async close() {
    this.reject(new Error("行情连接已关闭"));
    if (this.socket.destroyed) return;
    this.socket.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.socket.destroy();
  }

  /** 发送一帧并取回解压后的 body；调用之间自动排队。 */
  request(frame: Buffer): Promise<Buffer> {
    const result = this.tail.then(
      () => this.exchange(frame),
      () => this.exchange(frame),
    );
    this.tail = result.catch(() => {});
    return result;
  }

  private async exchange(frame: Buffer) {
    if (this.failure) throw this.failure;
    this.socket.write(frame);
    const header = parseFrameHeader(await this.read(FRAME_HEADER_SIZE));
    return inflateBody(header, await this.read(header.zipSize));
  }

  private read(size: number) {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (this.waiting) return reject(new Error("行情连接上存在并发读取"));
      if (size === 0) return resolve(Buffer.alloc(0));
      this.waiting = { size, resolve, reject };
      this.drain();
    });
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    this.drain();
  }

  private drain() {
    const waiting = this.waiting;
    if (!waiting || this.buffer.length < waiting.size) return;
    this.waiting = undefined;
    const payload = this.buffer.subarray(0, waiting.size);
    this.buffer = this.buffer.subarray(waiting.size);
    waiting.resolve(payload);
  }

  /** 一旦出错，连接就不可再用：清掉挂起的读取并让后续调用立即失败。 */
  private fail(error: Error) {
    this.reject(error);
    this.socket.destroy();
  }

  /** 标记连接不可用并唤醒挂起的读取；不碰 socket，供 close 复用。 */
  private reject(error: Error) {
    this.failure ??= error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(this.failure);
  }
}

/**
 * 按给定顺序逐台尝试，全部失败才报错，错误信息里保留每台的失败原因，
 * 免得只看到一句“连不上”而不知道是被拒绝、超时还是握手不通过。
 */
export type HostSource = readonly string[] | (() => readonly string[]);

export function createQuotesPool(
  hosts: HostSource = TDX_HOSTS,
  port = PORT,
  options: { timeoutMs?: number; connectBudgetMs?: number } = {},
) {
  uint(port, "port", 65535, 1);
  const timeout = uint(options.timeoutMs ?? 3000, "timeoutMs", 60000, 1);
  const budget = uint(
    options.connectBudgetMs ?? 15000,
    "connectBudgetMs",
    120000,
    1,
  );
  return new ConnectionPool(async () => {
    const failures: string[] = [];
    const deadline = Date.now() + budget;
    for (const host of typeof hosts === "function" ? hosts() : hosts)
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        return await TdxSession.connect(
          host,
          port,
          Math.min(timeout, remaining),
        );
      } catch (error) {
        failures.push(
          `${host}: ${error instanceof Error ? error.message : "连接失败"}`,
        );
      }
    throw new Error(`所有行情服务器均不可用：${failures.join("；")}`);
  });
}
export interface TdxClientOptions {
  hosts?: HostSource;
  port?: number;
  timeoutMs?: number;
  connectBudgetMs?: number;
  requestRetries?: number;
}

/** Each client owns its connection pool; configuration is supplied by the caller. */
export function createTdxClient(options: TdxClientOptions = {}) {
  let generation = 0;
  let nextHost: string | undefined;
  const retries = uint(options.requestRetries ?? 0, "requestRetries", 3);
  const hosts = () =>
    typeof options.hosts === "function"
      ? options.hosts()
      : (options.hosts ?? TDX_HOSTS);
  const pool = createQuotesPool(
    () => {
      const list = hosts(),
        at = nextHost ? list.indexOf(nextHost) : 0;
      return at > 0 ? [...list.slice(at), ...list.slice(0, at)] : list;
    },
    options.port,
    options,
  );

  async function send<T>(
    build: () => Buffer,
    parse: (body: Buffer) => T,
    reusable = true,
  ): Promise<T> {
    const request = build(),
      startedGeneration = generation;
    for (let attempt = 0; ; attempt++) {
      try {
        return await pool.use(async (session) => {
          try {
            return parse(await session.request(request));
          } catch (error) {
            const list = hosts(),
              at = list.indexOf(session.host);
            nextHost = list[(at + 1) % list.length];
            pool.invalidate(session);
            throw error;
          } finally {
            if (!reusable) pool.invalidate(session);
          }
        });
      } catch (error) {
        if (attempt >= retries || generation !== startedGeneration) throw error;
      }
    }
  }
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  const closeQuotes = () => {
    generation++;
    stopHeartbeat();
    precisionCatalog.clear();
    return pool.close();
  };
  const heartbeat = () =>
    send(() => buildSecurityCountRequest("sh"), parseSecurityCount);
  const reconnect = async () => {
    await pool.close();
    return heartbeat();
  };
  async function retry<T>(
    operation: () => Promise<T>,
    attempts = 2,
  ): Promise<T> {
    uint(attempts, "attempts", 4, 1);
    for (let i = 0; ; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i + 1 >= attempts) throw error;
        await pool.close();
      }
    }
  }
  function startHeartbeat(
    intervalMs = 60000,
    onError?: (error: unknown) => void,
  ) {
    uint(intervalMs, "intervalMs", 86400000, 100);
    stopHeartbeat();
    let busy = false;
    heartbeatTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void heartbeat()
        .catch((error) => {
          try {
            onError?.(error);
          } catch {
            /* Callback cannot crash the timer. */
          }
        })
        .finally(() => {
          busy = false;
        });
    }, intervalMs);
    heartbeatTimer.unref?.();
    return stopHeartbeat;
  }

  // 股票/指数的两位协议已验证；其他证券必须读取该源目录，不能按价格猜测。
  const precisionCatalog = new Map<TdxMarket, Promise<Map<string, number>>>();
  async function securityDecimals(symbol: string): Promise<number> {
    if (isAStock(symbol) || isIndexSymbol(symbol)) return 2;
    const market = symbol.slice(0, 2) as TdxMarket;
    let pending = precisionCatalog.get(market);
    if (!pending) {
      pending = (async () => {
        const count = await send(
          () => buildSecurityCountRequest(market),
          parseSecurityCount,
        );
        const values = new Map<string, number>();
        for (let offset = 0; offset < count;) {
          const page = await send(
            () => buildSecurityListRequest(market, offset),
            (body) => parseSecurityList(body, market),
            false,
          );
          if (!page.length || offset + page.length > count)
            throw new Error("价格精度目录分页不完整");
          for (const row of page) {
            priceDivisor(row.decimalPoint);
            if (values.has(row.symbol)) throw new Error("价格精度目录证券重复");
            values.set(row.symbol, row.decimalPoint);
          }
          offset += page.length;
        }
        return values;
      })();
      precisionCatalog.set(market, pending);
      void pending.catch(() => precisionCatalog.delete(market));
    }
    const decimals = (await pending).get(symbol);
    if (decimals === undefined)
      throw new Error(`证券目录缺少价格精度：${symbol}`);
    return decimals;
  }

  /** 五档盘口快照；指数没有可交易盘口，返回空 bids/asks。 */
  async function securityQuotes(symbols: string[]): Promise<TdxQuote[]> {
    const quotes: TdxQuote[] = [];
    for (let i = 0; i < symbols.length; i += QUOTES_BATCH_LIMIT) {
      const batch = symbols.slice(i, i + QUOTES_BATCH_LIMIT);
      const decimals = new Map<string, number>();
      for (const symbol of batch)
        decimals.set(symbol, await securityDecimals(symbol));
      quotes.push(
        ...(await send(
          () => buildQuotesRequest(batch),
          (body) =>
            parseQuotes(body, batch, decimals).map((quote) =>
              isIndexSymbol(quote.symbol)
                ? { ...quote, bids: [], asks: [] }
                : quote,
            ),
        )),
      );
    }
    return quotes;
  }

  /**
   * 一页逐笔成交。价格在页内差分累加，所以按页取、按页用，不要跨页拼接后再截断。
   *
   * 分页方向已在真实服务器上实测：**start 是从最新一笔往回数的偏移**，
   * start=0 拿到的是当前最新的成交，start 越大越早。
   */
  async function transactionPage(
    symbol: string,
    start: number,
    count = PAGE_LIMIT,
  ): Promise<TdxTransaction[]> {
    const decimals = await securityDecimals(symbol);
    return send(
      () => buildTransactionsRequest(symbol, start, count),
      (body) => parseTransactions(body, false, decimals),
    );
  }

  /** 历史某日的一页逐笔成交；date 为 YYYYMMDD，无成交笔数字段。 */
  async function historyTransactionPage(
    symbol: string,
    date: number,
    start: number,
    count = PAGE_LIMIT,
  ): Promise<TdxTransaction[]> {
    const decimals = await securityDecimals(symbol);
    return send(
      () => buildHistoryTransactionsRequest(symbol, date, start, count),
      (body) => parseTransactions(body, true, decimals),
    );
  }

  /**
   * 一页 K 线。开盘价在页内逐条累加，所以整页要一起用，不能跨页拼后再截断。
   */
  function barPage(
    symbol: string,
    kline: KlineName,
    start: number,
    count = PAGE_LIMIT,
  ): Promise<TdxBar[]> {
    return send(
      () => buildBarsRequest(symbol, kline, start, count),
      (body) => parseBars(body, kline),
    );
  }

  /** 指数 K 线；记录尾部多出当期涨跌家数。 */
  function indexBarPage(
    symbol: string,
    kline: KlineName,
    start: number,
    count = PAGE_LIMIT,
  ): Promise<TdxBar[]> {
    return send(
      () => buildBarsRequest(symbol, kline, start, count),
      (body) => parseBars(body, kline, true),
    );
  }

  /** 当日分时；盘中只到当前时刻，盘后可能仍返回整日数据。 */
  async function minutes(symbol: string): Promise<TdxMinute[]> {
    const decimals = await securityDecimals(symbol);
    return send(
      () => buildMinuteRequest(symbol),
      (body) => parseMinutes(body, symbol, false, decimals),
    );
  }

  /** 历史某日分时；date 为 YYYYMMDD。 */
  async function historyMinutes(
    symbol: string,
    date: number,
  ): Promise<TdxMinute[]> {
    const decimals = await securityDecimals(symbol);
    return send(
      () => buildHistoryMinuteRequest(symbol, date),
      (body) => parseMinutes(body, symbol, true, decimals),
    );
  }

  /**
   * 单只证券的除权除息历史。
   *
   * 返回协议原始事件，不与本地文件或其他提供商自动合并。
   */
  function xdxr(symbol: string): Promise<TdxXdxr[]> {
    return send(
      () => buildXdxrRequest(symbol),
      (body) => parseXdxr(body, symbol),
    );
  }

  /**
   * 最新财务快照。更新时点由服务器决定、口径不透明，适合取流通股本这类
   * 结构性字段；财报分析需要额外验证字段口径。
   */
  function finance(symbol: string): Promise<TdxFinance> {
    return send(
      () => buildFinanceRequest(symbol),
      (body) => parseFinance(body, symbol),
    );
  }

  return {
    ...createExtendedQueries(
      {
        barPage,
        indexBarPage,
        securityQuotes,
        transactionPage,
        historyTransactionPage,
        xdxr,
      },
      send,
      (): BatchWorker => createTdxClient(options),
    ),
    securityQuotes,
    transactionPage,
    historyTransactionPage,
    barPage,
    indexBarPage,
    minutes,
    historyMinutes,
    xdxr,
    finance,
    close: closeQuotes,
    heartbeat,
    reconnect,
    retry,
    startHeartbeat,
    stopHeartbeat,
  };
}
export type TdxClient = ReturnType<typeof createTdxClient>;

export async function pingAll(
  hosts: readonly string[] = TDX_HOSTS,
  options: { port?: number; timeoutMs?: number; parallel?: number } = {},
) {
  const parallel = uint(options.parallel ?? 4, "parallel", 16, 1);
  const timeout = uint(options.timeoutMs ?? 3000, "timeoutMs", 60000, 1);
  const results: {
    host: string;
    connected: boolean;
    elapsedMs: number;
    error?: string;
  }[] = new Array(hosts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, hosts.length) }, async () => {
      while (next < hosts.length) {
        const i = next++,
          host = hosts[i]!,
          begin = performance.now();
        let session: TdxSession | undefined;
        try {
          session = await TdxSession.connect(
            host,
            options.port ?? PORT,
            timeout,
          );
          results[i] = {
            host,
            connected: true,
            elapsedMs: performance.now() - begin,
          };
        } catch (error) {
          results[i] = {
            host,
            connected: false,
            elapsedMs: performance.now() - begin,
            error: String(error),
          };
        } finally {
          await session?.close();
        }
      }
    }),
  );
  return results.sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) || a.elapsedMs - b.elapsedMs,
  );
}
export async function fromBestHost(
  options: Omit<TdxClientOptions, "hosts"> & { hosts?: readonly string[] } = {},
) {
  const ranked = await pingAll(options.hosts, options),
    hosts = ranked.filter((r) => r.connected).map((r) => r.host);
  if (!hosts.length)
    throw new Error(
      `没有可连接的行情节点：${ranked.map((r) => r.error).join("；")}`,
    );
  return createTdxClient({ ...options, hosts });
}
