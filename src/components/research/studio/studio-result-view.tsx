import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { MetricStrip, Panel } from "~/components/panels";
import { tradeChartHref } from "~/lib/chart/chart-trade-marks";
import type { TradeReviewRef } from "~/lib/chart/trade-review-ref";
import { studioTemplateLabels } from "~/lib/research/studio-entry";
import type { StudioResult } from "~/lib/research/studio-result";
import { EquityChart } from "../../backtest/equity-chart";
import { TimeHoldoutCard } from "../diagnose/time-holdout-card";
import { SleeveAttributionCard } from "../diagnose/sleeve-attribution-card";
import { DiagnosePagination } from "./studio-pagination";
import {
  formatCount,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "../diagnose/format";

const heading = "px-3 py-2 text-left font-medium text-nc-text-3";
const cell = "px-3 py-2 tabular-nums";
const capitals = [100_000, 300_000, 1_000_000];
const windows = [
  ["open", "开盘"],
  ["09:35-09:40", "09:35–09:40"],
  ["09:45-09:50", "09:45–09:50"],
] as const;
const crises = [
  ["2015 股灾", "2015-06-12", "2015-09-15"],
  ["2018 下跌", "2018-01-29", "2018-12-28"],
  ["2022–24 回撤", "2022-01-04", "2024-02-05"],
  ["2024 年 9 月反转", "2024-09-24", "2024-10-18"],
] as const;
const costLabels = {
  fixed: "fixed · 固定费率",
  base: "base · 历史费税基准",
  "double-cost": "double-cost · 双倍成本",
};

export function StudioTable({
  label,
  headers,
  children,
}: {
  label: string;
  headers: readonly ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded border border-nc-border-soft">
      <table aria-label={label} className="w-full text-sm">
        <thead className="border-b border-nc-border-soft bg-nc-inset">
          <tr>
            {headers.map((header, index) => (
              <th key={index} scope="col" className={heading}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-nc-border-soft">{children}</tbody>
      </table>
    </div>
  );
}

function CostScenarios({
  rows,
  selected,
}: {
  rows: StudioResult["costScenarios"];
  selected: StudioResult["costScenario"];
}) {
  return (
    <Panel title="三档成本执行情景">
      <div className="grid gap-2 sm:grid-cols-3">
        {rows.map((row) => (
          <article
            key={row.costScenario}
            className={`rounded-lg border p-3 text-sm ${row.costScenario === selected ? "border-nc-accent bg-nc-inset" : "border-nc-border-soft"}`}
          >
            <h4 className="mb-2 font-medium">{costLabels[row.costScenario]}</h4>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums">
              <dt>累计收益</dt>
              <dd>{formatSignedPercent(row.totalReturn)}</dd>
              <dt>最大回撤</dt>
              <dd>{formatPercent(row.maxDrawdown)}</dd>
              <dt>费用（元）</dt>
              <dd>{formatRatio(row.totalFees)}</dd>
              <dt>成交笔数</dt>
              <dd>{formatCount(row.fills)}</dd>
            </dl>
            {row.reason && (
              <p className="mt-2 text-xs text-nc-warn">{row.reason}</p>
            )}
          </article>
        ))}
      </div>
    </Panel>
  );
}

function ExecutionReality({ result }: { result: StudioResult }) {
  const execution = result.executionReality;
  return (
    <Panel title="九格执行现实" bodyClassName="space-y-3">
      {execution ? (
        <>
          <StudioTable
            label="本金 × 5m 执行窗口"
            headers={["本金（元）", ...windows.map(([, label]) => label)]}
          >
            {capitals.map((capital) => (
              <tr key={capital}>
                <th scope="row" className={heading}>
                  {formatCount(capital)}
                </th>
                {windows.map(([id]) => {
                  const row = execution.matrix.find(
                    (item) => item.initial === capital && item.window === id,
                  );
                  const reason = row?.missingQuotes
                    ? `缺 ${formatCount(row.missingQuotes)} / ${formatCount(row.requestedQuotes)} 笔报价`
                    : row?.totalReturn == null
                      ? "可用绩效证据不足"
                      : null;
                  return (
                    <td key={id} className={`${cell} min-w-36`}>
                      {row ? (
                        <>
                          <strong>
                            {formatSignedPercent(row.totalReturn)}
                          </strong>
                          <p className="text-xs text-nc-text-3">
                            回撤 {formatPercent(row.maxDrawdown)} · 成交{" "}
                            {formatCount(row.fills)} · 费用{" "}
                            {formatRatio(row.totalFees)} 元
                          </p>
                          {reason && (
                            <p className="text-xs text-nc-warn">{reason}</p>
                          )}
                          {row.firstUncertainExecutionDate && (
                            <p className="text-xs text-nc-warn">
                              首个不确定日 {row.firstUncertainExecutionDate}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-nc-text-3">缺少该窗口证据</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </StudioTable>
          <details className="text-xs text-nc-text-3">
            <summary className="cursor-pointer">执行现实来源凭据</summary>
            <p className="break-all">
              组合来源 {execution.portfolioSourceHash}
            </p>
            <p className="break-all">冻结目标流 {execution.targetStreamHash}</p>
          </details>
        </>
      ) : (
        <p className="text-sm text-nc-text-3">
          本结果未包含九格执行证据。可在 ETF 轮动编排中启用。
        </p>
      )}
      <StudioTable
        label="四大危机切片"
        headers={["危机切片", "区间", "窗口绩效"]}
      >
        {crises.map(([label, start, end]) => (
          <tr key={label}>
            <th scope="row" className={heading}>
              {label}
            </th>
            <td className={cell}>
              {start} 至 {end}
            </td>
            <td className={`${cell} text-nc-text-3`}>
              {execution ? "归档契约未提供切片统计" : "无执行证据"}
            </td>
          </tr>
        ))}
      </StudioTable>
    </Panel>
  );
}

function Drawdowns({ rows }: { rows: StudioResult["topDrawdowns"] }) {
  return (
    <Panel title="Top-5 水下回撤">
      {rows?.length ? (
        <StudioTable
          label="Top-5 水下回撤"
          headers={[
            "峰值日",
            "谷底日",
            "恢复日",
            "深度",
            "水下自然日",
            "恢复自然日",
          ]}
        >
          {rows.map((row) => (
            <tr key={row.peakDate + row.valleyDate}>
              <td className={cell}>{row.peakDate}</td>
              <td className={cell}>{row.valleyDate}</td>
              <td className={cell}>{row.recoveryDate ?? "未恢复"}</td>
              <td className={cell}>{formatPercent(row.depth)}</td>
              <td className={cell}>{formatCount(row.underwaterDays)}</td>
              <td className={cell}>
                {row.recoveryDays === null
                  ? `已观察 ${formatCount(row.observedRecoveryDays)} 自然日`
                  : formatCount(row.recoveryDays)}
              </td>
            </tr>
          ))}
        </StudioTable>
      ) : (
        <p className="text-sm text-nc-text-3">
          {rows ? "期间没有可列示的回撤。" : "缺少完整净值证据。"}
        </p>
      )}
    </Panel>
  );
}

function Excursions({
  rows,
  distribution,
  review,
}: {
  rows: StudioResult["tradeExcursions"];
  distribution: StudioResult["excursionDistribution"];
  review?: Omit<TradeReviewRef, "symbol">;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const lastPage = Math.max(1, Math.ceil((rows?.length ?? 0) / pageSize));
  const activePage = Math.min(page, lastPage);
  const visible =
    rows?.slice((activePage - 1) * pageSize, activePage * pageSize) ?? [];
  const points = visible.filter((row) => row.mae !== null && row.mfe !== null);
  const xMax = Math.max(0.01, ...points.map((row) => -(row.mae ?? 0)));
  const yMax = Math.max(0.01, ...points.map((row) => row.mfe ?? 0));
  return (
    <Panel title="逐笔 MAE / MFE" bodyClassName="space-y-3">
      {distribution && (
        <MetricStrip
          items={[
            {
              label: "回合 / 缺失",
              value: `${formatCount(distribution.count)} / ${formatCount(distribution.missing)}`,
            },
            {
              label: "MAE 中位 / P10",
              value: `${formatPercent(distribution.maeMedian)} / ${formatPercent(distribution.maeP10)}`,
            },
            {
              label: "MFE 中位 / P90",
              value: `${formatPercent(distribution.mfeMedian)} / ${formatPercent(distribution.mfeP90)}`,
            },
          ]}
        />
      )}
      {!rows?.length ? (
        <p className="text-sm text-nc-text-3">
          {rows ? "期间没有交易回合。" : "缺少完整逐笔成交和持仓行情证据。"}
        </p>
      ) : (
        <>
          {points.length > 0 && (
            <figure className="max-w-xl text-xs text-nc-text-3">
              <figcaption>
                本页回合散点 · MFE ↑ {formatPercent(yMax)}
              </figcaption>
              <div
                role="img"
                aria-label="本页 MAE 与 MFE 散点，横轴为 MAE、纵轴为 MFE"
                className="relative mx-2 my-3 h-32 border-b border-l border-nc-border bg-nc-inset"
              >
                {points.map((row) => (
                  <span
                    key={row.id}
                    title={`${row.symbol} · MAE ${formatPercent(row.mae)} · MFE ${formatPercent(row.mfe)}`}
                    className="absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-nc-accent"
                    style={{
                      left: `${(1 + (row.mae ?? 0) / xMax) * 100}%`,
                      bottom: `${((row.mfe ?? 0) / yMax) * 100}%`,
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between">
                <span>{formatPercent(-xMax)}</span>
                <span>MAE → 0%</span>
              </div>
            </figure>
          )}
          <StudioTable
            label="逐笔 MAE / MFE 明细"
            headers={[
              "证券",
              "策略 / 分仓",
              "开仓",
              "平仓",
              "持有日",
              "MAE",
              "MFE",
              "净收益",
              "证据",
              "复盘",
            ]}
          >
            {visible.map((row) => (
              <tr key={row.id}>
                <td className={cell}>{row.symbol}</td>
                <td className={cell}>
                  {[row.strategyId, row.sleeve].filter(Boolean).join(" / ") ||
                    "—"}
                </td>
                <td className={cell}>{row.openedAt}</td>
                <td className={cell}>{row.closedAt ?? "持仓中"}</td>
                <td className={cell}>{formatCount(row.days)}</td>
                <td className={cell}>{formatPercent(row.mae)}</td>
                <td className={cell}>{formatPercent(row.mfe)}</td>
                <td className={cell}>
                  {formatSignedPercent(row.realizedNetReturn)}
                </td>
                <td className={`${cell} min-w-24`}>
                  {[
                    row.reason,
                    row.realizedNetReturnReason,
                    row.daysReason,
                    row.entryAverageReason,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </td>
                <td className={`${cell} whitespace-nowrap`}>
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={tradeChartHref({
                        symbol: row.symbol,
                        at: row.closedAt ?? row.openedAt,
                        review: review
                          ? { ...review, symbol: row.symbol }
                          : undefined,
                      })}
                      aria-label={`看K线 ${row.symbol} ${row.closedAt ?? row.openedAt}`}
                      prefetch={false}
                      scroll={false}
                    >
                      看K线
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </StudioTable>
          {lastPage > 1 && (
            <DiagnosePagination
              page={activePage}
              hasNext={activePage < lastPage}
              onPageChange={setPage}
              label={`第 ${activePage} / ${lastPage} 页 · 共 ${formatCount(rows.length)} 个回合`}
            />
          )}
        </>
      )}
    </Panel>
  );
}

export function StudioResultView({
  result,
  archiveDetail = false,
  compact = false,
}: {
  result: StudioResult;
  archiveDetail?: boolean;
  compact?: boolean;
}) {
  const performance = result.performance;
  const reviewSource =
    result.template === "alpha-formula"
      ? "alpha-backtest"
      : result.template === "etf-rotation"
        ? "etf-rotation"
        : undefined;
  const review: Omit<TradeReviewRef, "symbol"> | undefined =
    reviewSource && result.jobId
      ? {
          source: reviewSource,
          refId: result.jobId,
          label: reviewSource === "alpha-backtest" ? "Alpha Top-N" : "ETF 轮动",
          backHref: `/lab/backtest?${new URLSearchParams({ view: "result", run: result.jobId })}`,
        }
      : undefined;
  return (
    <div className="min-w-0 space-y-3">
      {!archiveDetail && (
        <div className="space-y-1">
          <h3 className="text-base font-semibold">
            {studioTemplateLabels[result.template]}
          </h3>
          <p className="break-words text-sm text-nc-text-3">
            {[result.strategyKey, result.symbols.join("、")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      )}
      <MetricStrip
        items={[
          {
            label: "累计收益",
            value: formatSignedPercent(result.totalReturn),
            note: performance?.totalReturn.reason,
          },
          {
            label: "最大回撤",
            value: formatPercent(result.maxDrawdown),
            note: performance?.maxDrawdown.reason,
          },
          {
            label: "夏普",
            value: performance?.sharpe.value,
            note: performance?.sharpe.reason,
          },
          {
            label: "年化收益",
            value: formatSignedPercent(performance?.annualReturn.value),
            note: performance?.annualReturn.reason,
          },
          { label: "交易日", value: performance?.days, digits: 0 },
        ]}
      />
      {!compact && !!result.equity?.length && (
        <Panel title="日末收益与回撤">
          <EquityChart equity={result.equity} initial={performance?.initial} />
        </Panel>
      )}
      <CostScenarios
        rows={result.costScenarios}
        selected={result.costScenario}
      />
      {(result.template === "etf-rotation" || result.executionReality) && (
        <ExecutionReality result={result} />
      )}
      {!archiveDetail && (result.timeHoldout || result.familyHoldout) && (
        <TimeHoldoutCard
          result={result.timeHoldout ?? undefined}
          family={result.familyHoldout ?? undefined}
        />
      )}
      {!archiveDetail && result.sleeveAttribution && (
        <SleeveAttributionCard attribution={result.sleeveAttribution} />
      )}
      <Drawdowns rows={result.topDrawdowns} />
      <Excursions
        rows={result.tradeExcursions}
        distribution={result.excursionDistribution}
        review={review}
      />
      {!archiveDetail && result.cases.length > 0 && (
        <StudioTable
          label="候选与执行情景"
          headers={["策略", "情景", "状态", "累计收益", "最大回撤"]}
        >
          {result.cases.map((row, index) => (
            <tr key={`${row.strategyKey}:${row.scenarioId}:${index}`}>
              <td className={cell}>{row.strategyKey}</td>
              <td className={cell}>{row.scenarioId}</td>
              <td className={cell}>{row.status}</td>
              <td className={cell}>{formatSignedPercent(row.totalReturn)}</td>
              <td className={cell}>{formatPercent(row.maxDrawdown)}</td>
            </tr>
          ))}
        </StudioTable>
      )}
      {!!result.disclosures.length && (
        <details className="rounded border border-nc-border-soft p-3 text-sm text-nc-text-3">
          <summary className="cursor-pointer">研究口径与数据缺口</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {[...new Set(result.disclosures)].map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
