import { sqliteMethod } from "./sqlite-calls.mjs";

/** @satisfies {import("eslint").Rule.RuleModule} */
export const sqliteBoundaryRule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { allowTransactions: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    messages: {
      repository:
        "此范围已迁入类型仓储；SQLite 调用必须放在 src/server/db 中。",
    },
  },
  /** @param {import("eslint").Rule.RuleContext} context */
  create(context) {
    const services = context.sourceCode.parserServices;
    const program = services?.program;
    if (!program || !services.esTreeNodeToTSNodeMap)
      throw new Error("SQLite 仓储守卫需要 TypeScript 类型信息");
    const checker = program.getTypeChecker();
    return {
      /** @param {import("estree").CallExpression} node */
      CallExpression(node) {
        const source = services.esTreeNodeToTSNodeMap.get(node);
        const method = sqliteMethod(checker, source);
        if (
          method &&
          !(method === "transaction" && context.options[0]?.allowTransactions)
        )
          context.report({ node, messageId: "repository" });
      },
    };
  },
};
