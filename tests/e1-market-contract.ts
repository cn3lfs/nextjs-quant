import ts from "typescript";

const expected = `<MarketPoolBrowser symbol={symbol} disabled={load.isPending} onSelect={(next) => {
  setSymbol(next);
  load.mutate({ symbol: next, period, source: "local" });
}} />`;
function emitted(source: string) {
  return ts.transpileModule(`const view = (${source});`, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
}
/** Validate the complete E1 addition separately, then compare all pre-existing UI unchanged. */
export function withoutE1MarketBrowser(source: string) {
  const ast = ts.createSourceFile(
    "market.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const nodes: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === "MarketPoolBrowser"
    )
      nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (
    nodes.length !== 1 ||
    emitted(nodes[0]!.getText(ast)) !== emitted(expected)
  )
    throw new Error(
      "E1股票池选择必须传递当前周期、本地来源、忙碌状态并同步所选代码",
    );
  const node = nodes[0]!;
  return source.slice(0, node.getStart(ast)) + source.slice(node.end);
}
