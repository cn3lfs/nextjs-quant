import ts from "typescript";

/** Resolve the method declaration, rather than matching names on unrelated objects.
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Node} node
 */
export function sqliteMethod(checker, node) {
  if (!ts.isCallExpression(node)) return null;
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (
    declaration &&
    (ts.isMethodSignature(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    /[\\/]@types[\\/]better-sqlite3[\\/]index\.d\.ts$/.test(
      declaration.getSourceFile().fileName,
    )
  ) {
    const name = declaration.name.getText().replaceAll(/["']/g, "");
    if (["prepare", "exec", "transaction"].includes(name)) return name;
  }
  const expression = node.expression;
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isElementAccessExpression(expression)
  )
    return null;
  const member = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : ts.isElementAccessExpression(expression)
      ? expression.argumentExpression
      : null;
  if (!member || (!ts.isIdentifier(member) && !ts.isStringLiteral(member)))
    return null;
  const name = member.text;
  if (!["prepare", "exec", "transaction"].includes(name)) return null;
  const receiver = expression.expression;
  const symbol = checker.getTypeAtLocation(receiver).getProperty(name);
  return symbol?.declarations?.some((declaration) =>
    /[\\/]@types[\\/]better-sqlite3[\\/]index\.d\.ts$/.test(
      declaration.getSourceFile().fileName,
    ),
  )
    ? name
    : null;
}
