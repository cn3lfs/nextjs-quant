"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { valuationScenarioSchema } from "~/lib/research/factors/valuation-scenario";
import { Button } from "../ui/button";

const commonFields = [
  ["totalShares", "总股数（股）"],
  ["growthRate", "预测期年增长率（%）"],
  ["discountRate", "折现率（%，DCF填WACC，郭永清法填股权资本成本）"],
  ["terminalGrowthRate", "永续增长率（%）"],
] as const;
const methodFields = {
  "fcff-wacc": [
    ["baseFcff", "基期FCFF（元）"],
    ["cashAndNonOperatingAssets", "现金及非经营资产价值（元）"],
    ["debtValue", "债务价值（元）"],
    ["minorityInterestValue", "少数股东权益价值（元）"],
    ["otherClaimsValue", "其他索取权价值（元）"],
  ],
  "guo-operating-equity": [
    ["forecastYears", "预测年数（3—5年）"],
    ["operatingCashFlow", "基期经营现金流（元）"],
    ["maintenanceCapex", "保全性资本支出（元）"],
    ["financialAssetsValue", "金融资产价值（元）"],
    ["longTermInvestmentsValue", "长期投资价值（元）"],
    ["interestBearingDebt", "有息负债（元）"],
    ["minorityEquity", "少数股东权益账面金额（元）"],
    ["totalEquity", "股东权益合计账面金额（元）"],
  ],
} as const;
const methodNames = {
  "fcff-wacc": "DCF · FCFF / WACC",
  "guo-operating-equity": "郭永清 · 经营现金流重构",
};
type Method = keyof typeof methodFields;
type Draft = { name: string; note: string; fields: Record<string, string> };
const emptyDraft = (index: number): Draft => ({
  name: `情景${index}`,
  note: "",
  fields: {},
});
const numberText = (value: number) =>
  value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

export function ValuationPanel({ symbol }: { symbol: string }) {
  const utils = api.useUtils();
  const [method, setMethod] = useState<Method>("fcff-wacc");
  const [title, setTitle] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([emptyDraft(1)]);
  const [error, setError] = useState("");
  const [reportId, setReportId] = useState("");
  const history = api.valuationHistory.useQuery();
  const report = api.valuationReport.useQuery(
    reportId || `valuation-scenario-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  const save = api.valuationSave.useMutation({
    onSuccess: ({ id }) => {
      setReportId(id);
      void utils.valuationHistory.invalidate();
    },
  });
  const fields = [...commonFields, ...methodFields[method]];
  const data = report.data;
  function update(index: number, patch: Partial<Draft>) {
    setDrafts((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }
  function submit() {
    setError("");
    save.reset();
    const scenarios = drafts.map((draft) => ({
      name: draft.name,
      assumptions: {
        method,
        currency: "CNY",
        amountUnit: "yuan",
        sharesUnit: "shares",
        cashFlowBasis:
          method === "fcff-wacc"
            ? "fcff"
            : "operating-cash-flow-less-maintenance",
        ...(method === "fcff-wacc" ? { forecastYears: 5 } : {}),
        assumptionNote: draft.note,
        ...Object.fromEntries(
          fields.map(([key]) => [
            key,
            draft.fields[key]?.trim()
              ? Number(draft.fields[key]) / (key.endsWith("Rate") ? 100 : 1)
              : undefined,
          ]),
        ),
      },
    }));
    const parsed = valuationScenarioSchema.safeParse({
      symbol,
      title,
      scenarios,
    });
    if (!parsed.success) {
      setError(
        "请填写全部金额、股数、利率和假设依据，并检查数值范围及情景名称。郭永清法折现率为8%—10%，永续增长率不超过4%。",
      );
      return;
    }
    save.mutate(parsed.data);
  }
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${data.symbol}-${data.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel">
      <h2>独立估值情景</h2>
      <p className="muted">
        当前证券：{symbol}
        。按人工假设计算并归档，不代表财务资料已核验。金额统一填人民币元，股数填股；不自动填充或生成买卖信号。
      </p>
      <details>
        <summary>创建估值情景</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending}>
            <label className="field">
              报告名称
              <input
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              估值方法
              <select
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value as Method);
                  setDrafts([emptyDraft(1)]);
                  setError("");
                  save.reset();
                }}
              >
                {Object.entries(methodNames).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {method === "fcff-wacc"
                ? "预测期固定5年。FCFF需自行统一口径，不能直接使用报表经营现金流减全部资本支出。"
                : "保全性资本支出需单独估算。折现率8%—10%，永续增长率不超过4%；特殊行业适用性与财报排雷尚需核验。"}{" "}
              切换方法会清空未保存的情景参数。
            </p>
            {drafts.map((draft, index) => (
              <fieldset key={index}>
                <legend>情景 {index + 1}</legend>
                <label className="field">
                  情景名称
                  <input
                    required
                    maxLength={40}
                    value={draft.name}
                    onChange={(event) =>
                      update(index, { name: event.target.value })
                    }
                  />
                </label>
                <div className="form-grid">
                  {fields.map(([key, label]) => (
                    <label className="field" key={key}>
                      {label}
                      <input
                        required
                        type="number"
                        step="any"
                        value={draft.fields[key] ?? ""}
                        onChange={(event) =>
                          update(index, {
                            fields: {
                              ...draft.fields,
                              [key]: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="field">
                  假设与数据依据
                  <textarea
                    required
                    maxLength={4000}
                    value={draft.note}
                    onChange={(event) =>
                      update(index, { note: event.target.value })
                    }
                    placeholder="注明财报期间、来源、增长率依据、资本支出及权益调整口径。"
                  />
                </label>
                {drafts.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setDrafts((rows) => rows.filter((_, i) => i !== index))
                    }
                  >
                    移除情景
                  </Button>
                )}
              </fieldset>
            ))}
            <div className="actions">
              <Button
                type="button"
                variant="outline"
                disabled={drafts.length >= 3}
                onClick={() =>
                  setDrafts((rows) => [...rows, emptyDraft(rows.length + 1)])
                }
              >
                增加情景（最多3个）
              </Button>
              <Button type="submit">
                {save.isPending ? "计算中…" : "计算并保存"}
              </Button>
            </div>
          </fieldset>
        </form>
      </details>
      {(error || save.error) && (
        <p role="alert">{error || save.error?.message}</p>
      )}
      <label className="field">
        已归档估值
        <select
          value={reportId}
          onChange={(event) => setReportId(event.target.value)}
        >
          <option value="">选择一份估值档案</option>
          {history.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.symbol} · {methodNames[row.method]} · {row.title} ·{" "}
              {new Date(row.createdAt).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
      </label>
      {history.error && <p role="alert">{history.error.message}</p>}
      {report.isFetching && reportId && <p>读取估值档案…</p>}
      {report.error && <p role="alert">{report.error.message}</p>}
      {reportId && report.isSuccess && !data && <p>未找到该估值档案。</p>}
      {data && (
        <article>
          <h3>
            {data.title} · {data.symbol}
          </h3>
          <p>
            {methodNames[data.method]} · 人工假设场景 ·{" "}
            {new Date(data.createdAt).toLocaleString("zh-CN")}
          </p>
          <p>
            情景每股值范围：{numberText(data.range.min)}—
            {numberText(data.range.max)}{" "}
            元。范围来自本组假设，不是统计置信区间。
          </p>
          <Button variant="outline" onClick={download}>
            下载完整估值档案
          </Button>
          {data.scenarios.map((row) => (
            <details key={row.name}>
              <summary>
                {row.name}：每股 {numberText(row.perShareValue)} 元
              </summary>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {row.input.assumptionNote}
              </p>
              <p>
                经营价值 {numberText(row.operatingPresentValue)} 元；归母价值{" "}
                {numberText(row.bridge.parentEquityValue)} 元；终值占经营价值{" "}
                {row.terminalSharePercent === null
                  ? "不适用"
                  : `${numberText(row.terminalSharePercent)}%`}
                。
              </p>
              <table>
                <thead>
                  <tr>
                    <th>预测年</th>
                    <th>现金流（元）</th>
                    <th>折现系数</th>
                    <th>现值（元）</th>
                  </tr>
                </thead>
                <tbody>
                  {row.schedule.map((year) => (
                    <tr key={year.year}>
                      <td>{year.year}</td>
                      <td>{numberText(year.cashFlow)}</td>
                      <td>{numberText(year.discountFactor)}</td>
                      <td>{numberText(year.presentValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                永续终值 {numberText(row.terminalValue)} 元；终值现值{" "}
                {numberText(row.terminalPresentValue)} 元。
              </p>
              <ul>
                {row.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <details>
                <summary>完整输入与权益换算</summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(
                    { input: row.input, bridge: row.bridge },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          ))}
        </article>
      )}
    </section>
  );
}
