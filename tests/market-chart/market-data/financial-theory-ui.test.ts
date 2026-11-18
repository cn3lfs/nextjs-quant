import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { FinancialTheoryEvidence } from "~/components/financial/financial-theory-evidence";
import { evaluateFinancialTheory } from "../../../packages/trading-strategies/src/research/financial-theory";

describe("financial theory evidence presentation", () => {
  it("keeps incomplete nine-item evidence visible without presenting zero as a score", () => {
    const result = evaluateFinancialTheory(
      [
        {
          symbol: "sh600000",
          financialCompany: false,
          reportDate: "2025-12-31",
          announcementDate: "2026-03-01",
          sourceFilename: "annual.dat",
          sourceSha256: "source",
          contentSha256: "content",
          recordOffset: 0,
          mappingVersion: "test",
          fields: [],
          warnings: [],
        },
      ],
      {
        asOf: "2026-11-16",
        strict: false,
      },
    );
    const html = renderToStaticMarkup(
      createElement(FinancialTheoryEvidence, { result }),
    );
    expect(html).toContain("F-score 未完整");
    expect(html).toContain("已知 0/9");
    expect(html).toContain("缺少同年度普通股发行事实");
    expect(html).toContain("盈利收益率 EY 未知");
    expect(html).not.toContain("F-score 0");
    expect(html).not.toContain("NaN");
  });
  it("shows denominator definitions and source identity rather than only ranks", () => {
    const result = evaluateFinancialTheory([], {
      asOf: "2026-11-16",
      strict: false,
    });
    result.magic.enterpriseValue.inputs[0]!.sourceSha256 =
      "frozen-market-cap-hash";
    const html = renderToStaticMarkup(
      createElement(FinancialTheoryEvidence, { result }),
    );
    expect(html).toContain("frozen-market-cap-hash");
    expect(html).toContain("一年内到期非流动负债");
    expect(html).toContain("EBIT 与特殊生产资产依据");
    expect(html).toContain("当前下载版本未认证历史首次披露");
  });
});
