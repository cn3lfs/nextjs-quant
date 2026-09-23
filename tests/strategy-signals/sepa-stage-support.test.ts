import { expect, it } from "vitest";
import type { Evidence, Report } from "../../src/lib/domain";
import { sepaSupportedStagesValid } from "../../src/server/strategies/canslim/sepa-stage-support";
const stage = (
  id: NonNullable<Report["stages"]>[number]["id"],
  status: "supported" | "missing" = "supported",
) => [{ id, status, summary: "fixture", citations: ["E"], missing: [] }];
it("rejects unsupported positive stages even with valid-looking citations", () => {
  for (const id of [
    "market",
    "fundamentals",
    "trend",
    "vcp",
    "entry-risk",
    "conclusion",
  ] as const)
    expect(
      sepaSupportedStagesValid(stage(id), [
        { id: "E", text: "{}" } as Evidence,
      ]),
    ).toBe(false);
  expect(sepaSupportedStagesValid(stage("trend", "missing"), [])).toBe(false);
  expect(
    sepaSupportedStagesValid(
      [{ ...stage("trend", "missing")[0]!, missing: ["RS缺失"] }],
      [],
    ),
  ).toBe(true);
});
it("requires a passing financial diagnostic from the correct source and its citation", () => {
  const evidence = (gate: string, source = "hithink-finance-query") => [
    {
      id: "E",
      envelope: { source },
      text: JSON.stringify({
        sepaFinanceDiagnostic: { version: "sepa-finance-diagnostic-2", gate },
      }),
    } as Evidence,
  ];
  expect(
    sepaSupportedStagesValid(stage("fundamentals"), evidence("strict-pass")),
  ).toBe(true);
  expect(
    sepaSupportedStagesValid(stage("fundamentals"), evidence("tolerant-pass")),
  ).toBe(true);
  expect(
    sepaSupportedStagesValid(stage("fundamentals"), evidence("failed")),
  ).toBe(false);
  expect(
    sepaSupportedStagesValid(
      stage("fundamentals"),
      evidence("strict-pass", "unverified"),
    ),
  ).toBe(false);
  expect(
    sepaSupportedStagesValid(
      [{ ...stage("fundamentals")[0]!, citations: ["other"] }],
      evidence("strict-pass"),
    ),
  ).toBe(false);
});
