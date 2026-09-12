import type { MultipleTesting } from "~/lib/multiple-testing";
import type { ReviewValue } from "~/lib/trade-review";

const display = (metric: ReviewValue) =>
  metric.value === null
    ? `无法判定：${metric.reason}`
    : metric.value.toFixed(4);

export function MultipleTestingPanel({ result }: { result?: MultipleTesting }) {
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
        记录试验数 N：{trials} · 拼接测试收益观测数：{selected.observations}
      </p>
      <p>
        日夏普：{display(selected.sharpeDaily)}（年化：
        {display(selected.sharpeAnnual)}，年化天数 {yearlyDays}）
      </p>
      <p>
        紧缩日夏普门槛：{display(selected.threshold)} · DSR：
        {display(selected.dsr)}
      </p>
      <p>{conclusion}</p>
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
