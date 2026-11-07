import { createHash } from "node:crypto";
import { validateLocalDate } from "./types.js";

export type TdxDbfField = {
  name: string;
  type: string;
  length: number;
  decimals: number;
  offset: number;
};
/** dBase III physical fields only. Legacy column names do not certify GO semantics or units. */
export function parseLocalBaseDbf(bytes: Uint8Array) {
  const body = Buffer.from(bytes);
  if (body.length < 33 || body.length > 64 * 1024 * 1024)
    throw new Error("基础DBF长度非法");
  if (body[0] !== 3) throw new Error("不支持的基础DBF版本");
  const records = body.readUInt32LE(4),
    headerBytes = body.readUInt16LE(8),
    recordBytes = body.readUInt16LE(10);
  if (
    headerBytes < 33 ||
    (headerBytes - 33) % 32 ||
    headerBytes > body.length ||
    body[headerBytes - 1] !== 13 ||
    recordBytes < 2 ||
    records > 100000
  )
    throw new Error("基础DBF头或字段表非法");
  const end = headerBytes + records * recordBytes;
  if (
    end > body.length ||
    body.length > end + 1 ||
    (body.length === end + 1 && body[end] !== 26)
  )
    throw new Error("基础DBF记录截断或尾部非法");
  const fields: TdxDbfField[] = [];
  let offset = 1;
  for (let p = 32; p < headerBytes - 1; p += 32) {
    const name = body.toString("ascii", p, p + 11).split("\0")[0]!,
      type = String.fromCharCode(body[p + 11]!),
      length = body[p + 16]!,
      decimals = body[p + 17]!;
    if (
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ||
      fields.some((f) => f.name === name) ||
      !"CNFDL".includes(type) ||
      !length ||
      decimals > length ||
      offset + length > recordBytes
    )
      throw new Error("基础DBF字段定义非法");
    fields.push({ name, type, length, decimals, offset });
    offset += length;
  }
  if (offset !== recordBytes) throw new Error("基础DBF记录宽度与字段不符");
  const decoder = new TextDecoder("gb18030", { fatal: true });
  const rows = Array.from({ length: records }, (_, index) => {
    const start = headerBytes + index * recordBytes,
      flag = body[start];
    if (flag !== 32 && flag !== 42) throw new Error("基础DBF删除标记非法");
    const cells = fields.map((field) => {
      const raw = decoder.decode(
        body.subarray(
          start + field.offset,
          start + field.offset + field.length,
        ),
      );
      const text = raw.trim();
      let value: string | number | boolean | null = text || null;
      if (text && /^[NF]$/.test(field.type)) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))
          throw new Error(`基础DBF数字非法：${field.name}`);
        value = Number(text);
        if (!Number.isFinite(value)) throw new Error("基础DBF数字超限");
      }
      if (text && field.type === "D") {
        if (!/^\d{8}$/.test(text)) throw new Error("基础DBF日期非法");
        validateLocalDate(
          `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`,
        );
      }
      if (field.type === "L") {
        if (!/^[TFYN?]?$/i.test(text)) throw new Error("基础DBF逻辑值非法");
        value = /^[TY]$/i.test(text)
          ? true
          : /^[FN]$/i.test(text)
            ? false
            : null;
      }
      return { name: field.name, raw, value };
    });
    return { index, offset: start, deleted: flag === 42, cells };
  });
  return {
    sourceSha256: createHash("sha256").update(body).digest("hex"),
    version: 3,
    headerBytes,
    recordBytes,
    recordCount: records,
    fields,
    rows,
    mappingStatus: "raw-columns-only" as const,
  };
}

/** Client base.map is code + decimal mapping number text; preserve duplicates and order. */
export function parseLocalBaseMap(bytes: Uint8Array) {
  const body = Buffer.from(bytes);
  if (body.length > 8 * 1024 * 1024) throw new Error("基础映射表容量超限");
  const text = new TextDecoder("ascii", { fatal: true }).decode(body);
  const rows = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^(\d{6})([+-]?\d+)\s*$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw new Error("基础映射表记录非法");
    rows.push({
      code: match[1]!,
      mappingNumber: Number(match[2]),
      raw: line,
      line: lineIndex + 1,
    });
  }
  return {
    sourceSha256: createHash("sha256").update(body).digest("hex"),
    rows,
  };
}
