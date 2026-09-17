import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Bar } from "~/lib/domain";
import type { ChartAdjustment } from "~/lib/chart-adjustment";
import { GBBQ_KEY_BASE64 } from "./tdx-gbbq-key";
import { XDXR_CATEGORIES, type TdxXdxr } from "./tdx-wire";

/**
 * 通达信本机 gbbq（股本变迁）文件的解析与复权因子计算。
 *
 * gbbq 位于 `T0002/hq_cache/gbbq`，随通达信自身更新，一个文件覆盖全市场的
 * 除权除息与股本变动历史 —— 相比逐只走 7709 协议查询，这是取复权数据的
 * 首选路径。文件只读不写，绝不修改通达信目录下的任何内容。
 *
 * 记录结构与解密轮函数参考 MIT 许可的 rustdx 项目，实现代码为本仓库自有。
 */

const KEY = Buffer.from(GBBQ_KEY_BASE64, "base64"),
  S1 = 0x48,
  S2 = 0x448,
  S3 = 0x848,
  S4 = 0xc48,
  RECORD_SIZE = 29,
  /** 每条记录只有前 24 字节（3 个 Blowfish 块）被加密，尾部 5 字节是明文。 */
  ENCRYPTED_SIZE = 24;

const box = (offset: number, index: number) =>
  KEY.readUInt32LE(offset + index * 4);

/** 标准 Blowfish 轮函数：((S1[a] + S2[b]) ^ S3[c]) + S4[d]，全程 32 位无符号。 */
function feistel(value: number) {
  const mixed = (box(S1, value >>> 24) + box(S2, (value >>> 16) & 0xff)) >>> 0;
  return (
    ((mixed ^ box(S3, (value >>> 8) & 0xff)) + box(S4, value & 0xff)) >>> 0
  );
}

/** Blowfish ECB 解密，P 数组逆序使用。就地改写传入的缓冲区。 */
function decrypt(block: Buffer) {
  for (let offset = 0; offset < ENCRYPTED_SIZE; offset += 8) {
    let left = (KEY.readUInt32LE(0x44) ^ block.readUInt32LE(offset)) >>> 0,
      right = block.readUInt32LE(offset + 4);
    for (let round = 64; round >= 4; round -= 4) {
      const next =
        (right ^ ((feistel(left) ^ KEY.readUInt32LE(round)) >>> 0)) >>> 0;
      right = left;
      left = next;
    }
    block.writeUInt32LE((right ^ KEY.readUInt32LE(0)) >>> 0, offset);
    block.writeUInt32LE(left, offset + 4);
  }
  return block;
}

/**
 * 解析整个 gbbq 文件：4 字节记录数，其后每 29 字节一条。
 *
 * 分红与送配比例按协议的每 10 股口径给出，这里统一除以 10 换成每股，
 * 与 7709 协议解析出的除权记录形状一致，两条路的结果可以直接互相校验。
 */
export function parseGbbq(buffer: Buffer): Map<string, TdxXdxr[]> {
  if (buffer.length < 4) throw new Error("gbbq 文件过短");
  const count = buffer.readUInt32LE(0);
  if (buffer.length < 4 + count * RECORD_SIZE)
    throw new Error(
      `gbbq 文件不完整：声明 ${count} 条，实际只有 ${Math.floor((buffer.length - 4) / RECORD_SIZE)} 条`,
    );
  const events = new Map<string, TdxXdxr[]>();
  for (let i = 0; i < count; i++) {
    const record = decrypt(
      Buffer.from(
        buffer.subarray(4 + i * RECORD_SIZE, 4 + (i + 1) * RECORD_SIZE),
      ),
    );
    const market = record.readUInt8(0),
      code = record.toString("ascii", 1, 7),
      packed = record.readUInt32LE(8),
      category = record.readUInt8(12);
    // gbbq 覆盖全市场，含指数、基金、债券等非 A 股品种；损坏或未知记录直接跳过，
    // 因为整份文件里只要有少数条目解不出，也不应连累其余可用的历史。
    if (!/^\d{6}$/.test(code) || !XDXR_CATEGORIES[category]) continue;
    const date = formatPacked(packed);
    if (!date) continue;
    const symbol = (market === 1 ? "sh" : market === 0 ? "sz" : "bj") + code,
      first = record.readFloatLE(13),
      second = record.readFloatLE(17),
      third = record.readFloatLE(21),
      fourth = record.readFloatLE(25),
      event: TdxXdxr = { date, category, name: XDXR_CATEGORIES[category]! };
    if (category === 1) {
      event.dividend = first / 10;
      event.rightsPrice = second;
      event.bonusRatio = third / 10;
      event.rightsRatio = fourth / 10;
    } else if (category === 11 || category === 12) event.shrinkRatio = third;
    else if (category === 13 || category === 14) {
      event.strikePrice = first;
      event.warrantShares = third;
    } else {
      // 股本字段在文件里是万股，换算成股，与 7709 协议解析出的口径一致。
      event.floatSharesBefore = first * 10000;
      event.totalSharesBefore = second * 10000;
      event.floatSharesAfter = third * 10000;
      event.totalSharesAfter = fourth * 10000;
    }
    const list = events.get(symbol);
    if (list) list.push(event);
    else events.set(symbol, [event]);
  }
  for (const list of events.values())
    list.sort((left, right) => left.date.localeCompare(right.date));
  return events;
}

function formatPacked(packed: number) {
  const year = Math.floor(packed / 10000),
    month = Math.floor(packed / 100) % 100,
    day = packed % 100;
  if (
    year < 1990 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 读取通达信目录下的 gbbq。与本地行情文件同样的做法：读前读后各取一次文件
 * 状态，通达信正在写盘时宁可报错，也不返回半份数据。
 */
export async function readGbbq(root: string) {
  const path = join(resolve(root), "T0002", "hq_cache", "gbbq"),
    before = await stat(path),
    buffer = await readFile(path),
    after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("gbbq 文件正在更新");
  return { events: parseGbbq(buffer), modified: after.mtimeMs, path };
}

export type HistoricalFloatShareCoverage = {
  status: "available" | "partial" | "missing";
  source: "tdx-gbbq";
  coveredBars: number;
  missingBars: number;
  coveredStart: string | null;
  coveredEnd: string | null;
  missingIntervals: {
    start: string;
    end: string;
    bars: number;
    reason: string;
  }[];
  eventCount: number;
};

export type HistoricalFloatShareEvidence = {
  evidence: Readonly<
    Record<
      string,
      {
        date: string;
        availableDate: string;
        availableAt: string;
        source: "tdx-gbbq:floatSharesAfter";
        floatShares: number;
        volumeUnit: "share";
      }
    >
  >;
  coverage: HistoricalFloatShareCoverage;
};

/**
 * Derive day-level circulating shares from the GBBQ effective-day events.
 * A value is carried only after its own effective date; current shares are
 * never projected backwards into earlier bars.
 */
export function deriveHistoricalFloatShares(
  bars: readonly Bar[],
  events: readonly TdxXdxr[],
): HistoricalFloatShareEvidence {
  const usable = events
    .filter(
      (event) =>
        event.floatSharesAfter != null &&
        Number.isFinite(event.floatSharesAfter) &&
        event.floatSharesAfter > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const evidence: Record<
    string,
    HistoricalFloatShareEvidence["evidence"][string]
  > = {};
  const missingIntervals: HistoricalFloatShareCoverage["missingIntervals"] = [];
  let cursor = 0;
  let current: (typeof usable)[number] | undefined;
  let missingStart: string | null = null;
  let missingEnd: string | null = null;
  let missingCount = 0;
  const closeMissing = (end: string) => {
    if (!missingStart) return;
    missingIntervals.push({
      start: missingStart,
      end: missingEnd ?? end,
      bars: missingCount,
      reason:
        usable.length === 0
          ? "GBBQ缺少正数floatSharesAfter事件"
          : "行情起点早于第一条可知的GBBQ流通股本生效日",
    });
    missingStart = null;
    missingEnd = null;
    missingCount = 0;
  };
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    while (cursor < usable.length && usable[cursor]!.date <= day)
      current = usable[cursor++];
    if (!current) {
      missingStart ??= day;
      missingEnd = day;
      missingCount++;
      continue;
    }
    closeMissing(day);
    evidence[bar.date] = {
      date: bar.date,
      availableDate: current.date,
      availableAt: `${current.date}T15:00:00+08:00`,
      source: "tdx-gbbq:floatSharesAfter",
      floatShares: current.floatSharesAfter!,
      volumeUnit: "share",
    };
  }
  if (missingStart) closeMissing(missingEnd ?? missingStart);
  const coveredDates = Object.keys(evidence).sort();
  const coveredBars = coveredDates.length;
  const missingBars = bars.length - coveredBars;
  return {
    evidence,
    coverage: {
      status:
        coveredBars === 0
          ? "missing"
          : missingBars === 0
            ? "available"
            : "partial",
      source: "tdx-gbbq",
      coveredBars,
      missingBars,
      coveredStart: coveredDates[0] ?? null,
      coveredEnd: coveredDates.at(-1) ?? null,
      missingIntervals,
      eventCount: usable.length,
    },
  };
}

export type AdjustFactor = {
  date: string;
  /** 后复权因子，上市首日为 1，此后只增不减。 */
  factor: number;
  /** 该日的除权调整后前收盘；未除权日等于上一交易日收盘。 */
  preClose: number;
};

/**
 * 由日线与除权事件推出复权因子序列。
 *
 * 采用后复权口径：首个交易日因子为 1，其后逐日累乘，因此**已有的因子不会
 * 因为新增除权事件而改变**，追加数据只会往序列尾部添加。前复权因子随时可由
 * `factor / 最后一个 factor` 得到，但它每次除权都会改写全部历史 —— 所以存储
 * 一律用后复权，前复权只在展示时临时换算。
 *
 * 除权价公式（每 10 股口径）：
 *   调整后前收 = (前收 × 10 − 每 10 股派现 + 每 10 股配股数 × 配股价)
 *              ÷ (10 + 每 10 股配股数 + 每 10 股送转数)
 */
export function adjustmentFactors(
  bars: Bar[],
  events: TdxXdxr[] = [],
): AdjustFactor[] {
  const dividends = events.filter((event) => event.category === 1),
    factors: AdjustFactor[] = [],
    firstDay = bars[0]?.date.slice(0, 10);
  let factor = 1,
    previousClose = bars[0]?.close ?? 0,
    cursor = 0;
  // 上市首日及更早的除权事件没有可累乘的基准，按上市日因子为 1 的约定丢弃。
  while (
    cursor < dividends.length &&
    firstDay &&
    dividends[cursor]!.date <= firstDay
  )
    cursor++;
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    let base = previousClose;
    // 用 <= 而不是 ==：除权日可能落在停牌日或非交易日，那样的事件必须在其后
    // 第一个交易日补上。只认相等会让游标卡住，之后所有除权全被漏掉。
    while (cursor < dividends.length && dividends[cursor]!.date <= day) {
      const event = dividends[cursor]!,
        cash = (event.dividend ?? 0) * 10,
        rights = (event.rightsRatio ?? 0) * 10,
        bonus = (event.bonusRatio ?? 0) * 10,
        divisor = 10 + rights + bonus,
        adjusted =
          divisor > 0
            ? (base * 10 - cash + rights * (event.rightsPrice ?? 0)) / divisor
            : 0;
      // 因子只在除权日跳一次，跳幅正是被除权抹掉的那部分，这样复权序列在
      // 除权日不再出现假跳空；非除权日因子保持不变，日常涨跌不进因子。
      // 连续多次除权时逐次以上一次的调整结果为基准。
      if (adjusted > 0) {
        factor *= base / adjusted;
        base = adjusted;
      }
      cursor++;
    }
    factors.push({ date: bar.date, factor, preClose: base });
    previousClose = bar.close;
  }
  return factors;
}

export type AdjustMode = ChartAdjustment;

/**
 * 按显式指定的复权模式换算行情。因子必须与 bars 逐条对齐（同一次调用产出），
 * 成交量不做换算 —— 复权只改价格，量仍是实际成交股数。
 */
export function applyAdjustment(
  bars: Bar[],
  factors: AdjustFactor[],
  mode: AdjustMode,
): Bar[] {
  if (mode === "none") return bars;
  if (factors.length !== bars.length)
    throw new Error("复权因子与行情长度不一致");
  const last = factors.at(-1)?.factor ?? 1;
  if (!(last > 0)) throw new Error("复权因子非法");
  return bars.map((bar, index) => {
    const factor = factors[index]!.factor,
      scale = mode === "backward" ? factor : factor / last;
    if (!(scale > 0)) throw new Error(`复权因子非法：${bar.date}`);
    return {
      ...bar,
      open: bar.open * scale,
      high: bar.high * scale,
      low: bar.low * scale,
      close: bar.close * scale,
    };
  });
}

/**
 * Apply factors calculated from a full daily reference series to a chart
 * series. Minute bars use the factor of their trading day; bars before the
 * reference range retain the neutral factor instead of inventing history.
 */
export function applyAdjustmentByDate(
  bars: Bar[],
  factors: AdjustFactor[],
  mode: AdjustMode,
): Bar[] {
  if (mode === "none") return bars;
  const last = factors.at(-1)?.factor ?? 1;
  if (!(last > 0)) throw new Error("复权因子非法");
  let cursor = 0;
  return bars.map((bar) => {
    const day = bar.date.slice(0, 10);
    while (
      cursor + 1 < factors.length &&
      factors[cursor + 1]!.date.slice(0, 10) <= day
    )
      cursor++;
    const factor =
      factors[cursor] && factors[cursor]!.date.slice(0, 10) <= day
        ? factors[cursor]!.factor
        : 1;
    const scale = mode === "backward" ? factor : factor / last;
    if (!(scale > 0)) throw new Error(`复权因子非法：${bar.date}`);
    return {
      ...bar,
      open: bar.open * scale,
      high: bar.high * scale,
      low: bar.low * scale,
      close: bar.close * scale,
    };
  });
}
