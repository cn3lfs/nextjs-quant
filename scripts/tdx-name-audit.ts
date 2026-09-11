import { parseArgs } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { values } = parseArgs({ options: { root: { type: "string" } } });
if (!values.root) throw new Error("需要 --root 通达信目录");
// Imports that can open SQLite happen only after selecting an isolated data directory.
const dataDir = await mkdtemp(join(tmpdir(), "quant-name-audit-"));
process.env.QUANT_DATA_DIR = dataDir;
const { scan } = await import("../src/server/tdx");
const { put } = await import("../src/server/db");
const { securityDirectory } = await import("../src/server/securities");
put("settings", "settings", { tdxRoot: values.root });
const coverage = await scan(values.root);
put("coverage", "coverage", coverage);
const directory = await securityDirectory();
const entries = Object.values(directory.entries);
const local = [...new Set(coverage.securities.map((row) => row.symbol))];
const report = {
  root: values.root,
  capturedAt: new Date().toISOString(),
  dataDir,
  localSymbols: local.length,
  namedLocal: local.filter((symbol) => directory.entries[symbol]).length,
  totalNames: entries.length,
  currentTnfSymbols: directory.currentSymbols?.length,
  supplement: directory.supplement,
  codeMapping: directory.codeMapping,
  codeMappedNames: entries.filter((row) => row.nameSource === "tdx-code-map")
    .length,
  missingNames: directory.missingNames,
  conflicts: entries
    .filter((row) => row.nameConflicts?.length)
    .map(({ symbol, name, nameSource, nameConflicts }) => ({
      symbol,
      name,
      nameSource,
      nameConflicts,
    })),
  supplementalNames: entries
    .filter((row) => row.nameSource === "tdx-infoharbor")
    .map(({ symbol, name }) => ({ symbol, name })),
};
await writeFile(
  join(dataDir, "name-audit.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);
console.log(JSON.stringify(report, null, 2));
