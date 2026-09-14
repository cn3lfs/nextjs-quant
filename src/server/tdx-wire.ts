import { inflateSync } from "node:zlib";
import { symbolSchema, type Bar } from "~/lib/domain";

/**
 * 通达信 7709 行情协议的编解码，纯函数、不做任何 IO。
 *
 * 该协议没有公开规范。这里的帧布局、命令码、字段顺序与偏移，均为对公开
 * 兼容实现（pytdx，MIT）与真实抓包交叉核对后得到的协议事实；握手帧的三条
 * 常量字节直接来自 pytdx。实现代码为本仓库自有。
 *
 * 该协议只覆盖行情查询，不涉及登录、委托或账户，也不读写通达信本地目录。
 */

/** 协议内的市场编号。本仓库对外一律使用 sh/sz/bj 符号前缀。 */
export const MARKET = { sz: 0, sh: 1, bj: 2 } as const;
const MARKET_NAMES = ["sz", "sh", "bj"] as const;

export type TdxQuote = {
  symbol: string;
  /** 单只证券快照的更新时刻 HH:MM:SS.mmm，不是服务器墙上时间，同批可不同。 */
  quoteTime: string;
  price: number;
  preClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** 最新一笔的成交量。 */
  currentVolume: number;
  amount: number;
  innerVolume: number;
  outerVolume: number;
  riseSpeed: number;
  bids: TdxLevel[];
  asks: TdxLevel[];
};
export type TdxLevel = { price: number; volume: number };
export type TdxTransaction = {
  /** 分钟精度，协议只给到分钟。 */
  time: string;
  price: number;
  volume: number;
  /** 0=买 1=卖 2=中性 8=集合竞价。 */
  direction: number;
  /** 当日逐笔独有；历史逐笔该字段不存在。 */
  orders: number | null;
};

/**
 * 连接建立后必须按序发送的三条握手帧，每条都要读走响应再发下一条。
 * 字节常量来自 pytdx（MIT）。
 */
export const SETUP_FRAMES = [
  Buffer.from("0c0218930001030003000d0001", "hex"),
  Buffer.from("0c0218940001030003000d0002", "hex"),
  Buffer.from(
    "0c031899000120002000db0fd5d0c9ccd6a4a8af0000008fc22540130000d500c9ccbdf0d7ea00000002",
    "hex",
  ),
] as const;

export const FRAME_HEADER_SIZE = 16;
export type FrameHeader = { zipSize: number; unzipSize: number };

/** 响应帧头：12 字节未用 + uint16 body 长度 + uint16 解压后长度。 */
export function parseFrameHeader(buffer: Buffer): FrameHeader {
  if (buffer.length < FRAME_HEADER_SIZE) throw new Error("行情响应帧头不完整");
  return {
    zipSize: buffer.readUInt16LE(12),
    unzipSize: buffer.readUInt16LE(14),
  };
}

/** zipSize 与 unzipSize 相等表示未压缩，否则整个 body 是一段 zlib 流。 */
export function inflateBody(header: FrameHeader, rawBody: Buffer): Buffer {
  if (rawBody.length !== header.zipSize)
    throw new Error(
      `行情响应长度与帧头不符：帧头 ${header.zipSize}，实收 ${rawBody.length}`,
    );
  const body =
    header.zipSize === header.unzipSize ? rawBody : inflateSync(rawBody);
  if (body.length !== header.unzipSize)
    throw new Error(
      `行情响应解压长度与帧头不符：帧头 ${header.unzipSize}，实得 ${body.length}`,
    );
  return body;
}

export function splitSymbol(symbol: string) {
  const parsed = symbolSchema.parse(symbol),
    market = MARKET[parsed.slice(0, 2) as keyof typeof MARKET];
  return { market, code: parsed.slice(2) };
}
function joinSymbol(market: number, code: string) {
  const name = MARKET_NAMES[market];
  if (!name) throw new Error(`行情响应包含未知市场编号 ${market}`);
  return name + code;
}

/**
 * 协议自有的变长有符号整数：首字节 bit6 是符号位、低 6 位是数据，
 * 后续字节各带 7 位数据，bit7 为继续标记，低位在前。
 *
 * 累加必须用乘法而不是左移：数据位最多可越过 32 位，JS 的位运算会在那里溢出。
 */
export function readVarint(buffer: Buffer, position: number): [number, number] {
  let pos = position;
  if (pos < 0 || pos >= buffer.length)
    throw new Error(`变长整数越界：偏移 ${position}`);
  const first = buffer[pos]!;
  let value = first & 0x3f,
    shift = 6;
  const negative = (first & 0x40) !== 0;
  if (first & 0x80)
    for (;;) {
      if (++pos >= buffer.length)
        throw new Error(`变长整数被截断：偏移 ${position}`);
      const byte = buffer[pos]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
  return [negative ? -value : value, pos + 1];
}

/**
 * 成交额的 4 字节编码。它被普遍描述为通达信自定义浮点，但对 20 万个规格化
 * 随机值与 pytdx 系实现对拍的结果是：只要符号位为 0，两者逐位等价于
 * IEEE-754 float32，因此这里直接按 float32 读。
 *
 * 成交额恒非负，符号位置位只可能是字段错位或包损坏。pytdx 系实现会把符号位
 * 当作指数的最高位，返回 1e49 量级的值；这里改为报错，不让坏值流进指标。
 *
 * 仅适用于金额字段，价格字段用 readVarint —— 混用会静默得到错值。
 */
export function readAmount(buffer: Buffer, position: number): [number, number] {
  if (position < 0 || position + 4 > buffer.length)
    throw new Error(`成交额字段越界：偏移 ${position}`);
  const raw = buffer.readUInt32LE(position);
  if (raw === 0) return [0, position + 4];
  if (raw >= 0x80000000)
    throw new Error(`成交额字段为负，响应可能错位：偏移 ${position}`);
  const value = buffer.readFloatLE(position);
  if (!Number.isFinite(value))
    throw new Error(`成交额字段不是有限数，响应可能错位：偏移 ${position}`);
  return [value, position + 4];
}

/** 逐笔时间是 2 字节的当日分钟数。 */
function readTradeTime(buffer: Buffer, position: number): [string, number] {
  if (position + 2 > buffer.length)
    throw new Error(`逐笔时间字段越界：偏移 ${position}`);
  const minutes = buffer.readUInt16LE(position);
  return [
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    position + 2,
  ];
}

/** 快照时刻编码为「小时 + 小时的百万分之一」，例如 14999212 → 14:59:57.163。 */
function formatQuoteTime(raw: number) {
  const hours = Math.floor(raw / 1_000_000),
    millis = Math.floor(((raw % 1_000_000) * 3600) / 1000),
    minutes = Math.floor(millis / 60_000),
    seconds = Math.floor((millis % 60_000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis % 1000).padStart(3, "0")}`;
}

export const QUOTES_BATCH_LIMIT = 80;
export const PAGE_LIMIT = 800;

export function buildQuotesRequest(symbols: string[]): Buffer {
  if (!symbols.length) throw new Error("五档行情请求不能为空");
  if (symbols.length > QUOTES_BATCH_LIMIT)
    throw new Error(`五档行情单次最多 ${QUOTES_BATCH_LIMIT} 只`);
  if (new Set(symbols).size !== symbols.length)
    throw new Error("五档行情请求包含重复证券");
  const payload = symbols.length * 7 + 12,
    request = Buffer.alloc(22 + symbols.length * 7);
  request.writeUInt16LE(0x010c, 0);
  request.writeUInt32LE(0x02006320, 2);
  request.writeUInt16LE(payload, 6);
  request.writeUInt16LE(payload, 8);
  request.writeUInt32LE(0x0005053e, 10);
  request.writeUInt32LE(0, 14);
  request.writeUInt16LE(0, 18);
  request.writeUInt16LE(symbols.length, 20);
  symbols.forEach((symbol, i) => {
    const { market, code } = splitSymbol(symbol),
      offset = 22 + i * 7;
    request.writeUInt8(market, offset);
    request.write(code, offset + 1, 6, "ascii");
  });
  return request;
}

/**
 * 五档行情。所有价格以最新价为基准差分编码，量为变长整数，成交额为自定义浮点。
 * 记录中有若干语义未确认的字段，此处按协议顺序消费但不对外暴露，以免把
 * 未经验证的值当成指标使用。
 */
export function parseQuotes(body: Buffer, expected: string[]): TdxQuote[] {
  if (body.length < 4) throw new Error("五档行情响应过短");
  const count = body.readUInt16LE(2);
  if (count !== expected.length)
    throw new Error(
      `五档行情返回数量与请求不符：请求 ${expected.length}，返回 ${count}`,
    );
  let pos = 4;
  const quotes: TdxQuote[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 9 > body.length) throw new Error("五档行情记录头越界");
    const market = body.readUInt8(pos),
      code = body.toString("ascii", pos + 1, pos + 7);
    pos += 9; // 市场 1 + 代码 6 + 2 字节活跃度
    let price: number,
      preCloseDiff: number,
      openDiff: number,
      highDiff: number,
      lowDiff: number,
      timeRaw: number,
      volume: number,
      currentVolume: number,
      amount: number,
      innerVolume: number,
      outerVolume: number,
      skip: number;
    [price, pos] = readVarint(body, pos);
    [preCloseDiff, pos] = readVarint(body, pos);
    [openDiff, pos] = readVarint(body, pos);
    [highDiff, pos] = readVarint(body, pos);
    [lowDiff, pos] = readVarint(body, pos);
    [timeRaw, pos] = readVarint(body, pos);
    [skip, pos] = readVarint(body, pos); // 经验上等于 -price，语义未确认
    [volume, pos] = readVarint(body, pos);
    [currentVolume, pos] = readVarint(body, pos);
    [amount, pos] = readAmount(body, pos);
    [innerVolume, pos] = readVarint(body, pos);
    [outerVolume, pos] = readVarint(body, pos);
    [skip, pos] = readVarint(body, pos);
    [skip, pos] = readVarint(body, pos);
    const bids: TdxLevel[] = [],
      asks: TdxLevel[] = [];
    for (let level = 0; level < 5; level++) {
      let bidDiff: number,
        askDiff: number,
        bidVolume: number,
        askVolume: number;
      [bidDiff, pos] = readVarint(body, pos);
      [askDiff, pos] = readVarint(body, pos);
      [bidVolume, pos] = readVarint(body, pos);
      [askVolume, pos] = readVarint(body, pos);
      bids.push({ price: (price + bidDiff) / 100, volume: bidVolume });
      asks.push({ price: (price + askDiff) / 100, volume: askVolume });
    }
    if (pos + 2 > body.length) throw new Error("五档行情记录尾越界");
    pos += 2;
    for (let field = 0; field < 4; field++) [skip, pos] = readVarint(body, pos);
    if (pos + 4 > body.length) throw new Error("五档行情记录尾越界");
    const riseSpeed = body.readInt16LE(pos);
    pos += 4;
    const symbol = joinSymbol(market, code);
    if (symbol !== expected[i])
      throw new Error(
        `五档行情返回证券与请求不符：期望 ${expected[i]}，返回 ${symbol}`,
      );
    quotes.push({
      symbol,
      quoteTime: formatQuoteTime(timeRaw),
      price: price / 100,
      preClose: (price + preCloseDiff) / 100,
      open: (price + openDiff) / 100,
      high: (price + highDiff) / 100,
      low: (price + lowDiff) / 100,
      volume,
      currentVolume,
      amount,
      innerVolume,
      outerVolume,
      riseSpeed: riseSpeed / 100,
      bids,
      asks,
    });
  }
  return quotes;
}

/** 当日逐笔：服务器按由新到旧分页，start 为页内起点。 */
export function buildTransactionsRequest(
  symbol: string,
  start: number,
  count = PAGE_LIMIT,
): Buffer {
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(12 + 12);
  Buffer.from("0c17080101010e000e00c50f", "hex").copy(request);
  request.writeUInt16LE(market, 12);
  request.write(code, 14, 6, "ascii");
  request.writeUInt16LE(checkPage(start, "start"), 20);
  request.writeUInt16LE(checkCount(count), 22);
  return request;
}

/** 历史逐笔：date 为 YYYYMMDD；响应比当日逐笔少一个成交笔数字段。 */
export function buildHistoryTransactionsRequest(
  symbol: string,
  date: number,
  start: number,
  count = PAGE_LIMIT,
): Buffer {
  checkDate(date, "历史逐笔日期");
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(12 + 16);
  Buffer.from("0c013001000112001200b50f", "hex").copy(request);
  request.writeUInt32LE(date, 12);
  request.writeUInt16LE(market, 16);
  request.write(code, 18, 6, "ascii");
  request.writeUInt16LE(checkPage(start, "start"), 24);
  request.writeUInt16LE(checkCount(count), 26);
  return request;
}
function formatDate(date: number) {
  const text = String(date);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
}
function checkPage(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff)
    throw new Error(`${name} 必须是 0..65535 的整数`);
  return value;
}
function checkCount(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > PAGE_LIMIT)
    throw new Error(`count 必须是 1..${PAGE_LIMIT} 的整数`);
  return value;
}
function checkDate(date: number, label: string) {
  const text = String(date);
  if (!/^\d{8}$/.test(text) || Number.isNaN(Date.parse(formatDate(date))))
    throw new Error(`${label}必须是有效的 YYYYMMDD`);
  return date;
}

/**
 * 逐笔成交。价格在页内按差分累加，因此整页必须一次解析完，
 * 不能只解析其中一段记录。
 */
export function parseTransactions(
  body: Buffer,
  history: boolean,
): TdxTransaction[] {
  if (body.length < 2) throw new Error("逐笔成交响应过短");
  const count = body.readUInt16LE(0);
  let pos = history ? 6 : 2, // 历史逐笔在计数后多 4 字节填充
    price = 0;
  const records: TdxTransaction[] = [];
  for (let i = 0; i < count; i++) {
    let time: string,
      diff: number,
      volume: number,
      orders: number,
      direction: number,
      skip: number;
    [time, pos] = readTradeTime(body, pos);
    [diff, pos] = readVarint(body, pos);
    [volume, pos] = readVarint(body, pos);
    orders = 0;
    if (!history) [orders, pos] = readVarint(body, pos);
    [direction, pos] = readVarint(body, pos);
    [skip, pos] = readVarint(body, pos);
    price += diff;
    records.push({
      time,
      price: price / 100,
      volume,
      direction,
      orders: history ? null : orders,
    });
  }
  return records;
}

/** K 线周期。分钟级与日级的时间戳编码不同，解析时必须带上周期。 */
export const KLINE = {
  "1m": 7,
  "5m": 0,
  "15m": 1,
  "30m": 2,
  "60m": 3,
  day: 4,
  week: 5,
  month: 6,
  quarter: 10,
  year: 11,
} as const;
export type KlineName = keyof typeof KLINE;
export const BARS_REQUEST_SIZE = 38;
const isMinuteKline = (category: number) =>
  category < 4 || category === 7 || category === 8;

export function buildBarsRequest(
  symbol: string,
  kline: KlineName,
  start: number,
  count = PAGE_LIMIT,
): Buffer {
  // 整包必须是 38 字节：尾部三个填充字段（4+4+2）少一个字节，服务器就不回包。
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(BARS_REQUEST_SIZE);
  request.writeUInt16LE(0x010c, 0);
  request.writeUInt32LE(0x01016408, 2);
  request.writeUInt16LE(0x001c, 6);
  request.writeUInt16LE(0x001c, 8);
  request.writeUInt16LE(0x052d, 10);
  request.writeUInt16LE(market, 12);
  request.write(code, 14, 6, "ascii");
  request.writeUInt16LE(KLINE[kline], 20);
  request.writeUInt16LE(1, 22);
  request.writeUInt16LE(checkPage(start, "start"), 24);
  request.writeUInt16LE(checkCount(count), 26);
  return request;
}

/**
 * K 线。开盘价在整页内逐条累加（每条以上一条的收盘为基准），所以整页要一次解析完。
 * 价格单位是千分之一，与本地 day 文件的百分之一不同。
 *
 * 校验规则与本地 day 文件解析保持一致：OHLC 必须自洽、日期合法、时间严格递增。
 * 两处各自实现，因为本地文件与网络包的字段布局完全不同，共用只会绑住两边。
 */
export function parseBars(
  body: Buffer,
  kline: KlineName,
  breadth = false,
): TdxBar[] {
  if (body.length < 2) throw new Error("K 线响应过短");
  const category = KLINE[kline],
    minute = isMinuteKline(category),
    count = body.readUInt16LE(0);
  if (count > 0 && body.length === 2)
    throw new Error(
      "通达信服务器未返回 K 线正文（只有数量字段），请换服务器或数据源",
    );
  let pos = 2,
    base = 0;
  const bars: TdxBar[] = [];
  for (let i = 0; i < count; i++) {
    let date: string;
    [date, pos] = readBarTime(body, pos, minute);
    let openDiff: number,
      closeDiff: number,
      highDiff: number,
      lowDiff: number,
      volume: number,
      amount: number;
    [openDiff, pos] = readVarint(body, pos);
    [closeDiff, pos] = readVarint(body, pos);
    [highDiff, pos] = readVarint(body, pos);
    [lowDiff, pos] = readVarint(body, pos);
    [volume, pos] = readAmount(body, pos);
    [amount, pos] = readAmount(body, pos);
    let upCount: number | undefined, downCount: number | undefined;
    if (breadth) {
      if (pos + 4 > body.length) throw new Error("指数 K 线涨跌家数越界");
      upCount = body.readUInt16LE(pos);
      downCount = body.readUInt16LE(pos + 2);
      pos += 4;
    }
    const open = openDiff + base,
      close = open + closeDiff,
      high = open + highDiff,
      low = open + lowDiff;
    base = close;
    const bar: TdxBar = {
      date,
      open: open / 1000,
      high: high / 1000,
      low: low / 1000,
      close: close / 1000,
      volume,
      amount,
    };
    if (breadth) Object.assign(bar, { upCount, downCount });
    checkBar(bar, bars.at(-1));
    bars.push(bar);
  }
  return bars;
}
export type TdxBar = Bar & { upCount?: number; downCount?: number };

function readBarTime(
  buffer: Buffer,
  position: number,
  minute: boolean,
): [string, number] {
  if (position + 4 > buffer.length) throw new Error("K 线时间字段越界");
  if (!minute) {
    const packed = buffer.readUInt32LE(position);
    return [
      `${Math.floor(packed / 10000)}-${pad(Math.floor(packed / 100) % 100)}-${pad(packed % 100)}`,
      position + 4,
    ];
  }
  const packed = buffer.readUInt16LE(position),
    minutes = buffer.readUInt16LE(position + 2),
    md = packed & 2047;
  if (minutes >= 1440) throw new Error("K 线分钟时间非法");
  return [
    `${(packed >> 11) + 2004}-${pad(Math.floor(md / 100))}-${pad(md % 100)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00+08:00`,
    position + 4,
  ];
}
const pad = (value: number) => String(value).padStart(2, "0");

function checkBar(bar: TdxBar, previous?: TdxBar) {
  const day = bar.date.slice(0, 10),
    parsed = new Date(day);
  if (
    !Number.isFinite(+parsed) ||
    parsed.toISOString().slice(0, 10) !== day ||
    day < "1990-01-01" ||
    ![bar.open, bar.high, bar.low, bar.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !Number.isFinite(bar.amount) ||
    bar.amount < 0 ||
    bar.low > Math.min(bar.open, bar.close) ||
    bar.high < Math.max(bar.open, bar.close) ||
    bar.high < bar.low
  )
    throw new Error(`K 线记录非法：${bar.date}`);
  if (previous && bar.date <= previous.date)
    throw new Error("K 线时间重复或倒序");
}

export type TdxMinute = { price: number; volume: number };
/** 分时价格的合理区间，用于在定位数据块时排除错位解。 */
const MINUTE_PRICE_MIN = 0.01,
  MINUTE_PRICE_MAX = 100000;

/** 当日分时；盘中只返回到当前时刻，全天 240 条。 */
export function buildMinuteRequest(symbol: string): Buffer {
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(12 + 12);
  Buffer.from("0c1b080001010e000e001d05", "hex").copy(request);
  request.writeUInt16LE(market, 12);
  request.write(code, 14, 6, "ascii");
  return request;
}

/** 历史某日分时；这条命令的响应格式一直是旧布局。 */
export function buildHistoryMinuteRequest(
  symbol: string,
  date: number,
): Buffer {
  checkDate(date, "历史分时日期");
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(12 + 11);
  Buffer.from("0c01300001010d000d00b40f", "hex").copy(request);
  request.writeUInt32LE(date, 12);
  request.writeUInt8(market, 16);
  request.write(code, 17, 6, "ascii");
  return request;
}

/**
 * 分时。每点三个变长整数：价格增量、保留字段、成交量；价格按增量累加。
 *
 * 当日分时从 2026 年起换了布局：11 字节头（点数 2 + 跳过 2 + 市场 1 + 代码 6）
 * 之后，还夹着一段盘口统计快照，其变长整数**个数随行情内容浮动**，没法正向跳过。
 * 好在数据块恰好耗尽到响应末尾，于是正向穷举头部结束位置：只接受能读满
 * `点数 × 3` 个整数、恰好停在末尾、且价格与成交量都合理的那个切分。
 *
 * 变长整数不自同步（bit7=0 的字节既可能是单字节整数，也可能是多字节整数的
 * 末字节），所以只能正向穷举，不能从尾部反推。
 *
 * 历史分时仍是旧布局：6 字节头后直接是数据。
 */
export function parseMinutes(
  body: Buffer,
  symbol: string,
  history: boolean,
): TdxMinute[] {
  if (body.length < 4) throw new Error("分时响应过短");
  const count = body.readUInt16LE(0);
  if (count === 0) return [];
  const { code } = splitSymbol(symbol),
    // 新布局的标志：头里回显了请求的市场与代码。
    isNewLayout =
      !history &&
      body.length >= 11 &&
      body.readUInt16LE(2) === 0 &&
      body.toString("ascii", 5, 11) === code;
  if (isNewLayout) return locateMinutes(body, count);
  const decoded = decodeMinutes(body, history ? 6 : 4, count);
  // 旧布局允许尾部残留少量字节，但点数和价格必须完整可信。
  if (!decoded || decoded.end + 8 < body.length || !validMinutes(decoded.bars))
    throw new Error("分时响应与已知布局不符");
  return decoded.bars;
}

function locateMinutes(body: Buffer, count: number) {
  const starts: number[] = [];
  let pos = 11;
  while (pos < body.length) {
    starts.push(pos);
    try {
      [, pos] = readVarint(body, pos);
    } catch {
      break;
    }
  }
  const need = count * 3;
  if (starts.length < need) throw new Error(`分时响应放不下 ${count} 个数据点`);
  for (let i = 0; i + need <= starts.length; i++) {
    const decoded = decodeMinutes(body, starts[i]!, count);
    if (decoded && decoded.end === body.length && validMinutes(decoded.bars))
      return decoded.bars;
  }
  throw new Error("分时数据块无法在响应中唯一定位");
}

function decodeMinutes(body: Buffer, start: number, count: number) {
  let pos = start,
    price = 0;
  const bars: TdxMinute[] = [];
  for (let i = 0; i < count; i++) {
    let diff: number, skip: number, volume: number;
    try {
      [diff, pos] = readVarint(body, pos);
      [skip, pos] = readVarint(body, pos);
      [volume, pos] = readVarint(body, pos);
    } catch {
      return undefined;
    }
    price += diff;
    bars.push({ price: price / 100, volume });
  }
  return { bars, end: pos };
}

const validMinutes = (bars: TdxMinute[]) =>
  bars.every(
    (bar) =>
      bar.price >= MINUTE_PRICE_MIN &&
      bar.price <= MINUTE_PRICE_MAX &&
      bar.volume >= 0,
  );

/** 除权除息。复权因子可由此还原；也可直接读本机 gbbq 文件，见 tdx-gbbq.ts。 */

/** 除权除息。复权因子可由此还原；也可直接读本机 gbbq 文件，见 tdx-gbbq.ts。 */
export function buildXdxrRequest(symbol: string): Buffer {
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(14 + 7);
  Buffer.from("0c1f187600010b000b000f000100", "hex").copy(request);
  request.writeUInt8(market, 14);
  request.write(code, 15, 6, "ascii");
  return request;
}

export const XDXR_CATEGORIES: Record<number, string> = {
  1: "除权除息",
  2: "送配股上市",
  3: "非流通股上市",
  4: "未知股本变动",
  5: "股本变化",
  6: "增发新股",
  7: "股份回购",
  8: "增发新股上市",
  9: "转配股上市",
  10: "可转债上市",
  11: "扩缩股",
  12: "非流通股缩股",
  13: "送认购权证",
  14: "送认沽权证",
};
export type TdxXdxr = {
  date: string;
  category: number;
  name: string;
  /** 每股口径；协议按每 10 股给出，这里已除以 10。 */
  dividend?: number;
  rightsPrice?: number;
  bonusRatio?: number;
  rightsRatio?: number;
  shrinkRatio?: number;
  strikePrice?: number;
  warrantShares?: number;
  /** 股本一律换算成股；协议按万股给出。 */
  floatSharesBefore?: number;
  totalSharesBefore?: number;
  floatSharesAfter?: number;
  totalSharesAfter?: number;
};

/**
 * 每条记录固定 16 字节负载，按事件类型换用三种不同的字段布局。
 * 值得一提的是：分红类按 4 个 IEEE float32 读，股本类按“通达信自定义浮点”读，
 * 而两者其实是同一种编码 —— 这也印证了 readAmount 的处理。
 */
export function parseXdxr(body: Buffer, symbol: string): TdxXdxr[] {
  if (body.length < 11) throw new Error("除权除息响应过短");
  const count = body.readUInt16LE(9);
  let pos = 11;
  const records: TdxXdxr[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 8 > body.length) throw new Error("除权除息记录头越界");
    const returned = joinSymbol(
      body.readUInt8(pos),
      body.toString("ascii", pos + 1, pos + 7),
    );
    if (returned !== symbol)
      throw new Error(
        `除权除息返回证券与请求不符：期望 ${symbol}，返回 ${returned}`,
      );
    pos += 8; // 市场 1 + 代码 6 + 1 字节填充
    let date: string;
    [date, pos] = readBarTime(body, pos, false);
    if (pos + 17 > body.length) throw new Error("除权除息记录越界");
    const category = body.readUInt8(pos);
    pos += 1;
    const record: TdxXdxr = {
      date,
      category,
      name: XDXR_CATEGORIES[category] ?? String(category),
    };
    if (category === 1) {
      record.dividend = body.readFloatLE(pos) / 10;
      record.rightsPrice = body.readFloatLE(pos + 4);
      record.bonusRatio = body.readFloatLE(pos + 8) / 10;
      record.rightsRatio = body.readFloatLE(pos + 12) / 10;
    } else if (category === 11 || category === 12) {
      record.shrinkRatio = body.readFloatLE(pos + 8);
    } else if (category === 13 || category === 14) {
      record.strikePrice = body.readFloatLE(pos);
      record.warrantShares = body.readFloatLE(pos + 8);
    } else {
      record.floatSharesBefore = readAmount(body, pos)[0] * 10000;
      record.totalSharesBefore = readAmount(body, pos + 4)[0] * 10000;
      record.floatSharesAfter = readAmount(body, pos + 8)[0] * 10000;
      record.totalSharesAfter = readAmount(body, pos + 12)[0] * 10000;
    }
    pos += 16;
    records.push(record);
  }
  return records;
}

/** 最新财务快照。口径与更新时点由服务器决定，不适合当作财报底稿。 */
export function buildFinanceRequest(symbol: string): Buffer {
  const { market, code } = splitSymbol(symbol),
    request = Buffer.alloc(14 + 7);
  Buffer.from("0c1f187600010b000b0010000100", "hex").copy(request);
  request.writeUInt8(market, 14);
  request.write(code, 15, 6, "ascii");
  return request;
}

/** 金额字段单位为万元、股本字段单位为万股，这里统一换算成元和股。 */
const FINANCE_SCALE = 10000,
  FINANCE_FIELDS = [
    "totalShares",
    "stateShares",
    "founderShares",
    "legalPersonShares",
    "bShares",
    "hShares",
    "employeeShares",
    "totalAssets",
    "currentAssets",
    "fixedAssets",
    "intangibleAssets",
    "shareholders",
    "currentLiabilities",
    "longTermLiabilities",
    "capitalReserve",
    "netAssets",
    "mainRevenue",
    "mainProfit",
    "receivables",
    "operatingProfit",
    "investmentIncome",
    "operatingCashFlow",
    "totalCashFlow",
    "inventory",
    "totalProfit",
    "afterTaxProfit",
    "netProfit",
    "undistributedProfit",
    "bookValuePerShare",
    "reserved",
  ] as const;
/** 这两个不是万元口径：股东户数是人数，每股净资产已是元/股。 */
const FINANCE_UNSCALED = new Set([
  "shareholders",
  "bookValuePerShare",
  "reserved",
]);
export type TdxFinance = Record<(typeof FINANCE_FIELDS)[number], number> & {
  floatShares: number;
  province: number;
  industry: number;
  updatedDate: number;
  ipoDate: number;
};

export function parseFinance(body: Buffer, symbol: string): TdxFinance {
  if (body.length < 9) throw new Error("财务数据响应过短");
  const returned = joinSymbol(body.readUInt8(2), body.toString("ascii", 3, 9));
  if (returned !== symbol)
    throw new Error(
      `财务数据返回证券与请求不符：期望 ${symbol}，返回 ${returned}`,
    );
  let pos = 9;
  if (pos + 136 > body.length) throw new Error("财务数据响应不完整");
  const finance = {
    floatShares: body.readFloatLE(pos) * FINANCE_SCALE,
    province: body.readUInt16LE(pos + 4),
    industry: body.readUInt16LE(pos + 6),
    updatedDate: body.readUInt32LE(pos + 8),
    ipoDate: body.readUInt32LE(pos + 12),
  } as TdxFinance;
  pos += 16;
  FINANCE_FIELDS.forEach((field, i) => {
    const value = body.readFloatLE(pos + i * 4);
    finance[field] = FINANCE_UNSCALED.has(field)
      ? value
      : value * FINANCE_SCALE;
  });
  return finance;
}
