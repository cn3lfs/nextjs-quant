"use client";

import type { ReactNode } from "react";
import type {
  DiagnoseArchiveDetail,
  DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import {
  boundaryLabels,
  changeTone,
  formatCount,
  formatMoney,
  formatPercent,
  formatSignedPercent,
} from "./format";

export type ScenarioBoundaryState = DiagnoseArchiveDetail["boundaryState"];

const statusTone = {
  ok: "ok",
  blocked: "bad",
  failed: "bad",
} as const;

const trendClass = (value: number | null) =>
  changeTone(value) === "bad"
    ? "text-nc-up"
    : changeTone(value) === "ok"
      ? "text-nc-down"
      : "";

/** A table cell with an optional muted Δ line against the strict baseline. */
function Metric({ children, delta }: { children: ReactNode; delta?: string }) {
  return (
    <td className="px-3 py-2 align-top text-nc-text tabular-nums">
      <span className="font-medium">{children}</span>
      {delta && (
        <span className="mt-0.5 block text-sub text-nc-text-3">{delta}</span>
      )}
    </td>
  );
}

function ScenarioStatus({ scenario }: { scenario: DiagnoseScenarioMetrics }) {
  return (
    <div className="space-y-1">
      <Pill tone={statusTone[scenario.status]}>
        {scenario.status === "ok"
          ? scenario.counts.fills === 0
            ? scenario.counts.signals === 0
              ? "零信号 · 0 成交"
              : "有信号 · 0 成交"
            : "完成"
          : scenario.status === "blocked"
            ? "阻断"
            : "失败"}
      </Pill>
      {scenario.status !== "ok" && (
        <p className="text-sub text-nc-text-3">
          {[scenario.layer, scenario.error].filter(Boolean).join(" · ") ||
            "未返回失败层"}
        </p>
      )}
    </div>
  );
}

function RejectionReasons({ scenario }: { scenario: DiagnoseScenarioMetrics }) {
  if (!scenario.rejectionReasons.length)
    return <span className="text-nc-text-3">—</span>;
  return (
    <ul className="space-y-0.5">
      {scenario.rejectionReasons.slice(0, 3).map((row) => (
        <li key={row.reason} className="text-sub text-nc-text-3">
          {row.reason} × {formatCount(row.count)}
        </li>
      ))}
      {scenario.rejectionReasons.length > 3 && (
        <li className="text-sub text-nc-text-4">
          另有 {scenario.rejectionReasons.length - 3} 类
        </li>
      )}
    </ul>
  );
}

/** Side-by-side strict / clamp / cap-0.5-clip over one frozen sample. */
export function ExecutionScenarioCard({
  scenarios,
  boundaryState,
  missingFiles = [],
}: {
  scenarios: readonly DiagnoseScenarioMetrics[];
  boundaryState?: ScenarioBoundaryState;
  missingFiles?: readonly string[];
}) {
  const baseline = scenarios.find(
    (scenario) => scenario.scenarioId === "strict",
  );
  const failed = scenarios.filter((scenario) => scenario.status !== "ok");
  const capacityNotes = scenarios.filter(
    (scenario) =>
      scenario.maxParticipation !== null && !scenario.capacityActive,
  );
  const boundary = boundaryState ?? "ok";
  const delta = (
    scenario: DiagnoseScenarioMetrics,
    value: number | null,
    base: number | null | undefined,
  ) =>
    scenario === baseline || value === null || base == null
      ? undefined
      : value - base;
  const moneyDelta = (
    scenario: DiagnoseScenarioMetrics,
    value: number | null,
  ) => {
    const diff = delta(scenario, value, baseline?.totalFees);
    if (diff === undefined) return undefined;
    return `Δ strict ${diff > 0 ? "+" : ""}${formatMoney(diff)} 元`;
  };
  const percentDelta = (
    scenario: DiagnoseScenarioMetrics,
    value: number | null,
    base: number | null | undefined,
  ) => {
    const diff = delta(scenario, value, base);
    return diff === undefined
      ? undefined
      : `Δ strict ${formatSignedPercent(diff).replace("%", " 个百分点")}`;
  };
  return (
    <section aria-label="执行情景对比" className="space-y-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-nc-text">执行情景对比</h4>
        <Pill
          tone={
            boundary === "ok"
              ? "ok"
              : boundary === "zero-signal"
                ? "warn"
                : "bad"
          }
        >
          {boundaryLabels[boundary]}
        </Pill>
        <span className="text-sub text-nc-text-3">
          同一冻结样本，共用行情与策略输入。
        </span>
      </header>
      {!baseline && scenarios.some((scenario) => scenario.status === "ok") && (
        <p className="text-sub text-nc-text-3">
          当前样本缺少 strict 基线，差值不可用。
        </p>
      )}

      {boundary === "zero-signal" && (
        <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm">
          <p className="font-medium text-nc-text">窗口内无规则信号</p>
          <p className="mt-1 text-nc-text-3">
            {scenarios.length > 0 &&
            scenarios.every((scenario) => scenario.counts.fills === 0)
              ? "当前样本 0 成交。"
              : "对照策略仍可能产生成交，请查看各情景的成交数。"}
            回测引擎与账本的工程健康以 15 项检查为准。
          </p>
        </div>
      )}

      {boundary === "blocked" && (
        <div
          role="alert"
          className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm"
        >
          <p className="font-medium text-nc-down">阻断：有情景未产出结果</p>
          <ul className="mt-1 space-y-0.5 text-nc-text-3">
            {failed.length ? (
              failed.map((scenario) => (
                <li key={scenario.scenarioId}>
                  {scenario.label} · {scenario.layer ?? "未知层"} ·{" "}
                  {scenario.error ?? "未返回错误信息"}
                </li>
              ))
            ) : (
              <li>归档状态为阻断，但没有返回具体失败情景。</li>
            )}
          </ul>
        </div>
      )}

      {boundary === "missing-files" && (
        <div
          role="alert"
          className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm"
        >
          <p className="font-medium text-nc-down">产物缺失：无法完整核对</p>
          {missingFiles.length ? (
            <ul className="mt-1 space-y-0.5 font-mono text-sub text-nc-text-3">
              {missingFiles.map((file) => (
                <li key={file} className="break-all">
                  {file}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-nc-text-3">未列出缺失文件路径。</p>
          )}
        </div>
      )}

      {capacityNotes.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm"
        >
          <p className="font-medium text-nc-warn">容量裁剪未生效</p>
          <ul className="mt-1 space-y-0.5 text-nc-text-3">
            {capacityNotes.map((scenario) => (
              <li key={scenario.scenarioId}>
                {scenario.label}：
                {scenario.capacityNote ??
                  "行情成交额缺失或为 0，cap-0.5-clip 未约束成交；容量结果不可解读为可成交规模。"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scenarios.length === 0 ? (
        <p className="text-sm text-nc-text-3">归档未返回执行情景。</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-nc-border-soft">
          <table className="w-full min-w-[680px] text-sm">
            <caption className="sr-only">
              执行情景对比：填充、成交、拒绝、费用、收益与回撤
            </caption>
            <thead>
              <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
                <th scope="col" className="px-3 py-2 font-medium">
                  指标
                </th>
                {scenarios.map((scenario) => (
                  <th
                    key={scenario.scenarioId}
                    scope="col"
                    className="px-3 py-2 font-medium"
                  >
                    <span className="block text-nc-text">{scenario.label}</span>
                    <span className="block text-sub font-normal">
                      {scenario.scenarioId}
                      {scenario.maxParticipation !== null
                        ? ` · 参与率 ${formatPercent(scenario.maxParticipation, 3)}`
                        : ""}
                      {scenario.capacityPolicy
                        ? ` · ${scenario.capacityPolicy}`
                        : ""}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-nc-border-soft">
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  状态
                </th>
                {scenarios.map((scenario) => (
                  <td key={scenario.scenarioId} className="px-3 py-2 align-top">
                    <ScenarioStatus scenario={scenario} />
                  </td>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  成交 / 拒绝
                </th>
                {scenarios.map((scenario) => (
                  <Metric key={scenario.scenarioId}>
                    {formatCount(scenario.counts.fills)} /{" "}
                    {formatCount(scenario.counts.rejections)}
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  平仓交易
                </th>
                {scenarios.map((scenario) => (
                  <Metric key={scenario.scenarioId}>
                    {formatCount(scenario.counts.closedTrades)}
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  拒绝原因
                </th>
                {scenarios.map((scenario) => (
                  <td key={scenario.scenarioId} className="px-3 py-2 align-top">
                    <RejectionReasons scenario={scenario} />
                  </td>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  容量裁剪成交
                </th>
                {scenarios.map((scenario) => (
                  <Metric key={scenario.scenarioId}>
                    {formatCount(scenario.counts.capacityClippedFills)}
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  总费用
                </th>
                {scenarios.map((scenario) => (
                  <Metric
                    key={scenario.scenarioId}
                    delta={moneyDelta(scenario, scenario.totalFees)}
                  >
                    {formatMoney(scenario.totalFees)}
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  累计收益
                </th>
                {scenarios.map((scenario) => (
                  <Metric
                    key={scenario.scenarioId}
                    delta={percentDelta(
                      scenario,
                      scenario.totalReturn,
                      baseline?.totalReturn,
                    )}
                  >
                    <span className={trendClass(scenario.totalReturn)}>
                      {formatSignedPercent(scenario.totalReturn)}
                    </span>
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  最大回撤
                </th>
                {scenarios.map((scenario) => (
                  <Metric
                    key={scenario.scenarioId}
                    delta={percentDelta(
                      scenario,
                      scenario.maxDrawdown,
                      baseline?.maxDrawdown,
                    )}
                  >
                    {formatPercent(scenario.maxDrawdown)}
                  </Metric>
                ))}
              </tr>
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-normal text-nc-text-3"
                >
                  输入摘要
                </th>
                {scenarios.map((scenario) => (
                  <td
                    key={scenario.scenarioId}
                    className="px-3 py-2 align-top font-mono text-sub text-nc-text-3"
                  >
                    {scenario.inputHash?.slice(0, 16) ?? "—"}
                    {scenario.timingStatus ? ` · ${scenario.timingStatus}` : ""}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {baseline && scenarios.length > 1 && (
        <p className="text-sub text-nc-text-3">
          Δ 相对 {baseline.label}。收益与回撤差值以百分点计，费用差值以元计。
        </p>
      )}
    </section>
  );
}
