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
import { readTdxLocalBlocks } from "./tdx-local-blocks";
import { get, put } from "./db";

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

export async function marketPoolCatalog(
  root: string,
  categoryInput: unknown,
  tdxRoot?: string,
) {
  const category = poolCategorySchema.parse(categoryInput);
  const warnings: string[] = [];
  let files: string[] = [];
  try {
    const path = await directory(root, category);
    files = (await readdir(path, { withFileTypes: true }))
      .filter(
        (e) => e.isFile() && !e.isSymbolicLink() && /\.txt$/i.test(e.name),
      )
      .map((e) => e.name.slice(0, -4))
      .filter((name) => category !== "index" || name === "中证A500")
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  } catch (error) {
    if (!tdxRoot) throw error;
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  if (tdxRoot) {
    try {
      const local = await readTdxLocalBlocks(tdxRoot);
      files.push(
        ...local.blocks
          .filter((row) => row.category === category && row.members.length)
          .map((row) => row.selectionName),
      );
    } catch (error) {
      warnings.push(
        `通达信板块资料不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (files.length > 2000) throw new Error("板块名单超过2000个上限");
  return { category, names: files, warnings };
}

/** Reuses the tested byte parser. No files or sidecars are ever written to Blocks. */
export async function readMarketPool(
  root: string,
  input: unknown,
  tdxRoot?: string,
  readOnly = false,
) {
  const pool = poolSelectionSchema.parse(input);
  if (tdxRoot && pool.name.startsWith("通达信·")) {
    const snapshot = await readTdxLocalBlocks(tdxRoot);
    const block = snapshot.blocks.find(
      (row) =>
        row.category === pool.category && row.selectionName === pool.name,
    );
    if (!block || !block.members.length)
      throw new Error("通达信板块名单缺失或为空");
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          root: snapshot.root,
          sourceHash: snapshot.hash,
          block,
        }),
      )
      .digest("hex");
    const id = `market-pool-snapshot-${hash}`;
    const result = {
      ...pool,
      root: snapshot.root,
      file: "T0002/hq_cache",
      hash,
      mtimeMs: Math.max(...snapshot.files.map((file) => file.mtimeMs)),
      observedAt: snapshot.observedAt,
      members: block.members,
      source: "tdx-local-metadata" as const,
      classification: block.classification,
      sourceDate: block.sourceDate,
      files: snapshot.files,
    };
    // Content-addressed evidence is immutable; later downloads produce another snapshot.
    const existing = get<typeof result>(id);
    if (existing) return existing;
    if (!readOnly) put("market-pool-snapshot", id, result);
    return result;
  }
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
