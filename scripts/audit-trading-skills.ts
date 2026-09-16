import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import ids from "../src/lib/trading-skill-ids.json";
import {
  diffSkillInventory,
  inventoryTradingSkills,
  type SkillInventory,
} from "./lib/trading-skill-inventory";

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--write"))
  throw new Error(
    "用法：tsx scripts/audit-trading-skills.ts [--write <清单路径>]",
  );
const current = await inventoryTradingSkills(
  process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
  [...ids, "astock-market-rules"],
);
if (args[0] === "--write") {
  // Explicit output only; the global skill root stays read-only.
  const target = resolve(args[1]!);
  await writeFile(target, `${JSON.stringify(current, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `已保存 ${current.skills.length} 项技能、${current.skills.reduce((n, s) => n + s.sources.length, 0)} 个来源文件：${target}`,
  );
} else {
  const baseline = JSON.parse(
    await readFile(resolve("docs/trading-skills-source-lock.json"), "utf8"),
  ) as SkillInventory;
  const diff = diffSkillInventory(baseline, current);
  console.log(JSON.stringify(diff, null, 2));
  if (Object.values(diff).some((items) => items.length)) process.exitCode = 1;
}
if (current.missing.length) process.exitCode = 1;
