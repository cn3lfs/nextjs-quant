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

/**
 * 股本变动类事件（相对 category 1 除权除息、11/12 扩缩股、13/14 权证）。
 * 与 `XDXR_CATEGORIES`（packages/tstdx/src/wire.ts:709）同名同序，这里只列
 * 参与「真实摊薄 vs 股份转让」判定的那些：解析器对 1/11/12/13/14 之外的类别
 * 一律按股本字段布局读（src/server/data-sources/tdx/tdx-gbbq.ts:96-107），集合必须与之一致。
 */
const SHARE_CHANGE_CATEGORIES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);

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
    /**
     * 股本变动类记录（2 送配股上市 … 10 可转债上市），按日期索引，同日多条时取
     * 最后一条。用途只有一个：区分 `bonusRatio > 0` 的两种情形——
     *
     * - **真实摊薄**：同日股本变动记录里 `totalSharesAfter > totalSharesBefore`
     *   → 股本真的增加，除权公式适用（行为与修复前逐字节相同）；
     * - **股份转让**（如股改对价）：`totalSharesAfter === totalSharesBefore`
     *   → 股本没有增加，价格从未被重新基准化，**因子不得跳变**。
     *
     * 修复前的代码对两者一视同仁，把转让也按 `divisor = 10 + 配股 + 送转` 处理，
     * 于是插出一个不存在的台阶。实测 sh600000 2006-05-12：因子恰好跳 1.3，
     * 而当日最高 10.66 高于「按 10 送 3 除权」的理论涨停 9.19（前收 10.86 /
     * 1.3 × 1.1），物理上不可能除权——原始 −5.99% 被复权成 +22.22%。
     *
     * 判据范围实测（280 只，`bonusRatio>0 || rightsRatio>0` 的 category-1 事件；
     * `.codex-runs/s4-xdxr-pairing-measure.ts`）：
     *   - 总股本增加 **519 起 / 156 只** → 沿用除权公式；
     *   - 总股本不变 **74 起 / 74 只** → 不再调整。**限定 category 5 只有 71 起**，
     *     另有 3 起记在 category 3（sh600346 2006-07-11、sh600499 2006-05-10、
     *     sz000035 1995-02-28），故这里用整个股本变动类集合而不是单个 category 5；
     *   - 总股本减少 1 起（sh600839 2006-04-12）→ 无公开依据，**沿用除权公式**；
     *   - 同日**没有**股本变动记录 422 起 / 116 只（事件之前共 806,902 根 K 线）
     *     → 维持现有行为。这些的比例呈逐年节奏（0.1–0.5 的年度送转），
     *     把它们也当作转让会把 80 万根 K 线的真实除权抹掉——没有依据时不改。
     */
    shareChangesByDate = new Map<string, TdxXdxr>();
  for (const event of events)
    if (SHARE_CHANGE_CATEGORIES.has(event.category))
      shareChangesByDate.set(event.date, event);
  const factors: AdjustFactor[] = [];
  const firstDay = bars[0]?.date.slice(0, 10);
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
      const event = dividends[cursor]!;
      // 股本未变的转让（股改对价等）：**股本部分不得参与除权** —— 没有新增股份
      // 就没有需要摊薄的价格，交易所也没有重新基准化。但当日若真有派现，派现仍
      // 必须调整（派现是要重新基准化的），所以这里只把配股/送转项归零，不整条跳过。
      // 见上方 shareChangesByDate 的实测分档；把整条跳过会连派现一起丢掉
      // （该过度修正被 .codex-runs/s4-gbbq-factor-diff.ts 的逐日比较当场抓出）。
      const shareChange = shareChangesByDate.get(event.date),
        sharesUnchanged =
          shareChange?.totalSharesBefore != null &&
          shareChange.totalSharesAfter != null &&
          shareChange.totalSharesAfter === shareChange.totalSharesBefore,
        cash = (event.dividend ?? 0) * 10,
        rights = sharesUnchanged ? 0 : (event.rightsRatio ?? 0) * 10,
        bonus = sharesUnchanged ? 0 : (event.bonusRatio ?? 0) * 10,
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

export type VolumeRatioCoverage = {
  status: "available" | "missing";
  reason: string | null;
  /** The bar whose share count is the fixed basis; explicit and never "today". */
  referenceDate: string | null;
  /**
   * Per-bar multiplier so raw volume can be compared on the reference day's
   * share-count basis. Empty when status is "missing".
   */
  ratios: number[];
};

/** GBBQ categories whose non-dividend fields carry floatSharesBefore/After
 * (see parseGbbq's else-branch: everything except 1/11/12/13/14). */
const SHARE_COUNT_CATEGORIES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);

function hasUsableFloatShares(event: TdxXdxr) {
  return (
    event.floatSharesBefore != null &&
    event.floatSharesAfter != null &&
    Number.isFinite(event.floatSharesBefore) &&
    Number.isFinite(event.floatSharesAfter) &&
    event.floatSharesBefore > 0 &&
    event.floatSharesAfter > 0
  );
}

/**
 * Derive a per-bar volume comparability ratio from dated GBBQ share-count
 * events, anchored at the *last* bar of the series (the explicit reference
 * date — never the security's present-day, out-of-window share count).
 *
 * A share-count change (bonus issue, rights issue, split/consolidation)
 * alters how many raw shares a given amount of trading turns into, so raw
 * volume before and after such an event is not directly comparable. The
 * ratio is the multiplier that restates a bar's raw volume in the reference
 * day's share-count terms: ratio(day) = product of (floatSharesAfter /
 * floatSharesBefore) for every quantified event strictly between `day` and
 * the reference day. Two consecutive 1:2 splits therefore compound to 4x for
 * bars before both events, not 2x from only the nearer one — the ratio is
 * built by walking bars backward from the reference day and multiplying in
 * every event crossed, never by taking a single event's local ratio.
 *
 * Any share-changing event in the window that is *not* quantified this way
 * (a category-1 除权除息 record with a bonus/rights ratio but no paired
 * floatSharesBefore/After, or a 扩缩股/非流通股缩股 record) leaves the
 * series' comparability undetermined, so the whole series is reported
 * "missing" rather than silently assuming ratio 1 for it.
 */
export function deriveVolumeRatios(
  bars: readonly Bar[],
  events: readonly TdxXdxr[],
): VolumeRatioCoverage {
  if (bars.length === 0)
    return {
      status: "missing",
      reason: "无日线，量能可比性无法判定",
      referenceDate: null,
      ratios: [],
    };
  const start = bars[0]!.date.slice(0, 10);
  const end = bars.at(-1)!.date.slice(0, 10);
  // The backward walk below treats bars[0] as the oldest day and bars.at(-1)
  // as the reference day, and advances the event cursor monotonically. A
  // descending or shuffled series would silently produce ratios anchored at
  // the wrong day, so refuse it instead of returning a plausible-looking
  // number.
  for (let i = 1; i < bars.length; i++)
    if (bars[i - 1]!.date.slice(0, 10) > bars[i]!.date.slice(0, 10))
      throw new Error("量能可比性要求日线按日期升序");
  const inWindow = (event: TdxXdxr) => event.date > start && event.date <= end;
  const unquantified = events.filter(
    (event) =>
      inWindow(event) &&
      ((event.category === 1 &&
        ((event.bonusRatio ?? 0) > 0 || (event.rightsRatio ?? 0) > 0)) ||
        event.category === 11 ||
        event.category === 12 ||
        (SHARE_COUNT_CATEGORIES.has(event.category) &&
          !hasUsableFloatShares(event))),
  );
  if (unquantified.length > 0)
    return {
      status: "missing",
      reason: `研究窗口内 ${unquantified.length} 处送股/转增/配股/扩缩股等股本变动事件缺少GBBQ流通股本前后记录（floatSharesBefore/floatSharesAfter），量能可比性无法判定`,
      referenceDate: end,
      ratios: [],
    };
  const quantified = events
    .filter(
      (event) =>
        inWindow(event) &&
        SHARE_COUNT_CATEGORIES.has(event.category) &&
        hasUsableFloatShares(event),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  let cumulative = 1;
  let cursor = 0;
  const ratios = new Array<number>(bars.length);
  for (let i = bars.length - 1; i >= 0; i--) {
    const day = bars[i]!.date.slice(0, 10);
    while (cursor < quantified.length && quantified[cursor]!.date > day) {
      const event = quantified[cursor]!;
      cumulative *= event.floatSharesAfter! / event.floatSharesBefore!;
      cursor++;
    }
    ratios[i] = cumulative;
  }
  return { status: "available", reason: null, referenceDate: end, ratios };
}

/**
 * Scale raw volume by the per-bar ratios from {@link deriveVolumeRatios}.
 * Price fields are left untouched — this only restates the share-count
 * basis of volume, it is not a price adjustment.
 */
export function applyVolumeRatios(bars: Bar[], ratios: number[]): Bar[] {
  if (ratios.length !== bars.length)
    throw new Error("量能比例与日线长度不一致");
  return bars.map((bar, index) => ({
    ...bar,
    volume: bar.volume * ratios[index]!,
  }));
}

/**
 * Apply the daily volume ratios to a finer-grained (e.g. five-minute) series
 * keyed by trading day. Bars outside the daily ratio series' date range keep
 * their raw volume instead of inventing a ratio.
 */
export function applyVolumeRatiosByDate(
  bars: Bar[],
  dailyDates: readonly string[],
  ratios: number[],
): Bar[] {
  if (dailyDates.length !== ratios.length)
    throw new Error("量能比例与日线长度不一致");
  const byDate = new Map(
    dailyDates.map((date, index) => [date.slice(0, 10), ratios[index]!]),
  );
  return bars.map((bar) => {
    const ratio = byDate.get(bar.date.slice(0, 10)) ?? 1;
    return { ...bar, volume: bar.volume * ratio };
  });
}
