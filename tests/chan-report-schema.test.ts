import { expect, it } from "vitest";
import {
  chanCitationRules,
  chanReportSchema,
  chanStageIds,
} from "~/server/chan-report-schema";
const files = [
  "02-morphology.md",
  "03-center-and-trend.md",
  "04-dynamics.md",
  "05-trading-points.md",
];
const passages = files.map((file, i) => ({
  id: `p${i}`,
  file,
  line: 1,
  heading: "fixture",
  lessons: [62],
  quote: "原文",
}));
const schema = chanReportSchema(passages, "e1", 10);
it("exposes the same exact chapter whitelist used by validation", () => {
  expect(chanCitationRules(passages)).toEqual([
    ...files.map((file, i) => ({
      id: chanStageIds[i],
      file,
      allowedPassageIds: [`p${i}`],
    })),
    {
      id: "conclusion",
      file: "任意已提供章节",
      allowedPassageIds: ["p0", "p1", "p2", "p3"],
    },
  ]);
  const value = valid();
  value.stages[2]!.passageIds = ["p0", "fake", "fake"];
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues[0]!.message).toContain(
      "重复1项，未知1项，跨章节1项",
    );
});
const valid = () => ({
  title: "标注研究",
  summary: "尚未核验",
  stages: chanStageIds.map((id, i) => ({
    id,
    status: "missing",
    summary: "资料不足",
    citations: ["e1"],
    passageIds: [`p${Math.min(i, 3)}`],
    missing: ["走势级别未核验"],
    annotations: [],
  })),
  risks: ["仅供标注研究"],
  nextSteps: ["补充结构证据"],
});
it("accepts complete research stages with source-bound quotations and real annotation ranges", () => {
  expect(schema.parse(valid()).stages).toHaveLength(5);
  const value = valid();
  const annotated = {
    ...value,
    stages: value.stages.map((stage, i) =>
      i === 0
        ? {
            ...stage,
            status: "hypothesis",
            annotations: [
              {
                startIndex: 2,
                endIndex: 6,
                label: "待核验结构",
                verification: "核对包含关系",
              },
            ],
          }
        : stage,
    ),
  };
  expect(schema.parse(annotated).stages[0]!.annotations[0]!.endIndex).toBe(6);
});
it("rejects invented quotes, wrong chapters, confirmed signals and missing evidence", () => {
  for (const change of [
    { passageIds: ["invented"] },
    { passageIds: ["p2"] },
    { passageIds: ["p0", "p0"] },
    { status: "supported" },
    { citations: ["other"] },
    { missing: [] },
    { status: "hypothesis" },
  ]) {
    const value = valid();
    expect(
      schema.safeParse({
        ...value,
        stages: [{ ...value.stages[0], ...change }, ...value.stages.slice(1)],
      }).success,
    ).toBe(false);
  }
});
it("rejects out-of-window and reversed annotations or stage reordering", () => {
  for (const range of [
    { startIndex: -1, endIndex: 2 },
    { startIndex: 1, endIndex: 10 },
    { startIndex: 8, endIndex: 2 },
  ]) {
    const value = valid();
    expect(
      schema.safeParse({
        ...value,
        stages: [
          {
            ...value.stages[0],
            annotations: [{ ...range, label: "x", verification: "y" }],
          },
          ...value.stages.slice(1),
        ],
      }).success,
    ).toBe(false);
  }
  const value = valid();
  expect(
    schema.safeParse({ ...value, stages: [...value.stages].reverse() }).success,
  ).toBe(false);
});
