import ts from "typescript";
import { relative } from "node:path";
import { sqliteMethod } from "./lib/sqlite-calls.mjs";

// Static only: never imports application modules or opens a database.
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  process.cwd(),
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const calls: { file: string; line: number; method: string; source: string }[] =
  [];
for (const source of program.getSourceFiles()) {
  const file = relative(process.cwd(), source.fileName).replaceAll("\\", "/");
  if (!file.startsWith("src/") || file.startsWith("src/server/db/")) continue;
  function visit(node: ts.Node) {
    const method = sqliteMethod(checker, node);
    if (method)
      calls.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        method,
        source: node.getText(source),
      });
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(
  JSON.stringify(
    {
      count: calls.length,
      files: new Set(calls.map((call) => call.file)).size,
      calls,
    },
    null,
    2,
  ),
);
