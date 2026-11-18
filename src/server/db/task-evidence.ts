import { sqlite } from ".";
import { formatNumber } from "trading-strategy-core/format-number";

/** Small result projection for the three local Lab/System tasks. Full frozen
 * inputs are read only by an explicit export, never by task polling. */
export function taskEvidence(id: string) {
  const row = sqlite()
    .prepare(
      `SELECT coalesce(json_extract(payload,'$.input.type'),json_extract(payload,'$.input.source')) kind,
    json_extract(payload,'$.result.command') command, json_extract(payload,'$.result.market') market,
    json_extract(payload,'$.result.total') total, json_extract(payload,'$.result.hash') hash,
    json_extract(payload,'$.result.boundary') boundary, json_extract(payload,'$.result.frozen.boundary') backtestBoundary,
    json_extract(payload,'$.result.overview.totalReturn.value') totalReturn,
    json_extract(payload,'$.result.overview.maxDrawdown.value') drawdown,
    json_array_length(payload,'$.result.result.fills') fills,
    (SELECT sum(json_extract(value,'$.evaluated')) FROM json_each(payload,'$.result.inputDiagnostics')) evaluated,
    (SELECT sum(json_extract(value,'$.unknown')) FROM json_each(payload,'$.result.inputDiagnostics')) unknown,
    (SELECT sum(json_extract(value,'$.missing.execution')) FROM json_each(payload,'$.result.frozen.sources')) missingExecution,
    (SELECT sum(json_extract(value,'$.missing.setup')) FROM json_each(payload,'$.result.frozen.sources')) missingSetup,
    (SELECT sum(json_extract(value,'$.missing.background')) FROM json_each(payload,'$.result.frozen.sources')) missingBackground,
    json_extract(payload,'$.result.datasets') datasets,
    (SELECT json_group_array(json_object('symbol',json_extract(value,'$.symbol'),'interval',json_extract(value,'$.interval'),
      'count',json_extract(value,'$.count'),'files',json_array_length(value,'$.files'),'gaps',json_array_length(value,'$.gaps'))) FROM json_each(payload,'$.result.series')) series
    FROM records WHERE id=? AND kind='job' AND json_extract(payload,'$.status')='completed'`,
    )
    .get(id) as
    | {
        kind: string;
        command: string | null;
        market: string | null;
        total: number | null;
        hash: string | null;
        boundary: string | null;
        backtestBoundary: string | null;
        totalReturn: number | null;
        drawdown: number | null;
        fills: number | null;
        evaluated: number | null;
        unknown: number | null;
        missingExecution: number | null;
        missingSetup: number | null;
        missingBackground: number | null;
        datasets: string | null;
        series: string | null;
      }
    | undefined;
  if (
    !row ||
    !["lab-backtest", "research-command", "binance-archive-audit"].includes(
      row.kind,
    )
  )
    return null;
  const fields: { label: string; value: string }[] = [];
  if (row.kind === "lab-backtest") {
    fields.push(
      {
        label: "收益",
        value:
          row.totalReturn === null
            ? "未知"
            : `${formatNumber(row.totalReturn * 100)}%`,
      },
      {
        label: "最大回撤",
        value:
          row.drawdown === null
            ? "未知"
            : `${formatNumber(row.drawdown * 100)}%`,
      },
      { label: "成交", value: formatNumber(row.fills, 0) },
    );
    for (const [label, value] of [
      ["已评估收盘", row.evaluated],
      ["未知判定", row.unknown],
      ["执行周期缺槽", row.missingExecution],
      ["准备周期缺槽", row.missingSetup],
      ["背景周期缺槽", row.missingBackground],
    ] as const)
      if (value !== null) fields.push({ label, value: formatNumber(value, 0) });
  }
  if (row.kind === "research-command")
    fields.push(
      {
        label: "任务",
        value:
          row.command === "inspect" ? "检查已有成绩单" : "冻结输入与版本校验",
      },
      { label: "市场", value: row.market === "crypto" ? "BTC/ETH" : "A股" },
      {
        label: row.command === "inspect" ? "已有成绩单条目" : "输入摘要",
        value:
          row.command === "inspect"
            ? formatNumber(row.total, 0)
            : (row.hash ?? "未知"),
      },
    );
  if (row.kind === "binance-archive-audit" && row.series) {
    const series = JSON.parse(row.series) as {
      symbol: string;
      interval: string;
      count: number;
      files: number;
      gaps: number;
    }[];
    for (const s of series)
      fields.push({
        label: `${s.symbol} ${s.interval}`,
        value: `${s.count}根 · ${s.files}文件 · ${s.gaps}缺口${s.files === 0 ? " · 未回填" : " · 已校验"}`,
      });
  }
  return {
    kind: row.kind,
    fields,
    boundary:
      row.backtestBoundary ??
      row.boundary ??
      "只读本地归档校验，不认证数据完整或策略有效",
  };
}
