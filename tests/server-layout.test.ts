import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
const root = process.cwd();
const slash = (p: string) => p.replaceAll("\\", "/");
const files = readdirSync("src/server", { recursive: true })
  .map(String)
  .filter((p) => p.endsWith(".ts"))
  .map((p) => `src/server/${slash(p)}`);
function resolveLocal(file: string, id: string) {
  const base = id.startsWith("~/")
    ? resolve("src", id.slice(2))
    : id.startsWith(".")
      ? resolve(dirname(file), id)
      : null;
  if (!base) return null;
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, "index.ts"),
  ].find((p) => existsSync(p) && statSync(p).isFile());
}
function graph() {
  const missing: string[] = [];
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const dependencies: string[] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const id = node.moduleSpecifier.text;
        const target = resolveLocal(file, id);
        if ((id.startsWith(".") || id.startsWith("~/")) && !target)
          missing.push(`${file}: ${id}`);
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly ||
            (!node.importClause?.name &&
              node.importClause?.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.every(
                (e) => e.isTypeOnly,
              ))
          : node.isTypeOnly;
        if (target && !typeOnly)
          dependencies.push(slash(relative(root, target)));
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    edges.set(file, dependencies);
  }
  return { edges, missing };
}
function upwardDataDependencies(edges: Map<string, string[]>) {
  const violations: string[] = [];
  for (const file of edges.keys()) {
    if (!file.startsWith("src/server/data-sources/")) continue;
    const seen = new Set<string>();
    function visit(p: string) {
      if (seen.has(p)) return;
      seen.add(p);
      if (/^src\/server\/(strategies|backtest|research)\//.test(p))
        violations.push(`${file} -> ${p}`);
      for (const target of edges.get(p) ?? []) visit(target);
    }
    visit(file);
  }
  return violations;
}
it("keeps only the composition root and protected MCP modules at server root", () => {
  expect(
    readdirSync("src/server")
      .filter((p) => p.endsWith(".ts"))
      .sort(),
  ).toEqual([
    "connection-pool.ts",
    "mcp-health.ts",
    "mcp-session.ts",
    "mcp.ts",
    "runtime.ts",
    "vault.ts",
  ]);
});
it("resolves service imports and keeps providers below strategy/backtest orchestration", () => {
  const { edges, missing } = graph();
  expect(missing).toEqual([]);
  expect(upwardDataDependencies(edges)).toEqual([]);
});
it("detects indirect provider dependencies on orchestration", () => {
  const bad = new Map([
    [
      "src/server/data-sources/test/provider.ts",
      ["src/server/infra/helper.ts"],
    ],
    ["src/server/infra/helper.ts", ["src/server/backtest/run.ts"]],
  ]);
  expect(upwardDataDependencies(bad)).toEqual([
    "src/server/data-sources/test/provider.ts -> src/server/backtest/run.ts",
  ]);
});
it("keeps every worker source entry resolvable and emitted runtime filenames stable", () => {
  const source = readFileSync("scripts/build-runtime.mjs", "utf8");
  const entries = [...source.matchAll(/entryPoints: \["([^"]+)"\]/g)].map(
    (m) => m[1]!,
  );
  expect(entries.length).toBeGreaterThanOrEqual(9);
  for (const entry of entries) expect(existsSync(entry), entry).toBe(true);
  const outputs = [...source.matchAll(/outfile: "(runtime\/[^\"]+)"/g)]
    .map((m) => m[1]!)
    .sort();
  expect(outputs).toEqual([
    "runtime/czsc-worker.cjs",
    "runtime/discipline-worker.cjs",
    "runtime/intraday-worker.cjs",
    "runtime/research-worker.cjs",
    "runtime/rps-worker.cjs",
    "runtime/signal-ledger-worker.cjs",
    "runtime/westock-preload.mjs",
    "runtime/worker.cjs",
    "runtime/workflow-runner.cjs",
  ]);
});
