import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  poolCategoryLabels,
  poolCategorySchema,
  poolSelectionSchema,
} from "~/lib/market-pool";
import { industryRpsPolicy } from "~/lib/industry-rps";
import { parseIndustryMembers } from "./industry-blocks";

async function directory(
  root: string,
  category: keyof typeof poolCategoryLabels,
) {
  if (!root.trim()) throw new Error("请先在行业RPS中配置只读Blocks根目录");
  const path = resolve(root, poolCategoryLabels[category]);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("板块目录须为普通目录");
  return path;
}

export async function marketPoolCatalog(root: string, categoryInput: unknown) {
  const category = poolCategorySchema.parse(categoryInput);
  const path = await directory(root, category);
  const files = (await readdir(path, { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.isSymbolicLink() && /\.txt$/i.test(e.name))
    .map((e) => e.name.slice(0, -4))
    .filter((name) => category !== "index" || name === "中证A500")
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (files.length > 2000) throw new Error("板块名单超过2000个上限");
  return { category, names: files };
}

/** Reuses the tested byte parser. No files or sidecars are ever written to Blocks. */
export async function readMarketPool(root: string, input: unknown) {
  const pool = poolSelectionSchema.parse(input);
  if (pool.category === "index" && pool.name !== "中证A500")
    throw new Error("当前仅接入中证A500指数成分");
  const folder = await directory(root, pool.category);
  // Resolve against actual entries so extension case remains consistent with the catalog.
  const file = (await readdir(folder)).find(
    (f) => /\.txt$/i.test(f) && f.slice(0, -4) === pool.name,
  );
  if (!file) throw new Error("板块名单不存在，请刷新目录");
  const path = join(folder, file);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > industryRpsPolicy.maxFileBytes
  )
    throw new Error("名单须为普通文件且不超过128000字节");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("读取期间成分名单变化，请重试");
  return {
    ...pool,
    file,
    root: resolve(root),
    hash: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: after.mtimeMs,
    observedAt: Date.now(),
    members: parseIndustryMembers(bytes, file),
  };
}
