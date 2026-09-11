import { expect, it } from "vitest";
import { parseClsReport } from "../src/server/cls-report-parser";
import { clsCandidates } from "../src/server/cls-candidates";

it("maps exact sectors to prior RPS while distinguishing recommendations from news mentions", async () => {
  const report = parseClsReport(
    "# 报告\n### 电子（方向：偏多 ｜ 信心：高）\n新闻：甲公司大涨 sh600000\n### 计算机（方向：偏多 ｜ 信心：中）\n**推荐标的**：乙公司 sz000001\n",
  );
  const deps = {
    securities: [
      { symbol: "sh600000", name: "甲公司" },
      { symbol: "sz000001", name: "乙公司" },
    ],
    pools: [{ category: "industry" as const, name: "电子" }],
    pool: async () => ({
      members: ["sh600000", "sh600000", "sh600002"],
      hash: "members",
    }),
    ranking: [{ symbol: "sh600000", rps: 96 }],
    rpsDate: "2026-09-10",
    rpsHash: "rps",
  };
  const result = await clsCandidates(report, deps);
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]).toMatchObject({
    basis: "sector-rps",
    symbol: "sh600000",
    rps: 96,
  });
  expect(result.candidates[1]).toMatchObject({
    basis: "explicit-recommendation",
    symbol: "sz000001",
    rps: null,
  });
  expect((await clsCandidates(report, deps)).poolHash).toBe(result.poolHash);
  const ambiguous = await clsCandidates(report, {
    ...deps,
    pools: [...deps.pools, { category: "concept", name: "电子" }],
  });
  expect(ambiguous.unmatched[0]?.reason).toContain("重复");
  expect(ambiguous.candidates).toHaveLength(1);
});
