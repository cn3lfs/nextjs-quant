import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { checkDependencies } from "../../scripts/lib/dependency-check";

function fixture(files: Record<string, string>, packages: string[] = []) {
  const root = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "dependency-"));
  function write(file: string, content: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(join(root, "packages"));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        verbatimModuleSyntax: true,
        baseUrl: ".",
        paths: { "~/*": ["src/*"] },
      },
      include: ["src", "packages"],
    }),
  );
  write("src/index.ts", "export const entry = 1;");
  for (const name of packages)
    write(
      `packages/${name}/package.json`,
      JSON.stringify({
        name,
        type: "module",
        exports: {
          ".": { import: "./dist/index.js" },
          "./leaf": { import: "./dist/leaf.js" },
          "./parts/*": { import: "./dist/parts/*.js" },
        },
      }),
    );
  for (const [file, content] of Object.entries(files)) write(file, content);
  return root;
}
const names = (graph: Awaited<ReturnType<typeof checkDependencies>>) =>
  graph.summary.violations.map((violation) => violation.rule.name);

it.each([
  'export { secret } from "~/server/data";',
  'export const load = () => import("../server/data");',
  "export const load = () => import(`~/server/data`);",
  'export const load = () => require("~/server/data");',
  'export const load = () => module.require("~/server/data");',
  'import data = require("../server/data"); export const result = data.secret;',
])("rejects runtime cross-layer dependencies: %s", async (source) => {
  const graph = await checkDependencies(
    fixture({
      "src/components/view.ts": source,
      "src/server/data.ts": "export const secret = 1;",
    }),
  );
  expect(names(graph)).toContain("no-client-server-runtime");
  expect(names(graph)).not.toContain("no-unresolved");
});

it("checks resolved paths and reverse UI imports without blocking type-only contracts or server pages", async () => {
  const graph = await checkDependencies(
    fixture({
      "src/server/data.ts":
        "export const secret = 1; export interface Contract { value: number }",
      "src/lib/value.ts":
        'export { secret } from "../components/../server/data";',
      "src/lib/type.ts":
        'import type { Contract } from "~/server/data"; export type Local = Contract; export type { Contract } from "~/server/data";',
      "src/components/view.ts": "export const view = 1;",
      "src/server/view.ts":
        'export const load = () => import("~/components/view");',
      "src/app/page.ts": 'export { secret } from "~/server/data";',
    }),
  );
  expect(names(graph).sort()).toEqual([
    "no-client-server-runtime",
    "no-server-ui-runtime",
  ]);
});

it.each([false, true])(
  "rejects runtime cycles including lazy edges (lazy=%s)",
  async (lazy) => {
    const graph = await checkDependencies(
      fixture({
        "src/lib/a.ts": lazy
          ? 'export const a = () => import("./b");'
          : 'import { b } from "./b"; export const a = () => b();',
        "src/lib/b.ts": 'import { a } from "./a"; export const b = () => a();',
      }),
    );
    expect(names(graph)).toContain("no-runtime-cycle");
  },
);

it("allows cycles broken by explicit type-only edges", async () => {
  const graph = await checkDependencies(
    fixture({
      "src/lib/a.ts":
        'import type { B } from "./b"; export const a = (b: B) => b.value;',
      "src/lib/b.ts":
        'import { a } from "./a"; export interface B { value: number }; export const b = a({value: 1});',
    }),
  );
  expect(graph.summary.error).toBe(0);
});

it("detects package cycles formed by different files, using public source exports with no dist present", async () => {
  const graph = await checkDependencies(
    fixture(
      {
        "src/index.ts": 'export { a } from "a";',
        "packages/a/src/index.ts":
          'import { leaf } from "b/leaf"; export const a = leaf;',
        "packages/a/src/parts/leaf.ts": "export const leaf = 1;",
        "packages/b/src/index.ts":
          'import { leaf } from "a/parts/leaf"; export const b = leaf;',
        "packages/b/src/leaf.ts": "export const leaf = 2;",
      },
      ["a", "b"],
    ),
  );
  expect(graph.packageCycles).toEqual([["packages/a", "packages/b"]]);
  expect(names(graph)).not.toContain("no-runtime-cycle");
  expect(names(graph)).not.toContain("no-unresolved");
  expect(graph.modules.some((module) => module.source.includes("/dist/"))).toBe(
    false,
  );
  expect(
    graph.modules.find((module) => module.source === "packages/b/src/index.ts")
      ?.dependencies[0]?.resolved,
  ).toBe("packages/a/src/parts/leaf.ts");
});

it("rejects declared workspace build cycles even when no source file imports the other package", async () => {
  const graph = await checkDependencies(
    fixture(
      {
        "packages/a/package.json": JSON.stringify({
          name: "a",
          exports: { ".": "./dist/index.js" },
          dependencies: { b: "workspace:*" },
        }),
        "packages/b/package.json": JSON.stringify({
          name: "b",
          exports: { ".": "./dist/index.js" },
          devDependencies: { a: "workspace:*" },
        }),
        "packages/a/src/index.ts": "export const a = 1;",
        "packages/b/src/index.ts": "export const b = 1;",
      },
      ["a", "b"],
    ),
  );
  expect(graph.summary.error).toBe(0);
  expect(graph.packageCycles).toEqual([["packages/a", "packages/b"]]);
});

it("rejects host dependencies from package source and unresolved modules", async () => {
  const graph = await checkDependencies(
    fixture(
      {
        "packages/a/src/index.ts":
          'export { secret } from "../../../src/server/data";',
        "src/server/data.ts": "export const secret = 1;",
        "src/lib/missing.ts": 'export { value } from "./missing-module";',
      },
      ["a"],
    ),
  );
  expect(names(graph).sort()).toEqual(["no-package-host", "no-unresolved"]);
});

it("returns a failing CLI exit code for a real forbidden import", () => {
  const root = fixture({
    "src/components/view.ts":
      'export const load = () => import("~/server/data");',
    "src/server/data.ts": "export const secret = 1;",
  });
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      resolve("scripts/check-dependencies.ts"),
    ],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("no-client-server-runtime");
});
