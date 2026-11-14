import { resolveTdxRoot } from "./root.js";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
const signature = (
  info: Awaited<ReturnType<typeof stat>> & {
    mtimeNs?: bigint;
    ctimeNs?: bigint;
    birthtimeNs?: bigint;
  },
) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs ?? info.mtimeMs}:${info.ctimeNs ?? info.ctimeMs}:${info.birthtimeNs ?? info.birthtimeMs}`;
const cache = new Map<
  string,
  { key: string; body: Buffer; loadedAt: number }
>();
const maxCacheBytes = 48 * 1024 * 1024;

/** Process-only bounded cache; a changed source can never reuse an old index. */
export async function readStableLocalFile(
  path: string,
  options: { refresh?: boolean } = {},
) {
  const before = await stat(path, { bigint: true });
  if (!before.isFile() || before.size > 64n * 1024n * 1024n)
    throw new Error("通达信路径不是常规文件或容量超限");
  const key = signature(before),
    hit = cache.get(path);
  if (!options.refresh && hit?.key === key) {
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  const body = await readFile(path),
    after = await stat(path, { bigint: true });
  if (signature(after) !== key || BigInt(body.length) !== before.size)
    throw new Error("读取期间通达信文件已更新，请重试");
  const result = { key, body, loadedAt: Date.now() };
  cache.delete(path);
  let bytes = [...cache.values()].reduce(
    (sum, item) => sum + item.body.length,
    0,
  );
  for (const [old, item] of cache) {
    if (bytes + body.length <= maxCacheBytes) break;
    cache.delete(old);
    bytes -= item.body.length;
  }
  if (body.length <= maxCacheBytes) cache.set(path, result);
  return result;
}

/** Read-only root-relative client data; reject traversal and absolute caller paths. */
export async function readLocalClientFile(root: string, name: string) {
  const directory = resolveTdxRoot(root),
    target = resolve(directory, name),
    path = relative(directory, target);
  if (!path || path.startsWith("..") || isAbsolute(path))
    throw new Error("通达信本地文件路径越界");
  return readStableLocalFile(target);
}
