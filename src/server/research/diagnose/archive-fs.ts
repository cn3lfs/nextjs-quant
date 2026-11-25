import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const isAbsent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
export class UnsafeArchivePath extends Error {
  constructor() {
    super("诊断归档路径不安全或类型错误");
  }
}

// The same rule applies to discovered names and to names arriving over RPC.
export function safeSegment(name: string) {
  return (
    /^[a-zA-Z0-9_\u3400-\u9fff-][a-zA-Z0-9_.\u3400-\u9fff-]{0,127}$/.test(
      name,
    ) &&
    !name.includes("..") &&
    !name.endsWith(".") &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  );
}

export function archiveStrategySegment(strategyKey: string) {
  const segment = strategyKey.replaceAll(":", "__");
  if (!safeSegment(segment)) throw new UnsafeArchivePath();
  return segment;
}

/** Every component must resolve to itself, including the configured root. */
export async function checked(path: string, kind: "file" | "directory") {
  try {
    const st = await lstat(/*turbopackIgnore: true*/ path);
    if (
      st.isSymbolicLink() ||
      relative(
        resolve(/*turbopackIgnore: true*/ path),
        await realpath(/*turbopackIgnore: true*/ path),
      ) !== "" ||
      !(kind === "file" ? st.isFile() : st.isDirectory())
    ) {
      throw new UnsafeArchivePath();
    }
    return st;
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

export async function ensureRealDirectory(path: string): Promise<void> {
  if (await checked(path, "directory")) return;
  await ensureRealDirectory(dirname(resolve(/*turbopackIgnore: true*/ path)));
  try {
    await mkdir(/*turbopackIgnore: true*/ path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await checked(path, "directory"))) throw new Error("归档目录不可用");
}

export async function directories(path: string, rejectLinks = false) {
  if (!(await checked(path, "directory"))) return [];
  const entries = await readdir(/*turbopackIgnore: true*/ path, {
    withFileTypes: true,
  });
  if (rejectLinks && entries.some((entry) => entry.isSymbolicLink()))
    throw new UnsafeArchivePath();
  return entries
    .filter((entry) => entry.isDirectory() && safeSegment(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Read at most 'limit' bytes, even when the file grows after stat. */
export async function readBounded(path: string, limit: number) {
  const st = await checked(path, "file");
  if (!st) return undefined;
  const handle = await open(
    /*turbopackIgnore: true*/ path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    const current = await checked(path, "file");
    if (
      !current ||
      !opened.isFile() ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      throw new UnsafeArchivePath();
    const size = Math.min(limit + 1, opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        size - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      text: bytes.toString("utf8", 0, Math.min(offset, limit)),
      truncated: offset > limit,
    };
  } finally {
    await handle.close();
  }
}

/** Supplementary evidence can be unavailable without invalidating the
 * original archive. Unsafe paths are still rejected before any read. */
export async function readOptionalArchiveEvidence(
  path: string,
  limit: number,
  onUnavailable?: (reason: string) => void,
) {
  try {
    return await readBounded(path, limit);
  } catch (error) {
    if (error instanceof UnsafeArchivePath) {
      onUnavailable?.(error.message);
      return undefined;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "EIO",
        "EBUSY",
        "EAGAIN",
        "EINTR",
        "ETIMEDOUT",
        "ESTALE",
        "EMFILE",
        "ENFILE",
      ].includes(code)
    ) {
      onUnavailable?.(`读取失败（${code}）`);
      return undefined;
    }
    throw error;
  }
}
