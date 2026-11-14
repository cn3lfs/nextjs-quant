import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { renderHandlers } from "../helpers/r2-contracts";

// Radix migration source hashes are retired; settings save/races/validation
// are exercised in connections-browser.mjs. Research form selection, submission
// and draft lifetime are exercised in page-state-browser.mjs.
it("connects current strategy, connection and evidence controls", () => {
  const strategy = readFileSync(
    "src/components/workbench/strategy-fields.tsx",
    "utf8",
  );
  expect(strategy.match(/<Input\b/g)).toHaveLength(5);
  for (const field of [
    "fast",
    "slow",
    "minChange",
    "maxChange",
    "minVolumeRatio",
  ])
    expect(strategy).toContain(`value={strategy.${field}}`);
  expect(strategy).toContain('step="0.1"');
  const connection = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  expect(connection).toContain("checked={config.autoNewsAnalysis}");
  expect(connection).not.toContain("config.autoAnalysis");
  expect(connection).not.toContain("选股和回测完成后自动分析");
  expect(connection).toContain('aria-label="模型提供方"');
  for (const value of ["codex", "claude", "deepseek"])
    expect(connection).toContain(`<SelectItem value="${value}">`);
  const evidence = readFileSync(
    "src/components/workbench/evidence-analysis.tsx",
    "utf8",
  );
  expect(evidence).toContain('className="field-sizing-fixed"');
  expect(evidence).toContain("rows={4}");
  expect(evidence).toContain("value={question}");
  expect(evidence).toContain('aria-label="研究方法"');
  expect(evidence).toContain(
    '<SelectItem value="general">通用证据分析</SelectItem>',
  );
  expect(evidence).toContain(
    '<SelectItem value="sepa">SEPA 分阶段研究</SelectItem>',
  );
  // Submitted filters, cursor reset and detail selection are exercised in
  // task-center-query-browser.mjs against the real TaskHistory component.
});

it("R2c evidence rejects changed strategy conversion and task page reset", () => {
  for (const [file, from, to] of [
    [
      "src/components/workbench/strategy-fields.tsx",
      "fast: Number(e.target.value)",
      "fast: 0",
    ],
    [
      "src/components/workbench/task-history.tsx",
      "setCursors((p) => p.slice(0, -1));",
      "setSelected('');",
    ],
  ]) {
    const source = readFileSync(file!, "utf8");
    expect(renderHandlers(source.replace(from!, to!))).not.toEqual(
      renderHandlers(source),
    );
  }
});

it("R2c leaves native controls only in the exact frozen exemption inventory", () => {
  const exempt: Record<string, number> = {
    "research/financial-growth-panel.tsx": 1,
    "research/financial-quality-panel.tsx": 2,
    // News workspace: five source/analysis controls, four archive filters.
    // Submitted-only queries and pagination are exercised by news browser tests.
    "news/news-panel.tsx": 5,
    "news/news-archive-list.tsx": 4,
    "news/news-sector-panel.tsx": 1,
    "research/revenue-reconciliation-panel.tsx": 2,
    "news/theme-prices-panel.tsx": 1,
    "research/valuation-panel.tsx": 7,
  };
  const remaining: Record<string, number> = {};
  for (const file of readdirSync("src", { recursive: true })) {
    if (typeof file !== "string" || !file.endsWith(".tsx")) continue;
    const path = file.replaceAll("\\", "/");
    if (path.startsWith("components/ui/")) continue;
    const count =
      readFileSync(`src/${file}`, "utf8").match(
        /<(input|select|textarea|table)(?=[\s>])/g,
      )?.length ?? 0;
    if (count) remaining[path.replace(/^components\//, "")] = count;
  }
  expect(remaining).toEqual(exempt);
});
