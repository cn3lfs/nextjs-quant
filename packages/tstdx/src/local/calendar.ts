import { resolveTdxRoot } from "./root.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { open, stat } from "node:fs/promises";
import { parseBars } from "./quotes.js";
import { validateLocalDate } from "./types.js";

/** Observed index dates, not a certified exchange calendar. No network fallback. */
export async function readLocalTradingDates(root: string, limit?: number) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error("交易日期窗口非法");
  const path = join(resolveTdxRoot(root), "vipdoc/sh/lday/sh000001.day"),
    handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size % 32 || before.size > 64 * 1024 * 1024)
      throw new Error("指数日期记录不完整");
    const size = limit ? Math.min(before.size, limit * 32) : before.size;
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(
        bytes,
        offset,
        size - offset,
        before.size - size + offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat(),
      current = await stat(path);
    const unchanged = (info: typeof before) =>
      info.dev === before.dev &&
      info.ino === before.ino &&
      info.size === before.size &&
      info.mtimeMs === before.mtimeMs &&
      info.ctimeMs === before.ctimeMs &&
      info.birthtimeMs === before.birthtimeMs;
    if (offset !== size || !unchanged(after) || !unchanged(current))
      throw new Error("指数日期文件读取期间发生变化");
  } finally {
    await handle.close();
  }
  const days: string[] = [];
  if (limit) days.push(...parseBars(bytes, "day").map((bar) => bar.date));
  else
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const raw = String(bytes.readUInt32LE(offset)).padStart(8, "0"),
        day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
      if (raw.length !== 8 || raw.startsWith("0000"))
        throw new Error(`指数日期非法：${raw}`);
      try {
        validateLocalDate(day);
      } catch {
        throw new Error(`指数日期非法：${raw}`);
      }
      if (days.length && day <= days.at(-1)!)
        throw new Error(`指数日期倒序或重复：${day}`);
      days.push(day);
    }
  return {
    days,
    hash: createHash("sha256").update(bytes).digest("hex"),
    source: limit
      ? `本地上证指数最近 ${limit} 根已有交易日期（非完整官方日历）`
      : "本地上证指数全部已有交易日期（非完整官方日历）",
  };
}
