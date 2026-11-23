import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnoseCell } from "./types";

const escapeCell = (value: string) =>
  value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const cellLabel = (cell: DiagnoseCell) =>
  `${cell.mode}/${cell.strategy}/${cell.symbols.join("+")}`;

function table(cells: readonly DiagnoseCell[]) {
  const header = [
    "策略",
    "标的",
    "状态",
    "层",
    "bars",
    "signals",
    "orders",
    "fills",
    "拒绝",
    "平仓",
    "主要拒绝原因",
    "发现",
  ];
  const rows = cells.map((cell) => [
    cell.strategy,
    cell.symbols.join("+"),
    cell.error ? `${cell.status}: ${cell.error}` : cell.status,
    cell.layer ?? "",
    String(cell.counts.bars),
    String(cell.counts.signals),
    String(cell.counts.orders),
    String(cell.counts.fills),
    String(cell.counts.rejections),
    String(cell.counts.closedTrades),
    (cell.rejectionReasons ?? [])
      .slice(0, 3)
      .map((row) => `${row.reason}×${row.count}`)
      .join("；"),
    cell.findings.slice(0, 3).join("；"),
  ]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) => `| ${row.map((value) => escapeCell(value)).join(" | ")} |`,
    ),
  ].join("\n");
}

function issueSection(cells: readonly DiagnoseCell[]) {
  const p0: string[] = [],
    p1: string[] = [],
    p2: string[] = [];
  for (const cell of cells) {
    const label = cellLabel(cell);
    if (cell.status === "failed" && cell.error)
      p0.push(`- ${label}：${cell.error}`);
    if (cell.status === "blocked")
      p2.push(
        `- ${label}：阻断（${cell.layer ?? "data"}）${cell.error ?? ""}`.trim(),
      );
    const checks = cell.checks ?? [];
    const messages = new Set(checks.map((check) => check.message));
    for (const check of checks) {
      if (check.status === "fail")
        p0.push(`- ${label}：${check.id} — ${check.message}`);
      else if (check.status === "warn")
        p1.push(`- ${label}：${check.id} — ${check.message}`);
    }
    for (const finding of cell.findings)
      if (!messages.has(finding)) p2.push(`- ${label}：${finding}`);
  }
  const section = (title: string, rows: string[]) =>
    [title, "", ...(rows.length ? [...new Set(rows)] : ["- 无"])].join("\n");
  return [
    section("### P0（正确性失败）", p0),
    section("### P1（告警/数据限制）", p1),
    section("### P2（阻断与未验证边界）", p2),
  ].join("\n\n");
}

/**
 * Native Chan rows carry the DLL/api identity and capture scale each cell ran
 * against. The full DLL hash is printed so an auditor can match the artifact
 * build exactly rather than trusting a shortened prefix.
 */
function nativeSection(cells: readonly DiagnoseCell[]) {
  const rows = cells.flatMap((cell) =>
    (cell.nativeChan ?? []).map((row) => ({ cell, row })),
  );
  if (!rows.length) return "";
  const header = [
    "单元",
    "标的",
    "dllHash",
    "apiVersion",
    "buildCommit",
    "configId",
    "config / anchor",
    "起点/基线",
    "前缀数",
    "耗时",
    "审计/待确认",
    "信号价基",
  ];
  const body = rows.map(({ cell, row }) => [
    cellLabel(cell),
    row.symbol,
    row.identity.dllHash,
    String(row.identity.apiVersion),
    row.identity.buildCommit,
    row.identity.configId,
    `${row.identity.config} / ${row.identity.anchor}`,
    `${row.originDate} / ${row.baselineDate}`,
    String(row.prefixCount),
    row.cached
      ? `${(row.captureElapsedMs / 1000).toFixed(1)}s（缓存读取 ${row.cacheLoadMs ?? 0}ms）`
      : `${(row.captureElapsedMs / 1000).toFixed(1)}s`,
    `${row.auditCount} / ${row.pendingCount}`,
    row.signalPriceBasis ?? "",
  ]);
  return [
    "## 原生引擎披露",
    "",
    "> 原生缠论结构由本机 DLL 生成；下表固定来源指纹、起点与前缀规模，供复核与复现。",
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(
      (row) => `| ${row.map((value) => escapeCell(value)).join(" | ")} |`,
    ),
  ].join("\n");
}

/**
 * Growth PIT rows expose how strict disclosure gating reduced the raw price
 * signals. The boundary quote comes from the disclosure itself so the report
 * cannot drift from the series semantics.
 */
function canslimPitSection(cells: readonly DiagnoseCell[]) {
  const rows = cells.flatMap((cell) =>
    (cell.canslimPit ?? []).map((row) => ({ cell, row })),
  );
  if (!rows.length) return "";
  const header = [
    "单元",
    "标的",
    "strict 报告数",
    "报告期范围",
    "合格交易日",
    "缺失日",
    "负基数/冲突日",
    "价格触发数",
    "PIT 过滤后信号",
    "财务包问题数",
  ];
  const body = rows.map(({ cell, row }) => [
    cellLabel(cell),
    row.symbol,
    String(row.strictReportCount),
    row.reportDateRange
      ? `${row.reportDateRange[0]} ~ ${row.reportDateRange[1]}`
      : "",
    String(row.qualifiedDays),
    String(row.missingDays),
    String(row.conflictDays),
    String(row.priceSignalCount),
    String(row.pitFilteredSignalCount),
    String(row.sourceIssuesCount),
  ]);
  return [
    "## 成长 PIT 财务披露",
    "",
    `> ${rows[0]!.row.boundary}`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(
      (row) => `| ${row.map((value) => escapeCell(value)).join(" | ")} |`,
    ),
  ].join("\n");
}

export function renderReport(cells: readonly DiagnoseCell[]): string {
  const perSymbol = cells.filter((cell) => cell.mode === "per-symbol");
  const portfolio = cells.filter((cell) => cell.mode === "portfolio");
  const counts = {
    ok: cells.filter((cell) => cell.status === "ok").length,
    blocked: cells.filter((cell) => cell.status === "blocked").length,
    failed: cells.filter((cell) => cell.status === "failed").length,
  };
  const native = nativeSection(cells);
  const canslimPit = canslimPitSection(cells);
  return [
    "# 回测诊断报告",
    "",
    "> 流程诊断，不是策略业绩；不做收益排名，不构成任何可交易结论。",
    "",
    `- 单元：${cells.length}（ok ${counts.ok} / blocked ${counts.blocked} / failed ${counts.failed}）`,
    `- 单标的：${perSymbol.length}；组合：${portfolio.length}`,
    "",
    "## 单标的",
    "",
    perSymbol.length ? table(perSymbol) : "（无）",
    "",
    "## 组合",
    "",
    portfolio.length ? table(portfolio) : "（无）",
    "",
    ...(native ? [native, ""] : []),
    ...(canslimPit ? [canslimPit, ""] : []),
    "## 问题分级",
    "",
    issueSection(cells),
    "",
  ].join("\n");
}

export async function writeReport(
  outDir: string,
  cells: readonly DiagnoseCell[],
): Promise<string> {
  const path = join(outDir, "report.md");
  await writeFile(path, renderReport(cells), { encoding: "utf8", flag: "wx" });
  return path;
}
