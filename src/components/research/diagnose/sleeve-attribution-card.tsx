"use client";

import type {
  DiagnoseSleeveInvestment,
  DiagnoseSleeveTrades,
  SleeveAttribution,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import type { Tone } from "../../panels/tone";
import {
  formatCount,
  formatMoney,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "./format";

function correlationTone(value: number): {
  label: string;
  tone: Tone;
} {
  const magnitude = Math.abs(value);
  if (magnitude < 0.3) return { label: "低相关", tone: "ok" };
  if (magnitude < 0.7) return { label: "中相关", tone: "warn" };
  return { label: "高相关", tone: "bad" };
}

type Pair = SleeveAttribution["correlations"][number];

function pairKey(left: string, right: string) {
  return `${left}\u0000${right}`;
}

/**
 * Standalone sleeve metrics and signed contributions over the portfolio
 * peak-to-trough window.
 */
function PeakAttribution({ attribution }: { attribution: SleeveAttribution }) {
  const ids = attribution.sleeves.map((sleeve) => sleeve.id);
  const verified =
    Math.abs(
      attribution.sleeves.reduce(
        (sum, sleeve) => sum + sleeve.drawdownContribution,
        0,
      ) - attribution.contributionSum,
    ) < 1e-9 &&
    Math.abs(attribution.contributionSum - attribution.maxDrawdown) < 1e-9;
  return (
    <>
      <header className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-nc-text">分仓峰谷回撤归因</h4>
        <Pill tone="neutral">{formatCount(ids.length)} 个分仓</Pill>
        <span className="text-sub text-nc-text-3">
          组合峰 {attribution.peakDate} · 谷 {attribution.troughDate} · 最大回撤{" "}
          {formatPercent(attribution.maxDrawdown)}
        </span>
      </header>

      <div className="overflow-x-auto rounded border border-nc-border-soft">
        <table className="w-full min-w-[620px] text-sm">
          <caption className="sr-only">分仓独立指标与峰谷回撤贡献</caption>
          <thead>
            <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
              <th scope="col" className="px-2 py-1 font-medium">
                分仓
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                区间收益
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                独立最大回撤
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                成交笔数
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                平均资金占比
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                回撤贡献
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nc-border-soft">
            {attribution.sleeves.map((sleeve) => (
              <tr key={sleeve.id}>
                <th
                  scope="row"
                  className="px-2 py-1 text-left font-medium text-nc-text"
                >
                  {sleeve.id}
                </th>
                <td className="px-2 py-1 tabular-nums text-nc-text">
                  {formatSignedPercent(sleeve.return)}
                </td>
                <td className="px-2 py-1 tabular-nums text-nc-text">
                  {formatPercent(sleeve.maxDrawdown)}
                </td>
                <td className="px-2 py-1 tabular-nums text-nc-text">
                  {formatCount(sleeve.trades)}
                </td>
                <td className="px-2 py-1 tabular-nums text-nc-text">
                  {formatPercent(sleeve.averageWeight)}
                </td>
                <td className="px-2 py-1 tabular-nums text-nc-text">
                  {formatSignedPercent(sleeve.drawdownContribution)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-nc-border-soft">
              <th
                scope="row"
                className="px-2 py-1 text-left font-medium text-nc-text"
              >
                分仓贡献合计
              </th>
              <td className="px-2 py-1 tabular-nums text-nc-text-3">—</td>
              <td className="px-2 py-1 tabular-nums text-nc-text-3">—</td>
              <td className="px-2 py-1 tabular-nums text-nc-text-3">—</td>
              <td className="px-2 py-1 tabular-nums text-nc-text-3">—</td>
              <td className="px-2 py-1 tabular-nums text-nc-text">
                {formatSignedPercent(attribution.contributionSum)}
              </td>
            </tr>
            <tr>
              <th
                scope="row"
                className="px-2 py-1 text-left font-medium text-nc-text"
              >
                组合最大回撤（核验）
              </th>
              <td colSpan={4} className="px-2 py-1 text-sub text-nc-text-3">
                组合峰值 {formatMoney(attribution.peakEquity)} → 谷值{" "}
                {formatMoney(attribution.troughEquity)}
              </td>
              <td className="px-2 py-1 tabular-nums text-nc-text">
                {formatPercent(attribution.maxDrawdown)}
              </td>
            </tr>
            <tr>
              <th
                scope="row"
                className="px-2 py-1 text-left font-medium text-nc-text"
              >
                核验结果
              </th>
              <td colSpan={5} className="px-2 py-1">
                <Pill tone={verified ? "ok" : "bad"}>
                  {verified
                    ? "分仓贡献合计 = 组合最大回撤"
                    : "分仓贡献合计与组合最大回撤不一致"}
                </Pill>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-sub text-nc-text-4">{attribution.transferBasis}</p>
    </>
  );
}

function CorrelationMatrix({
  ids,
  correlations,
  title,
}: {
  ids: string[];
  correlations: Pair[];
  title: string;
}) {
  const pairs = new Map<string, Pair>();
  for (const pair of correlations) {
    pairs.set(pairKey(pair.left, pair.right), pair);
    pairs.set(pairKey(pair.right, pair.left), pair);
  }
  return (
    <div className="space-y-1">
      <h5 className="text-sm font-semibold text-nc-text">{title}</h5>
      <div className="overflow-x-auto rounded border border-nc-border-soft">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">
            分仓两两相关性矩阵，缺失值附原因
          </caption>
          <thead>
            <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
              <th scope="col" className="px-2 py-1 font-medium">
                分仓
              </th>
              {ids.map((id) => (
                <th key={id} scope="col" className="px-2 py-1 font-medium">
                  {id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-nc-border-soft">
            {ids.map((row) => (
              <tr key={row}>
                <th
                  scope="row"
                  className="px-2 py-1 text-left font-medium text-nc-text"
                >
                  {row}
                </th>
                {ids.map((column) => {
                  if (row === column)
                    return (
                      <td
                        key={column}
                        className="px-2 py-1 tabular-nums text-nc-text-4"
                      >
                        自相关
                      </td>
                    );
                  const pair = pairs.get(pairKey(row, column));
                  const meta =
                    pair?.correlation == null
                      ? null
                      : correlationTone(pair.correlation);
                  return (
                    <td key={column} className="px-2 py-1 align-top">
                      {!pair || !meta ? (
                        <span
                          className="text-nc-text-3"
                          title={pair?.reason ?? "未返回该分仓对"}
                        >
                          —{pair?.reason ? ` · ${pair.reason}` : ""}
                        </span>
                      ) : (
                        <span className="flex flex-wrap items-baseline gap-1">
                          <span className="tabular-nums text-nc-text">
                            {formatRatio(pair.correlation, 3)}
                          </span>
                          <Pill tone={meta.tone}>{meta.label}</Pill>
                          <span className="text-sub text-nc-text-3">
                            {formatCount(pair.overlap)} 日
                          </span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sub text-nc-text-4">
        相关性按重叠有效交易日计算，绝对值以 0.3 和 0.7 为低、中、高相关的分界。
      </p>
    </div>
  );
}

const evidenceCell = "px-2 py-1 text-left tabular-nums";

function SleeveInvestmentTable({
  investment,
}: {
  investment: DiagnoseSleeveInvestment;
}) {
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-semibold">剔除划转的分仓投资归因</h5>
      <div className="overflow-x-auto rounded border border-nc-border-soft">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nc-border-soft text-nc-text-3">
              {["分仓", "投资收益", "投资最大回撤", "交易盈亏贡献"].map(
                (label) => (
                  <th key={label} scope="col" className={evidenceCell}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-nc-border-soft">
            {investment.sleeves.map((row) => (
              <tr key={row.id}>
                <th scope="row" className={evidenceCell}>
                  {row.id}
                </th>
                <td className={evidenceCell}>
                  {formatSignedPercent(row.investmentReturn)}
                </td>
                <td className={evidenceCell}>
                  {formatPercent(row.investmentMaxDrawdown)}
                </td>
                <td className={evidenceCell}>
                  {formatMoney(row.tradingPnlContribution)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CorrelationMatrix
        ids={investment.sleeves.map(({ id }) => id)}
        correlations={investment.correlations}
        title="剔除划转的投资日收益相关性"
      />
    </div>
  );
}

type TradeMetrics = DiagnoseSleeveTrades["portfolio"];
const tradeRows: Array<{
  label: string;
  value: (row: TradeMetrics) => string;
}> = [
  { label: "完整交易轮次", value: (row) => formatCount(row.roundTrips) },
  { label: "胜率", value: (row) => formatPercent(row.winRate) },
  { label: "盈亏比", value: (row) => formatRatio(row.profitLossRatio) },
  { label: "利润因子", value: (row) => formatRatio(row.profitFactor) },
  {
    label: "持有期分位 P25 / P50 / P75 / P90（日）",
    value: ({ holdingPeriod }) =>
      [
        holdingPeriod.p25,
        holdingPeriod.p50,
        holdingPeriod.p75,
        holdingPeriod.p90,
      ]
        .map((days) => formatRatio(days, 1))
        .join(" / "),
  },
  { label: "现金占比", value: (row) => formatPercent(row.cashRatio) },
  { label: "单边换手", value: (row) => formatPercent(row.oneSidedTurnover) },
  { label: "佣金", value: (row) => formatMoney(row.costs.commission) },
  { label: "印花税", value: (row) => formatMoney(row.costs.stampDuty) },
  { label: "过户费", value: (row) => formatMoney(row.costs.transferFee) },
  {
    label: "滑点",
    value: ({ costs }) =>
      `${formatMoney(costs.slippage)}${costs.slippageMissingFills ? ` · 缺 ${formatCount(costs.slippageMissingFills)} 笔` : ""}`,
  },
];

function SleeveTradesTable({ trades }: { trades: DiagnoseSleeveTrades }) {
  const columns = [
    { key: "portfolio", label: "组合", metrics: trades.portfolio },
    ...trades.sleeves.map((row) => ({
      key: `sleeve:${row.id}`,
      label: row.id,
      metrics: row,
    })),
  ];
  return (
    <div className="space-y-1">
      <h5 className="text-sm font-semibold">交易轮次、换手与成本拆解</h5>
      <div className="overflow-x-auto rounded border border-nc-border-soft">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="border-b border-nc-border-soft text-nc-text-3">
              <th scope="col" className={evidenceCell}>
                指标
              </th>
              {columns.map(({ key, label }) => (
                <th key={key} scope="col" className={evidenceCell}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-nc-border-soft">
            {tradeRows.map(({ label, value }) => (
              <tr key={label}>
                <th
                  scope="row"
                  className={`${evidenceCell} font-normal text-nc-text-3`}
                >
                  {label}
                </th>
                {columns.map(({ key, metrics }) => (
                  <td key={key} className={evidenceCell}>
                    {value(metrics)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SleeveAttributionCard({
  attribution,
  investment,
  trades,
}: {
  attribution?: SleeveAttribution;
  investment?: DiagnoseSleeveInvestment;
  trades?: DiagnoseSleeveTrades;
}) {
  return (
    <section
      data-testid="diagnose-sleeve-attribution-card"
      aria-label="分仓归因与相关性"
      className="space-y-3 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2"
    >
      {attribution && <PeakAttribution attribution={attribution} />}
      {investment ? (
        <SleeveInvestmentTable investment={investment} />
      ) : (
        attribution && (
          <CorrelationMatrix
            ids={attribution.sleeves.map(({ id }) => id)}
            correlations={attribution.correlations}
            title="分仓日收益相关性矩阵"
          />
        )
      )}
      {trades && <SleeveTradesTable trades={trades} />}
    </section>
  );
}
