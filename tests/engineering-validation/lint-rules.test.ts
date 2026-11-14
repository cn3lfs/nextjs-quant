import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
// Project-service checks need a real included path; lintText supplies only an
// in-memory replacement and never changes this component on disk.
const clientFile = "src/components/ui/button.tsx";

it.each([
  "export const load = (path: string) => import(path);",
  "export const load = (path: string) => import(`./${path}`);",
  "export const load = (path: string) => require(path);",
  "export const load = (path: string) => module.require(path);",
  "export const load = (path: string) => require(`./${path}`);",
])("rejects computed module paths: %s", async (source) => {
  for (const filePath of [clientFile, "packages/quant-rps/src/index.ts"]) {
    const [bad] = await eslint.lintText(source, { filePath });
    expect(bad!.messages.map((m) => m.ruleId)).toContain(
      "no-restricted-syntax",
    );
  }
});

it("allows literal lazy imports, CommonJS paths and type-only import expressions", async () => {
  for (const source of [
    'export const load = () => import("react");',
    "export const load = () => import(`react`);",
    'export const load = () => require("react");',
    'export const load = () => module.require("react");',
    'export type Node = import("react").ReactNode;',
  ]) {
    const [good] = await eslint.lintText(source, { filePath: clientFile });
    expect(good!.messages).toEqual([]);
  }
});

/** Negative control: the rule set must reject React #310 (hook after return). */
it("lint rejects a hook called after an early return", async () => {
  const [bad] = await eslint.lintText(
    `import { useState } from "react";
export function Panel({ ready }: { ready: boolean }) {
  if (!ready) return null;
  const [value] = useState(0);
  return value;
}`,
    { filePath: clientFile },
  );
  expect(bad!.messages.map((m) => m.ruleId)).toContain(
    "react-hooks/rules-of-hooks",
  );
  const [good] = await eslint.lintText(
    `import { useState } from "react";
export function Panel({ ready }: { ready: boolean }) {
  const [value] = useState(0);
  if (!ready) return null;
  return value;
}`,
    { filePath: clientFile },
  );
  expect(good!.errorCount).toBe(0);
});

it("uses types to reject floating promises and accepts await, rejection handlers and explicit background intent", async () => {
  const prefix = "declare function work(): Promise<void>;";
  const [bad] = await eslint.lintText(`${prefix} work();`, {
    filePath: clientFile,
  });
  expect(bad!.messages.map((m) => m.ruleId)).toContain(
    "@typescript-eslint/no-floating-promises",
  );
  for (const body of [
    "await work();",
    "work().catch(() => {});",
    "void work();",
  ]) {
    const [good] = await eslint.lintText(`${prefix} ${body}`, {
      filePath: clientFile,
    });
    expect(good!.messages).toEqual([]);
  }
});

it("rejects dead locals while allowing an intentionally unused callback argument and object omission", async () => {
  const [bad] = await eslint.lintText(
    "const unused = 1; export const used = 2;",
    { filePath: clientFile },
  );
  expect(bad!.messages.map((m) => m.ruleId)).toContain(
    "@typescript-eslint/no-unused-vars",
  );
  const [good] = await eslint.lintText(
    "export const callback = (_event: unknown) => 1; export function omit(value: { secret: string, name: string }) { const { secret, ...rest } = value; return rest; }",
    { filePath: clientFile },
  );
  expect(good!.messages).toEqual([]);
});

it.each([
  [clientFile, 'export { sqlite } from "~/server/db";'],
  [clientFile, 'export { sqlite } from "../../server/db";'],
  ["src/lib/domain.ts", 'export { sqlite } from "~/server/db";'],
  ["src/server/runtime.ts", 'export { Button } from "~/components/ui/button";'],
])("blocks runtime layer imports for %s", async (filePath, text) => {
  const [bad] = await eslint.lintText(text, { filePath });
  expect(bad!.messages.map((m) => m.ruleId)).toContain(
    "@typescript-eslint/no-restricted-imports",
  );
  const [good] = await eslint.lintText(
    'export type { RpsWorkerClient } from "~/server/screening/rps-client";',
    { filePath },
  );
  expect(good!.messages).toEqual([]);
});
