import type {
  FinancialTheoryResult,
  FinancialTheoryEvidence as Evidence,
} from "trading-strategies/research/financial-theory";

function Inputs({ inputs }: { inputs: readonly Evidence[] }) {
  return (
    <ul className="space-y-1">
      {inputs.map((input, index) => (
        <li className="break-all" key={index}>
          {input.reportDate} · {input.code} · {input.value ?? "未知"}{" "}
          {input.unit} · {input.reason} · {input.sourceSha256 || "无来源身份"}
        </li>
      ))}
    </ul>
  );
}
export function FinancialTheoryEvidence({
  result,
}: {
  result: FinancialTheoryResult;
}) {
  const percent = (value: number | null) =>
    value === null ? "未知" : `${(value * 100).toFixed(2)}%`;
  return (
    <section aria-label="财务理论分项证据" className="space-y-2 text-xs">
      <p>
        完整年度 {result.reportDate ?? "缺失"} · F-score{" "}
        {result.fScore.score ?? "未完整"}（已知 {result.fScore.known}/9）
      </p>
      {result.fScore.checks.map((check) => (
        <details key={check.id}>
          <summary className="cursor-pointer">
            {check.label}：
            {check.matched === null
              ? "未知"
              : check.matched
                ? "通过"
                : "未通过"}
          </summary>
          <p>
            {check.formula} · {check.reason ?? check.value}
          </p>
          <Inputs inputs={check.inputs} />
        </details>
      ))}
      <p>
        魔法公式盈利收益率 EY {percent(result.magic.earningsYield)} · 资本回报率
        ROC {percent(result.magic.returnOnCapital)} · {result.magic.reason}
      </p>
      {[result.magic.enterpriseValue, result.magic.investedCapital].map(
        (metric) => (
          <details key={metric.id}>
            <summary className="cursor-pointer">
              {metric.label}：{metric.value ?? "未知"} 元
            </summary>
            <p>
              {metric.formula} · {metric.reason}
            </p>
            <Inputs inputs={metric.inputs} />
          </details>
        ),
      )}
      <details>
        <summary className="cursor-pointer">EBIT 与特殊生产资产依据</summary>
        <Inputs
          inputs={[result.magic.ebit, ...result.magic.specialProductionAssets]}
        />
      </details>
      <p>{result.warning}</p>
    </section>
  );
}
