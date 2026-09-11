import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** This file contains A-share codes without an exchange field. Never infer index identities. */
function aShareSymbol(code: string) {
  if (/^(60|68)\d{4}$/.test(code)) return `sh${code}`;
  if (/^(00|30)\d{4}$/.test(code)) return `sz${code}`;
  if (/^(43|83|87|88|92)\d{4}$/.test(code)) return `bj${code}`;
  return null;
}

export function parseInfoharborNames(bytes: Buffer) {
  if (!bytes.length || bytes.length > 16 * 1024 * 1024)
    throw new Error("名称资料为空或超过16MB");
  const text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  const names: Record<string, string> = {};
  let rows = 0,
    ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [code, rawName] = line.split("|");
    const name = rawName?.trim();
    if (
      !code ||
      !/^\d{6}$/.test(code) ||
      !name ||
      name.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(name)
    )
      throw new Error(`名称资料第${rows + 1}条格式非法`);
    rows++;
    const symbol = aShareSymbol(code);
    if (!symbol) {
      ignored++;
      continue;
    }
    if (names[symbol] && names[symbol] !== name)
      throw new Error(`名称资料同一证券存在冲突：${symbol}`);
    names[symbol] = name;
  }
  if (!rows) throw new Error("名称资料没有有效记录");
  return { names, rows, ignored };
}

export async function readInfoharborNames(root: string) {
  const path = join(root, "T0002", "hq_cache", "infoharbor_ex.code");
  try {
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 16 * 1024 * 1024)
        throw new Error("名称资料不是普通文件或超过16MB");
      const bytes = await handle.readFile();
      const after = await handle.stat(),
        current = await stat(path);
      const unchanged = (s: typeof before) =>
        s.dev === before.dev &&
        s.ino === before.ino &&
        s.size === before.size &&
        s.mtimeMs === before.mtimeMs &&
        s.ctimeMs === before.ctimeMs &&
        s.birthtimeMs === before.birthtimeMs;
      if (
        bytes.length !== before.size ||
        !unchanged(after) ||
        !unchanged(current)
      )
        throw new Error("名称资料读取期间发生变化");
      return {
        status: "available" as const,
        ...parseInfoharborNames(bytes),
        hash: createHash("sha256").update(bytes).digest("hex"),
        mtimeMs: after.mtimeMs,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      status: "unavailable" as const,
      names: {} as Record<string, string>,
      hash: null,
      mtimeMs: null,
      rows: 0,
      ignored: 0,
      error:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "本地补充名称文件不存在"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
