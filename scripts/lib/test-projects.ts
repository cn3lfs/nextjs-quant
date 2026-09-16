import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/** Follow runtime imports, not test names. Unknown dynamic imports are serial.
 * Read-only fixture access is safe; writable IO and external runtimes are not.
 */
export function classifyTestFiles(root = process.cwd()) {
  const slash = (path: string) => path.replaceAll("\\", "/");
  const files = readdirSync(resolve(root, "tests"), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => `tests/${slash(path)}`)
    .sort();
  const cache = new Map<string, { imports: string[]; reasons: string[] }>();
  function inspect(path: string) {
    const cached = cache.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const result = { imports: [] as string[], reasons: [] as string[] };
    cache.set(path, result);
    const local = slash(relative(root, path));
    const reason = (value: string) => result.reasons.push(`${local}: ${value}`);
    function dependency(id: string, node: ts.Node) {
      if (
        /^(?:node:)?(?:child_process|worker_threads|http|https|net|tls)$/.test(
          id,
        ) ||
        /^(better-sqlite3|koffi|undici|openai)$/.test(id)
      )
        reason(id);
      if (
        /^(?:node:)?fs(?:\/promises)?$/.test(id) &&
        /\b(mkdtemp|mkdir|writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|createWriteStream|open|truncate|chmod|write|writev|appendFile|link|symlink|utimes|chown|ftruncate)(Sync)?\b/.test(
          node.getText(),
        )
      )
        reason("writable filesystem");
      if (/^(?:node:)?fs(?:\/promises)?$/.test(id)) {
        const clause = ts.isImportDeclaration(node)
          ? node.importClause
          : undefined;
        const bindings = clause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || clause?.name)
          reason("opaque filesystem import");
        else if (
          bindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              !/^(?:readFile|readdir|readlink|realpath|stat|lstat|fstat|access|exists|read|readv|createReadStream|constants|Dirent|Stats)(?:Sync)?$/.test(
                (element.propertyName ?? element.name).text,
              ),
          )
        )
          reason("unreviewed filesystem capability");
      }
      if (!id.startsWith(".") && !id.startsWith("~/")) {
        if (
          !/^(?:node:)?(?:assert(?:\/strict)?|path|url|util|os|crypto|buffer|events|string_decoder|stream(?:\/promises)?|fs(?:\/promises)?)$/.test(
            id,
          ) &&
          !/^(?:vitest|zod|react(?:\/.*)?|react-dom(?:\/.*)?|clsx|tailwind-merge|class-variance-authority|superjson|typescript)$/.test(
            id,
          )
        )
          reason(`unreviewed external dependency: ${id}`);
        return;
      }
      const base = id.startsWith("~/")
        ? resolve(root, "src", id.slice(2))
        : resolve(dirname(path), id);
      const target = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mjs`,
        `${base}/index.ts`,
      ].find(
        (candidate) =>
          /\.(ts|tsx|mjs)$/.test(candidate) && existsSync(candidate),
      );
      if (target) result.imports.push(target);
      else if (!id.endsWith(".json"))
        reason(`unresolved runtime dependency: ${id}`);
    }
    function visit(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (node.importClause?.isTypeOnly) return;
        const bindings = node.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((item) => item.isTypeOnly)
        )
          return;
        dependency(node.moduleSpecifier.text, node);
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        dependency(node.moduleSpecifier.text, node);
      } else if (ts.isCallExpression(node)) {
        const name = node.expression.getText();
        if (name === "import" || name === "require") {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument))
            dependency(argument.text, node);
          else reason("dynamic runtime dependency");
        }
        if (name === "fetch" || name === "globalThis.fetch")
          reason("network/live call");
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (/process\.env\.[A-Z_]*(?:LIVE|REAL_DATA)/.test(source))
      reason("live opt-in");
    return result;
  }
  const reasons: Record<string, string[]> = {};
  for (const file of files) {
    const seen = new Set<string>();
    const found = new Set<string>();
    function walk(path: string) {
      if (seen.has(path)) return;
      seen.add(path);
      const info = inspect(path);
      info.reasons.forEach((reason) => found.add(reason));
      info.imports.forEach(walk);
    }
    walk(resolve(root, file));
    if (found.size) reasons[file] = [...found].sort();
  }
  return {
    serial: files.filter((file) => file in reasons),
    parallel: files.filter((file) => !(file in reasons)),
    reasons,
  };
}
