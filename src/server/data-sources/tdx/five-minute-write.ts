import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, link, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  mergeFiveMinuteBars,
  parseFiveMinuteCsv,
  type ImportVolumeUnit,
} from "./five-minute-csv";
import type { FiveMinutePreviewItem } from "./five-minute-preview";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function readOptional(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("目标文件是符号链接");
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeNewFile(path: string, data: Buffer) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Internal primitive only. The caller must journal the backup and check the
 * client is closed before calling this; never expose paths from a request. */
export async function importPreviewItem(
  item: FiveMinutePreviewItem,
  unit: ImportVolumeUnit,
  backup: string,
) {
  if (
    !item.sourceHash ||
    (!item.targetHash && !item.targetMissing) ||
    !item.mergedHash ||
    !item.added ||
    item.error
  )
    throw new Error("预检结果不可写入或没有新增记录");
  const source = await readFile(item.source),
    original = await readOptional(item.target);
  if (
    hash(source) !== item.sourceHash ||
    (original === null
      ? !item.targetMissing
      : hash(original) !== item.targetHash)
  )
    throw new Error("CSV 或目标文件已改变，请重新预检");
  const result = mergeFiveMinuteBars(
    original ?? Buffer.alloc(0),
    parseFiveMinuteCsv(
      source.toString("utf8"),
      unit,
      item.indexVolumeOverflow ? "zero-signed" : "error",
    ),
  );
  if (
    result.added !== item.added ||
    result.conflicts !== item.conflicts ||
    result.identical !== item.identical ||
    hash(result.data) !== item.mergedHash
  )
    throw new Error("导入结果与预检不一致");
  if (original) {
    await writeNewFile(backup, original);
    if (hash(await readFile(backup)) !== item.targetHash)
      throw new Error("备份校验失败");
  }
  const temporary = join(dirname(item.target), `.quant-${randomUUID()}.tmp`);
  try {
    await writeNewFile(temporary, result.data);
    const current = await readOptional(item.target);
    if (
      current === null ? !item.targetMissing : hash(current) !== item.targetHash
    )
      throw new Error("目标文件在写入期间改变，请重新预检");
    if (item.targetMissing) {
      await link(temporary, item.target);
      await rm(temporary);
    } else await rename(temporary, item.target);
  } finally {
    await rm(temporary, { force: true });
  }
  const afterHash = hash(result.data);
  if (hash(await readFile(item.target)) !== afterHash)
    throw new Error("写入后校验失败，请使用备份检查恢复");
  return {
    beforeHash: item.targetHash ?? null,
    afterHash,
    backup: original ? backup : null,
  };
}

/** Reject a restore if the backup or the current target has changed. */
export async function restoreImportedFile(
  target: string,
  backup: string,
  beforeHash: string,
  afterHash: string,
) {
  const saved = await readFile(backup);
  if (hash(saved) !== beforeHash) throw new Error("备份校验失败");
  if (hash(await readFile(target)) !== afterHash)
    throw new Error("目标在导入后发生变化，拒绝覆盖");
  const temporary = join(dirname(target), `.quant-${randomUUID()}.tmp`);
  try {
    await writeNewFile(temporary, saved);
    if (hash(await readFile(target)) !== afterHash)
      throw new Error("目标在恢复期间发生变化，拒绝覆盖");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  if (hash(await readFile(target)) !== beforeHash)
    throw new Error("恢复后校验失败");
}

export async function removeImportedFile(target: string, afterHash: string) {
  if (hash(await readFile(target)) !== afterHash)
    throw new Error("目标在导入后发生变化，拒绝删除");
  await rm(target);
}
