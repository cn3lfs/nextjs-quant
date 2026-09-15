import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const HEADER_BYTES = 20;
const RECORD_INDEX_BYTES = 11;
const MAX_RECORDS = 100_000;
const MAX_FIELDS = 4096;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;

export type TdxFinancialFile = {
  filename: string;
  md5: string;
  filesize: number;
};

export type TdxFinancialRecord = {
  code: string;
  marker: number;
  dataOffset: number;
  values: number[];
};

export type TdxFinancialReport = {
  sourceFilename?: string;
  sourceSha256: string;
  formatVersion: number;
  reportDate: number;
  recordCount: number;
  fieldCount: number;
  records: TdxFinancialRecord[];
};

type ParsedFinancialReport = Omit<
  TdxFinancialReport,
  "sourceFilename" | "sourceSha256"
>;

function need(body: Buffer, size: number, label: string) {
  if (body.length < size)
    throw new Error(`${label}响应截断：${body.length}/${size}`);
}

function validReportDate(value: number) {
  if (!Number.isInteger(value) || value < 19000101 || value > 21001231)
    return false;
  const text = String(value),
    year = Number(text.slice(0, 4)),
    month = Number(text.slice(4, 6)),
    day = Number(text.slice(6, 8)),
    parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseDat(body: Buffer): ParsedFinancialReport {
  need(body, HEADER_BYTES, "财务文件头");
  const formatVersion = body.readInt16LE(0),
    reportDate = body.readUInt32LE(2),
    recordCount = body.readUInt16LE(6),
    fieldBytes = body.readUInt32LE(12);
  if (!validReportDate(reportDate)) throw new Error("财务报告日期非法");
  if (recordCount > MAX_RECORDS) throw new Error("财务记录数量超限");
  if (fieldBytes % 4 !== 0) throw new Error("财务字段字节数未按 float 对齐");
  const fieldCount = fieldBytes / 4;
  if (fieldCount > MAX_FIELDS) throw new Error("财务字段数量超限");
  if (recordCount > 0 && fieldCount === 0)
    throw new Error("有财务记录但没有字段");
  const tableEnd = HEADER_BYTES + recordCount * RECORD_INDEX_BYTES;
  need(body, tableEnd, "财务记录索引");
  const records: TdxFinancialRecord[] = [];
  for (let index = 0; index < recordCount; index++) {
    const indexOffset = HEADER_BYTES + index * RECORD_INDEX_BYTES,
      codeBytes = body.subarray(indexOffset, indexOffset + 6),
      code = codeBytes.toString("ascii"),
      marker = body[indexOffset + 6]!,
      dataOffset = body.readUInt32LE(indexOffset + 7);
    if (!/^\d{6}$/.test(code)) throw new Error(`财务证券代码非法：${code}`);
    if (dataOffset < tableEnd)
      throw new Error(`财务记录数据偏移落在索引区：${code}`);
    const end = dataOffset + fieldBytes;
    if (!Number.isSafeInteger(end) || end > body.length)
      throw new Error(`财务记录数据截断：${code}`);
    const values = new Array<number>(fieldCount);
    for (let field = 0; field < fieldCount; field++) {
      const value = body.readFloatLE(dataOffset + field * 4);
      if (!Number.isFinite(value))
        throw new Error(`财务字段数值非法：${code}[${field}]`);
      values[field] = value;
    }
    records.push({ code, marker, dataOffset, values });
  }
  return {
    formatVersion,
    reportDate,
    recordCount,
    fieldCount,
    records,
  };
}

function crc32(body: Buffer) {
  let value = 0xffffffff;
  for (const byte of body) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipDat(body: Buffer): Buffer {
  const searchStart = Math.max(0, body.length - 0xffff - 22);
  let endOffset = -1;
  for (let offset = body.length - 22; offset >= searchStart; offset--)
    if (body.readUInt32LE(offset) === ZIP_END_SIGNATURE) {
      endOffset = offset;
      break;
    }
  if (endOffset < 0) throw new Error("财务 ZIP 缺少结束目录");
  need(body, endOffset + 22, "财务 ZIP 结束目录");
  const disk = body.readUInt16LE(endOffset + 4),
    centralDisk = body.readUInt16LE(endOffset + 6),
    entriesOnDisk = body.readUInt16LE(endOffset + 8),
    entries = body.readUInt16LE(endOffset + 10),
    centralBytes = body.readUInt32LE(endOffset + 12),
    centralOffset = body.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries)
    throw new Error("不支持多磁盘财务 ZIP");
  if (centralOffset + centralBytes > body.length)
    throw new Error("财务 ZIP 中央目录截断");
  const candidates: {
    name: string;
    method: number;
    flags: number;
    compressedBytes: number;
    uncompressedBytes: number;
    crc: number;
    localOffset: number;
  }[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entries; index++) {
    need(body, offset + 46, "财务 ZIP 中央目录项");
    if (body.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE)
      throw new Error("财务 ZIP 中央目录项非法");
    const flags = body.readUInt16LE(offset + 8),
      method = body.readUInt16LE(offset + 10),
      crc = body.readUInt32LE(offset + 16),
      compressedBytes = body.readUInt32LE(offset + 20),
      uncompressedBytes = body.readUInt32LE(offset + 24),
      nameBytes = body.readUInt16LE(offset + 28),
      extraBytes = body.readUInt16LE(offset + 30),
      commentBytes = body.readUInt16LE(offset + 32),
      localOffset = body.readUInt32LE(offset + 42),
      nameStart = offset + 46;
    need(
      body,
      nameStart + nameBytes + extraBytes + commentBytes,
      "财务 ZIP 目录项",
    );
    if (
      nameStart + nameBytes + extraBytes + commentBytes >
      centralOffset + centralBytes
    )
      throw new Error("财务 ZIP 中央目录项超出范围");
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new Error("不支持 ZIP64 财务文件");
    const name = body.toString("utf8", nameStart, nameStart + nameBytes);
    if (name.toLowerCase().endsWith(".dat"))
      candidates.push({
        name,
        method,
        flags,
        compressedBytes,
        uncompressedBytes,
        crc,
        localOffset,
      });
    offset = nameStart + nameBytes + extraBytes + commentBytes;
  }
  if (candidates.length !== 1)
    throw new Error(`财务 ZIP 中应有一个 DAT，实际 ${candidates.length} 个`);
  const entry = candidates[0]!;
  if (entry.flags & 1) throw new Error("不支持加密财务 ZIP");
  need(body, entry.localOffset + 30, "财务 ZIP 本地文件头");
  if (body.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_SIGNATURE)
    throw new Error("财务 ZIP 本地文件头非法");
  const localNameBytes = body.readUInt16LE(entry.localOffset + 26),
    localExtraBytes = body.readUInt16LE(entry.localOffset + 28),
    dataOffset = entry.localOffset + 30 + localNameBytes + localExtraBytes,
    dataEnd = dataOffset + entry.compressedBytes;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > body.length)
    throw new Error("财务 ZIP 数据截断");
  const compressed = body.subarray(dataOffset, dataEnd);
  let result: Buffer;
  if (entry.method === 0) result = Buffer.from(compressed);
  else if (entry.method === 8) {
    try {
      result = inflateRawSync(compressed);
    } catch {
      throw new Error(`财务 ZIP 解压失败：${entry.name}`);
    }
  } else throw new Error(`不支持财务 ZIP 压缩方式：${entry.method}`);
  if (result.length !== entry.uncompressedBytes)
    throw new Error("财务 ZIP 解压长度不符");
  if (crc32(result) !== entry.crc) throw new Error("财务 ZIP CRC 不符");
  return result;
}

/** 解析 tdxfin/gpcw.txt；只返回清单，不下载或写入文件。 */
export function parseFinancialFileList(bytes: Uint8Array): TdxFinancialFile[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("财务文件清单不是有效 UTF-8");
  }
  const rows: TdxFinancialFile[] = [],
    seen = new Set<string>();
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 3) throw new Error(`财务文件清单行非法：${line}`);
    const [filename, md5, rawSize] = parts;
    if (!/^gpcw\d{8}\.zip$/i.test(filename!))
      throw new Error(`财务文件名非法：${filename}`);
    if (!validReportDate(Number(filename!.slice(4, 12))))
      throw new Error(`财务文件日期非法：${filename}`);
    if (!/^[a-f\d]{32}$/i.test(md5!))
      throw new Error(`财务文件 MD5 非法：${filename}`);
    const filesize = Number(rawSize);
    if (!Number.isSafeInteger(filesize) || filesize < 0)
      throw new Error(`财务文件大小非法：${filename}`);
    if (seen.has(filename!.toLowerCase()))
      throw new Error(`财务文件清单重复：${filename}`);
    seen.add(filename!.toLowerCase());
    rows.push({ filename: filename!, md5: md5!.toLowerCase(), filesize });
  }
  return rows;
}

/** 解析 gpcw*.dat，或只含一个 DAT 的 gpcw*.zip；不读取路径、不下载。 */
export function parseFinancialReport(
  bytes: Uint8Array,
  filename?: string,
): TdxFinancialReport {
  const body = Buffer.from(bytes),
    isZip = body.length >= 4 && body.readUInt32LE(0) === ZIP_LOCAL_SIGNATURE;
  if (filename && !/\.(?:dat|zip)$/i.test(filename))
    throw new Error("财务文件扩展名必须是 .dat 或 .zip");
  if (filename?.toLowerCase().endsWith(".zip") && !isZip)
    throw new Error("财务 ZIP 文件头非法");
  return {
    ...parseDat(isZip ? zipDat(body) : body),
    sourceFilename: filename,
    sourceSha256: createHash("sha256").update(body).digest("hex"),
  };
}
