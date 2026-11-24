"use client";

import type { ReactNode } from "react";
import {
  DIAGNOSE_SCENARIO_PRESETS,
  type DiagnoseArchiveDetail,
  type DiagnoseScenarioCellGroup,
  type DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import {
  boundaryLabels,
  formatCount,
  formatMoney,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "./format";

const sourceLabels = {
  "lab-archive": "Lab 诊断运行",
  "cli-report": "CLI 诊断报告",
} as const;

function CompareRow({
  label,
  left,
  right,
}: {
  label: string;
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <tr>
      <th
        scope="row"
        className="px-2 py-1 text-left align-top font-normal text-nc-text-3"
      >
        {label}
      </th>
      <td className="px-2 py-1 align-top text-nc-text">{left}</td>
      <td className="px-2 py-1 align-top text-nc-text">{right}</td>
    </tr>
  );
}

function ScenarioCell({
  cell,
  metrics,
}: {
  cell: DiagnoseScenarioCellGroup;
  metrics: DiagnoseScenarioMetrics;
}) {
  const zeroSignal =
    metrics.status === "ok" && !metrics.counts.signals && !metrics.counts.fills;
  const hasPerformance = metrics.status === "ok" && !zeroSignal;
  const { timeHoldout, sleeveAttribution } = metrics;

  let status = "完成";
  if (metrics.status === "failed") status = "失败";
  else if (metrics.status === "blocked") status = "阻断";
  else if (zeroSignal) status = "零信号";
  else if (!metrics.counts.fills) status = "有信号 · 0 成交";

  return (
    <li className="space-y-1 py-1.5">
      <p className="text-sub text-nc-text-3">
        {cell.strategyKey} · {cell.symbols.join("、")}
      </p>
      <Pill
        tone={
          metrics.status !== "ok" ? "bad" : metrics.counts.fills ? "ok" : "warn"
        }
      >
        {status}
      </Pill>
      <p className="tabular-nums">
        收益 {formatSignedPercent(hasPerformance ? metrics.totalReturn : null)}{" "}
        · 最大回撤 {formatPercent(hasPerformance ? metrics.maxDrawdown : null)}{" "}
        · 成交 {formatCount(metrics.counts.fills)} · 费用{" "}
        {formatMoney(metrics.totalFees)}
      </p>
      {metrics.error && (
        <p className="text-sub text-nc-warn">{metrics.error}</p>
      )}
      {timeHoldout && (
        <div className="text-sub text-nc-text-3">
          <p>
            历史留出复核 · 切点 {timeHoldout.holdoutStart} ·{" "}
            {timeHoldout.passed ? "通过" : "未通过"} · DSR{" "}
            {formatRatio(timeHoldout.statistics.dsr, 3)} · PBO{" "}
            {timeHoldout.statistics.pbo === null
              ? "— · 单候选不适用"
              : formatRatio(timeHoldout.statistics.pbo, 3)}
          </p>
          {timeHoldout.status === "reviewed" && (
            <p className="tabular-nums">
              留出收益 · 基准{" "}
              {formatSignedPercent(timeHoldout.holdout.base.return)} · 双倍成本{" "}
              {formatSignedPercent(timeHoldout.holdout.doubledCost.return)} ·
              延迟 {formatSignedPercent(timeHoldout.holdout.delayed.return)}
            </p>
          )}
        </div>
      )}
      {sleeveAttribution && (
        <div className="text-sub text-nc-text-3">
          <p>
            {formatCount(sleeveAttribution.sleeves.length)} 个分仓 · 峰{" "}
            {sleeveAttribution.peakDate} / 谷 {sleeveAttribution.troughDate} ·
            组合回撤 {formatPercent(sleeveAttribution.maxDrawdown)}
          </p>
          <p className="tabular-nums">
            回撤贡献{" "}
            {sleeveAttribution.sleeves
              .map(
                (sleeve) =>
                  `${sleeve.id} ${formatSignedPercent(sleeve.drawdownContribution)}`,
              )
              .join(" · ")}
          </p>
        </div>
      )}
    </li>
  );
}

function ScenarioColumn({
  detail,
  id,
}: {
  detail: DiagnoseArchiveDetail;
  id: string;
}) {
  const cells = detail.cells.flatMap((cell, index) => {
    const metrics = cell.scenarios.find(
      (scenario) => scenario.scenarioId === id,
    );
    return metrics
      ? [<ScenarioCell key={index} cell={cell} metrics={metrics} />]
      : [];
  });
  return cells.length > 0 ? (
    <ul className="divide-y divide-nc-border-soft">{cells}</ul>
  ) : (
    "—"
  );
}

export function DiagnoseComparePanel({
  left,
  right,
  onClose,
}: {
  left: DiagnoseArchiveDetail;
  right: DiagnoseArchiveDetail;
  onClose: () => void;
}) {
  const available = new Set([
    ...left.summary.scenarios,
    ...right.summary.scenarios,
  ]);
  const scenarioOrder = [
    ...Object.keys(DIAGNOSE_SCENARIO_PRESETS),
    ...available,
  ].filter((id, index, ids) => available.has(id) && ids.indexOf(id) === index);
  return (
    <section
      data-testid="diagnose-compare-panel"
      aria-label="诊断归档并排对比"
      className="space-y-3 rounded-lg border border-nc-accent bg-nc-card px-3 py-2"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-nc-text">诊断归档并排对比</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={onClose}
        >
          关闭对比
        </Button>
      </header>
      <div className="overflow-x-auto rounded border border-nc-border-soft">
        <table className="w-full min-w-[680px] table-fixed break-words text-sm">
          <caption className="sr-only">
            归档信息与各执行情景的诊断单元对比
          </caption>
          <thead>
            <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
              <th scope="col" className="w-28 px-2 py-1 font-medium">
                归档
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                {left.summary.title}
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                {right.summary.title}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nc-border-soft">
            <CompareRow
              label="来源"
              left={sourceLabels[left.summary.source]}
              right={sourceLabels[right.summary.source]}
            />
            <CompareRow
              label="生成时间"
              left={left.summary.generatedAt}
              right={right.summary.generatedAt}
            />
            <CompareRow
              label="策略"
              left={left.summary.strategyKeys.join("、") || "—"}
              right={right.summary.strategyKeys.join("、") || "—"}
            />
            <CompareRow
              label="标的"
              left={left.summary.symbols.join("、") || "—"}
              right={right.summary.symbols.join("、") || "—"}
            />
            <CompareRow
              label="归档状态"
              left={boundaryLabels[left.boundaryState]}
              right={boundaryLabels[right.boundaryState]}
            />
          </tbody>
          <tbody className="divide-y divide-nc-border-soft border-t border-nc-border-soft">
            {scenarioOrder.map((id) => (
              <CompareRow
                key={id}
                label={id}
                left={<ScenarioColumn detail={left} id={id} />}
                right={<ScenarioColumn detail={right} id={id} />}
              />
            ))}
            {scenarioOrder.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-2 text-nc-text-3">
                  两份归档都没有返回执行情景。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
