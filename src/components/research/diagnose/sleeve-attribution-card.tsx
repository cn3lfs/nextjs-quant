"use client";

import type { SleeveAttribution } from "~/lib/research/diagnose-contract";
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
 * Four-sleeve attribution: standalone sleeve metrics, signed drawdown
 * contributions over the portfolio peak-to-trough window, and the pairwise
 * correlation matrix. Missing correlations keep the backend reason visible.
 */
export function SleeveAttributionCard({
  attribution,
}: {
  attribution: SleeveAttribution;
}) {
  const ids = attribution.sleeves.map((sleeve) => sleeve.id);
  const pairs = new Map<string, Pair>();
  for (const pair of attribution.correlations) {
    pairs.set(pairKey(pair.left, pair.right), pair);
    pairs.set(pairKey(pair.right, pair.left), pair);
  }
  const verified =
    Math.abs(
      attribution.sleeves.reduce(
        (sum, sleeve) => sum + sleeve.drawdownContribution,
        0,
      ) - attribution.contributionSum,
    ) < 1e-9 &&
    Math.abs(attribution.contributionSum - attribution.maxDrawdown) < 1e-9;
  return (
    <section
      data-testid="diagnose-sleeve-attribution-card"
      aria-label="四分仓归因与相关性"
      className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-nc-text">
          四分仓归因与相关性矩阵
        </h4>
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

      <div className="space-y-1">
        <h5 className="text-sm font-semibold text-nc-text">
          分仓日收益相关性矩阵
        </h5>
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
          相关性按重叠有效交易日计算，绝对值以 0.3 和 0.7
          为低、中、高相关的分界。
        </p>
      </div>
    </section>
  );
}
