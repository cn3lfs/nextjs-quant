import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import original from "./fixtures/r2c-original-contracts.json";
import { componentLogic, renderHandlers } from "./r2-contracts";

it("R2c preserves original callbacks, requests, validation and hooks with only Radix event adaptation", () => {
  for (const [file, contract] of Object.entries(original)) {
    const source = readFileSync(file, "utf8");
    expect(renderHandlers(source), file).toEqual(contract.handlers);
    expect(componentLogic(source), file).toEqual(contract.logic);
  }
});

it("R2c precisely connects controlled values and keeps server cursor pagination", () => {
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
  for (const field of ["autoNewsAnalysis", "autoAnalysis"])
    expect(connection).toContain(`checked={config.${field}}`);
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
  expect(evidence).toContain("value={researchMethod}");
  expect(evidence).toContain(
    '<SelectItem value="general">通用证据分析</SelectItem>',
  );
  expect(evidence).toContain(
    '<SelectItem value="sepa">SEPA 分阶段研究</SelectItem>',
  );
  const history = readFileSync("src/components/task-history.tsx", "utf8");
  for (const prop of [
    "data={history.data.items}",
    "rowCount={history.data.total}",
    "pagination={{ pageIndex: cursors.length - 1, pageSize: 20 }}",
    "sorting={[]}",
    "showPagination={false}",
    "emptyMessage={null}",
    '<SelectValue placeholder="全部" />',
    "value={status}",
    '<SelectItem value="">全部</SelectItem>',
  ])
    expect(history).toContain(prop);
  expect(history.match(/enableSorting: false/g)).toHaveLength(5);
  expect(history).not.toMatch(
    /\.sort\(|getSortedRowModel|getPaginationRowModel/,
  );
  for (const text of [
    'header: "任务"',
    'header: "状态"',
    'header: "进度 / 阶段"',
    'header: "创建时间"',
    'header: "详情"',
    'job.error || job.phase || "—"',
    "job.phaseTruncated || job.errorTruncated",
    'new Date(row.original.createdAt).toLocaleString("zh-CN")',
  ])
    expect(history).toContain(text);
});

it("R2c evidence rejects changed strategy conversion and task page reset", () => {
  for (const [file, from, to] of [
    [
      "src/components/workbench/strategy-fields.tsx",
      "fast: Number(e.target.value)",
      "fast: 0",
    ],
    ["src/components/task-history.tsx", "reset();", "setSelected('');"],
  ]) {
    const source = readFileSync(file!, "utf8");
    expect(renderHandlers(source.replace(from!, to!))).not.toEqual(
      renderHandlers(source),
    );
  }
});

it("R2c leaves native controls only in the exact frozen exemption inventory", () => {
  const exempt: Record<string, number> = {
    "backtest-actions.tsx": 3,
    "canslim-panel.tsx": 2,
    "cash-dividend-experiment.tsx": 4,
    "chan-panel.tsx": 2,
    "financial-growth-panel.tsx": 1,
    "financial-quality-panel.tsx": 2,
    "fundamental-report-panel.tsx": 4,
    "news-panel.tsx": 6,
    "news-sector-panel.tsx": 1,
    "revenue-reconciliation-panel.tsx": 2,
    "theme-prices-panel.tsx": 1,
    "valuation-panel.tsx": 7,
    "walk-forward-panel.tsx": 4,
    "workbench/backtest-view.tsx": 4,
    "wyckoff-panel.tsx": 2,
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
