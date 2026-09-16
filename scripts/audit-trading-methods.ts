import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import inventory from "../docs/trading-skills-source-lock.json";
import {
  auditTradingMethodMap,
  tradingMethodMapSchema,
} from "./lib/trading-method-map";
import type { SkillInventory } from "./lib/trading-skill-inventory";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--require-complete"))
  throw new Error(
    "用法：tsx scripts/audit-trading-methods.ts [--require-complete]",
  );
const map = tradingMethodMapSchema.parse(
  JSON.parse(
    await readFile(resolve("docs/trading-skills-method-map.json"), "utf8"),
  ),
);
const paths = [
  ...new Set(
    map.methods.flatMap((method) => [
      ...method.implementation,
      ...method.tests,
    ]),
  ),
];
const files = new Set<string>();
for (const path of paths) {
  try {
    await access(resolve(path));
    files.add(path);
  } catch {
    /* Report missing paths through the same auditor. */
  }
}
const report = auditTradingMethodMap(map, inventory as SkillInventory, files);
console.log(JSON.stringify(report, null, 2));
if (
  report.errors.length ||
  (args[0] === "--require-complete" &&
    (report.pendingMethods.length || report.undisposedSources.length))
)
  process.exitCode = 1;
