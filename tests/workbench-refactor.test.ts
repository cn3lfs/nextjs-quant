import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import baseline from "./fixtures/n3-workbench-structure.json";
import { withoutE1MarketBrowser } from "./e1-market-contract";

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
    file.endsWith("/market-view.tsx")
      ? withoutE1MarketBrowser(readFileSync(file, "utf8"))
      : readFileSync(file, "utf8"),
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

it("retains the original unconditional state, effects, queries and callbacks", () => {
  const statements = functions("use-workbench-state.ts")[0]!.body!.statements;
  expect(fingerprint(statements.slice(0, -1))).toBe(baseline.state);
});

it("Q2b wires formula jobs to the existing result selection and preserves exact snapshot disclosure", () => {
  const statements = functions("use-workbench-state.ts")[0]!.body!.statements;
  const selection = statements.filter(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some(
        (d) => d.name.getText() === "selectFormulaJob",
      ),
  );
  expect(selection).toHaveLength(1);
  const expected = ts.createSourceFile(
    "expected.ts",
    `const selectFormulaJob = (id: string) => {
    setScreenId(id); setExcludedPage(0); setErrorPage(0); setScreenPage(0); setScreenQuery("");
    setScreenSort("original"); void utils.jobs.invalidate();
  };`,
    ts.ScriptTarget.Latest,
    true,
  );
  expect(fingerprint(selection)).toBe(fingerprint(expected.statements));
  const returnedState = statements.at(-1)!.getText();
  expect(returnedState).toMatch(/\bselectFormulaJob\s*,/);
  const additions: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === "FormulaScreen") ||
      (ts.isJsxExpression(node) &&
        node.expression &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.left.getText() === "screenResult.formula")
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

it("retains every extracted view subtree, including handlers and panel props", () => {
  for (const [file, hash] of Object.entries(baseline.views)) {
    expect(viewFingerprint(returned(file)), file).toBe(hash);
  }
});

it("retains connection implementation with the explicitly verified P2 configuration addition", () => {
  const connection = functions("connections.tsx");
  const additions: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
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
  expect(fingerprint(connection, new Set(additions))).toBe(
    baseline.connections,
  );
});

it("detects a changed query option or panel prop in structural evidence", () => {
  const original = parse("src/components/workbench/use-workbench-state.ts");
  const altered = ts.createSourceFile(
    "altered.ts",
    original.text.replace("refetchInterval: 30000", "refetchInterval: 30001"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  expect(fingerprint(original.statements)).not.toBe(
    fingerprint(altered.statements),
  );
});

it("T1 names the candidate action explicitly while preserving snapshot navigation", () => {
  const source = readFileSync(
    "src/components/workbench/screen-view.tsx",
    "utf8",
  );
  expect(source).toContain("个股研究 <ArrowUpRight size={13} />");
  expect(source).toContain('setTab("market")');
  expect(source).toContain("setSymbol(c.symbol)");
  expect(source).toContain("setPeriod(source.period)");
  expect(source).toContain("setLoaded(source)");
});
