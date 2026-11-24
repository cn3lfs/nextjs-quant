import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { MetricStrip, Panel } from "~/components/panels";
import {
  parameterGridWarning,
  type StudioParameterGridResult,
} from "~/lib/research/studio-result";
import { api } from "~/trpc/react";
import {
  formatCount,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "../diagnose/format";
import { StudioTable } from "./studio-result-view";

const axes: Record<string, string> = {
  momentumWindow: "动量回看（交易日）",
  topK: "持有只数",
};
const numericList = (value: string) =>
  value
    .split(/[\s,，、]+/)
    .filter(Boolean)
    .map(Number);

export function ParameterGridHeatmap({
  grid,
}: {
  grid: StudioParameterGridResult;
}) {
  const { xAxis, yAxis } = grid;
  const recorded = new Map(grid.cells.map((row) => [`${row.x}:${row.y}`, row]));
  const xLabel = axes[xAxis.key] ?? xAxis.key;
  const yLabel = axes[yAxis.key] ?? yAxis.key;
  const strength = Math.max(
    1,
    ...grid.cells.map((row) => Math.abs(row.sharpe ?? 0)),
  );
  return (
    <div className="space-y-3" aria-label="参数稳健性统计与热力图">
      <p
        role="note"
        className="rounded border border-nc-warn-edge bg-nc-inset p-2 text-sm text-nc-warn"
      >
        {grid.warning}
      </p>
      <MetricStrip
        items={[
          {
            label: "PBO(Sharpe)",
            value: formatPercent(grid.pbo),
            note: grid.reason,
          },
          {
            label: "DSR 0.95",
            value: formatRatio(grid.dsr, 3),
            note: `预登记坐标 ${formatCount(grid.dsrReference.x)} × ${formatCount(grid.dsrReference.y)} · 门槛 ${formatRatio(grid.dsrThreshold)}`,
          },
          {
            label: "N_eff",
            value: grid.effectiveTrials,
            digits: 0,
            note: `去重收益序列 ${formatCount(grid.distinctReturnSeries)}`,
          },
          {
            label: "CSCV 组合数",
            value: grid.cscvCombinations,
            digits: 0,
            note: `CSCV 弃尾 ${formatCount(grid.discardedCscvDays)} 日`,
          },
        ]}
      />
      <p className="text-sm text-nc-text-3">
        留出切点 {grid.holdoutStart} · 开发段滚动样本外{" "}
        {formatCount(grid.devOosDays)} 日 · 已评估窗口{" "}
        {formatCount(grid.windows.length)} · 开发段未成窗{" "}
        {formatCount(grid.trailingDevelopmentDays)} 日
      </p>
      <StudioTable
        label="2D 参数稳健性高原热力图"
        headers={[
          `${yLabel} / ${xLabel}`,
          ...xAxis.values.map((x) => formatCount(x)),
        ]}
      >
        {yAxis.values.map((y) => (
          <tr key={y}>
            <th scope="row" className="px-3 py-2 text-left tabular-nums">
              {formatCount(y)}
            </th>
            {xAxis.values.map((x) => {
              const row = recorded.get(`${x}:${y}`);
              const sharpe = row?.sharpe ?? null;
              const shade =
                sharpe == null
                  ? 0
                  : Math.round((Math.abs(sharpe) / strength) * 32 + 5);
              const color =
                sharpe != null && sharpe < 0 ? "--nc-down" : "--nc-up";
              const reference =
                x === grid.dsrReference.x && y === grid.dsrReference.y;
              return (
                <td
                  key={x}
                  className="min-w-32 border-l border-nc-border-soft px-3 py-2 tabular-nums"
                  style={{
                    backgroundColor: shade
                      ? `color-mix(in srgb, var(${color}) ${shade}%, var(--nc-card))`
                      : undefined,
                  }}
                >
                  <p className="font-medium">
                    Sharpe {formatRatio(sharpe)}
                    {reference && " · 预登记"}
                  </p>
                  <p className="text-xs text-nc-text-3">
                    DSR {formatRatio(row?.dsr, 3)}
                    {row?.meetsDsrThreshold === true && " · 达到门槛"}
                    {row?.meetsDsrThreshold === false && " · 低于门槛"}
                  </p>
                  <p className="text-xs text-nc-text-3">
                    收益 {formatSignedPercent(row?.totalReturn)} · 回撤{" "}
                    {formatPercent(row?.maxDrawdown)}
                  </p>
                  <p className="text-xs text-nc-text-3">
                    闭环交易 {formatCount(row?.trades)}
                  </p>
                  {(row?.reason || !row) && (
                    <p className="text-xs text-nc-warn">
                      {row?.reason ?? "缺少参数格证据"}
                    </p>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </StudioTable>
      {grid.windows.length > 0 && (
        <details className="text-sm text-nc-text-3">
          <summary className="cursor-pointer">查看开发段滚动窗口</summary>
          <ul className="mt-2 space-y-1">
            {grid.windows.map((window) => (
              <li key={window.start}>
                {window.trainStart} 至 {window.trainEnd} 预热 · {window.start}{" "}
                至 {window.end} 验证
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ParameterGrid({
  grid,
  enabled,
}: {
  grid?: StudioParameterGridResult;
  enabled: boolean;
}) {
  const [start, setStart] = useState("2020-01-01");
  const [holdoutStart, setHoldoutStart] = useState("2023-01-01");
  const [momentum, setMomentum] = useState("20, 40, 60");
  const [topK, setTopK] = useState("1, 2, 3");
  const [trainBars, setTrainBars] = useState("126");
  const [testBars, setTestBars] = useState("63");
  const [validation, setValidation] = useState("");
  const run = api.studioParameterGrid.useMutation();
  const evidence = run.data ?? grid;
  return (
    <Panel title="2D 参数稳健性高原" bodyClassName="space-y-3">
      {enabled && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (run.isPending) return;
            const momentumWindows = numericList(momentum);
            const topKs = numericList(topK);
            if (
              !momentumWindows.length ||
              !topKs.length ||
              start >= holdoutStart ||
              momentumWindows.length * topKs.length > 36 ||
              ![...momentumWindows, ...topKs].every(Number.isInteger)
            ) {
              setValidation("请输入有效的开发区间和整数参数，最多 36 格。");
              return;
            }
            setValidation("");
            run.mutate({
              start,
              holdoutStart,
              momentumWindows,
              topKs,
              trainBars: Number(trainBars),
              testBars: Number(testBars),
            });
          }}
        >
          <p className="text-sm text-nc-text-3">
            独立复核固定 ETF 双动量样本，只读取留出切点以前的开发段。
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <label className="block text-sm">
              网格开发起点
              <Input
                type="date"
                required
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              网格留出切点
              <Input
                type="date"
                required
                value={holdoutStart}
                onChange={(event) => setHoldoutStart(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              动量窗口序列
              <Input
                value={momentum}
                required
                onChange={(event) => setMomentum(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              持有只数序列
              <Input
                value={topK}
                required
                onChange={(event) => setTopK(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              训练交易日
              <Input
                type="number"
                required
                min={20}
                max={504}
                value={trainBars}
                onChange={(event) => setTrainBars(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              验证交易日
              <Input
                type="number"
                required
                min={20}
                max={252}
                value={testBars}
                onChange={(event) => setTestBars(event.target.value)}
              />
            </label>
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={run.isPending}
            aria-busy={run.isPending}
          >
            {run.isPending ? "正在计算参数网格…" : "运行参数稳健性网格"}
          </Button>
        </form>
      )}
      {(validation || run.error) && (
        <p role="alert" className="text-sm text-nc-warn">
          {validation || run.error?.message}
        </p>
      )}
      {run.data && (
        <p className="break-words text-xs text-nc-text-3">
          固定样本 {run.data.replay.symbols.join("、")} · 月末调仓 · 每窗本金{" "}
          {formatCount(run.data.replay.initialPerWindow)} 元
        </p>
      )}
      {evidence ? (
        <ParameterGridHeatmap grid={evidence} />
      ) : (
        <p className="text-sm text-nc-warn">{parameterGridWarning}</p>
      )}
    </Panel>
  );
}
