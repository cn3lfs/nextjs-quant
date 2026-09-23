import { expect, it } from "vitest";
import { mergeCanslimFinance } from "../../../../src/server/strategies/canslim/canslim-finance-bundle";
import { financeEvidence } from "../../../../src/server/data-sources/hithink/hithink-finance";
const entry = (value: number, period = "20251231") =>
  financeEvidence(
    "sh600519",
    {
      status_code: 0,
      datas: [{ 股票代码: "600519.SH", [`基本每股收益[${period}]`]: value }],
      columns: [
        {
          key: `基本每股收益[${period}]`,
          unit: "元",
          timestamp: period,
          type: "DOUBLE",
        },
      ],
    },
    "fixture",
    1000,
  );
it("merges periods, deduplicates identical observations and preserves origins", () => {
  const first = entry(2),
    older = entry(1, "20241231");
  const result = mergeCanslimFinance("sh600519", [older, first, first]);
  expect(result.series.annualEps?.map((p) => p.value)).toEqual([2, 1]);
  expect(result.origins["基本每股收益[20251231]"]).toEqual([first.id]);
});
it("quarantines conflicting values irrespective of arrival order", () => {
  const a = entry(2),
    b = entry(3);
  for (const sources of [
    [a, b, a],
    [b, a, b],
  ]) {
    const result = mergeCanslimFinance("sh600519", sources);
    expect(result.series.annualEps?.[0]?.value).toBeNull();
    expect(result.series.annualEps?.[0]?.reasons).toContain(
      "多份财务证据同字段不一致",
    );
    expect(result.origins["基本每股收益[20251231]"]).toHaveLength(2);
  }
});
it("rejects mismatched envelope and raw security identities", () => {
  const source = entry(2);
  expect(() => mergeCanslimFinance("sz000001", [source])).toThrow("身份");
  const raw = JSON.parse(source.text);
  raw.row.股票代码 = "000001.SZ";
  expect(() =>
    mergeCanslimFinance("sh600519", [{ ...source, text: JSON.stringify(raw) }]),
  ).toThrow("身份");
});
