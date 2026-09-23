import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { knownSourceDrift, compareSourceDrift } from "./lib/source-drift";
import ids from "../src/lib/strategy-facts/trading-skill-ids.json";
import {
  diffSkillInventory,
  inventoryTradingSkills,
  type SkillInventory,
} from "./lib/trading-skill-inventory";

const args = process.argv.slice(2);
if (
  args.length &&
  !(args.length === 2 && args[0] === "--write") &&
  !(args.length === 1 && args[0] === "--registered")
)
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
  if (args[0] === "--registered") {
    const registered = knownSourceDrift(
      await readFile("docs/known-source-drift.md", "utf8"),
    );
    const map = JSON.parse(
      await readFile(resolve("docs/trading-skills-method-map.json"), "utf8"),
    ) as { methods: { id: string; status: string; sources?: string[] }[] };
    const result = compareSourceDrift(
      baseline,
      current,
      registered,
      map.methods,
    );
    console.log("已登记漂移（未解决，B6 语义对齐前不得更新锁定）：");
    console.log(JSON.stringify(registered, null, 2));
    console.log(
      JSON.stringify(
        { failures: result.errors, notices: result.notices },
        null,
        2,
      ),
    );
    if (result.errors.length) process.exitCode = 1;
  } else if (Object.values(diff).some((items) => items.length))
    process.exitCode = 1;
}
if (current.missing.length) process.exitCode = 1;
