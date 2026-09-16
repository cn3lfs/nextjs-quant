import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

export type SkillSource = {
  path: string;
  hash: string;
  bytes: number;
  headings: { line: number; text: string }[];
};
export type SkillInventory = {
  version: "trading-skill-inventory-1";
  skills: {
    id: string;
    sources: SkillSource[];
    excluded: { path: string; reason: string }[];
  }[];
  missing: string[];
  otherSkills: string[];
};

const excludedDirectories = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".work",
  "data",
  "cache",
  "output",
  "dist",
  ".venv",
  "venv",
]);
const sourceExtensions = new Set([".md", ".py", ".ts", ".js", ".mjs", ".cjs"]);
const portable = (path: string) => path.split(sep).join("/");
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Read method sources, never import or execute skill scripts. Hashes detect
 * drift; headings are navigation evidence, NOT a claim of semantic coverage. */
export async function inventoryTradingSkills(
  directory: string,
  ids: readonly string[],
): Promise<SkillInventory> {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9-]+$/.test(id))
  )
    throw new Error("技能清单包含重复或非法标识");
  const root = await realpath(directory);
  const result: SkillInventory = {
    version: "trading-skill-inventory-1",
    skills: [],
    missing: [],
    otherSkills: [],
  };
  for (const id of [...ids].sort()) {
    const skillRoot = join(root, id);
    let resolved: string;
    try {
      resolved = await realpath(skillRoot);
      await readFile(join(resolved, "SKILL.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result.missing.push(id);
      continue;
    }
    if (!inside(root, resolved)) throw new Error(`技能目录越界：${id}`);
    const skill: SkillInventory["skills"][number] = {
      id,
      sources: [],
      excluded: [],
    };
    const visit = async (folder: string) => {
      const entries = (await readdir(folder, { withFileTypes: true })).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      for (const entry of entries) {
        const path = join(folder, entry.name);
        const rel = portable(relative(resolved, path));
        if (entry.isSymbolicLink()) {
          skill.excluded.push({
            path: rel,
            reason: "嵌套链接不遍历，需单独核对引用",
          });
        } else if (entry.isDirectory()) {
          if (excludedDirectories.has(entry.name))
            skill.excluded.push({
              path: rel,
              reason: "运行数据、缓存、依赖或生成产物目录",
            });
          else await visit(path);
        } else if (
          entry.isFile() &&
          sourceExtensions.has(extname(entry.name))
        ) {
          const bytes = await readFile(path);
          const headings: SkillSource["headings"] = [];
          if (extname(entry.name) === ".md") {
            let fence: string | null = null;
            bytes
              .toString("utf8")
              .split(/\r?\n/)
              .forEach((line, index) => {
                const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
                if (marker) {
                  if (fence === null) fence = marker;
                  else if (
                    marker[0] === fence[0] &&
                    marker.length >= fence.length
                  )
                    fence = null;
                  return;
                }
                const heading = !fence && /^#{1,6}\s+(.+)$/.exec(line);
                if (heading)
                  headings.push({ line: index + 1, text: heading[1]!.trim() });
              });
          }
          skill.sources.push({
            path: rel,
            hash: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            headings,
          });
        }
      }
    };
    await visit(resolved);
    result.skills.push(skill);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (ids.includes(entry.name) || entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await readFile(join(root, entry.name, "SKILL.md"));
      result.otherSkills.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  result.otherSkills.sort();
  return result;
}

export function diffSkillInventory(
  previous: SkillInventory,
  current: SkillInventory,
) {
  const flatten = (value: SkillInventory) =>
    new Map(
      value.skills.flatMap((skill) =>
        skill.sources.map(
          (source) => [`${skill.id}/${source.path}`, source.hash] as const,
        ),
      ),
    );
  const before = flatten(previous),
    after = flatten(current);
  return {
    added: [...after.keys()].filter((path) => !before.has(path)),
    removed: [...before.keys()].filter((path) => !after.has(path)),
    changed: [...after]
      .filter(([path, hash]) => before.has(path) && before.get(path) !== hash)
      .map(([path]) => path),
    missing: current.missing,
    newUnclassifiedSkills: current.otherSkills.filter(
      (id) => !previous.otherSkills.includes(id),
    ),
  };
}
