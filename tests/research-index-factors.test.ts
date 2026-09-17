import {
  indexFixtureDates as dates,
  indexFixtureRows,
  indexFixtureRequest as req,
} from "./helpers/market-factor-fixture";
import { expect, it } from "vitest";
import { evaluateGrowthFactors } from "../src/server/research-growth-factors";
import { indexFactorRules } from "../src/lib/research-index-factors";
import { asOfInputDefinitions } from "../src/lib/as-of-inputs";
import type { AsOfObservation } from "../src/lib/as-of";
import { request } from "./helpers/growth-factor-fixture";

function alter(
  field: string,
  edit: (value: Record<string, unknown>) => unknown,
) {
  return indexFixtureRows().map((r) =>
    r.field === field
      ? { ...r, value: edit(r.value as Record<string, unknown>) }
      : r,
  );
}
const one = (id = "GF01", rows = indexFixtureRows()) =>
  evaluateGrowthFactors(req, rows, [id]).results[0]!;
it.each(Object.keys(indexFactorRules))(
  "%s routes existing as-of entry to frozen ETF candidates",
  (id) => {
    expect(one(id)).toMatchObject({
      status: "computed",
      passed: true,
      details: {
        score: 0,
        exit: false,
        allocation: [{ symbol: req.symbol, weightPct: 25 }],
      },
    });
    expect(one(id, [])).toMatchObject({ status: "missing", points: null });
  },
);
it("PE and PB use strict lower ranks including tied current samples, worst wins", () => {
  const rows = alter("indexValuation", (v) => ({
    ...v,
    samples: dates.map((date, i) => ({ date, pe: 10, pb: i === 2 ? 3 : 1 })),
  }));
  expect(one("GF01", rows)).toMatchObject({
    passed: false,
    details: { pePercentile: 0, pbPercentile: 200 / 3, action: "hold" },
  });
  expect(one("GF02", rows).details.allocation).toEqual([
    { symbol: req.symbol, weightPct: 6.25 },
  ]);
});
it("threshold equality closes entry and opens exit, and GF02 retains separate middle tier", () => {
  const rows = alter("indexPolicy", (v) => ({
    ...v,
    entryBelow: 0,
    middleAt: 40,
    exitAt: 60,
  }));
  expect(one("GF01", rows).passed).toBe(false);
  expect(one("GF02", rows).details.allocation).toEqual([
    { symbol: req.symbol, weightPct: 12.5 },
  ]);
  const high = alter("indexValuation", (v) => ({
    ...v,
    samples: dates.map((date, i) => ({ date, pe: 10 + i, pb: 1 + i })),
  }));
  const exit = high.map((r) =>
    r.field === "indexPolicy"
      ? { ...r, value: { ...(r.value as object), exitAt: 200 / 3 } }
      : r,
  );
  expect(one("GF01", exit).details).toMatchObject({
    exit: true,
    action: "exit",
    allocation: [{ symbol: req.symbol, weightPct: 0 }],
  });
});
it.each([
  ["indexValuation", { calculationDate: "2024-04-30" }],
  ["indexValuation", { calendar: dates.slice(1) }],
  ["indexPolicy", { frozenAt: "2024-04-30T00:00:00Z" }],
  ["indexPolicy", { windowStart: "2024-04-01" }],
  ["indexEtfMapping", { validThrough: "2024-04-30" }],
  ["indexEtfMapping", { validFrom: "2024-05-02" }],
  ["indexEtfMapping", { indexId: "sh000001" }],
  ["indexEtfMapping", { rows: [] }],
] as const)("rejects %s inconsistent frozen metadata %j", (field, change) =>
  expect(
    one(
      "GF01",
      alter(field, (v) => ({ ...v, ...change })),
    ).status,
  ).toBe("missing"),
);
it("historical mapping cannot be archived today or substitute an index for an ETF", () => {
  expect(
    one(
      "GF01",
      indexFixtureRows().map((r) =>
        r.field === "indexEtfMapping"
          ? { ...r, capturedAt: "2026-09-17T00:00:00Z" }
          : r,
      ),
    ).status,
  ).toBe("missing");
  expect(
    evaluateGrowthFactors(
      { ...req, symbol: "sh000300" },
      indexFixtureRows().map((r) => ({ ...r, entity: "sh000300" })),
      ["GF03"],
    ).results[0]!.status,
  ).toBe("missing");
});
it("mapping allocation preserves frozen weights and refuses duplicate, unlisted or nontracking ETFs", () => {
  const rows = [
    {
      symbol: req.symbol,
      instrument: "domestic-equity-etf",
      listingDate: "2020-01-01",
      trackingIndex: "sh000300",
      weight: 0.4,
    },
    {
      symbol: "sh510310",
      instrument: "domestic-equity-etf",
      listingDate: "2020-01-01",
      trackingIndex: "sh000300",
      weight: 0.6,
    },
  ];
  expect(
    one(
      "GF03",
      alter("indexEtfMapping", (v) => ({ ...v, rows })),
    ).details.allocation,
  ).toEqual([
    { symbol: req.symbol, weightPct: 10 },
    { symbol: "sh510310", weightPct: 15 },
  ]);
  for (const change of [
    { symbol: req.symbol },
    { listingDate: "2025-01-01" },
    { trackingIndex: "sh000001" },
    { weight: 0.8 },
    { instrument: "index" },
  ])
    expect(
      one(
        "GF03",
        alter("indexEtfMapping", (v) => ({
          ...v,
          rows: [rows[0], { ...rows[1], ...change }],
        })),
      ).status,
    ).toBe("missing");
});
it("does not accept a close valuation published before the close", () =>
  expect(
    one(
      "GF01",
      indexFixtureRows().map((r) =>
        r.field === "indexValuation"
          ? { ...r, availableAt: "2024-05-01T10:00:00+08:00" }
          : r,
      ),
    ).status,
  ).toBe("missing"));
it("declaring an index to be an ETF cannot bypass instrument identity", () => {
  const rows = alter("indexEtfMapping", (v) => ({
    ...v,
    rows: [
      {
        symbol: "sh000300",
        instrument: "domestic-equity-etf",
        listingDate: "2000-01-01",
        trackingIndex: "sh000300",
        weight: 1,
      },
    ],
  })).map((r) => ({ ...r, entity: "sh000300" }));
  expect(
    evaluateGrowthFactors({ ...req, symbol: "sh000300" }, rows, ["GF03"])
      .results[0]!.status,
  ).toBe("missing");
});
