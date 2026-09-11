import { Socket } from "node:net";
import { ConnectionPool } from "./connection-pool";
import { get, put } from "./db";
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
  type KlineName,
  type TdxBar,
  type TdxFinance,
  type TdxMinute,
  type TdxQuote,
  type TdxTransaction,
  type TdxXdxr,
} from "./tdx-wire";

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

/**
 * 行情服务器可以覆盖：环境变量 `TDX_HOSTS`（逗号分隔）优先，其次本地配置里的
 * `tdx-hosts`，最后才是内置列表。公共服务器随时可能失效，写死一份是不够的。
 *
 * 这里刻意不进 settingsSchema：那份 schema 是全项目共用的，单独存一条配置
 * 既能让界面按需读写，也不会和别处对配置定义的改动互相争抢。
 */
export const TDX_HOSTS_KEY = "tdx-hosts";
const hostPattern = /^[a-zA-Z0-9.-]{1,253}$/;

export function parseHosts(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",") : [];
  const hosts = list.map((host) => host.trim()).filter(Boolean);
  if (hosts.some((host) => !hostPattern.test(host)))
    throw new Error("行情服务器地址含非法字符");
  return hosts;
}

/** 读取生效的服务器列表；配置为空或读取失败时回落到内置列表。 */
export function configuredHosts(): readonly string[] {
  const fromEnv = parseHosts(process.env.TDX_HOSTS);
  if (fromEnv.length) return fromEnv;
  try {
    const stored = get<{ hosts?: string[] }>(TDX_HOSTS_KEY)?.hosts;
    if (Array.isArray(stored) && stored.length)
      return parseHosts(stored.join(","));
  } catch {
    // 配置不可读时不该让行情整体不可用，回落到内置列表。
  }
  return TDX_HOSTS;
}

/** 保存自定义服务器列表；传空数组即恢复内置列表。 */
export function saveHosts(hosts: string[]) {
  const checked = parseHosts(hosts.join(","));
  put(TDX_HOSTS_KEY, TDX_HOSTS_KEY, { hosts: checked });
  void pool.close();
  return checked;
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
    for (const frame of SETUP_FRAMES) await session.exchange(frame);
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
export function createQuotesPool(hosts?: readonly string[], port = PORT) {
  return new ConnectionPool(async () => {
    const failures: string[] = [];
    for (const host of hosts ?? configuredHosts())
      try {
        return await TdxSession.connect(host, port);
      } catch (error) {
        failures.push(
          `${host}: ${error instanceof Error ? error.message : "连接失败"}`,
        );
      }
    throw new Error(`所有行情服务器均不可用：${failures.join("；")}`);
  });
}
const pool = createQuotesPool();

async function send<T>(build: () => Buffer, parse: (body: Buffer) => T) {
  return pool.use(async (session) => {
    try {
      return parse(await session.request(build()));
    } catch (error) {
      pool.invalidate(session);
      throw error;
    }
  });
}
export const closeQuotes = () => pool.close();

/** 五档盘口快照；超过单包上限时自动分片，返回顺序与入参一致。 */
export async function securityQuotes(symbols: string[]): Promise<TdxQuote[]> {
  const quotes: TdxQuote[] = [];
  for (let i = 0; i < symbols.length; i += QUOTES_BATCH_LIMIT) {
    const batch = symbols.slice(i, i + QUOTES_BATCH_LIMIT);
    quotes.push(
      ...(await send(
        () => buildQuotesRequest(batch),
        (body) => parseQuotes(body, batch),
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
export function transactionPage(
  symbol: string,
  start: number,
  count = PAGE_LIMIT,
): Promise<TdxTransaction[]> {
  return send(
    () => buildTransactionsRequest(symbol, start, count),
    (body) => parseTransactions(body, false),
  );
}

/** 历史某日的一页逐笔成交；date 为 YYYYMMDD，无成交笔数字段。 */
export function historyTransactionPage(
  symbol: string,
  date: number,
  start: number,
  count = PAGE_LIMIT,
): Promise<TdxTransaction[]> {
  return send(
    () => buildHistoryTransactionsRequest(symbol, date, start, count),
    (body) => parseTransactions(body, true),
  );
}

/**
 * 一页 K 线。开盘价在页内逐条累加，所以整页要一起用，不能跨页拼后再截断。
 * 本地 vipdoc 已覆盖日线与 5 分钟线；这里主要用于本地缺失的周期和补历史。
 */
export function barPage(
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
export function indexBarPage(
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

/** 当日分时；盘中只到当前时刻，非交易时段返回空。 */
export function minutes(symbol: string): Promise<TdxMinute[]> {
  return send(
    () => buildMinuteRequest(symbol),
    (body) => parseMinutes(body, symbol, false),
  );
}

/** 历史某日分时；date 为 YYYYMMDD。 */
export function historyMinutes(
  symbol: string,
  date: number,
): Promise<TdxMinute[]> {
  return send(
    () => buildHistoryMinuteRequest(symbol, date),
    (body) => parseMinutes(body, symbol, true),
  );
}

/**
 * 单只证券的除权除息历史。
 *
 * 全市场复权优先读本机 gbbq 文件（见 tdx-gbbq.ts）：一个文件覆盖全部证券，
 * 不受服务器限速影响。这里适合只查一两只、或与 gbbq 结果交叉核对时使用。
 */
export function xdxr(symbol: string): Promise<TdxXdxr[]> {
  return send(
    () => buildXdxrRequest(symbol),
    (body) => parseXdxr(body, symbol),
  );
}

/**
 * 最新财务快照。更新时点由服务器决定、口径不透明，适合取流通股本这类
 * 结构性字段；财报口径的分析仍应走既有的 hithink 数据源。
 */
export function finance(symbol: string): Promise<TdxFinance> {
  return send(
    () => buildFinanceRequest(symbol),
    (body) => parseFinance(body, symbol),
  );
}
