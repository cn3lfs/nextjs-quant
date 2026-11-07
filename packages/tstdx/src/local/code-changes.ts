import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function parseTdxCodeChanges(bytes: Buffer) {
  if (!bytes.length || bytes.length > 1024 * 1024)
    throw new Error("代码映射文件大小非法");
  const lines = new TextDecoder("gb18030", { fatal: true })
    .decode(bytes)
    .trim()
    .split(/\r?\n/);
  const header = lines.shift()?.split(",");
  if (!header || header[0] !== "000000" || !/^\d+$/.test(header[2] ?? ""))
    throw new Error("代码映射文件头非法");
  if (lines.length !== Number(header[2]))
    throw new Error("代码映射记录数量不完整");
  const changes: Record<
    string,
    { name: string; targetCode: string; recordedDate: string; note: string }
  > = {};
  for (const line of lines) {
    const [market, code, targetCode, label, date] = line.split("|");
    const match = /^(.*)\((已切换|已转板)\)$/.exec(label ?? "");
    if (
      market !== "44" ||
      !/^(43|83|87|88|92)\d{4}$/.test(code ?? "") ||
      !/^92\d{4}$/.test(targetCode ?? "") ||
      !match?.[1] ||
      !/^\d{8}$/.test(date ?? "")
    )
      throw new Error("代码映射记录格式非法");
    const day = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}`;
    if (
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      throw new Error("代码映射日期非法");
    const symbol = `bj${code}`;
    if (changes[symbol]) throw new Error("代码映射原代码重复");
    // Vendor notes are evidence only: never splice old and target price histories.
    changes[symbol] = {
      name: match[1],
      targetCode: targetCode!,
      recordedDate: day,
      note: match[2]!,
    };
  }
  return changes;
}

export async function readTdxCodeChanges(root: string) {
  try {
    const path = join(root, "T0002", "hq_cache", "addedcode_bj.cfg");
    const before = await stat(path);
    if (!before.isFile() || before.size > 1024 * 1024)
      throw new Error("代码映射文件大小非法");
    const bytes = await readFile(path),
      after = await stat(path);
    if (
      bytes.length !== before.size ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("代码映射读取期间发生变化");
    return {
      status: "available" as const,
      changes: parseTdxCodeChanges(bytes),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      changes: {} as ReturnType<typeof parseTdxCodeChanges>,
      hash: null,
      error:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "本地代码映射文件不存在"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
