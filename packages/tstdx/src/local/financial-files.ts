import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFinancialReport, type TdxFinancialReport } from "../financial.js";
import { readStableLocalFile as readStableFinancialFile } from "./files.js";
export { readStableLocalFile as readStableFinancialFile } from "./files.js";
export const financialDirectory = (root: string) =>
  resolve(root, "vipdoc", "cw");
const indexes = new WeakMap<
  Buffer,
  Omit<TdxFinancialReport, "records"> & {
    indexes: Map<string, { offset: number; marker: number }[]>;
  }
>();
export async function listFinancialReports(root: string) {
  const entries = await readdir(financialDirectory(root));
  return entries
    .filter((name) => /^gpcw\d{8}\.dat$/i.test(name))
    .sort()
    .reverse();
}
export async function financialPackage(root: string, name: string) {
  if (!/^gpcw\d{8}\.dat$/i.test(name)) throw new Error("财务文件名非法");
  const file = await readStableFinancialFile(
    resolve(financialDirectory(root), name),
  );
  let index = indexes.get(file.body);
  if (!index) {
    const parsed = parseFinancialReport(file.body, name);
    const byCode = new Map<string, { offset: number; marker: number }[]>();
    for (const record of parsed.records) {
      const records = byCode.get(record.code) ?? [];
      records.push({ offset: record.dataOffset, marker: record.marker });
      byCode.set(record.code, records);
    }
    const { records: _records, ...metadata } = parsed;
    index = { ...metadata, indexes: byCode };
    indexes.set(file.body, index);
  }
  return { ...file, index };
}
export function packageRecord(
  file: Awaited<ReturnType<typeof financialPackage>>,
  code: string,
) {
  const indexes = file.index.indexes.get(code);
  if (!indexes) return null;
  if (indexes.length !== 1)
    throw new Error(`同一财报存在重复证券记录：${code}`);
  const record = indexes[0]!;
  return {
    ...record,
    values: Array.from({ length: file.index.fieldCount }, (_, i) =>
      file.body.readFloatLE(record.offset + i * 4),
    ),
  };
}
