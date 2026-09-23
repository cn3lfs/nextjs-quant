import { expect, it } from "vitest";
import {
  evaluateGrowthFactors,
  rankGrowthFactors,
} from "../../../src/server/strategies/canslim/research-growth-factors";
import {
  valueFactorRules,
  valueThesisMetrics,
} from "../../../src/lib/research/factors/research-value-factors";
import {
  valueQualitySchema,
  valueMarketSchema,
  valuePolicySchema,
  valueGuoSchema,
  valueRiskSchema,
  valueThesisSchema,
  valueThesisObservationSchema,
} from "../../../src/lib/research/evidence/as-of-inputs";
import { z } from "zod";
import {
  valueFixture,
  valueRequest,
  setValue,
} from "../../helpers/value-factor-fixture";
const one = (id: string, rows = valueFixture(id), req = valueRequest) =>
  evaluateGrowthFactors(req, rows, [id]).results[0]!;
it("32 named K9 methods use the existing research entry and explicit waiting-data status", () => {
  expect(Object.keys(valueFactorRules)).toHaveLength(32);
  for (const id of Object.keys(valueFactorRules)) {
    const r = one(id);
    expect(r.status, `${id}: ${JSON.stringify(r.dataGaps)}`).toBe("computed");
    expect(r.passed, id).toBe(id !== "VI05");
    expect(
      evaluateGrowthFactors(valueRequest, valueFixture(id), [id]).realBacktest,
    ).toMatchObject({ available: false, coverage: { start: null, end: null } });
  }
});
it.each(Object.keys(valueFactorRules))(
  "%s refuses missing and future disclosures instead of fabricating a score",
  (id) => {
    expect(one(id, [])).toMatchObject({
      status: "missing",
      points: null,
      passed: null,
    });
    const rows = valueFixture(id),
      r = one(id),
      used = r.evidence[0]!;
    const future = rows.map((x) =>
      x.field === used.field && x.effectiveAt === used.effectiveAt
        ? { ...x, availableAt: "2025-01-01T00:00:00Z" }
        : x,
    );
    expect(one(id, future)).toMatchObject({ status: "missing", passed: null });
    const invalid = rows.map((x) =>
      x.field === used.field && x.effectiveAt === used.effectiveAt
        ? { ...x, unit: "wrong" }
        : x,
    );
    expect(one(id, invalid).status).toBe("missing");
  },
);
it("F-Score computes all nine from statement values and strict improvement boundaries", () => {
  expect(one("FA01").points).toBe(9);
  const rows = valueFixture(),
    prior = rows.find(
      (r) => r.field === "annualValueQuality" && r.effectiveAt === "2022-12-31",
    )!.value;
  const equal = setValue(rows, "annualValueQuality", () => prior, "2023-12-31");
  expect(one("FA01", equal).points).toBe(4);
  expect(
    one(
      "FA01",
      setValue(rows, "annualValueQuality", (v) => ({
        ...valueQualitySchema.parse(v),
        issuedShares: 100,
      })),
    ).points,
  ).toBe(8);
});
it("DuPont agrees with net income/equity and rejects leverage-only improvement", () => {
  const r = one("FA02");
  const d = r.details.decomposition as { roe: number }[];
  expect(d[0]!.roe).toBeCloseTo((150 / 800) * 100);
  const bad = setValue(
    valueFixture(),
    "annualValueQuality",
    (v) => ({ ...valueQualitySchema.parse(v), equity: 100 }),
    "2023-12-31",
  );
  expect(one("FA02", bad).passed).toBe(false);
});
it("FA DCF uses reconciled FCFF, frozen WACC and cannot use Guo equity discount or repair denominator", () => {
  const r = one("FA03");
  expect(r.details.model).toBe("historical-fcff-wacc-frozen");
  expect(r.details.baseFcff).toBe(140);
  expect(r.details.wacc).toBeCloseTo((1000 * 0.085 + 100 * 0.04 * 0.75) / 1100);
  expect(
    one(
      "FA03",
      valueFixture().filter((r) => r.field !== "annualFcff"),
    ).status,
  ).toBe("missing");
  const bad = setValue(valueFixture(), "valuePolicy", (v) => ({
    ...valuePolicySchema.parse(v),
    riskFreeRate: 0,
    beta: 0,
    debtCost: 0,
  }));
  expect(one("FA03", bad).status).toBe("missing");
});
it.each(["FA03", "FA06", "FA07", "FA08", "FA09", "GY02", "GY05", "GY06"])(
  "%s refuses refrozen or retrospectively captured valuation assumptions",
  (id) => {
    const rows = valueFixture(id);
    expect(
      one(
        id,
        setValue(rows, "valuePolicy", (v) => ({
          ...valuePolicySchema.parse(v),
          frozenAt: valueRequest.asOf,
        })),
      ).status,
    ).toBe("missing");
    expect(
      one(
        id,
        rows.map((r) =>
          r.field === "valuePolicy"
            ? { ...r, capturedAt: "2025-01-01T00:00:00Z" }
            : r,
        ),
      ).status,
    ).toBe("missing");
    expect(
      one(
        id,
        setValue(rows, "valuePolicy", (v) => ({
          ...valuePolicySchema.parse(v),
          purpose: "manual-scenario",
        })),
      ).status,
    ).toBe("missing");
  },
);
it("Graham clamps growth and has a strict 67% price boundary; PEG zero growth is unavailable", () => {
  const base = one("FA06");
  expect(base.details.fair).toBe(57);
  const changePrice = (price: number) =>
    setValue(valueFixture(), "valueMarket", (v) => {
      const m = valueMarketSchema.parse(v);
      m.price = price;
      m.history.rows.at(-1)!.pe = price / m.epsTtm;
      m.history.rows.at(-1)!.pb = price / m.bps;
      return m;
    });
  expect(one("FA06", changePrice(57 * 0.67)).passed).toBe(false);
  expect(one("FA06", changePrice(57 * 0.67 - 0.0001)).passed).toBe(true);
  expect(one("FA07").details.peg).toBe(0.1);
  expect(
    one(
      "FA07",
      setValue(valueFixture(), "valuePolicy", (v) => ({
        ...valuePolicySchema.parse(v),
        expectedGrowthPct: 0,
      })),
    ).status,
  ).toBe("missing");
});
it("historical PE/PB uses complete five-year annual panel and does not skip holes", () => {
  expect(one("FA05").details).toMatchObject({ pePct: 0, pbPct: 0 });
  const hole = setValue(valueFixture(), "valueMarket", (v) => {
    const m = valueMarketSchema.parse(v);
    m.history.calendar.splice(1, 1);
    m.history.rows.splice(1, 1);
    return m;
  });
  expect(one("FA05", hole).status).toBe("missing");
  const bad = setValue(valueFixture(), "valueMarket", (v) => {
    const m = valueMarketSchema.parse(v);
    m.history.rows.at(-1)!.pe = 5;
    return m;
  });
  expect(one("FA05", bad).status).toBe("missing");
});
it("FA weighted valuation preserves all weights and six dimensions; unexplained danger vetoes before valuation", () => {
  const r = one("FA09");
  const models = r.details.models as number[];
  expect(r.details.fair).toBeCloseTo(
    models.reduce((s, v, i) => s + v * [0.3, 0.25, 0.15, 0.2, 0.1][i]!, 0),
  );
  expect(
    one(
      "FA09",
      valueFixture().filter((r) => r.field !== "annualFcff"),
    ).status,
  ).toBe("missing");
  expect(one("FA08").details.dimensions).toHaveLength(6);
  const bad = setValue(valueFixture(), "valueRisk", (v) => {
    const r = valueRiskSchema.parse(v);
    r.flags.accountingChange!.hit = true;
    return r;
  });
  for (const id of ["FA08", "FA09"])
    expect(one(id, bad)).toMatchObject({
      status: "computed",
      passed: false,
      details: { veto: true },
    });
});
it.each([
  [-1, 1],
  [0, 2],
  [10, 3],
  [20, 4],
  [21, 5],
])("Guo OCF %s yields independently calculated state %s", (ocf, state) => {
  const rows = setValue(valueFixture(), "annualGuo", (v) => ({
    ...valueGuoSchema.parse(v),
    ocf,
  }));
  const r = one("GY03", rows);
  expect(r.details.state).toBe(state);
  expect(r.passed).toBe(state === 5);
});
it("Guo maintenance FCF excludes expansion capex and reconstructs debt/equity without WACC", () => {
  expect(one("GY04").details).toMatchObject({
    maintenance: 20,
    fcf: 180,
    fullCapexFcf: 130,
  });
  const r = one("GY02");
  const rec = (r.details.reconstruction as Record<string, number>[])[0]!;
  expect(rec.financial).toBe(730);
  expect(rec.working).toBe(30);
  expect(rec.longFinancing).toBe(700);
  expect(rec.equityAdded).toBe(86);
  expect(rec.roe).toBeCloseTo(150 / 800);
  const gy = one("GY05");
  expect(gy.details.model).toBe("historical-guo-equity-frozen");
  expect(
    (gy.details.valuation as { input: { discountRate: number } }).input
      .discountRate,
  ).toBe(0.08);
});
it("Guo risk veto has five-year coverage, unexplained flags and cash/profit divergence", () => {
  const bad = setValue(valueFixture(), "valueRisk", (v) => {
    const r = valueRiskSchema.parse(v);
    r.flags.relatedParty!.hit = true;
    return r;
  });
  expect(one("GY01", bad).passed).toBe(false);
  expect(one("GY05", bad).passed).toBe(false);
  expect(
    one(
      "GY01",
      setValue(bad, "valueRisk", (v) => {
        const r = valueRiskSchema.parse(v);
        r.flags.relatedParty!.explanation = "frozen auditable explanation";
        return r;
      }),
    ).passed,
  ).toBe(true);
  expect(
    one(
      "GY01",
      setValue(valueFixture(), "annualGuo", (v) => ({
        ...valueGuoSchema.parse(v),
        ocf: 1,
      })),
    ).passed,
  ).toBe(false);
  expect(
    one("GY01", valueFixture(), {
      ...valueRequest,
      annualPeriods: valueRequest.annualPeriods.slice(0, 4),
    }).status,
  ).toBe("missing");
});
it.each(["bank", "research", "long-asset", "cycle", "growth", "property"])(
  "Guo %s retains its independent formula, branch admission and data gaps",
  (branch) => {
    const id = `GY06-${branch}`,
      r = one(id);
    expect(r.details.branch).toBe(branch);
    expect(
      one(
        id,
        setValue(valueFixture(id), "valuePolicy", (v) => ({
          ...valuePolicySchema.parse(v),
          industry: "general",
          cycle: false,
        })),
      ).status,
    ).toBe("missing");
    if (branch === "bank")
      expect(r.details.fair).toBeCloseTo(
        (200 + 10 - 20 - 10 - 5 - 20 - 15) / 100 / 0.08,
      );
    if (branch === "research") expect(r.details.baseFcf).toBe(185);
    if (branch === "long-asset") expect(r.details.baseFcf).toBe(195);
    if (branch === "cycle") expect(r.details.baseFcf).toBe(160);
    if (branch === "growth") expect(r.details.baseFcf).toBe(192);
    if (branch === "property") expect(r.details.fair).toBe(37);
  },
);
it("long-life maintenance cannot substitute depreciation, cyclic research adds the sixth prior R&D year, and minority gaps remain", () => {
  const long = setValue(valueFixture("GY06-long-asset"), "annualGuo", (v) => ({
    ...valueGuoSchema.parse(v),
    maintenanceActual: null,
  }));
  expect(one("GY06-long-asset", long).status).toBe("missing");
  const cyclic = setValue(
    valueFixture("GY06-research"),
    "valuePolicy",
    (v) => ({ ...valuePolicySchema.parse(v), cycle: true }),
  );
  expect(one("GY06-research", cyclic).details.baseFcf).toBe(165);
  expect(
    one("GY06-research", cyclic, {
      ...valueRequest,
      annualPeriods: valueRequest.annualPeriods.slice(0, 5),
    }).status,
  ).toBe("missing");
  expect(
    one(
      "GY05",
      setValue(valueFixture(), "valuePolicy", (v) => ({
        ...valuePolicySchema.parse(v),
        minorityComparable: false,
      })),
    ).status,
  ).toBe("missing");
});
it.each(Object.keys(valueThesisMetrics))(
  "%s has method-specific frozen triggers, independent invalidation and no lookback impersonation",
  (id) => {
    const rows = valueFixture(id);
    const mutate = (fn: (t: z.infer<typeof valueThesisSchema>) => void) =>
      setValue(rows, "valueTheses", (v) => {
        const ts = z.array(valueThesisSchema).parse(v);
        fn(ts.find((t) => t.methodId === id)!);
        return ts;
      });
    expect(
      one(
        id,
        mutate((t) => {
          t.recordedAt = "2025-01-01T00:00:00Z";
        }),
      ).status,
    ).toBe("missing");
    expect(
      one(
        id,
        mutate((t) => {
          t.mode = "retrospective-roleplay" as never;
        }),
      ).status,
    ).toBe("missing");
    expect(
      one(
        id,
        mutate((t) => {
          t.triggers = [];
        }),
      ).status,
    ).toBe("missing");
    const damaged = setValue(rows, "valueThesisObservations", (v) => {
      const obs = z.record(z.string(), valueThesisObservationSchema).parse(v);
      obs[id]!.metrics.permanentDamage = 1;
      return obs;
    });
    expect(one(id, damaged)).toMatchObject({
      passed: false,
      details: { action: "exit", invalid: true, targetPositionPct: 0 },
    });
    const weak = setValue(rows, "valueThesisObservations", (v) => {
      const obs = z.record(z.string(), valueThesisObservationSchema).parse(v);
      for (const k of valueThesisMetrics[id]!)
        obs[id]!.metrics[k as keyof (typeof obs)[string]["metrics"]] = -1;
      return obs;
    });
    if (id !== "VI05") expect(one(id, weak).passed).toBe(false);
  },
);
it("VI human/LLM/rule counts and ranks are isolated, LLM needs model/prompt/archive versions", () => {
  const human = setValue(valueFixture("VI01"), "valueTheses", (v) =>
    z
      .array(valueThesisSchema)
      .parse(v)
      .map((t) => ({ ...t, origin: "human" })),
  );
  expect(evaluateGrowthFactors(valueRequest, human, ["VI01"]).counts).toEqual({
    rule: 0,
    human: 1,
    llm: 0,
  });
  const llm = setValue(human, "valueTheses", (v) =>
    z
      .array(valueThesisSchema)
      .parse(v)
      .map((t) => ({
        ...t,
        origin: "llm",
        modelVersion: "archived-model-1",
        promptHash: "archived-prompt-1",
      })),
  );
  expect(evaluateGrowthFactors(valueRequest, llm, ["VI01"]).counts).toEqual({
    rule: 0,
    human: 0,
    llm: 1,
  });
  expect(
    one(
      "VI01",
      setValue(llm, "valueTheses", (v) =>
        z
          .array(valueThesisSchema)
          .parse(v)
          .map((t) => ({ ...t, promptHash: null })),
      ),
    ).status,
  ).toBe("missing");
  expect(rankGrowthFactors([valueRequest], llm, "VI01")[0]).toMatchObject({
    participation: "llm",
    rank: 1,
  });
});
it("VI wait and holding expiry use frozen deadlines; future revisions do not rewrite a past result", () => {
  const id = "VI07",
    rows = valueFixture(id);
  const clocked = setValue(rows, "valueTheses", (v) =>
    z
      .array(valueThesisSchema)
      .parse(v)
      .map((t) => ({
        ...t,
        start: "2024-04-01",
        frozenAt: "2024-03-31T15:00:00+08:00",
        recordedAt: "2024-03-31T14:00:00+08:00",
        evidenceCutoff: "2024-03-31T14:00:00+08:00",
        maxWaitDays: 29,
        maxHoldingDays: 30,
      })),
  ).map((r) =>
    r.field === "valueTheses"
      ? {
          ...r,
          availableAt: "2024-03-31T05:00:00Z",
          capturedAt: "2024-03-31T05:00:00Z",
        }
      : r,
  );
  expect(one(id, clocked)).toMatchObject({
    passed: false,
    details: { expired: true, action: "wait" },
  });
  const held = setValue(clocked, "valueThesisObservations", (v) => {
    const o = z.record(z.string(), valueThesisObservationSchema).parse(v);
    o[id]!.enteredAt = "2024-04-01";
    o[id]!.positionPct = 10;
    return o;
  });
  expect(one(id, held)).toMatchObject({
    passed: false,
    details: { holdExpired: true, action: "exit" },
  });
  const future = rows.map((r) => ({
    ...r,
    versionId: "future",
    availableAt: "2025-01-01T00:00:00Z",
    capturedAt: "2025-01-01T00:00:00Z",
    value: null,
  }));
  expect(
    evaluateGrowthFactors(valueRequest, [...future, ...rows], [id]),
  ).toEqual(evaluateGrowthFactors(valueRequest, rows, [id]));
});
it("VI observation participation cannot masquerade as pure rules, and missing thesis metrics are not zero", () => {
  const rows = valueFixture("VI01");
  const human = setValue(rows, "valueThesisObservations", (v) => {
    const o = z.record(z.string(), valueThesisObservationSchema).parse(v);
    o.VI01!.origin = "human";
    return o;
  });
  expect(evaluateGrowthFactors(valueRequest, human, ["VI01"]).counts).toEqual({
    rule: 0,
    human: 1,
    llm: 0,
  });
  expect(
    one(
      "VI01",
      human.map((r) =>
        r.field === "valueThesisObservations"
          ? { ...r, capturedAt: "2025-01-01T00:00:00Z" }
          : r,
      ),
    ).status,
  ).toBe("missing");
  const missing = setValue(rows, "valueThesisObservations", (v) => {
    const o = z.record(z.string(), valueThesisObservationSchema).parse(v);
    delete o.VI01!.metrics.moatRetention;
    return o;
  });
  expect(one("VI01", missing).status).toBe("missing");
  const wrong = setValue(
    valueFixture("VI03"),
    "valueThesisObservations",
    (v) => {
      const o = z.record(z.string(), valueThesisObservationSchema).parse(v);
      o.VI03!.metrics.marketRequiredGrowth = 3;
      return o;
    },
  );
  expect(one("VI03", wrong).passed).toBe(false);
  const damage = setValue(
    valueFixture("VI05"),
    "valueThesisObservations",
    (v) => {
      const o = z.record(z.string(), valueThesisObservationSchema).parse(v);
      o.VI05!.metrics.governanceDamage = 1;
      return o;
    },
  );
  expect(one("VI05", damage).details.action).toBe("exit");
});
it("value observation market panels cannot be known before the same-day close", () => {
  for (const id of ["FA03", "VI01"]) {
    const rows = valueFixture(id).map((r) =>
      ["valueMarket", "valueThesisObservations"].includes(r.field)
        ? { ...r, availableAt: "2024-05-01T06:59:59Z" }
        : r,
    );
    expect(one(id, rows).status).toBe("missing");
  }
});
it("Guo reconstruction must balance its asset and capital sides and never inserts a plug", () => {
  const rows = valueFixture();
  const balanced = one("GY02", rows).details.reconstruction as {
    assetTotal: number;
    capital: number;
  }[];
  expect(balanced.every((r) => Math.abs(r.assetTotal - r.capital) < 1e-8)).toBe(
    true,
  );
  const broken = setValue(
    rows,
    "annualGuo",
    (v) => {
      const r = valueGuoSchema.parse(v);
      r.financial.cash! += 1;
      return r;
    },
    "2023-12-31",
  );
  for (const id of ["GY02", "GY05", "GY06"]) {
    const r = one(id, broken);
    expect(r.status).toBe("missing");
    expect(r.dataGaps.some((g) => g.reason.includes("不配平"))).toBe(true);
  }
});
