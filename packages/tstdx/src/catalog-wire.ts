import { readAmount, splitSymbol } from "./wire.js";
import iconv from "iconv-lite";

export type TdxMarket = "sz" | "sh" | "bj";
const markets = { sz: 0, sh: 1, bj: 2 } as const;
export function uint(value: number, name: string, max = 65535, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} 必须在 ${min}..${max} 范围内`);
  return value;
}
export function marketId(market: TdxMarket) {
  if (!Object.hasOwn(markets, market)) throw new Error("未知证券市场");
  return markets[market];
}
export function dateNumber(date: number): string {
  uint(date, "date", 21001231, 19900101);
  const s = String(date),
    iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== iso
  )
    throw new Error("非法交易日期");
  return iso;
}
function need(body: Buffer, size: number, name: string) {
  if (body.length < size)
    throw new Error(`${name} 响应截断：${body.length}/${size}`);
}
export function decodeGbk(body: Uint8Array) {
  return new TextDecoder("gbk").decode(body);
}
function text(body: Buffer) {
  const end = body.indexOf(0);
  return decodeGbk(end < 0 ? body : body.subarray(0, end));
}
function filename(
  value: string,
  size: number,
  encoding: "ascii" | "gbk" = "ascii",
) {
  // These are remote protocol filenames, never local filesystem paths.
  if (
    typeof value !== "string" ||
    !value.length ||
    /[\x00-\x1f\\/:]/.test(value) ||
    value.includes("..")
  )
    throw new Error("远程文件名非法");
  const encoded = iconv.encode(value, encoding);
  if (encoded.length > size || iconv.decode(encoded, encoding) !== value)
    throw new Error("远程文件名过长或编码不可表示");
  const bytes = Buffer.alloc(size);
  encoded.copy(bytes);
  return bytes;
}
export type TdxSecurity = {
  symbol: string;
  code: string;
  market: TdxMarket;
  name: string;
  volumeUnit: number;
  decimalPoint: number;
  preClose: number;
  unknown1: string;
  unknown2: string;
  industryTdx?: string;
  industrySw?: string;
};
export function buildSecurityCountRequest(market: TdxMarket) {
  const b = Buffer.from("0c0c186c0001080008004e04000075c73301", "hex");
  b.writeUInt16LE(marketId(market), 12);
  return b;
}
export function parseSecurityCount(body: Buffer) {
  need(body, 2, "证券数量");
  return body.readUInt16LE(0);
}
export function buildSecurityListRequest(market: TdxMarket, start: number) {
  const b = Buffer.from("0c0118640101060006005004000000000000", "hex");
  b.writeUInt16LE(marketId(market), 12);
  b.writeUInt16LE(uint(start, "start"), 14);
  return b;
}
export function parseSecurityList(
  body: Buffer,
  market: TdxMarket,
): TdxSecurity[] {
  marketId(market);
  need(body, 2, "证券列表");
  const count = body.readUInt16LE(0);
  uint(count, "证券页数量", 1000);
  need(body, 2 + count * 29, "证券列表");
  const rows: TdxSecurity[] = [],
    seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const p = 2 + i * 29,
      code = body.toString("ascii", p, p + 6);
    if (!/^\d{6}$/.test(code) || seen.has(code))
      throw new Error("证券列表代码非法或重复");
    seen.add(code);
    rows.push({
      symbol: market + code,
      code,
      market,
      name: text(body.subarray(p + 8, p + 16)),
      volumeUnit: body.readUInt16LE(p + 6),
      decimalPoint: body[p + 20]!,
      preClose: readAmount(body, p + 21)[0],
      unknown1: body.subarray(p + 16, p + 20).toString("hex"),
      unknown2: body.subarray(p + 25, p + 29).toString("hex"),
    });
  }
  return rows;
}
export type TdxCompanyCategory = {
  name: string;
  filename: string;
  start: number;
  length: number;
};
export function buildCompanyCategoryRequest(symbol: string) {
  const { market, code } = splitSymbol(symbol),
    b = Buffer.alloc(24);
  Buffer.from("0c0f109b00010e000e00cf02", "hex").copy(b);
  b.writeUInt16LE(market, 12);
  b.write(code, 14, "ascii");
  return b;
}
export function parseCompanyCategories(body: Buffer): TdxCompanyCategory[] {
  need(body, 2, "F10目录");
  const count = body.readUInt16LE(0);
  need(body, 2 + count * 152, "F10目录");
  return Array.from({ length: count }, (_, i) => {
    const p = 2 + i * 152;
    return {
      name: text(body.subarray(p, p + 64)),
      filename: text(body.subarray(p + 64, p + 144)),
      start: body.readUInt32LE(p + 144),
      length: body.readUInt32LE(p + 148),
    };
  });
}
export function buildCompanyContentRequest(
  symbol: string,
  name: string,
  start: number,
  length: number,
) {
  const { market, code } = splitSymbol(symbol),
    b = Buffer.alloc(114);
  Buffer.from("0c07109c000168006800d002", "hex").copy(b);
  b.writeUInt16LE(market, 12);
  b.write(code, 14, "ascii");
  filename(name, 80, "gbk").copy(b, 22);
  b.writeUInt32LE(uint(start, "start", 0xffffffff), 102);
  b.writeUInt32LE(uint(length, "length", 65535, 1), 106);
  return b;
}
export function parseCompanyContent(body: Buffer): Buffer {
  need(body, 12, "F10正文");
  const length = body.readUInt16LE(10);
  need(body, 12 + length, "F10正文");
  return body.subarray(12, 12 + length);
}
export function buildBlockMetaRequest(name: string) {
  return Buffer.concat([
    Buffer.from("0c39186900012a002a00c502", "hex"),
    filename(name, 40),
  ]);
}
export function parseBlockMeta(body: Buffer) {
  need(body, 38, "板块元数据");
  const md5 = body.toString("ascii", 5, 37).replace(/\0+$/, "");
  if (md5 && !/^[a-f0-9]{32}$/i.test(md5)) throw new Error("板块 MD5 非法");
  return { size: body.readUInt32LE(0), md5: md5.toLowerCase() };
}
export function buildFileChunkRequest(
  name: string,
  start: number,
  length = 30000,
) {
  const b = Buffer.alloc(120);
  Buffer.from("0c37186a00016e006e00b906", "hex").copy(b);
  b.writeUInt32LE(uint(start, "start", 0xffffffff), 12);
  b.writeUInt32LE(uint(length, "length", 30000, 1), 16);
  filename(name, 100).copy(b, 20);
  return b;
}
export function parseFileChunk(body: Buffer): Buffer {
  need(body, 4, "文件分片");
  return body.subarray(4);
}
export type TdxBlock = {
  name: string;
  category: number;
  type: number;
  count: number;
  codes: string[];
};
export function parseBlockFile(body: Buffer, name = ""): TdxBlock[] {
  need(body, 386, "板块文件");
  const count = body.readUInt16LE(384);
  need(body, 386 + count * 2813, "板块文件");
  return Array.from({ length: count }, (_, i) => {
    const p = 386 + i * 2813,
      members = body.readUInt16LE(p + 9);
    uint(members, "板块成分数", 400);
    const codes = Array.from({ length: members }, (_, j) =>
      text(body.subarray(p + 13 + j * 7, p + 20 + j * 7)),
    );
    if (codes.some((code) => !/^\d{6}$/.test(code)))
      throw new Error("板块成分代码非法");
    return {
      name: text(body.subarray(p, p + 9)),
      category: name.includes("gn") ? 2 : name.includes("fg") ? 3 : 0,
      type: body.readUInt16LE(p + 11),
      count: members,
      codes,
    };
  });
}
export function parseIndustryFile(body: Buffer) {
  const rows = new Map<string, { industryTdx: string; industrySw: string }>();
  for (const line of decodeGbk(body).split(/\r?\n/)) {
    const parts = line.trim().split("|"),
      market = ({ "0": "sz", "1": "sh", "2": "bj" } as Record<string, string>)[
        parts[0] ?? ""
      ];
    if (market && /^\d{6}$/.test(parts[1] ?? "") && parts.length >= 3)
      rows.set(market + parts[1], {
        industryTdx: parts[2]!,
        industrySw: parts[5] ?? "",
      });
  }
  return rows;
}
export const FLOW_FIELDS = [
  "superIn",
  "largeIn",
  "mediumIn",
  "smallIn",
  "superOut",
  "largeOut",
  "mediumOut",
  "smallOut",
] as const;
export type FlowAmounts = Record<(typeof FLOW_FIELDS)[number], number>;
export type TdxHistoricalFlow = FlowAmounts & {
  date: string;
  source: "category22" | "transactions";
  fallbackReason?: string;
};
export function buildHistoryFlowRequest(
  symbol: string,
  start: number,
  count: number,
) {
  const { market, code } = splitSymbol(symbol),
    b = Buffer.alloc(38);
  Buffer.from("0c01086401011c001c002d05", "hex").copy(b);
  b.writeUInt16LE(market, 12);
  b.write(code, 14, "ascii");
  b.writeUInt16LE(22, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt16LE(uint(start, "start"), 24);
  b.writeUInt16LE(uint(count, "count", 800, 1), 26);
  return b;
}
export function parseHistoryFlow(body: Buffer): TdxHistoricalFlow[] {
  need(body, 11, "历史资金流");
  const count = body.readUInt16LE(9);
  uint(count, "资金流记录数", 800);
  need(body, 11 + count * 36, "历史资金流");
  return Array.from({ length: count }, (_, i) => {
    const p = 11 + i * 36,
      row = {
        date: dateNumber(body.readUInt32LE(p)),
        source: "category22",
      } as TdxHistoricalFlow;
    FLOW_FIELDS.forEach((field, j) => {
      row[field] = readAmount(body, p + 4 + j * 4)[0];
    });
    return row;
  });
}
