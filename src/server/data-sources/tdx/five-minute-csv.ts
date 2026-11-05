import {
  fiveMinuteVolumePolicy,
  normalizeFiveMinuteVolume,
} from "./five-minute-volume";
/** CSV and lc5 conversion for explicitly requested imports. Timestamps are Shanghai local time. */
export type ImportVolumeUnit = "shares" | "lots";
export type CsvBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  amount: number;
  volume: number;
  volumeOverflow?: true;
  sourceVolume?: number;
};

export function parseFiveMinuteCsv(
  text: string,
  unit: ImportVolumeUnit,
  overflowPolicy: "error" | "zero-signed" | "zero-unsigned" = "error",
  symbol?: string,
): CsvBar[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header =
    lines
      .shift()
      ?.split(",")
      .map((v) => v.trim()) ?? [];
  const columns = ["Date", "Open", "Low", "High", "Close", "Volume", "Amount"];
  if (
    header.length !== columns.length ||
    columns.some((c) => !header.includes(c))
  )
    throw new Error(
      "CSV 列必须包含 Date, Open, Low, High, Close, Volume, Amount",
    );
  const result: CsvBar[] = [];
  let previous = "";
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const cells = line.split(",").map((v) => v.trim());
    if (cells.length !== header.length)
      throw new Error(`第 ${index + 2} 行列数错误`);
    const field = (name: string) => cells[header.indexOf(name)]!;
    const time = field("Date");
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):00$/.exec(time);
    if (!match) throw new Error(`第 ${index + 2} 行时间格式错误`);
    const [, ys, ms, ds, hs, mins] = match;
    const y = Number(ys),
      m = Number(ms),
      d = Number(ds),
      h = Number(hs),
      minute = Number(mins);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (
      y < 1990 ||
      y > new Date().getFullYear() + 1 ||
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d ||
      h > 23 ||
      minute > 59 ||
      minute % 5 !== 0 ||
      (previous && time <= previous)
    )
      throw new Error(`第 ${index + 2} 行日期非法、重复或未排序`);
    const number = (name: string) => {
      const value = field(name);
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
        throw new Error(`第 ${index + 2} 行 ${name} 非法`);
      return Number(value);
    };
    const open = number("Open"),
      high = number("High"),
      low = number("Low"),
      close = number("Close"),
      amount = number("Amount");
    const sourceVolume = number("Volume");
    const rawVolume = symbol
      ? normalizeFiveMinuteVolume(
          sourceVolume,
          amount,
          low,
          high,
          fiveMinuteVolumePolicy(symbol),
        )
      : sourceVolume * (unit === "lots" ? 100 : 1);
    const volumeOverflow =
      (overflowPolicy === "zero-signed" && rawVolume >= 0x80000000) ||
      (overflowPolicy === "zero-unsigned" && rawVolume > 0xffffffff);
    const volume = volumeOverflow ? 0 : rawVolume;
    if (
      ![open, high, low, close, amount].every(Number.isFinite) ||
      low <= 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      !Number.isSafeInteger(rawVolume) ||
      rawVolume < 0 ||
      volume > 0xffffffff ||
      !Number.isFinite(Math.fround(amount)) ||
      ![open, high, low, close].every(
        (v) => Number.isFinite(Math.fround(v)) && Math.fround(v) > 0,
      )
    )
      throw new Error(`第 ${index + 2} 行价格、成交额或成交量非法`);
    result.push({
      time,
      open,
      high,
      low,
      close,
      amount,
      volume,
      ...(symbol ? { sourceVolume } : {}),
      ...(volumeOverflow ? { volumeOverflow: true as const } : {}),
    });
    previous = time;
  }
  if (!result.length) throw new Error("CSV 没有记录");
  return result;
}

export function encodeFiveMinuteBar(bar: CsvBar): Buffer {
  const year = Number(bar.time.slice(0, 4)),
    month = Number(bar.time.slice(5, 7)),
    day = Number(bar.time.slice(8, 10));
  const out = Buffer.alloc(32);
  out.writeUInt16LE((((year - 2004) & 31) << 11) + month * 100 + day, 0);
  out.writeUInt16LE(
    Number(bar.time.slice(11, 13)) * 60 + Number(bar.time.slice(14, 16)),
    2,
  );
  [bar.open, bar.high, bar.low, bar.close, bar.amount].forEach((value, i) =>
    out.writeFloatLE(value, 4 + i * 4),
  );
  out.writeUInt32LE(bar.volume, 24);
  return out;
}

/** Preserve every existing record byte-for-byte; only insert absent timestamps. */
function readFiveMinuteTimes(existing: Buffer, referenceYear: number) {
  if (existing.length % 32 !== 0)
    throw new Error("原文件长度不是 32 字节的整数倍");
  const times: string[] = new Array(existing.length / 32);
  let nextYear = referenceYear + 1;
  for (let i = times.length - 1; i >= 0; i--) {
    const packed = existing.readUInt16LE(i * 32),
      md = packed & 2047,
      minutes = existing.readUInt16LE(i * 32 + 2);
    let year = (packed >> 11) + 2004;
    while (year > nextYear) year -= 32;
    nextYear = year;
    const month = Math.floor(md / 100),
      day = md % 100;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1990 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      minutes >= 1440
    )
      throw new Error(`原文件第 ${i + 1} 条时间非法`);
    const pad = (v: number) => String(v).padStart(2, "0");
    times[i] =
      `${year}-${pad(month)}-${pad(day)} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
    if (i + 1 < times.length && times[i]! >= times[i + 1]!)
      throw new Error(`原文件第 ${i + 1} 条时间重复或乱序`);
  }
  return times;
}

export function mergeFiveMinuteBars(
  existing: Buffer,
  bars: CsvBar[],
  referenceYear = new Date().getFullYear(),
) {
  const times = readFiveMinuteTimes(existing, referenceYear);
  const chunks: Buffer[] = [],
    expected: string[] = [];
  const insertedOverflowTimes: string[] = [];
  let old = 0,
    incoming = 0,
    added = 0,
    identical = 0,
    conflicts = 0;
  while (old < times.length || incoming < bars.length) {
    const time = times[old],
      bar = bars[incoming];
    if (time !== undefined && (bar === undefined || time < bar.time)) {
      expected.push(time);
      chunks.push(existing.subarray(old * 32, ++old * 32));
    } else if (bar !== undefined && (time === undefined || bar.time < time)) {
      expected.push(bar.time);
      if (bar.volumeOverflow) insertedOverflowTimes.push(bar.time);
      chunks.push(encodeFiveMinuteBar(bar));
      incoming++;
      added++;
    } else {
      expected.push(time!);
      const record = existing.subarray(old * 32, ++old * 32);
      if (
        record.subarray(0, 28).equals(encodeFiveMinuteBar(bar!).subarray(0, 28))
      )
        identical++;
      else conflicts++;
      chunks.push(record);
      incoming++;
    }
  }
  const data = Buffer.concat(chunks),
    actual = readFiveMinuteTimes(data, referenceYear);
  if (actual.some((time, i) => time !== expected[i]))
    throw new Error("日期跨度无法无歧义编码到通达信文件");
  return { data, added, identical, conflicts, insertedOverflowTimes };
}
