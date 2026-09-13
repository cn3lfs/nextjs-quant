import type { WalkForwardPage } from "~/lib/walk-forward";
import type { ReviewValue } from "~/lib/trade-review";

const display = (metric: ReviewValue) =>
  metric.value === null
    ? `无法判定：${metric.reason}`
    : metric.value.toFixed(4);

export function MultipleTestingPanel({
  result,
}: {
  result?: WalkForwardPage["multipleTesting"];
}) {
  if (!result)
    return (
      <section className="rounded-lg border p-4">
        <h4>过拟合修正</h4>
        <p>无法判定：旧档案未记录试验修正，请重新运行滚动检验。</p>
      </section>
    );
  const { selected, trials, yearlyDays } = result;
  const reasons = [
    ...new Set([
      ...result.trialSharpeReasons.filter((reason) => reason !== null),
      ...[
        result.sharpeVariance,
        ...Object.values(selected).filter(
          (value): value is ReviewValue => typeof value === "object",
        ),
      ]
        .filter((value) => value.value === null)
        .map((value) => value.reason),
    ]),
  ];
  const stored = result.overfit;
  const overfit =
    stored && "bySelectionRule" in stored ? stored.bySelectionRule : undefined;
  const sharpe = stored && "bySharpe" in stored ? stored.bySharpe : stored;
  const pbo = overfit?.pbo.value;
  const pboConclusion =
    pbo === undefined || pbo === null
      ? `无法判定：${overfit?.pbo.reason ?? "旧档案未记录 PBO"}`
      : pbo <= 0.2
        ? `选参规则在样本外基本保持排序（PBO=${(pbo * 100).toFixed(2)}%，仅限当前候选集合）`
        : pbo < 0.5
          ? "选参规则部分失效"
          : "选参规则在样本外不优于随机，训练期第一名不具备预测力";
  const dsr = selected.dsr.value;
  const conclusion =
    reasons.length || dsr === null
      ? `无法判定：${reasons.join("；")}`
      : dsr >= 0.95
        ? `在记录到的 ${trials} 次试验下未被选择偏差解释（Bailey & López de Prado 2014；N 为下界，不构成业绩证据）`
        : dsr >= 0.5
          ? "不足以排除选择偏差"
          : "更可能是选择偏差的产物";
  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm">
      <h4 className="font-medium">过拟合修正</h4>
      <p>
        本次运行内部候选数 N（DSR 使用）：{trials} · 拼接测试收益观测数：
        {selected.observations}
      </p>
      <p>
        该区间历史累计已记录的试验次数（下界，运行时快照）：
        {result.recordedTrials?.value ?? "不可得"} ·{" "}
        {result.recordedTrials?.reason ?? "旧档案未记录"}
      </p>
      {result.recordedTrials?.value != null &&
        result.recordedTrials.value > trials && (
          <p>
            DSR 按本次候选数计算；该区间历史上已记录{" "}
            {result.recordedTrials.value}{" "}
            次试验（下界）。累计值跨标的跨配置，不能直接代入
            DSR，也不能据此量化额外紧缩。
          </p>
        )}
      <p>
        日夏普：{display(selected.sharpeDaily)}（年化：
        {display(selected.sharpeAnnual)}，年化天数 {yearlyDays}）
      </p>
      <p>
        紧缩日夏普门槛：{display(selected.threshold)} · DSR：
        {display(selected.dsr)}
      </p>
      <p>{conclusion}</p>
      <p>
        本系统选参规则（净收益→回撤→参数）：PBO ={" "}
        {pbo == null ? "—" : `${(pbo * 100).toFixed(2)}%`} · {pboConclusion}
      </p>
      <p>
        夏普口径对照：PBO ={" "}
        {sharpe
          ? sharpe.pbo.value === null
            ? display(sharpe.pbo)
            : `${(sharpe.pbo.value * 100).toFixed(2)}%`
          : "—"}
      </p>
      {overfit && (
        <p>
          性能衰减斜率：{display(overfit.performanceDegradation.slope)} · R²：
          {display(overfit.performanceDegradation.r2)} · 样本外亏损概率：
          {overfit.probabilityOfLoss.value === null
            ? display(overfit.probabilityOfLoss)
            : `${(overfit.probabilityOfLoss.value * 100).toFixed(2)}%`}
        </p>
      )}
      <p className="text-muted-foreground">
        依据 Bailey、Borwein、López de Prado 与
        Zhu（2015）CSCV。本系统口径检验净收益→回撤→参数排序，夏普口径检验日夏普选优，两者分列不合成。仅限当前均线半值/原值/双值候选集合；换候选集合
        PBO
        会变，人工反复试验不可观测；分档是描述性提示，不是预测力的显著性检验，不构成策略有效或业绩证据。
      </p>
      <p className="text-muted-foreground">
        依据 Bailey & López de Prado（2014）。N
        为实际试验数的下界，未记录的人工调参、更换标的及窗口不计入；DSR
        为乐观估计，不构成业绩证据。候选相关性未校正，拼接收益跨 fold
        换参数，不代表连续账户。
      </p>
      <p className="text-muted-foreground">
        候选方差取全部预热后行情（含未满 fold
        尾部），仅用于事后修正，不参与每轮选参。
      </p>
    </section>
  );
}
