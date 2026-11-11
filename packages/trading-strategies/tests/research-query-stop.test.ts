import { expect, it } from "vitest";
import {
  initialStopPolicySchema,
  stopOverridePolicySchema,
} from "../src/research/contracts/initial-stop.js";
import {
  researchInitialStop,
  researchStopOverride,
  researchStopComparison,
} from "../src/research/risk/research-initial-stop.js";
import {
  evaluateQueryTemplate,
  queryRebalance,
  queryFieldUnits,
} from "../src/research/query/research-query-templates.js";

it("owns the original stop defaults and compares all valid distances before selecting", () => {
  expect(initialStopPolicySchema.parse(undefined)).toEqual({
    kind: "percent",
    fraction: 0.05,
  });
  const stop = initialStopPolicySchema.parse({
    kind: "max-distance",
    fraction: 0.05,
    period: 14,
    multiple: 1.5,
    structureBuffer: 0.3,
  });
  expect(
    researchStopComparison(stop, 80, { initialStop: 76.5, stopAtr: 2.5 })
      ?.selected,
  ).toBe(75.75);
  expect(researchStopComparison(stop, 80, {})).toBeNull();
});

it("uses an override only for the exact frozen security and observation", () => {
  const management = {
    stop: initialStopPolicySchema.parse(undefined),
    stopOverride: stopOverridePolicySchema.parse({
      symbol: "sh600000",
      observedDate: "2024-05-01",
      price: 95,
    }),
  };
  expect(
    researchInitialStop(management, 100, {
      symbol: "sh600000",
      observedDate: "2024-05-01",
    }),
  ).toBe(95);
  expect(
    researchStopOverride(management, {
      symbol: "sh600001",
      observedDate: "2024-05-01",
    }),
  ).toBeNull();
  expect(
    researchInitialStop(management, 94, {
      symbol: "sh600000",
      observedDate: "2024-05-01",
    }),
  ).toBeNull();
});

it("screens a frozen query panel and generates intents while missing snapshots retain positions", () => {
  const asOf = "2024-05-01T15:00:00+08:00";
  const result = evaluateQueryTemplate(
    "astock-return5",
    {
      asset: "hs-stock",
      date: "2024-05-01",
      sessionClosedAt: asOf,
      sessionEvidence: "fixture",
      universeId: "fixed",
      membershipEvidence: "fixture",
      universe: ["sh600000"],
      rows: [
        {
          id: "sh600000",
          values: {
            dailyReturnPct: {
              value: 6,
              unit: queryFieldUnits.dailyReturnPct,
              version: "fixture",
              evidence: "fixture",
              effectiveAt: "2024-05-01",
              availableAt: asOf,
              capturedAt: asOf,
            },
          },
        },
      ],
    },
    { asOf },
  );
  expect(result.status).toBe("computed");
  expect(queryRebalance(result, ["sz000001"])).toMatchObject({
    entries: ["sh600000"],
    exits: ["sz000001"],
    targetWeight: 1,
  });
  expect(
    queryRebalance(evaluateQueryTemplate("astock-return5", {}, { asOf }), [
      "sz000001",
    ]),
  ).toMatchObject({ exits: [], retained: ["sz000001"] });
});
