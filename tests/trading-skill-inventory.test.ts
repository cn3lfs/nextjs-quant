import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  diffSkillInventory,
  inventoryTradingSkills,
} from "../scripts/lib/trading-skill-inventory";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-skill-inventory-"));
  roots.push(root);
  await mkdir(join(root, "test-data-skill", "references"), { recursive: true });
  await writeFile(
    join(root, "test-data-skill", "SKILL.md"),
    "# 方法\n```python\n# 不是真标题\n```\n## 入场\n",
  );
  await writeFile(
    join(root, "test-data-skill", "references", "rules.md"),
    "# 止损\n价格低于结构位退出\n",
  );
  return root;
}
it("includes references and scripts even when a skill name contains data; ignores fenced comments", async () => {
  const root = await fixture();
  await mkdir(join(root, "test-data-skill", "scripts"));
  await writeFile(
    join(root, "test-data-skill", "scripts", "method.py"),
    "raise Exception('never execute')",
  );
  await mkdir(join(root, "test-data-skill", "data"));
  await writeFile(
    join(root, "test-data-skill", "data", "cached.md"),
    "not a method",
  );
  const result = await inventoryTradingSkills(root, ["test-data-skill"]);
  expect(result.skills[0]!.sources.map((s) => s.path)).toEqual([
    "SKILL.md",
    "references/rules.md",
    "scripts/method.py",
  ]);
  expect(result.skills[0]!.sources[0]!.headings).toEqual([
    { line: 1, text: "方法" },
    { line: 5, text: "入场" },
  ]);
  expect(result.skills[0]!.excluded).toEqual([
    { path: "data", reason: "运行数据、缓存、依赖或生成产物目录" },
  ]);
});
it("detects changed methods, added examples, deleted files and unclassified new skills", async () => {
  const root = await fixture();
  const before = await inventoryTradingSkills(root, ["test-data-skill"]);
  await writeFile(join(root, "test-data-skill", "SKILL.md"), "# 新方法\n");
  await rm(join(root, "test-data-skill", "references", "rules.md"));
  await writeFile(
    join(root, "test-data-skill", "references", "example.md"),
    "# 新示例\n",
  );
  await mkdir(join(root, "new-method"));
  await writeFile(join(root, "new-method", "SKILL.md"), "# 新技能\n");
  const after = await inventoryTradingSkills(root, [
    "test-data-skill",
    "missing-skill",
  ]);
  expect(diffSkillInventory(before, after)).toEqual({
    added: ["test-data-skill/references/example.md"],
    removed: ["test-data-skill/references/rules.md"],
    changed: ["test-data-skill/SKILL.md"],
    missing: ["missing-skill"],
    newUnclassifiedSkills: ["new-method"],
  });
});
it("rejects traversal and duplicate IDs; unchanged bytes produce stable snapshots", async () => {
  const root = await fixture();
  await expect(inventoryTradingSkills(root, ["../x"])).rejects.toThrow("非法");
  await expect(inventoryTradingSkills(root, ["x", "x"])).rejects.toThrow(
    "重复",
  );
  const before = await inventoryTradingSkills(root, ["test-data-skill"]);
  expect(await inventoryTradingSkills(root, ["test-data-skill"])).toEqual(
    before,
  );
});
