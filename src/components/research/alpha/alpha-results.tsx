import { useState } from "react";
import {
  GridTable,
  MetricStrip,
  Panel,
  Pill,
  Segmented,
} from "~/components/panels";
import type { AlphaEvaluationResult } from "~/lib/research/alpha-experiment";
import {
  CumulativeRankIcChart,
  DailyIcChart,
  QuantileBars,
} from "./alpha-charts";
import { neutralizationLabels, weightingLabels } from "./alpha-config";
import {
  integer,
  mean,
  nonOverlappingCumulative,
  num,
  pct,
  returnTone,
  signedPct,
} from "./alpha-format";

const comparisonLabels = {
  selected: "当前方案",
  original: "原版（未中性化）",
  strict: "行业 + 市值中性化",
  equal: "等权对照",
  icir: "ICIR 对照",
} satisfies Record<AlphaEvaluationResult["comparisons"][number]["id"], string>;

export function AlphaResults({
  result,
  stale,
}: {
  result: AlphaEvaluationResult;
  stale: boolean;
}) {
  const [horizon, setHorizon] = useState(String(result.config.icirHorizon));
  const active =
    result.metrics.horizons.find((h) => String(h.horizon) === horizon) ??
    result.metrics.horizons[0]!;
  const benchmarks = result.benchmarks.flatMap((benchmark) => {
    const sample = benchmark.horizons.find((h) => h.horizon === active.horizon);
    if (!sample) return [];
    const values = sample.series.flatMap(({ value }) =>
      value === null ? [] : [value],
    );
    return [
      {
        id: benchmark.id,
        name: benchmark.name,
        primary: benchmark.primary,
        average: mean(values),
        cumulative: nonOverlappingCumulative(sample.series, active.horizon),
        coverage: sample.coverage,
      },
    ];
  });
  const top = active.quantileRawMeans.length - 1;
  const benchmarkRows = [
    {
      id: "top",
      name: "因子最高组",
      primary: false,
      average: active.quantileRawMeans[top],
      cumulative: active.quantileCumulative[top],
      coverage: result.daily.length
        ? active.groups.filter((group) => group.returns[top] != null).length /
          result.daily.length
        : null,
    },
    ...benchmarks,
  ];

  return (
    <>
      <div className="col-span-full space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">全市场截面评估</h2>
            {stale && <Pill tone="warn">上次评估 · 当前配置已变更</Pill>}
          </div>
          <Segmented
            label="评估结果持有期"
            value={String(active.horizon)}
            options={result.metrics.horizons.map((h) => ({
              value: String(h.horizon),
              label: `T+${h.horizon}`,
            }))}
            onChange={setHorizon}
          />
        </div>
        <p className="text-xs text-nc-text-3">
          {result.targetSnapshot.start} 至 {result.targetSnapshot.end} ·
          {integer(result.metadata.universe)} 只股票 ·{" "}
          {integer(result.daily.length)} 个交易日 ·
          {weightingLabels[result.config.weightingMethod]} · 中性化{" "}
          {neutralizationLabels[result.config.neutralizationMode]}
        </p>
        <MetricStrip
          items={[
            {
              label: "Spearman RankIC",
              value: active.rankIC.mean,
              digits: 3,
              note: `${integer(active.rankIC.days)} 个有效截面`,
            },
            {
              label: "Pearson IC",
              value: active.pearson.mean,
              digits: 3,
              note: `${integer(active.pearson.days)} 个有效截面`,
            },
            { label: "RankIC ICIR", value: active.rankIC.icir, digits: 2 },
            {
              label: "正 RankIC 占比",
              value: pct(active.rankIC.positiveRatio, 1),
            },
            {
              label: "日均合格样本数",
              value: integer(mean(result.daily.map((row) => row.eligible))),
              unit: "只",
              note: `日均有效得分 ${integer(mean(result.daily.map((row) => row.scored)))} 只`,
            },
          ]}
        />
      </div>
      <Panel title="每日截面相关性" span={6}>
        <h4 className="text-sm font-medium">累计 RankIC</h4>
        <CumulativeRankIcChart points={active.ic} />
        <h4 className="mt-3 text-sm font-medium">每日 Pearson IC</h4>
        <DailyIcChart points={active.pearsonIC} />
      </Panel>
      <Panel title="分组平均超额收益" span={6} meta={`T+${active.horizon}`}>
        <QuantileBars values={active.quantileMeans} horizon={active.horizon} />
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-nc-border-soft pt-3 text-xs md:grid-cols-4">
          {[
            {
              label: "多空收益（最高减最低）",
              value: signedPct(active.spread),
              className: returnTone(active.spread),
            },
            { label: "Top 日换手率", value: pct(result.metrics.turnover.top) },
            {
              label: "Bottom 日换手率",
              value: pct(result.metrics.turnover.bottom),
            },
            {
              label: "排名自相关",
              value: num(result.metrics.rankAutocorrelation),
            },
          ].map(({ label, value, className }) => (
            <div key={label}>
              <dt className="text-nc-text-3">{label}</dt>
              <dd
                className={`mt-1 text-sm font-medium tabular-nums ${className ?? ""}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel
        title="原版、中性化与加权对照"
        span={7}
        meta={`T+${active.horizon}`}
      >
        <GridTable
          label="方案对照"
          minWidth={610}
          rows={result.comparisons.map((row) => ({
            ...row,
            statistics: row.decay.find((h) => h.horizon === active.horizon),
          }))}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "label",
              header: "方案",
              width: "1.6fr",
              cell: (row) => comparisonLabels[row.id],
            },
            {
              key: "mode",
              header: "中性化",
              cell: (row) => neutralizationLabels[row.mode],
            },
            {
              key: "method",
              header: "加权",
              cell: (row) => weightingLabels[row.method],
            },
            {
              key: "ric",
              header: "RankIC",
              align: "right",
              cell: (row) => num(row.statistics?.rankIC),
            },
            {
              key: "ic",
              header: "Pearson IC",
              align: "right",
              cell: (row) => num(row.statistics?.pearsonIC),
            },
            {
              key: "ir",
              header: "ICIR",
              align: "right",
              cell: (row) => num(row.statistics?.icir, 2),
            },
            {
              key: "fallback",
              header: "回退等权天数",
              align: "right",
              cell: (row) =>
                row.method === "icir" ? integer(row.fallbackToEqualDays) : "—",
            },
          ]}
        />
        <p className="mt-2 text-xs text-nc-text-3">{result.metadata.weights}</p>
      </Panel>
      <Panel title="持有期衰减" span={5}>
        <GridTable
          label="持有期衰减"
          minWidth={420}
          rows={result.decay}
          rowKey={(row) => String(row.horizon)}
          columns={[
            { key: "h", header: "持有期", cell: (row) => `T+${row.horizon}` },
            {
              key: "ric",
              header: "RankIC",
              align: "right",
              cell: (row) => num(row.rankIC),
            },
            {
              key: "ic",
              header: "Pearson IC",
              align: "right",
              cell: (row) => num(row.pearsonIC),
            },
            {
              key: "ir",
              header: "ICIR",
              align: "right",
              cell: (row) => num(row.icir, 2),
            },
            {
              key: "spread",
              header: "多空收益",
              align: "right",
              cell: (row) => signedPct(row.topBottom),
            },
          ]}
        />
      </Panel>
      <Panel title="五基准对照" span={7} meta={`T+${active.horizon}`}>
        <GridTable
          label="基准收益对照"
          minWidth={480}
          rows={benchmarkRows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "name",
              header: "组别 / 基准",
              width: "1.5fr",
              cell: (row) => (
                <>
                  {row.name}
                  {row.primary && (
                    <Pill className="ml-1" tone="accent">
                      主基准
                    </Pill>
                  )}
                </>
              ),
            },
            {
              key: "average",
              header: "平均前向收益",
              align: "right",
              cell: (row) => signedPct(row.average),
            },
            {
              key: "cumulative",
              header: "非重叠累计",
              align: "right",
              cell: (row) => signedPct(row.cumulative),
            },
            {
              key: "coverage",
              header: "日期覆盖",
              align: "right",
              cell: (row) => pct(row.coverage, 1),
            },
          ]}
        />
        <p className="mt-2 text-xs text-nc-text-3">
          按同一交易日历和持有期对照各自的原始收益。累计从首日起间隔同等交易日复利，缺失区间留空，各行实际覆盖可能不同。
        </p>
      </Panel>
      <Panel title="研究边界" span={5}>
        <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-nc-text-2">
          <li>{result.metadata.survivorship}</li>
          <li>{result.metadata.coverage}</li>
          <li>
            {result.metadata.calendar}。{result.metadata.returns}
          </li>
          <li>
            截面统计未模拟订单撮合或扣除交易成本，不能用作可成交策略业绩。
          </li>
        </ul>
      </Panel>
    </>
  );
}
