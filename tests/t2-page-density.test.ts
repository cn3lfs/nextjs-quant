import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { renderHandlers } from "./r2-contracts";

const screen = readFileSync("src/components/workbench/screen-view.tsx", "utf8");
const workspace = readFileSync("src/components/chart-workspace.tsx", "utf8");
const chart = readFileSync("src/components/chart.tsx", "utf8");

it("T2 keeps all four forms mounted and hides exactly the inactive entries", () => {
  const ast = ts.createSourceFile(
    "screen.tsx",
    screen,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const panels: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node)) {
      const props = node.attributes.properties;
      const id = props.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText() === "id",
      );
      if (
        id &&
        ts.isJsxAttribute(id) &&
        id.initializer &&
        ts.isStringLiteral(id.initializer) &&
        id.initializer.text.startsWith("screen-entry-")
      ) {
        const name = id.initializer.text.replace("screen-entry-", "");
        const hidden = props.find(
          (p) => ts.isJsxAttribute(p) && p.name.getText() === "hidden",
        );
        expect(hidden?.getText()).toBe(`hidden={entry !== "${name}"}`);
        expect(ts.isJsxElement(node.parent)).toBe(true);
        expect(ts.isJsxFragment(node.parent.parent)).toBe(true);
        panels.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(panels).toEqual(["formula", "online", "draft", "local"]);
  expect(screen).toContain("aria-pressed={entry === id}");
  expect(screen).toContain("aria-controls={`screen-entry-${id}`}");
  expect(screen).toContain("onClick={() => setEntry(id)}");
  expect(screen).toContain(
    "<FormulaScreen onStarted={state.selectFormulaJob} />",
  );
});

it("T2 retains import and draft actions while opening the destination form", () => {
  const expected = renderHandlers(`<><OnlineScreen onImport={(selected) => {
    setUniverse(selected.join(",")); setEntry("local");
    notify(\`已将本页 \${selected.length} 只证券填入本地池，请核对周期与规则后运行复核\`);
  }} /><Button onClick={() => { setOnlineQuery(prompt); setEntry("online"); }} />
  <Button onClick={() => { setStrategy(draft.strategy); setEntry("local"); notify("草案已应用，请核对后运行"); }} />
  <Button onClick={() => screen.mutate({ strategy, period, symbols: symbols(), asOf: historicalDate || undefined, requireCurrent, universeSource: historicalDate ? universeSource : undefined })} /></>`);
  const actual = renderHandlers(screen);
  for (const hash of expected)
    expect(actual.filter((value) => value === hash)).toHaveLength(1);
});

it("T2 describes the four entry boundaries without implying online or current coverage guarantees", () => {
  for (const text of [
    "使用通达信公式筛选本地全 A 股已完成日线，采用不复权口径。",
    "查询财务、行业等在线条件，结果不代表本地规则已通过，导入后仍需复核。",
    "将自然语言需求转为双均线条件草案，确认应用后再运行本地筛选。",
    "按双均线、涨幅与量比规则筛选本地数据，覆盖范围只反映最近扫描索引。",
  ])
    expect(screen).toContain(text);
});

it("T2 groups chart controls into two nonwrapping rows and retains parameter and drawing actions", () => {
  expect(workspace).toContain('data-testid="chart-primary-controls"');
  expect(workspace).toContain(
    'className="relative flex items-center gap-3 py-2 whitespace-nowrap"',
  );
  expect(workspace.match(/name="chart-tools"/g)).toHaveLength(2);
  expect(workspace).toContain("指标参数</summary>");
  expect(workspace).toContain("画线：{tools[tool]}</summary>");
  expect(workspace).toContain('role="toolbar"');
  expect(workspace).toContain("Object.entries(tools).map");
  expect(workspace).toContain("左右键平移 · 上下键缩放 · 拖拽价格轴缩放");
  expect(chart).toContain('data-testid="chart-secondary-controls"');
  expect(chart).toContain(
    "flex items-center gap-3 overflow-x-auto py-2 text-sm whitespace-nowrap",
  );
  for (const handler of renderHandlers(
    `<><Button onClick={() => save.mutate({ symbol: snapshot.symbol, period, view })} /><Button onClick={() => { setTool(id as keyof typeof tools); setAnchor(null); }} /></>`,
  ))
    expect(renderHandlers(workspace)).toContain(handler);
  for (const label of [
    'aria-label="双突破观察日"',
    'aria-label="副图"',
    'data-testid="rps-controls"',
    "setShowBoll(checked === true)",
    "setShowBreakout(checked === true)",
    "setShowCzsc(checked === true)",
  ])
    expect(chart).toContain(label);
});
