import { createHash } from "node:crypto";
import ts from "typescript";

// Only normalize the event payload adapter required by Radix. Everything in
// the callback body (validation, state updates, requests) remains significant.
export function renderHandlers(source: string) {
  const ast = ts.createSourceFile(
    "view.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const handlers: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(ast))) {
      let name = node.name.getText(ast);
      let body = node.initializer?.getText(ast) ?? "";
      // R2 retains existing external pagers. These exact no-op callbacks are
      // presentation plumbing; do not exempt callbacks that acquire behavior.
      if (
        ["onPaginationChange", "onSortingChange"].includes(name) &&
        body.replace(/\s/g, "") === "{()=>{}}"
      )
        return;
      const expression =
        node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : undefined;
      if (
        ["onChange", "onValueChange", "onCheckedChange"].includes(name) &&
        expression &&
        ts.isArrowFunction(expression)
      ) {
        const parameter = expression.parameters[0]?.name.getText(ast);
        body = expression.body.getText(ast);
        if (parameter) {
          if (name === "onChange")
            body = body
              .replaceAll(`${parameter}.target.value`, "__payload")
              .replaceAll(`${parameter}.target.checked`, "__payload");
          else if (name === "onCheckedChange")
            body = body.replace(
              new RegExp(`${parameter}\\s*===\\s*true`, "g"),
              "__payload",
            );
          else
            body = body.replace(
              new RegExp(`\\b${parameter}\\b`, "g"),
              "__payload",
            );
        }
        name = "onControlChange";
      }
      const parsed = ts.createSourceFile(
        "handler.ts",
        body,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const tokens: (string | number)[] = [];
      function shape(n: ts.Node) {
        tokens.push(n.kind);
        if (ts.isIdentifier(n) || ts.isLiteralExpression(n))
          tokens.push(n.text);
        ts.forEachChild(n, shape);
      }
      shape(parsed);
      handlers.push(
        createHash("sha256")
          .update(name + JSON.stringify(tokens))
          .digest("hex"),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return handlers;
}

export function componentLogic(source: string) {
  const ast = ts.createSourceFile(
    "view.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const result: Record<string, string> = {};
  const containsJsx = (node: ts.Node): boolean =>
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxSelfClosingElement(node) ||
    !!ts.forEachChild(node, (child) => containsJsx(child) || undefined);
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const tokens: (number | string)[] = [];
      function shape(n: ts.Node) {
        if (ts.isParenthesizedExpression(n)) {
          shape(n.expression);
          return;
        }
        tokens.push(n.kind);
        if (ts.isIdentifier(n) || ts.isLiteralExpression(n))
          tokens.push(n.text);
        ts.forEachChild(n, shape);
      }
      node.body.statements
        .filter((statement) => !containsJsx(statement))
        .forEach(shape);
      result[node.name.text] = createHash("sha256")
        .update(JSON.stringify(tokens))
        .digest("hex");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
