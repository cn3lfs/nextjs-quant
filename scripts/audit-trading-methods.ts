import { readFile, access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import inventory from "../docs/trading-skills-source-lock.json";
import {
  auditTradingMethodMap,
  tradingMethodMapSchema,
} from "./lib/trading-method-map";
import type { SkillInventory } from "./lib/trading-skill-inventory";

import { researchStrategyFamilies } from "../src/lib/research/specs/research-strategies";
import {
  collectMethodEvidence,
  reconcileMethodEvidence,
  syncMethodDelivery,
} from "./lib/trading-method-evidence";
const args = process.argv.slice(2);
if (args.some((arg) => !["--require-complete", "--write"].includes(arg)))
  throw new Error(
    "用法：tsx scripts/audit-trading-methods.ts [--write] [--require-complete]",
  );
const map = tradingMethodMapSchema.parse(
  JSON.parse(
    await readFile(resolve("docs/trading-skills-method-map.json"), "utf8"),
  ),
);
const reconciliation = reconcileMethodEvidence(
  map,
  collectMethodEvidence(researchStrategyFamilies),
);
const deliverySync = syncMethodDelivery(reconciliation.map);
const counts = (value: typeof map) => ({
  total: value.methods.length,
  planned: value.methods.filter((m) => m.status === "planned").length,
  variants: value.methods.filter((m) => m.status === "implemented-variant")
    .length,
  implemented: value.methods.filter((m) => m.status === "implemented").length,
});
const before = counts(map);
const paths = [
  ...new Set(
    deliverySync.methods.flatMap((method) => [
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
const report = auditTradingMethodMap(
  deliverySync,
  inventory as SkillInventory,
  files,
);
if (
  args.includes("--write") &&
  !reconciliation.errors.length &&
  !report.errors.length
) {
  await writeFile(
    resolve("docs/trading-skills-method-map.json"),
    `${JSON.stringify(deliverySync, null, 2)}\n`,
  );
}
console.log(
  JSON.stringify(
    {
      ...report,
      reconciliation: {
        before,
        after: counts(deliverySync),
        errors: reconciliation.errors,
        changes: reconciliation.changes,
        pendingWithoutEvidence: reconciliation.pendingWithoutEvidence,
      },
      deliverySync: {
        added: deliverySync.methods.filter(
          (method) =>
            !reconciliation.map.methods.find((row) => row.id === method.id)
              ?.delivery,
        ).length,
      },
    },
    null,
    2,
  ),
);
if (
  report.errors.length ||
  reconciliation.errors.length ||
  (!args.includes("--write") &&
    (reconciliation.changes.length > 0 ||
      deliverySync.methods.some(
        (method) =>
          !reconciliation.map.methods.find((row) => row.id === method.id)
            ?.delivery,
      ))) ||
  (args.includes("--require-complete") &&
    (report.pendingMethods.length || report.undisposedSources.length))
)
  process.exitCode = 1;
