import ts from "typescript";

const expected = `<TdxSnapshotContainer symbol={snapshot.symbol} />`;
function emitted(source: string) {
  return ts.transpileModule(`const view = (${source});`, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
}

/**
 * 实时盘口/基本面区块是本次对图表工作区的唯一 JSX 新增。先单独核验它按当前
 * 图表快照的证券取数，再把它摘掉与既有渲染指纹比对，保证其余 UI 未被改动。
 */
export function withoutTdxSnapshotPanel(source: string) {
  const ast = ts.createSourceFile(
    "chart-workspace.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const nodes: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === "TdxSnapshotContainer"
    )
      nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (
    nodes.length !== 1 ||
    emitted(nodes[0]!.getText(ast)) !== emitted(expected)
  )
    throw new Error("实时盘口与基本面区块必须按当前图表快照的证券唯一挂载");
  const node = nodes[0]!;
  return source.slice(0, node.getStart(ast)) + source.slice(node.end);
}
