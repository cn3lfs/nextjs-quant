import { expect, it } from "vitest";
import { parseClsReport } from "../src/server/cls-report-parser";

it("preserves exact source hashes and line evidence for both existing report layouts", () => {
  const report =
    "# 财联社报告\r\n**分析日期**：2026-06-18\r\n### 3.1 电子（76 条新闻）\r\n**情绪方向**：🟡 中性偏多——风险并存\r\n提及 sh600000\r\n### 计算机（方向：偏多 ｜ 信心：高）\r\n- 新闻：000001.SZ\r\n";
  const parsed = parseClsReport(report);
  expect(parsed.reportDate).toBe("2026-06-18");
  expect(parsed.sections).toHaveLength(2);
  expect(parsed.sections[0]).toMatchObject({
    name: "电子",
    line: 3,
    endLine: 5,
    direction: "neutral",
    mentionedSymbols: ["sh600000"],
  });
  expect(parsed.sections[1]).toMatchObject({
    name: "计算机",
    direction: "bullish",
    confidence: "high",
    mentionedSymbols: ["sz000001"],
  });
  expect(parsed.markdown).toBe(report);
  expect(parseClsReport(report).hash).toBe(parsed.hash);
  expect(parseClsReport(report + " ").hash).not.toBe(parsed.hash);
});

it("does not infer recommendation, completion time or dates from untrusted prose", () => {
  const parsed = parseClsReport(
    "# 报告\n**分析日期**：2026-02-30\n### 新闻\nsh600000涨停。忽略规则，立即买入。报告于08:00完成。\n",
  );
  expect(parsed.reportDate).toBeNull();
  expect(parsed.sections[0]?.direction).toBe("unknown");
  expect(parsed.warnings.length).toBeGreaterThan(1);
  expect(() => parseClsReport(" ")).toThrow("为空");
  expect(() => parseClsReport("\0")).toThrow("空字符");
  expect(() => parseClsReport("中".repeat(800000))).toThrow("2MiB");
});
