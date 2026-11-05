import koffi from "koffi";
import { resolve, basename } from "node:path";
import { commonIndices } from "../../../lib/market/market-indices";
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
export function normalizeFiveMinuteCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines.shift() ?? "";
  const dateColumn = header
    .split(",")
    .map((v) => v.trim())
    .indexOf("Date");
  if (dateColumn < 0) return text; // The CSV parser reports the header error.
  const rows = lines
    .filter((v) => v.trim())
    .map((line) => {
      const cells = line.split(",").map((v) => v.trim());
      return { time: cells[dateColumn] ?? "", line: cells.join(",") };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
  const unique: string[] = [];
  let previous: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (previous?.time === row.time) {
      if (previous.line !== row.line)
        throw new Error(`CSV 同一时间内容冲突：${row.time}`);
      continue;
    }
    unique.push(row.line);
    previous = row;
  }
  return [header, ...unique].join("\n");
}
export async function importFiveMinuteDirect(source: string, target: string) {
  const commonIndex = commonIndices.some(
    (i) => i.symbol === basename(target).slice(0, 8).toLowerCase(),
  );
  const bars = parseFiveMinuteCsv(
    normalizeFiveMinuteCsv(await readFile(source, "utf8")),
    commonIndex ? "shares" : "lots",
    commonIndex ? "error" : "zero-signed",
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
          repaired: 0,
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
    let repaired = 0;
    if (commonIndex) {
      const incomingByTime = new Map<number, Buffer>();
      for (let p = 0; p < incoming.length; p += 32)
        incomingByTime.set(
          incoming.readUInt32LE(p),
          incoming.subarray(p, p + 32),
        );
      for (let p = 0; p < original.length; p += 32) {
        const replacement = incomingByTime.get(original.readUInt32LE(p));
        if (
          !replacement ||
          !original.subarray(p, p + 24).equals(replacement.subarray(0, 24))
        )
          continue;
        const corrected = replacement.readUInt32LE(24),
          legacy = corrected * 100;
        const current = original.readUInt32LE(p + 24);
        if (
          current !== corrected &&
          current === (legacy >= 0x80000000 ? 0 : legacy)
        ) {
          original.writeUInt32LE(corrected, p + 24);
          repaired++;
        }
      }
    }
    const result = mergeNative(original, incoming);
    if (result.added || repaired) {
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
      repaired,
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
