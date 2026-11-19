import { readFileSync, readdirSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { build, type BuildOptions } from "esbuild";
import ts from "typescript";
import { beforeAll, expect, it } from "vitest";
import { checkDependencies } from "../../scripts/lib/dependency-check";

const slash = (path: string) => path.replaceAll("\\", "/");
const normalized = (path: string) => posix.normalize(slash(path));
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

let modules: Awaited<ReturnType<typeof checkDependencies>>["modules"];
beforeAll(async () => {
  ({ modules } = await checkDependencies());
}, 60_000);

function upwardDataDependencies(edges: Map<string, string[]>) {
  const violations: string[] = [];
  for (const file of edges.keys()) {
    if (!file.startsWith("src/server/data-sources/")) continue;
    const seen = new Set<string>();
    function visit(p: string) {
      if (seen.has(p)) return;
      seen.add(p);
      if (/^src\/server\/(strategies|backtest|research|performance)\//.test(p))
        violations.push(`${file} -> ${p}`);
      for (const target of edges.get(p) ?? []) visit(target);
    }
    visit(file);
  }
  return violations;
}

it("resolves the runtime and API composition roots and the protected MCP module", () => {
  const indexed = new Set(modules.map(({ source }) => source));
  for (const file of [
    "src/server/runtime.ts",
    "src/server/api/root.ts",
    "src/server/mcp.ts",
  ]) {
    expect(statSync(file).isFile(), file).toBe(true);
    expect(indexed.has(file), file).toBe(true);
    expect(
      parse(file).statements.some(
        (statement) =>
          ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      ),
      file,
    ).toBe(true);
  }
});

it("resolves service imports and bars indirect provider dependencies on orchestration", () => {
  const missing: string[] = [];
  const edges = new Map<string, string[]>();
  for (const { source, dependencies } of modules) {
    if (source.startsWith("src/server/"))
      for (const dep of dependencies)
        if (dep.couldNotResolve) missing.push(`${source}: ${dep.module}`);
    edges.set(
      source,
      dependencies
        .filter((dep) => !dep.dependencyTypes.includes("type-only"))
        .map((dep) => dep.resolved),
    );
  }
  expect(missing).toEqual([]);
  expect(upwardDataDependencies(edges)).toEqual([]);
});

it("detects indirect provider dependencies on orchestration", () => {
  const bad = new Map([
    [
      "src/server/data-sources/test/provider.ts",
      ["src/server/infra/helper.ts"],
    ],
    ["src/server/infra/helper.ts", ["src/server/backtest/run.ts"]],
    [
      "src/server/data-sources/test/performance-provider.ts",
      ["src/server/performance/backtest-evaluation.ts"],
    ],
  ]);
  expect(upwardDataDependencies(bad)).toEqual([
    "src/server/data-sources/test/provider.ts -> src/server/backtest/run.ts",
    "src/server/data-sources/test/performance-provider.ts -> src/server/performance/backtest-evaluation.ts",
  ]);
});

type RuntimeFormat = "cjs" | "esm";
type RuntimeBuild = BuildOptions & {
  entryPoints: string[];
  outfile: string;
  format: RuntimeFormat;
};

function stringLiteral(node: ts.Node | undefined) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function runtimeBuilds() {
  const script = parse("scripts/build-runtime.mjs");
  const options: RuntimeBuild[] = [];
  walk(script, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText() !== "build")
      return;
    const declaration = node.arguments[0];
    if (!declaration || !ts.isObjectLiteralExpression(declaration))
      throw new Error(`Expected an esbuild options object: ${node.getText()}`);
    const fields = new Map(
      declaration.properties
        .filter(ts.isPropertyAssignment)
        .map(({ name, initializer }) => [
          stringLiteral(name) ?? name.getText(),
          initializer,
        ]),
    );
    const entry = fields.get("entryPoints");
    const outfile = stringLiteral(fields.get("outfile"));
    const format = stringLiteral(fields.get("format"));
    if (
      !entry ||
      !ts.isArrayLiteralExpression(entry) ||
      !outfile ||
      (format !== "cjs" && format !== "esm")
    )
      throw new Error(
        `Declare explicit entryPoints, outfile and format: ${node.getText()}`,
      );
    expect(fields.get("write")?.kind, outfile).not.toBe(
      ts.SyntaxKind.FalseKeyword,
    );
    const entryPoints = entry.elements.map((value) => {
      const path = stringLiteral(value);
      if (!path)
        throw new Error(`Expected a literal build entry: ${value.getText()}`);
      return path;
    });
    const external = fields.get("external");
    const platform = stringLiteral(fields.get("platform"));
    options.push({
      entryPoints,
      outfile: normalized(outfile),
      format,
      bundle: fields.get("bundle")?.kind === ts.SyntaxKind.TrueKeyword,
      platform: platform as BuildOptions["platform"],
      target: stringLiteral(fields.get("target")),
      external:
        external && ts.isArrayLiteralExpression(external)
          ? external.elements.map((value) => {
              const name = stringLiteral(value);
              if (!name)
                throw new Error(
                  `Expected a literal external package: ${value.getText()}`,
                );
              return name;
            })
          : undefined,
    });
  });
  return options;
}

function formatFromPath(path: string): RuntimeFormat | undefined {
  if (path.endsWith(".cjs")) return "cjs";
  if (path.endsWith(".mjs")) return "esm";
  return undefined;
}

function runtimeConsumers(entries: readonly RuntimeBuild[]) {
  const consumers: { file: string; path: string; format?: RuntimeFormat }[] =
    [];
  const add = (file: string, path: string, format?: RuntimeFormat) =>
    consumers.push({ file, path: normalized(path), format });
  const packageMain = (
    JSON.parse(readFileSync("package.json", "utf8")) as { main: string }
  ).main;
  expect(normalized(packageMain), "Electron package main").toMatch(
    /^desktop\//,
  );
  add("package.json", packageMain);

  const byPath = new Map(modules.map((module) => [module.source, module]));
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const ast = parse(file);
    walk(ast, (node) => {
      let target: ts.Node | undefined;
      let format: RuntimeFormat | undefined;
      let directory: "runtime" | "desktop" = "runtime";
      if (ts.isNewExpression(node) && node.expression.getText() === "Worker") {
        target = node.arguments?.[0];
      } else if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "fork"
      ) {
        target = node.arguments[0];
      } else if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "Reflect.construct" &&
        node.arguments[0]?.getText() === "Worker"
      ) {
        const args = node.arguments[1];
        if (args && ts.isArrayLiteralExpression(args))
          target = args.elements[0];
      } else if (ts.isArrayLiteralExpression(node)) {
        const preloadFlags = ["--import", "--require", "-r"];
        const index = node.elements.findIndex((value) =>
          preloadFlags.includes(stringLiteral(value) ?? ""),
        );
        if (index !== -1) {
          target = node.elements[index + 1];
          format =
            stringLiteral(node.elements[index]) === "--import" ? "esm" : "cjs";
        }
      } else if (
        file.startsWith("electron/") &&
        ts.isPropertyAssignment(node) &&
        (stringLiteral(node.name) ?? node.name.getText()) === "preload"
      ) {
        target = node.initializer;
        directory = "desktop";
        format = "cjs";
      }
      if (!target) return;
      walk(target, (value) => {
        const path = stringLiteral(value);
        if (path && /\.(?:[cm]?js)$/.test(path))
          add(
            file,
            path.includes("/") || path.includes("\\")
              ? path
              : `${directory}/${path}`,
            format,
          );
      });
    });
    for (const dep of byPath.get(file)?.dependencies ?? [])
      if (
        dep.resolved.startsWith("src/") &&
        !dep.dependencyTypes.includes("type-only")
      )
        visit(dep.resolved);
  }

  // Follow production entry points. Retired clients still used by test fixtures
  // are not active hosts and must not require shipping their old bundles.
  visit("src/server/runtime.ts");
  visit("src/server/api/root.ts");
  for (const { source } of modules)
    if (/^src\/(app\/|instrumentation\.)/.test(source)) visit(source);
  for (const entry of entries.flatMap(({ entryPoints }) => entryPoints))
    if (!visited.has(normalized(entry))) visit(normalized(entry));
  for (const script of readdirSync("scripts").filter((file) =>
    file.endsWith(".ps1"),
  )) {
    const file = `scripts/${script}`;
    for (const match of readFileSync(file, "utf8").matchAll(
      /\bruntime[\\/][\w./\\-]+\.[cm]?js\b/g,
    ))
      add(file, match[0]);
  }
  return consumers;
}

it("builds runtime and desktop entries without collisions and satisfies their production loaders", async () => {
  const entries = runtimeBuilds();
  const outputs = new Map<string, RuntimeFormat>();
  for (const { entryPoints, outfile, format } of entries) {
    expect(entryPoints, outfile).not.toHaveLength(0);
    for (const entry of entryPoints)
      expect(statSync(entry).isFile(), entry).toBe(true);
    expect(outfile, `output for ${entryPoints.join(", ")}`).toMatch(
      /^(runtime|desktop)\/.+/,
    );
    expect(formatFromPath(outfile), outfile).toBe(format);
    expect(
      outputs.has(outfile.toLowerCase()),
      `duplicate output: ${outfile}`,
    ).toBe(false);
    outputs.set(outfile.toLowerCase(), format);
  }

  const emitted = new Map<string, RuntimeFormat>();
  for (const entry of entries) {
    // Emit into memory from the current sources; old files cannot satisfy a loader.
    const { outputFiles } = await build({ ...entry, write: false });
    const paths = outputFiles.map((file) =>
      slash(relative(resolve("."), file.path)),
    );
    expect(paths, entry.outfile).toContain(entry.outfile);
    emitted.set(entry.outfile, entry.format);
  }
  for (const { file, path, format } of runtimeConsumers(entries)) {
    expect(emitted.has(path), `${file} loads missing ${path}`).toBe(true);
    if (format)
      expect(emitted.get(path), `${file} loads ${path} as ${format}`).toBe(
        format,
      );
  }
});
