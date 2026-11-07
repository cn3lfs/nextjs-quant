import { createHash } from "node:crypto";

export type TdxSeriesRecord = {
  group: number;
  date: number | null;
  rawDate: number;
  values: [number, number];
  offset: number;
};
export type TdxSeriesFile = {
  sourceSha256: string;
  records: TdxSeriesRecord[];
  issues: { offset: number; reason: string }[];
};

function calendarDate(value: number) {
  if (value < 19000101 || value > 21001231) return false;
  const y = Math.floor(value / 10000),
    m = Math.floor(value / 100) % 100,
    d = value % 100;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return m >= 1 && m <= 12 && d >= 1 && d <= days;
}

/** GP, BK and SC share a physical record, but never a semantic dictionary. */
export function parseFinancialSeries(bytes: Uint8Array): TdxSeriesFile {
  const body = Buffer.from(bytes);
  if (body.length > 64 * 1024 * 1024) throw new Error("财务序列文件容量超限");
  if (body.length % 13)
    throw new Error("财务序列记录截断：长度不是13字节的整数倍");
  const records: TdxSeriesRecord[] = [],
    issues: TdxSeriesFile["issues"] = [];
  for (let offset = 0; offset < body.length; offset += 13) {
    const group = body[offset]!,
      rawDate = body.readUInt32LE(offset + 1);
    const values: [number, number] = [
      body.readFloatLE(offset + 5),
      body.readFloatLE(offset + 9),
    ];
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error(`财务序列数值非法：${offset}`);
    const date = calendarDate(rawDate) ? rawDate : null;
    if (date === null)
      issues.push({
        offset,
        reason:
          rawDate === 0
            ? "记录无日期，不能作为历史可见日期"
            : `非法记录日期：${rawDate}`,
      });
    records.push({ group, date, rawDate, values, offset });
  }
  return {
    sourceSha256: createHash("sha256").update(body).digest("hex"),
    records,
    issues,
  };
}

export type TdxLocalManifest = {
  filename: string;
  md5: string;
  filesize: number;
}[];
/** The local download manifest contains securities, blocks AND market files. */
export function parseStockFileList(bytes: Uint8Array): TdxLocalManifest {
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  const seen = new Set<string>();
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [filename, md5, size, ...extra] = line
        .split(",")
        .map((s) => s.trim());
      if (
        extra.length ||
        !/^gp(?:sh|sz|bj)\d{6}\.dat$/i.test(filename ?? "") ||
        !/^[a-f0-9]{32}$/i.test(md5 ?? "") ||
        !/^\d+$/.test(size ?? "") ||
        !Number.isSafeInteger(Number(size))
      )
        throw new Error("股票数据清单格式非法");
      const name = filename!.toLowerCase();
      if (seen.has(name)) throw new Error("股票数据清单文件重复");
      seen.add(name);
      return {
        filename: name,
        md5: md5!.toLowerCase(),
        filesize: Number(size),
      };
    });
}

export function parseLocalFinancialMd5(
  bytes: Uint8Array,
): Record<string, string> {
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  const result: Record<string, string> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section !== "[MD5]") throw new Error("本地财务元数据分区未知");
    const match = /^(gp(?:sh|sz|bj)\d{6}\.dat)=([a-f0-9]{32})$/i.exec(line);
    if (!match || Object.hasOwn(result, match[1]!.toLowerCase()))
      throw new Error("本地财务MD5元数据非法或重复");
    result[match[1]!.toLowerCase()] = match[2]!.toLowerCase();
  }
  return result;
}
