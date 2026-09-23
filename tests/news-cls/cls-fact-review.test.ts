import { expect, it } from "vitest";
import {
  clsFactStatistics,
  clsFactReviewSchema,
} from "../../src/lib/news/cls-fact-review";

it("separates unresolved facts and counts the latest review of each claim", () => {
  const base = {
    reportId: "report",
    sectionId: "a".repeat(64),
    quote: "订单增长",
    evidence: "公告编号",
    id: "first",
    reviewedAt: 1,
    verdict: "unresolved" as const,
  };
  expect(clsFactStatistics([base])).toMatchObject({
    unresolved: 1,
    supportRate: null,
  });
  expect(
    clsFactStatistics([
      base,
      { ...base, id: "second", reviewedAt: 2, verdict: "supported" },
      { ...base, quote: "已投产", verdict: "contradicted" },
    ]),
  ).toMatchObject({
    reviewed: 2,
    supported: 1,
    contradicted: 1,
    supportRate: 0.5,
  });
  expect(
    clsFactReviewSchema.safeParse({ ...base, evidence: " " }).success,
  ).toBe(false);
});
