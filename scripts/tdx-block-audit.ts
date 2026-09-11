import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: { root: { type: "string" }, blocks: { type: "string" } },
});
if (!values.root) throw new Error("需要 --root 通达信目录");
const dataDir = await mkdtemp(join(tmpdir(), "quant-block-audit-"));
process.env.QUANT_DATA_DIR = dataDir;
const { readTdxLocalBlocks } = await import("../src/server/tdx-local-blocks");
const { readMarketPool } = await import("../src/server/market-pool-files");
const snapshot = await readTdxLocalBlocks(values.root);
const a500 = await readMarketPool(
  "",
  { category: "index", name: "通达信·成分·中证A500" },
  values.root,
);
let comparison = null;
if (values.blocks) {
  const external = await readMarketPool(values.blocks, {
    category: "index",
    name: "中证A500",
  });
  comparison = {
    externalCount: external.members.length,
    externalHash: external.hash,
    onlyTdx: a500.members.filter(
      (symbol) => !external.members.includes(symbol),
    ),
    onlyExternal: external.members.filter(
      (symbol) => !a500.members.includes(symbol),
    ),
  };
}
const report = {
  capturedAt: new Date().toISOString(),
  root: snapshot.root,
  hash: snapshot.hash,
  files: snapshot.files,
  groups: snapshot.blocks.map(({ members, ...block }) => ({
    ...block,
    count: members.length,
  })),
  a500,
  comparison,
};
const path = join(dataDir, "block-audit.json");
await writeFile(path, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      report: path,
      groups: snapshot.blocks.length,
      categoryCounts: ["industry", "concept", "index"].map((category) => ({
        category,
        count: snapshot.blocks.filter((b) => b.category === category).length,
      })),
      a500Count: a500.members.length,
      comparison,
    },
    null,
    2,
  ),
);
