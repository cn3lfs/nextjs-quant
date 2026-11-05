import koffi from "koffi";
import { resolve } from "node:path";
import { open, readFile, rename, rm, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { encodeFiveMinuteBar, parseFiveMinuteCsv } from "./five-minute-csv";

let merge: ReturnType<ReturnType<typeof koffi.load>["func"]> | undefined;
export function mergeNative(existing: Buffer, incoming: Buffer) {
  if (existing.length % 32 || incoming.length % 32)
    throw new Error("LC5 长度非法");
  merge ??= koffi
    .load(resolve("runtime/tdx-import/merge.dll"))
    .func(
      "int lc5_merge(const void *, uint32, const void *, uint32, void *, void *, int)",
    );
  const output = Buffer.allocUnsafe(existing.length + incoming.length);
  const stats = Buffer.alloc(12);
  const count = merge(
    existing,
    existing.length / 32,
    incoming,
    incoming.length / 32,
    output,
    stats,
    new Date().getFullYear(),
  ) as number;
  if (count < 0) throw new Error("LC5 时间非法、重复或乱序");
  return {
    data: output.subarray(0, count * 32),
    added: stats.readUInt32LE(0),
    identical: stats.readUInt32LE(4),
    conflicts: stats.readUInt32LE(8),
  };
}

/** One parse and write, without preview, backup, or history hashes. */
export async function importFiveMinuteDirect(source: string, target: string) {
  const bars = parseFiveMinuteCsv(
    await readFile(source, "utf8"),
    "lots",
    "zero-signed",
  );
  const incoming = Buffer.concat(bars.map(encodeFiveMinuteBar));
  for (let i = 0; i < bars.length; i++) {
    let decodedYear = 2004 + (incoming.readUInt16LE(i * 32) >> 11);
    while (decodedYear > new Date().getFullYear() + 1) decodedYear -= 32;
    if (decodedYear !== Number(bars[i]!.time.slice(0, 4)))
      throw new Error("CSV 年份无法无歧义编码到 LC5");
  }
  let handle;
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error("目标文件是符号链接");
    handle = await open(target, "r+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const targetMissing = !handle;
  try {
    const size = handle ? (await handle.stat()).size : 0;
    if (size % 32) throw new Error("LC5 长度非法");
    if (handle && size) {
      const tail = Buffer.alloc(32);
      const read = await handle.read(tail, 0, 32, size - 32);
      if (read.bytesRead !== 32) throw new Error("读取文件尾失败");
      const trial = mergeNative(tail, incoming);
      if (
        trial.added === bars.length &&
        trial.data.subarray(0, 32).equals(tail)
      ) {
        const append = trial.data.subarray(32);
        let written = 0;
        try {
          while (written < append.length) {
            const result = await handle.write(
              append,
              written,
              append.length - written,
              size + written,
            );
            if (!result.bytesWritten) throw new Error("追加写入未完成");
            written += result.bytesWritten;
          }
        } catch (error) {
          await handle.truncate(size);
          throw error;
        }
        return {
          ...trial,
          targetMissing,
          overflowTimes: bars
            .filter((b) => b.volumeOverflow)
            .map((b) => b.time),
          first: bars[0]!.time,
          last: bars.at(-1)!.time,
        };
      }
    }
    const original = handle ? await handle.readFile() : Buffer.alloc(0);
    const result = mergeNative(original, incoming);
    if (result.added) {
      await handle?.close();
      handle = undefined;
      const temporary = `${target}.quant-${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, "wx");
        try {
          await output.writeFile(result.data);
        } finally {
          await output.close();
        }
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return {
      ...result,
      targetMissing,
      overflowTimes: bars
        .filter((b) => b.volumeOverflow)
        .filter((b) => {
          const encoded = encodeFiveMinuteBar(b).subarray(0, 4);
          for (let p = 0; p < original.length; p += 32)
            if (original.subarray(p, p + 4).equals(encoded)) return false;
          return true;
        })
        .map((b) => b.time),
      first: bars[0]!.time,
      last: bars.at(-1)!.time,
    };
  } finally {
    await handle?.close();
  }
}
