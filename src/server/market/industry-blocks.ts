import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  industryFileSchema,
  industryRpsPolicy,
  industrySnapshotSchema,
} from "~/lib/screening/industry-rps";
import { rpsHash } from "~/server/infra/content-hash";

/** External Blocks directory is read-only; no cache or sidecar is written there. */
export function parseIndustryMembers(bytes: Buffer, file: string) {
  if (bytes.length > industryRpsPolicy.maxFileBytes)
    throw new Error(`${file}：名单超过128000字节上限`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${file}：名单不是有效UTF-8/ASCII`);
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) return [];
  const members = lines.map((line, i) => {
    const result = z
      .string()
      .regex(/^(SH|SZ|BJ)\d{6}$/i)
      .safeParse(line);
    if (!result.success)
      throw new Error(`${file}：第${i + 1}行格式非法，须为SH/SZ/BJ加6位代码`);
    return result.data.toLowerCase();
  });
  if (new Set(members).size !== members.length)
    throw new Error(`${file}：成分代码重复`);
  return members;
}
export async function readIndustryBlocks(
  root: string,
  checkpoint: () => void = () => {},
  category: "industry" | "concept" = "industry",
) {
  if (!root.trim()) throw new Error("请配置只读Blocks根目录");
  const label = category === "concept" ? "概念" : "申万行业";
  const limit =
    category === "concept"
      ? industryRpsPolicy.maxConcepts
      : industryRpsPolicy.maxIndustries;
  const directory = resolve(root, label);
  const entries = async () =>
    (await readdir(directory, { withFileTypes: true }))
      .filter((e) => /\.txt$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  try {
    const names = await entries();
    if (!names.length || names.length > limit)
      throw new Error(`${label}名单缺失或超过${limit}个上限`);
    const files = [];
    for (const file of names) {
      checkpoint();
      const path = join(directory, file),
        before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink())
        throw new Error(`${file}：只接受普通名单文件`);
      if (before.size > industryRpsPolicy.maxFileBytes)
        throw new Error(`${file}：名单超过128000字节上限`);
      const bytes = await readFile(path),
        after = await lstat(path);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error(`${file}：读取期间文件变化，请重试`);
      files.push(
        industryFileSchema.parse({
          name: file.slice(0, -4),
          file,
          hash: createHash("sha256").update(bytes).digest("hex"),
          mtimeMs: after.mtimeMs,
          members: parseIndustryMembers(bytes, file),
        }),
      );
    }
    if (JSON.stringify(names) !== JSON.stringify(await entries()))
      throw new Error("读取期间名单文件新增或缺失，请重试");
    for (const file of files) {
      checkpoint();
      const current = await lstat(join(directory, file.file));
      if (current.mtimeMs !== file.mtimeMs)
        throw new Error(`${file.file}：读取期间文件变化，请重试`);
    }
    return industrySnapshotSchema.parse({
      ...(category === "concept" ? { category } : {}),
      root: resolve(root),
      files,
      hash: rpsHash(files),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "rps-cancelled")
      throw error;
    throw new Error(
      `${label}名单读取失败（${directory}）：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}
