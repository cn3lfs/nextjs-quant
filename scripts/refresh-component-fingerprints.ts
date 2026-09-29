/** Refresh the component-characterization fingerprints (R2, R2b, N3 guards)
 * for files that were changed on purpose. The guards exist to catch
 * unintended rendering/logic changes, so run this only for the files whose
 * change you intend, after reviewing the diff:
 *   npx tsx scripts/refresh-component-fingerprints.ts src/components/market/chart.tsx
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { componentLogic, renderHandlers } from "../tests/r2-contracts";
import { withoutE1MarketBrowser } from "../tests/e1-market-contract";
import { withoutTdxSnapshotPanel } from "../tests/tdx-snapshot-contract";

const read = (file: string) => {
  const source = readFileSync(file, "utf8");
  return file.endsWith("/market-view.tsx")
    ? withoutE1MarketBrowser(source)
    : file.endsWith("/chart-workspace.tsx")
      ? withoutTdxSnapshotPanel(source)
      : source;
};
const files = process.argv.slice(2);
if (!files.length)
  throw new Error(
    "usage: npx tsx scripts/refresh-component-fingerprints.ts <file>...",
  );
function update(path: string, compute: (file: string) => unknown) {
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text) as Record<string, unknown>;
  let changed = false;
  for (const file of files) {
    if (!(file in json)) continue;
    const next = compute(file);
    if (JSON.stringify(json[file]) !== JSON.stringify(next)) {
      json[file] = next;
      changed = true;
      console.log(path, "updated", file);
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}
// r2-render-contract: render handlers (market-view without E1 browser).
update("tests/fixtures/r2-render-handlers.json", (file) =>
  renderHandlers(read(file)),
);
update("tests/fixtures/r2-component-logic.json", (file) =>
  componentLogic(readFileSync(file, "utf8")),
);
update("tests/fixtures/r2c-original-contracts.json", (file) => ({
  handlers: renderHandlers(readFileSync(file, "utf8")),
  logic: componentLogic(readFileSync(file, "utf8")),
}));
// r2b-button: same normalization as tests/engineering-validation/r2b-button.test.ts.
function originalRendering(text: string) {
  const original = text.replace(/<Button\s+variant="plain"/g, "<button");
  const ast = ts.createSourceFile(
    "view.tsx",
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: { start: number; end: number }[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(ast) === "button"
    )
      edits.push({
        start: node.closingElement.tagName.getStart(ast),
        end: node.closingElement.tagName.end,
      });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let restored = original;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    restored =
      restored.slice(0, edit.start) + "button" + restored.slice(edit.end);
  return createHash("sha256")
    .update(
      ts
        .transpileModule(restored, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ESNext,
          },
        })
        .outputText.replace(/^import .*;\r?\n/gm, ""),
    )
    .digest("hex");
}
update("tests/fixtures/r2b-button-render.json", (file) =>
  originalRendering(read(file)),
);
// workbench-refactor: viewFingerprint of the returned JSX, keyed by bare file name.
function fingerprint(
  nodes: readonly ts.Node[],
  additions: ReadonlySet<ts.Node> = new Set(),
) {
  function shape(node: ts.Node): unknown {
    if (additions.has(node)) return undefined;
    if (node.kind === ts.SyntaxKind.ExportKeyword) return undefined;
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => {
      const value = shape(child);
      if (value !== undefined) children.push(value);
    });
    const text = ts.isJsxText(node)
      ? node.text.replace(/\s+/g, " ").trim()
      : ts.isIdentifier(node) || ts.isLiteralExpression(node)
        ? node.text
        : undefined;
    if (ts.isJsxText(node) && !text) return undefined;
    return [node.kind, text, children];
  }
  return createHash("sha256")
    .update(JSON.stringify(nodes.map(shape)))
    .digest("hex");
}
function viewFingerprint(node: ts.Node) {
  const emitted = ts.transpileModule(`const view = (${node.getText()});`, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
  return fingerprint(
    ts.createSourceFile("view.js", emitted, ts.ScriptTarget.Latest, true)
      .statements,
  );
}
const n3Path = "tests/fixtures/n3-workbench-structure.json";
const n3 = JSON.parse(readFileSync(n3Path, "utf8"));
// Explicitly requested helper files only; rendering behavior has its own tests.
for (const name of ["reports.tsx", "shared.tsx", "strategy-fields.tsx"]) {
  const file = `src/components/workbench/${name}`;
  if (!files.includes(file)) continue;
  const ast = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const fn of ast.statements.filter(ts.isFunctionDeclaration)) {
    if (fn.name) n3.functions[fn.name.text] = fingerprint([fn]);
  }
  if (
    name === "reports.tsx" &&
    !ast.statements.some(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === "ReportArchive",
    )
  )
    delete n3.functions.ReportArchive;
  writeFileSync(n3Path, JSON.stringify(n3, null, 2) + "\n");
}
const connectionFile = "src/components/workbench/connections.tsx";
if (files.includes(connectionFile)) {
  const ast = ts.createSourceFile(
    connectionFile,
    readFileSync(connectionFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const additions = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === "NotificationPolicyFields"
    )
      additions.add(node);
    ts.forEachChild(node, visit);
  };
  functions.forEach(visit);
  if (additions.size !== 1)
    throw Error(
      "Expected exactly one separately guarded notification policy control",
    );
  n3.connections = fingerprint(functions, additions);
  writeFileSync(n3Path, JSON.stringify(n3, null, 2) + "\n");
}
for (const name of Object.keys(n3.views)) {
  const file = `src/components/workbench/${name}`;
  if (!files.includes(file)) continue;
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = ast.statements.filter(ts.isFunctionDeclaration)[0]!;
  const ret = fn.body!.statements.find(ts.isReturnStatement)!.expression!;
  const next = viewFingerprint(
    ts.isParenthesizedExpression(ret) ? ret.expression : ret,
  );
  if (n3.views[name] !== next) {
    n3.views[name] = next;
    console.log(n3Path, "updated", name);
    writeFileSync(n3Path, JSON.stringify(n3, null, 2) + "\n");
  }
}
// N3 state guard: fingerprint of the workbench state hook's statements
// (all but the returned object), as tests/workbench/workbench-refactor.test.ts.
const stateFile = "src/components/workbench/use-workbench-state.ts";
if (files.includes(stateFile)) {
  const ast = ts.createSourceFile(
    stateFile,
    readFileSync(stateFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = ast.statements.filter(ts.isFunctionDeclaration)[0]!;
  const next = fingerprint(fn.body!.statements.slice(0, -1));
  if (n3.state !== next) {
    n3.state = next;
    console.log(n3Path, "updated state");
    writeFileSync(n3Path, JSON.stringify(n3, null, 2) + "\n");
  }
}
