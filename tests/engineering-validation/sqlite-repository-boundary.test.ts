import { expect, it } from "vitest";
import { resolve } from "node:path";
import ts from "typescript";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { sqliteBoundaryRule } from "../../scripts/lib/sqlite-boundary-rule.mjs";
import { sqliteMethod } from "../../scripts/lib/sqlite-calls.mjs";

it("recognizes real SQLite methods, aliases and bracket access without rejecting unrelated objects", async () => {
  const file = resolve("src/server/jobs/jobs.ts");
  const code = `import Database from 'better-sqlite3';
    const connection = new Database(':memory:');
    const alias = connection;
    connection.prepare('SELECT 1');
    alias['exec']('SELECT 1');
    alias.transaction(() => 1)();
    const other = { prepare: () => 1, exec: () => 1, transaction: () => 1 };
    other.prepare(); other.exec(); other.transaction();
    const { prepare } = connection; prepare('SELECT 2');`;
  const host = ts.createCompilerHost({});
  const original = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === file ? code : original(path));
  const program = ts.createProgram(
    [file],
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
    host,
  );
  const source = program.getSourceFile(file)!;
  const methods: string[] = [];
  function visit(node: ts.Node) {
    const method = sqliteMethod(program.getTypeChecker(), node);
    if (method) methods.push(method);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(methods).toEqual(["prepare", "exec", "transaction", "prepare"]);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { programs: [program] },
        },
        plugins: {
          repositories: { rules: { "no-raw-sqlite": sqliteBoundaryRule } },
        },
        rules: { "repositories/no-raw-sqlite": "error" },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: file });
  expect(result!.messages.map((message) => message.ruleId)).toEqual([
    "repositories/no-raw-sqlite",
    "repositories/no-raw-sqlite",
    "repositories/no-raw-sqlite",
    "repositories/no-raw-sqlite",
  ]);
  expect(result!.messages.map((message) => message.line)).toEqual([4, 5, 6, 9]);
  const orchestration = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { programs: [program] },
        },
        plugins: {
          repositories: { rules: { "no-raw-sqlite": sqliteBoundaryRule } },
        },
        rules: {
          "repositories/no-raw-sqlite": ["error", { allowTransactions: true }],
        },
      },
    ],
  });
  const [allowed] = await orchestration.lintText(code, { filePath: file });
  expect(allowed!.messages.map((message) => message.line)).toEqual([4, 5, 9]);
});
