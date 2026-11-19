import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { connectionSourcePaths } from "../helpers/r2-contracts";

// connections-browser.mjs exercises settings save, races and validation.
// page-state-browser.mjs exercises research selection, submission and drafts.
it("connects current strategy, connection and evidence controls", () => {
  const strategy = readFileSync(
    "src/components/workbench/strategy-fields.tsx",
    "utf8",
  );
  for (const field of [
    "fast",
    "slow",
    "minChange",
    "maxChange",
    "minVolumeRatio",
  ])
    expect(strategy).toContain(`value={strategy.${field}}`);
  expect(strategy).toContain('step="0.1"');
  const connection = connectionSourcePaths()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
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

it("allows native form and table controls only in shared UI or existing exemptions", () => {
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
    const source = readFileSync(`src/${file}`, "utf8");
    expect(source, path).not.toMatch(/<button(?=[\s/>])/);
    const count =
      source.match(/<(input|select|textarea|table)(?=[\s/>])/g)?.length ?? 0;
    if (count) remaining[path.replace(/^components\//, "")] = count;
  }
  expect(remaining).toEqual(exempt);
});
