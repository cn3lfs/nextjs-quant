import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const tdxBlockFiles = [
  "infoharbor_block.dat",
  "spblock.dat",
  "tdxhy.cfg",
  "tdxzs.cfg",
  "tdxzs3.cfg",
] as const;
type Files = Record<(typeof tdxBlockFiles)[number], string>;
export type TdxLocalBlock = {
  category: "industry" | "concept" | "index";
  classification: "tdx-research" | "tdx-concept" | "tdx-index";
  code: string | null;
  name: string;
  selectionName: string;
  sourceDate: string | null;
  members: string[];
  level?: number;
};
function member(market: string, code: string) {
  const prefix = (
    { "0": "sz", "1": "sh", "2": "bj" } as Record<string, string>
  )[market];
  if (!prefix || !/^\d{6}$/.test(code))
    throw new Error("板块成分市场或代码非法");
  return prefix + code;
}
function sourceDate(value: string | undefined) {
  if (!value || value === "0") return null;
  if (!/^\d{8}$/.test(value)) throw new Error("板块日期非法");
  const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  if (
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error("板块日期非法");
  return day;
}
export function parseTdxLocalBlocks(files: Files): TdxLocalBlock[] {
  const names = new Map<string, string>(),
    industries = new Map<string, { code: string; name: string }>();
  for (const file of ["tdxzs.cfg", "tdxzs3.cfg"] as const) {
    for (const line of files[file].split(/\r?\n/).filter(Boolean)) {
      const [name, code, category, , , key] = line.split("|");
      if (!name || !/^\d{6}$/.test(code ?? ""))
        throw new Error("板块定义格式非法");
      names.set(code!, name);
      if (file === "tdxzs3.cfg" && category === "12" && key)
        industries.set(key, { code: code!, name });
    }
  }
  const special = new Map<string, Set<string>>();
  let set: Set<string> | undefined;
  for (const line of files["spblock.dat"].split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("#")) {
      const name = line.slice(1);
      if (!name || special.has(name)) throw new Error("特殊板块名称为空或重复");
      set = new Set();
      special.set(name, set);
    } else {
      if (!set || !/^\d{7}$/.test(line))
        throw new Error("特殊板块成分格式非法");
      set.add(member(line[0]!, line.slice(1)));
    }
  }
  const result: TdxLocalBlock[] = [];
  let current:
    | {
        type: string;
        name: string;
        code: string;
        date: string | null;
        expected: number;
        members: string[];
      }
    | undefined;
  const finish = () => {
    if (!current) return;
    if (
      current.members.length !== current.expected ||
      new Set(current.members).size !== current.members.length
    )
      throw new Error(`板块成分数量不完整或重复：${current.name}`);
    if (current.type === "FG") return; // Style groups are outside the existing pool categories.
    if (current.type !== "GN" && current.type !== "ZS")
      throw new Error("未知板块分类");
    const category = current.type === "GN" ? "concept" : "index";
    const name = names.get(current.code) ?? current.name;
    result.push({
      category,
      classification: category === "concept" ? "tdx-concept" : "tdx-index",
      code: current.code || null,
      name,
      selectionName: `通达信·${current.code || "成分"}·${name}`,
      sourceDate: current.date,
      members: [
        ...(current.members.length
          ? current.members
          : (special.get(current.name) ?? [])),
      ].sort(),
    });
  };
  for (const line of files["infoharbor_block.dat"]
    .split(/\r?\n/)
    .filter(Boolean)) {
    if (line.startsWith("#")) {
      finish();
      const [label, count, code, , updated] = line.slice(1).split(",");
      const match = /^(GN|ZS|FG)_(.+)$/.exec(label ?? "");
      if (
        !match ||
        !/^\d+$/.test(count ?? "") ||
        (code && !/^\d{6}$/.test(code))
      )
        throw new Error("板块文件头非法");
      current = {
        type: match[1]!,
        name: match[2]!,
        code: code!,
        date: sourceDate(updated),
        expected: Number(count),
        members: [],
      };
    } else {
      if (!current) throw new Error("板块成员缺少文件头");
      for (const token of line.split(",").filter(Boolean)) {
        const match = /^(\d)#(\d{6})$/.exec(token);
        if (!match) throw new Error("板块成分格式非法");
        current.members.push(member(match[1]!, match[2]!));
      }
    }
  }
  finish();
  const grouped = new Map<string, Set<string>>();
  for (const line of files["tdxhy.cfg"].split(/\r?\n/).filter(Boolean)) {
    const [market, code, , , , key] = line.split("|");
    const symbol = member(market!, code!);
    if (!key) continue;
    for (const industry of industries.keys())
      if (key.startsWith(industry)) {
        const members = grouped.get(industry) ?? new Set<string>();
        members.add(symbol);
        grouped.set(industry, members);
      }
  }
  for (const [key, definition] of industries)
    result.push({
      ...definition,
      category: "industry",
      classification: "tdx-research",
      level: [...industries.keys()].filter((ancestor) =>
        key.startsWith(ancestor),
      ).length,
      selectionName: `通达信·${definition.code}·${definition.name}`,
      sourceDate: null,
      members: [...(grouped.get(key) ?? [])].sort(),
    });
  if (
    new Set(result.map((row) => `${row.category}:${row.code ?? row.name}`))
      .size !== result.length
  )
    throw new Error("板块代码重复");
  return result;
}

export async function readTdxLocalBlocks(root: string) {
  const directory = join(resolve(root), "T0002", "hq_cache");
  const files = {} as Files;
  const evidence = [];
  for (const file of tdxBlockFiles) {
    const path = join(directory, file),
      before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !before.size ||
      before.size > 8 * 1024 * 1024
    )
      throw new Error("板块文件类型或大小非法");
    const bytes = await readFile(path),
      after = await lstat(path);
    if (
      before.size !== bytes.length ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("板块文件读取期间变化");
    files[file] = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    evidence.push({
      file,
      hash: createHash("sha256").update(bytes).digest("hex"),
      mtimeMs: after.mtimeMs,
      size: after.size,
      ino: after.ino,
      ctimeMs: after.ctimeMs,
    });
  }
  for (const file of evidence) {
    const now = await lstat(join(directory, file.file));
    if (
      now.size !== file.size ||
      now.ino !== file.ino ||
      now.mtimeMs !== file.mtimeMs ||
      now.ctimeMs !== file.ctimeMs
    )
      throw new Error("板块资料读取期间变化");
  }
  return {
    root: resolve(root),
    observedAt: Date.now(),
    files: evidence,
    blocks: parseTdxLocalBlocks(files),
    hash: createHash("sha256")
      .update("tdx-blocks-v1:")
      .update(
        JSON.stringify(evidence.map(({ file, hash }) => ({ file, hash }))),
      )
      .digest("hex"),
  };
}
