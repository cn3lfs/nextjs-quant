"use client";

import type { ReactNode } from "react";
import type {
  DiagnoseFamilyHoldout,
  DiagnoseSuspensionSummary,
  DiagnoseTimeHoldoutResult,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import {
  formatCount,
  formatMoney,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "./format";

type HoldoutLeg = {
  return: number | null;
  excess: number | null;
  drawdown: number | null;
  sharpe: number | null;
  calmar?: number | null;
  trades: number;
  fees: number;
};

const legOrder = [
  { key: "base", label: "base 基准" },
  { key: "doubledCost", label: "doubledCost 双倍成本" },
  { key: "delayed", label: "delayed 延迟一根" },
] as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th
        scope="row"
        className="px-2 py-1 text-left font-normal text-nc-text-3"
      >
        {label}
      </th>
      {children}
    </tr>
  );
}

function LegTable({
  caption,
  legs,
}: {
  caption: string;
  legs: Record<(typeof legOrder)[number]["key"], HoldoutLeg>;
}) {
  return (
    <div className="overflow-x-auto rounded border border-nc-border-soft">
      <table className="w-full min-w-[420px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
            <th scope="col" className="px-2 py-1 font-medium">
              指标
            </th>
            {legOrder.map((leg) => (
              <th key={leg.key} scope="col" className="px-2 py-1 font-medium">
                {leg.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-nc-border-soft">
          <Row label="收益">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatSignedPercent(legs[leg.key].return)}
              </td>
            ))}
          </Row>
          <Row label="超额收益">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatSignedPercent(legs[leg.key].excess)}
              </td>
            ))}
          </Row>
          <Row label="最大回撤">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatPercent(legs[leg.key].drawdown)}
              </td>
            ))}
          </Row>
          <Row label="夏普">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatRatio(legs[leg.key].sharpe)}
              </td>
            ))}
          </Row>
          {legOrder.some(({ key }) => legs[key].calmar !== undefined) && (
            <Row label="Calmar">
              {legOrder.map(({ key }) => (
                <td
                  key={key}
                  className="px-2 py-1 align-top tabular-nums text-nc-text"
                >
                  {formatRatio(legs[key].calmar)}
                </td>
              ))}
            </Row>
          )}
          <Row label="成交数">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatCount(legs[leg.key].trades)}
              </td>
            ))}
          </Row>
          <Row label="费用">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatMoney(legs[leg.key].fees)}
              </td>
            ))}
          </Row>
        </tbody>
      </table>
    </div>
  );
}

function DevTable({
  summary,
}: {
  summary: Extract<
    DiagnoseTimeHoldoutResult,
    { status: "reviewed" }
  >["devSummary"];
}) {
  return (
    <div className="overflow-x-auto rounded border border-nc-border-soft">
      <table className="w-full min-w-[420px] text-sm">
        <caption className="sr-only">开发滚动窗三腿均值</caption>
        <thead>
          <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
            <th scope="col" className="px-2 py-1 font-medium">
              指标（滚动窗均值）
            </th>
            {legOrder.map((leg) => (
              <th key={leg.key} scope="col" className="px-2 py-1 font-medium">
                {leg.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-nc-border-soft">
          <Row label="平均收益">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatSignedPercent(summary[leg.key].meanReturn)}
              </td>
            ))}
          </Row>
          <Row label="平均夏普">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatRatio(summary[leg.key].meanSharpe)}
              </td>
            ))}
          </Row>
          <Row label="最差回撤">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatPercent(summary[leg.key].worstDrawdown)}
              </td>
            ))}
          </Row>
          <Row label="成交数合计">
            {legOrder.map((leg) => (
              <td
                key={leg.key}
                className="px-2 py-1 align-top tabular-nums text-nc-text"
              >
                {formatCount(summary[leg.key].trades)}
              </td>
            ))}
          </Row>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Historical holdout review. The badge and disclosure are always shown; the
 * card never renames a historical split as a fresh out-of-sample result.
 */
function HistoricalHoldout({ result }: { result: DiagnoseTimeHoldoutResult }) {
  const reviewed = result.status === "reviewed";
  return (
    <>
      <header className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-nc-text">
          历史留出复核（Historical Holdout Review）
        </h4>
        <Pill tone={result.passed ? "ok" : "warn"}>
          {result.passed ? "通过风险标准" : "未通过/存在风险"}
        </Pill>
        <span className="text-sub text-nc-text-3">
          留出切点 {result.holdoutStart}
        </span>
      </header>
      <p className="text-sub text-nc-text-3">{result.disclosure}</p>
      <p className="text-sub text-nc-text-4">
        诚实口径：此处只复核历史留出段，不宣称新鲜样本外收益，也不据此自动登记或晋级策略。
      </p>

      {reviewed ? (
        <div className="space-y-2">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-sub text-nc-text-3">Dev 滚动窗区间</dt>
              <dd className="text-nc-text tabular-nums">
                {result.devWindowRange.start} 至 {result.devWindowRange.end}
              </dd>
            </div>
            <div>
              <dt className="text-sub text-nc-text-3">滚动窗总数</dt>
              <dd className="text-nc-text tabular-nums">
                {formatCount(result.devSummary.windowCount)}
              </dd>
            </div>
            <div>
              <dt className="text-sub text-nc-text-3">
                通过风险调整标准的窗口数
              </dt>
              <dd className="text-nc-text tabular-nums">
                {formatCount(result.devSummary.positiveWindows)} /{" "}
                {formatCount(result.devSummary.windowCount)}
              </dd>
            </div>
            <div>
              <dt className="text-sub text-nc-text-3">Holdout 留出区间</dt>
              <dd className="text-nc-text tabular-nums">
                {result.holdoutRange.start} 至 {result.holdoutRange.end}
              </dd>
            </div>
          </dl>
          <p className="text-sub text-nc-text-3">开发滚动窗三腿均值</p>
          <DevTable summary={result.devSummary} />
          <p className="text-sub text-nc-text-3">Holdout 留出段三腿对比</p>
          <LegTable caption="Holdout 留出段三腿对比" legs={result.holdout} />
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="text-nc-warn">
            样本不足，未形成完整的开发滚动窗与留出复核。
          </p>
          {result.holdoutRange && (
            <p className="text-sub text-nc-text-3">
              已识别留出区间 {result.holdoutRange.start} 至{" "}
              {result.holdoutRange.end}。
            </p>
          )}
        </div>
      )}

      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-sub text-nc-text-3">DSR（门槛 ≥ 0.95）</dt>
          <dd className="text-nc-text tabular-nums">
            {formatRatio(result.statistics.dsr, 3)}
          </dd>
        </div>
        <div>
          <dt className="text-sub text-nc-text-3">PBO</dt>
          <dd className="text-nc-text tabular-nums">
            {result.statistics.pbo === null
              ? "— · 单候选不适用"
              : formatRatio(result.statistics.pbo, 3)}
          </dd>
        </div>
        <div>
          <dt className="text-sub text-nc-text-3">有效试验数</dt>
          <dd className="text-nc-text tabular-nums">
            {formatCount(result.statistics.effectiveTrials)}
          </dd>
        </div>
        <div className="sm:col-span-2 lg:col-span-1">
          <dt className="text-sub text-nc-text-3">统计口径</dt>
          <dd className="break-all text-sub text-nc-text-3">
            {result.statistics.note || "—"}
          </dd>
        </div>
      </dl>

      {result.reasons.length > 0 && (
        <div role="alert" className="text-sm text-nc-warn">
          <p className="font-medium">未通过原因 / 风险</p>
          <ul className="mt-1 space-y-0.5">
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function TimeHoldoutCard({
  result,
  suspension,
  family,
}: {
  result?: DiagnoseTimeHoldoutResult;
  suspension?: DiagnoseSuspensionSummary;
  family?: DiagnoseFamilyHoldout;
}) {
  return (
    <section
      data-testid="diagnose-time-holdout-card"
      aria-label="时间留出验证"
      className="space-y-3 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2"
    >
      {result && <HistoricalHoldout result={result} />}
      {suspension && (
        <div className="space-y-1 text-sm">
          <h4 className="font-semibold">认证停牌披露</h4>
          <p className="text-nc-text-3">
            标的停牌 {formatCount(suspension.symbolSuspensionDays)} 标的日 ·
            组合受影响 {formatCount(suspension.portfolioAffectedDays)} 日 ·
            未知日数{" "}
            {suspension.unknownDays === undefined
              ? "未记录"
              : formatCount(suspension.unknownDays)}
          </p>
        </div>
      )}
      {family && (
        <div className="space-y-1 text-sm">
          <h4 className="font-semibold">{family.family} 家族 CSCV</h4>
          <p className="text-nc-text-3">
            PBO(Sharpe) {formatRatio(family.pbo, 3)} · N<sub>eff</sub>{" "}
            {formatCount(family.effectiveTrials)} · 候选{" "}
            {formatCount(family.rawCandidateCount)} · 聚类{" "}
            {formatCount(family.clusters.length)} · 排除{" "}
            {formatCount(family.excluded.length)}
          </p>
          {family.pboReason && (
            <p className="text-nc-text-3">{family.pboReason}</p>
          )}
          {family.note && <p className="text-nc-text-3">{family.note}</p>}
          {family.clusters.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                聚类成员（{family.clusters.length} 组）
              </summary>
              <ul className="list-decimal space-y-0.5 ps-5 text-nc-text-3">
                {family.clusters.map((ids) => (
                  <li key={JSON.stringify(ids)}>{ids.join("、")}</li>
                ))}
              </ul>
            </details>
          )}
          {family.excluded.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                排除原因（{family.excluded.length} 项）
              </summary>
              <ul className="space-y-0.5 ps-5 text-nc-text-3">
                {family.excluded.map(({ id, reason }) => (
                  <li key={`${id}:${reason}`}>
                    {id} · {reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
