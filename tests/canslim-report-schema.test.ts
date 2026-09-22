import { expect, it } from "vitest";
import {
  canslimReportSchema,
  canslimStageIds,
  type CanslimStagePolicy,
} from "../src/server/strategies/canslim/canslim-report-schema";
const policy = Object.fromEntries(
  canslimStageIds.map((id) => [
    id,
    { supported: false, missing: [`${id} prerequisite`] },
  ]),
) as CanslimStagePolicy;
const report = () => ({
  title: "研究",
  summary: "资料尚未完整",
  stages: canslimStageIds.map((id) => ({
    id,
    status: "missing",
    summary: "保留缺口",
    citations: ["E1"],
    missing: [`${id} prerequisite`],
  })),
  risks: ["数据未核验"],
  nextSteps: ["补齐资料"],
  citations: ["E1"],
});
it("accepts a complete six-stage explanation of missing prerequisites", () => {
  expect(canslimReportSchema(["E1"], policy).safeParse(report()).success).toBe(
    true,
  );
});
it("rejects skipped stages, fabricated references, scores and hidden prerequisites", () => {
  const schema = canslimReportSchema(["E1"], policy);
  const samples = [report(), report(), report(), report(), report()];
  samples[0]!.stages.pop();
  samples[1]!.stages[0]!.citations = ["invented"];
  samples[2]!.stages[0]!.status = "supported";
  samples[3]!.stages[0]!.missing = [];
  samples[4]!.stages.reverse();
  for (const sample of samples)
    expect(schema.safeParse(sample).success).toBe(false);
  expect(schema.safeParse({ ...report(), score: 116 }).success).toBe(false);
});
it("does not turn absence of a prerequisite into a negative finding", () => {
  const sample = report();
  sample.stages[0]!.status = "contradicted";
  expect(canslimReportSchema(["E1"], policy).safeParse(sample).success).toBe(
    false,
  );
});
