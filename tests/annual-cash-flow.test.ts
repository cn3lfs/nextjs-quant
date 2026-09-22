import { expect, it } from "vitest";
import { annualCashFlow } from "~/server/strategies/value/annual-cash-flow";
import { financeEvidence } from "~/server/data-sources/hithink/hithink-finance";
const ocf = "经营活动产生的现金流量净额";
const capex = "购建固定资产、无形资产和其他长期资产支付的现金";
const profit = "归属于母公司所有者的净利润";
function evidence(
  points: { name: string; period: string; value: unknown; unit?: string }[],
  query = "annual",
) {
  return financeEvidence(
    "sh600519",
    {
      status_code: 0,
      datas: [
        {
          股票代码: "600519.SH",
          ...Object.fromEntries(
            points.map((p) => [`${p.name}[${p.period}]`, p.value]),
          ),
        },
      ],
      columns: points.map((p) => ({
        key: `${p.name}[${p.period}]`,
        timestamp: p.period,
        unit: p.unit ?? "人民币元",
      })),
    },
    query,
    1000,
  );
}
it("aligns annual amounts, normalizes scales and separates parent from consolidated profit", () => {
  const entry = evidence([
    { name: ocf, period: "20251231", value: 3, unit: "人民币亿元" },
    { name: capex, period: "20251231", value: 10000, unit: "人民币万元" },
    { name: profit, period: "20251231", value: 42 },
    { name: ocf, period: "20250930", value: 999 },
    { name: ocf, period: "29991231", value: 999 },
  ]);
  const before = JSON.stringify(entry);
  const facts = annualCashFlow("sh600519", [entry]);
  expect(facts.annual).toHaveLength(1);
  expect(facts.rejected).toHaveLength(2);
  expect(facts.annual[0]!.postCapexCashFlow).toBe(200000000);
  expect(facts.annual[0]!.amounts.parentNetProfit.value).toBe(42);
  expect(facts.annual[0]!.amounts.netProfit.value).toBeNull();
  expect(JSON.stringify(entry)).toBe(before);
});
it("does not infer currency, substitute years or guess negative capital spending signs", () => {
  const facts = annualCashFlow("sh600519", [
    evidence([
      { name: ocf, period: "20241231", value: 100, unit: "元" },
      { name: capex, period: "20241231", value: 20, unit: "元" },
      { name: ocf, period: "20251231", value: 100 },
      { name: capex, period: "20251231", value: -20 },
    ]),
  ]);
  expect(facts.annual.every((row) => row.postCapexCashFlow === null)).toBe(
    true,
  );
  expect(facts.annual[0]!.amounts.operatingCashFlow.value).toBe(100);
  expect(facts.annual[0]!.amounts.operatingCashFlow.currency).toBeNull();
  expect(facts.annual[1]!.amounts.capitalExpenditure.value).toBeNull();
});
it("preserves conflicting origins and rejects tampered contents or mismatched identities", () => {
  const a = evidence([{ name: ocf, period: "20251231", value: 100 }], "one");
  const b = evidence([{ name: ocf, period: "20251231", value: 101 }], "two");
  const result = annualCashFlow("sh600519", [a, b]);
  const value = result.annual[0]!.amounts.operatingCashFlow;
  expect(value.value).toBeNull();
  expect(value.points.map((p) => p.evidenceId)).toEqual([a.id, b.id]);
  expect(() => annualCashFlow("sz000001", [a])).toThrow("证券");
  expect(() =>
    annualCashFlow("sh600519", [{ ...a, text: a.text.replace("100", "200") }]),
  ).toThrow("哈希");
});
it("invalid numerical values and unsupported units remain missing", () => {
  for (const [value, unit] of [
    ["--", "元"],
    ["12亿元", "元"],
    [true, "元"],
    [1, "美元"],
    [Number.MAX_VALUE, "人民币亿元"],
  ] as const) {
    const facts = annualCashFlow("sh600519", [
      evidence([{ name: ocf, period: "20251231", value, unit }]),
    ]);
    expect(facts.annual[0]!.amounts.operatingCashFlow.value).toBeNull();
  }
});

it("does not substitute a provider capital-expenditure indicator for the statement cash line", () => {
  const facts = annualCashFlow("sh600519", [
    evidence([
      { name: ocf, period: "20251231", value: 100 },
      { name: "资本性支出", period: "20251231", value: 20 },
    ]),
  ]);
  expect(facts.annual[0]!.amounts.reportedCapitalExpenditure.value).toBe(20);
  expect(facts.annual[0]!.amounts.capitalExpenditure.value).toBeNull();
  expect(facts.annual[0]!.postCapexCashFlow).toBeNull();
});
