import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import baseline from "./fixtures/r2b-button-render.json";

function originalRendering(source: string) {
  // Only the authorized tag/variant substitution is normalized. Event bodies,
  // attributes, children, hook order and request payloads remain significant.
  const original = source.replace(/<Button\s+variant="plain"/g, "<button");
  const ast = ts.createSourceFile(
    "view.tsx",
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: { start: number; end: number }[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(ast) === "button"
    )
      edits.push({
        start: node.closingElement.tagName.getStart(ast),
        end: node.closingElement.tagName.end,
      });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let restored = original;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    restored =
      restored.slice(0, edit.start) + "button" + restored.slice(edit.end);
  return createHash("sha256")
    .update(
      ts
        .transpileModule(restored, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ESNext,
          },
        })
        .outputText.replace(/^import .*;\r?\n/gm, ""),
    )
    .digest("hex");
}

it("R2b replaces only button tags while preserving every original rendered prop, event and component statement", () => {
  for (const [file, expected] of Object.entries(baseline))
    expect(originalRendering(readFileSync(file, "utf8")), file).toBe(expected);
});

it("R2b rendering evidence detects changed actions", () => {
  const file = "src/app/trade-ledger/error.tsx";
  expect(
    originalRendering(
      readFileSync(file, "utf8").replace(
        "onClick={reset}",
        "onClick={() => {}}",
      ),
    ),
  ).not.toBe(baseline[file]);
});
it("T1 keeps all three server routes in the shared client navigation", () => {
  const source = readFileSync("src/components/workbench.tsx", "utf8");
  expect(source).toContain("routeTabs.map((item)");
  expect(source).toContain("href={item.href}");
  expect(source).toContain("scroll={false}");
  expect(source).toContain("hidden={!home}");
  expect(source).toContain("{!home && children}");
  expect(source).toContain("state.setTab(next)");
  expect(source).toContain('router.push("/", { scroll: false })');
  expect(source).not.toContain("<a ");
  expect(source).not.toContain("RESEARCH /");
  const navigation = readFileSync(
    "src/components/workbench/navigation.ts",
    "utf8",
  );
  for (const href of ["/signal-ledger", "/trade-ledger", "/rps"])
    expect(navigation.split(`href: "${href}"`)).toHaveLength(2);
  expect(readFileSync("src/app/layout.tsx", "utf8")).toContain(
    "<WorkbenchLayout>{children}</WorkbenchLayout>",
  );
  expect(readFileSync("src/components/workbench-layout.tsx", "utf8")).toContain(
    "<Workbench>{children}</Workbench>",
  );
  for (const file of [
    "src/app/rps/page.tsx",
    "src/components/signal-ledger-view.tsx",
    "src/components/trade-ledger-panel.tsx",
  ])
    expect(readFileSync(file, "utf8")).not.toContain("返回工作台");
});

it("R2b leaves only the explicitly exempt frozen native button", () => {
  const files = readdirSync("src", { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" &&
        file.endsWith(".tsx") &&
        file.replaceAll("\\", "/") !== "components/backtest-actions.tsx",
    )
    .map((file) => `src/${file}`);
  for (const file of files)
    expect(readFileSync(file, "utf8")).not.toMatch(/<button\b/);
  expect(
    readFileSync("src/components/backtest-actions.tsx", "utf8").match(
      /<button\b/g,
    ),
  ).toHaveLength(1);
  const css = readFileSync("src/styles/globals.css", "utf8");
  expect(css).not.toMatch(/\.button-(primary|outline|ghost|danger|sm)\b/);
});
