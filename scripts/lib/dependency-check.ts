import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cruise, type IRegularForbiddenRuleType } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { Graph, alg } from "@dagrejs/graphlib";

export const dependencyRules: IRegularForbiddenRuleType[] = [
  {
    name: "no-client-server-runtime",
    severity: "error",
    from: { path: "^src/(components|lib)/" },
    to: { path: "^src/server/", dependencyTypesNot: ["type-only"] },
  },
  {
    name: "no-server-ui-runtime",
    severity: "error",
    from: { path: "^src/server/" },
    to: { path: "^src/(components|app)/", dependencyTypesNot: ["type-only"] },
  },
  {
    name: "no-package-host",
    severity: "error",
    from: { path: "^packages/" },
    to: { path: "^(src|electron|scripts|runtime)/" },
  },
  {
    name: "no-runtime-cycle",
    severity: "error",
    from: {},
    to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
  },
  {
    name: "no-unresolved",
    severity: "error",
    from: {},
    to: { couldNotResolve: true },
  },
  {
    name: "workspace-source-only",
    severity: "error",
    from: {},
    to: { path: "^packages/[^/]+/dist/" },
  },
];

/** Resolve public workspace exports to their source owners, not stale dist files. */
export async function checkDependencies(workspaceRoot = process.cwd()) {
  const root = resolve(workspaceRoot);
  const tsConfig = extractTSConfig(resolve(root, "tsconfig.json"));
  const alias: Record<string, string> = {};
  function sourceAlias(specifier: string, source: string) {
    if (specifier.endsWith("/*") && /\*(?:\.ts)?$/.test(source))
      alias[specifier.slice(0, -2)] = resolve(
        root,
        source.replace(/\*(?:\.ts)?$/, ""),
      );
    else if (!specifier.includes("*") && !source.includes("*"))
      alias[`${specifier}$`] = resolve(root, source);
    else throw new Error(`Unsupported source alias: ${specifier} -> ${source}`);
  }
  for (const [specifier, paths] of Object.entries(
    tsConfig.options.paths ?? {},
  )) {
    if (paths.length !== 1)
      throw new Error(`Ambiguous source alias: ${specifier}`);
    sourceAlias(
      specifier,
      resolve(tsConfig.options.baseUrl ?? root, paths[0]!),
    );
  }
  const packages = readdirSync(resolve(root, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const manifests = new Map<
    string,
    { directory: string; dependencies: string[] }
  >();
  for (const directory of packages) {
    const manifest = JSON.parse(
      readFileSync(
        resolve(root, "packages", directory, "package.json"),
        "utf8",
      ),
    ) as {
      name: string;
      exports: Record<string, string | { import: string }>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    manifests.set(manifest.name, {
      directory,
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
      }),
    });
    for (const [key, value] of Object.entries(manifest.exports)) {
      const target = typeof value === "string" ? value : value.import;
      if (!target?.startsWith("./dist/") || !target.endsWith(".js"))
        throw new Error(
          `Unsupported workspace export: ${manifest.name}:${key}`,
        );
      const source = `packages/${directory}/${target.replace("./dist/", "src/").replace(/\.js$/, ".ts")}`;
      sourceAlias(manifest.name + (key === "." ? "" : key.slice(1)), source);
    }
  }
  const result = await cruise(
    ["src", ...packages.map((directory) => `packages/${directory}/src`)],
    {
      baseDir: root,
      tsPreCompilationDeps: "specify",
      exoticRequireStrings: ["module.require"],
      doNotFollow: { path: "node_modules" },
      validate: true,
      ruleSet: { forbidden: dependencyRules },
    },
    {
      alias,
      conditionNames: ["import", "default"],
      exportsFields: ["exports"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
    },
    { tsConfig },
  );
  if (typeof result.output === "string")
    throw new Error("Expected a dependency graph");
  if (!result.output.modules.some((module) => module.source.startsWith("src/")))
    throw new Error("No application source modules were inspected");
  // A package-level cycle need not form a module-level cycle. Collapse actual
  // source edges by package owner and include declared build dependencies too.
  const packageGraph = new Graph({ directed: true });
  for (const { directory, dependencies } of manifests.values()) {
    const from = `packages/${directory}`;
    packageGraph.setNode(from);
    for (const dependency of dependencies) {
      const to = manifests.get(dependency);
      if (to) packageGraph.setEdge(from, `packages/${to.directory}`);
    }
  }
  const owner = (path: string) => path.match(/^packages\/[^/]+(?=\/)/)?.[0];
  for (const module of result.output.modules) {
    const from = owner(module.source);
    if (!from) continue;
    for (const dependency of module.dependencies) {
      const to = owner(dependency.resolved);
      if (to && to !== from) packageGraph.setEdge(from, to);
    }
  }
  // findCycles returns strongly connected groups, not an ordered edge path.
  return {
    ...result.output,
    packageCycles: alg.findCycles(packageGraph).map((group) => group.sort()),
  };
}
