import type { ResearchUsageSummary } from "~/lib/research-usage";

export function ResearchUsagePanel({
  summary,
}: {
  summary: ResearchUsageSummary;
}) {
  const holdout = summary.holdout;
  return (
    <div className="space-y-2 text-sm">
      <p>
        已记录的试验次数（下界）：{summary.trialLowerBound} · 运行{" "}
        {summary.runs} 次 · 不同配置 {summary.distinctConfigs} · 候选累计{" "}
        {summary.candidateSum}
      </p>
      <p>
        滚动检验 {summary.byKind["walk-forward"]} · 回测{" "}
        {summary.byKind.backtest} · 公式选股 {summary.byKind["formula-screen"]}{" "}
        · 样本研究 {summary.byKind["sample-research"]} · 纪律反事实{" "}
        {summary.byKind["discipline-counterfactual"]}
      </p>
      <p>
        首末记录时间：
        {summary.firstRunAt === null
          ? "暂无记录"
          : `${new Date(summary.firstRunAt).toISOString()} — ${new Date(summary.lastRunAt!).toISOString()}`}
      </p>
      <p className="text-muted-foreground">{summary.reason}</p>
      {holdout.start === null ? (
        <p>留出集未启用</p>
      ) : (
        <>
          <p>
            留出集起点 {holdout.start}，留出集已被 {holdout.touches}{" "}
            次运行覆盖（全台账，按当前起点核对）；不同配置{" "}
            {holdout.distinctConfigs}，首次覆盖{" "}
            {holdout.firstTouchAt === null
              ? "暂无记录"
              : new Date(holdout.firstTouchAt).toISOString()}
            。
          </p>
          {holdout.touches > 0 && (
            <p>
              留出集的样本外意义已随使用次数递减，{holdout.touches}{" "}
              次之后它与样本内没有本质区别。此为保守的治理提示，次数不是统计阈值，不能量化剩余样本外意义。
            </p>
          )}
        </>
      )}
    </div>
  );
}
