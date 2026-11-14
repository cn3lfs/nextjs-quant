import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import baseline from "../fixtures/n3-workbench-structure.json";

// Characterization of the pre-N3 source: supporting evidence for mechanical
// extraction, not a substitute for browser reachability or existing API tests.
// Ignore formatting and export modifiers, but retain expressions, JSX props,
// callbacks, hook order, query options, keys, classes and literal values.
export function fingerprint(
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

// Compare emitted JSX so Prettier's equivalent `{" "}` / JSX text spacing
// representations do not hide or invent a rendering difference.
export function viewFingerprint(node: ts.Node) {
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

function parse(file: string) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function functions(file: string) {
  return parse(`src/components/workbench/${file}`).statements.filter(
    ts.isFunctionDeclaration,
  );
}
function returned(name: string) {
  const result = functions(name)[0]!.body!.statements.find(
    ts.isReturnStatement,
  )!;
  const expression = result.expression!;
  return ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
}

// The old unconditional-state fingerprint included the removed backtest workflow.
// Current query behavior is covered by workbench-state.test.ts.

it("Q2b wires formula jobs to the existing result selection and preserves exact snapshot disclosure", () => {
  // Selection reset and query ownership are behavioral contracts now:
  // screen-session.test.ts, workbench-state.test.ts and screen-state-browser.mjs.
  const additions: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === "FormulaScreen") ||
      (ts.isJsxExpression(node) &&
        node.expression &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.left.getText() === "screenResult.formula" &&
        !node.expression.right.getText().includes("ResearchUsageContainer"))
    )
      additions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(returned("screen-view.tsx"));
  expect(additions).toHaveLength(2);
  const expectedView = ts.createSourceFile(
    "expected.tsx",
    `const v = <>
    <FormulaScreen onStarted={state.selectFormulaJob} />
    {screenResult.formula && (<div className="notice"><strong>公式：{screenResult.formula.name}</strong><p>参数：{JSON.stringify(screenResult.formula.parameters)}。下表均线差与量比仅作描述，不参与公式选中判定。</p><details><summary>本次执行公式快照</summary><pre>{screenResult.formula.source}</pre></details></div>)}
  </>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const expectedNodes: ts.Node[] = [];
  const collect = (n: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(n) ||
      (ts.isJsxExpression(n) &&
        n.expression &&
        ts.isBinaryExpression(n.expression))
    )
      expectedNodes.push(n);
    ts.forEachChild(n, collect);
  };
  collect(expectedView);
  // R2 formatting introduces equivalent JSX whitespace expressions. Compare
  // emitted rendering while retaining every prop and disclosure expression.
  const rendered = (node: ts.Node) =>
    viewFingerprint(ts.isJsxExpression(node) ? node.expression! : node);
  expect(additions.map(rendered)).toEqual(expectedNodes.map(rendered));
});

it("retains existing helper and report implementations", () => {
  for (const file of ["shared.tsx", "reports.tsx", "strategy-fields.tsx"]) {
    for (const fn of functions(file)) {
      expect(fingerprint([fn]), fn.name!.text).toBe(
        baseline.functions[fn.name!.text as keyof typeof baseline.functions],
      );
    }
  }
});

it("keeps notification policy wiring and read-only connection boundaries", () => {
  const connection = functions("connections.tsx");
  const additions: ts.JsxSelfClosingElement[] = [];
  const importPanel: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText() === "FiveMinuteImport"
    )
      importPanel.push(node);
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText() === "NotificationPolicyFields"
    )
      additions.push(node);
    ts.forEachChild(node, visit);
  };
  connection.forEach(visit);
  expect(additions).toHaveLength(1);
  // P2 owns this new controlled field: it must read the existing settings state
  // and replace only notificationPolicy so the existing Save action persists it.
  const expected = ts.createSourceFile(
    "p2.tsx",
    `<NotificationPolicyFields value={config.notificationPolicy} onChange={(notificationPolicy) => setConfig({ ...config, notificationPolicy })} />`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = expected.statements[0] as ts.ExpressionStatement;
  expect(fingerprint(additions)).toBe(fingerprint([statement.expression]));
  expect(importPanel).toHaveLength(0);
  const connectionSource = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  expect(connectionSource).not.toContain("FiveMinuteImport");
  expect(connectionSource).not.toContain("五分钟 CSV 导入");
  expect(connectionSource).not.toContain("五分钟导入按下方流程操作");
  expect(connectionSource.replace(/\s+/g, " ")).toContain(
    "行情读取与外部 Blocks 目录只读",
  );
  // Current save validation, races and error recovery: connections-browser.mjs.
  // The old whole-component fingerprint predates the settings workflow.
});

it.each([
  ["query option", "refetchInterval: 30000", "refetchInterval: 30001"],
  ["panel prop", "visible={true}", "visible={false}"],
])("detects a changed %s in structural evidence", (_name, before, after) => {
  // Test the evidence tool itself without requiring a particular application
  // hook to keep a polling interval that no longer belongs to it.
  const source = `const query = api.status.useQuery(undefined, { refetchInterval: 30000 });
    const panel = <Panel visible={true} />;`;
  const altered = source.replace(before, after);
  expect(altered).not.toBe(source);
  const statements = (text: string) =>
    ts.createSourceFile(
      "fixture.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ).statements;
  expect(fingerprint(statements(source))).not.toBe(
    fingerprint(statements(altered)),
  );
});

it("V5 attaches usage to completed formula results", () => {
  const screen = readFileSync(
    "src/components/workbench/screen-view.tsx",
    "utf8",
  );
  expect(screen).toMatch(
    /screenResult.formula &&[\s\S]*?<ResearchUsageContainer[\s\S]*?key=\{screenJob\?\.id\}/,
  );
  expect(screen.match(/<ResearchUsageContainer/g)).toHaveLength(1);
});
