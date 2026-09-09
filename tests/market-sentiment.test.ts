import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  marketSentiment,
  marketSentimentEvidence,
  type MarketSentimentInput,
} from "~/server/market-sentiment";

function fixture(): MarketSentimentInput {
  const provenance = (id: string, asOf = "2026-09-08") => ({
    evidenceId: id,
    payloadHash: createHash("sha256").update(id).digest("hex"),
    source: "test-fixture",
    asOf,
    fetchedAt: Date.parse("2026-09-09T10:00:00+08:00"),
  });
  return {
    cutoff: "2026-09-08",
    observedAt: Date.parse("2026-09-09T11:00:00+08:00"),
    maxAgeDays: 1,
    activity: {
      provenance: provenance("activity"),
      universe: "legu-all-a",
      up: 3000,
      down: 2000,
      realLimitUp: 30,
      realLimitDown: 10,
      limitDefinition: "exclude-st-one-price-no-volume",
    },
    strength: {
      provenance: provenance("strength", "2026-09-07"),
      universe: "legu-all-a",
      window: 20,
      newHigh: 200,
      newLow: 300,
    },
    valuation: {
      provenance: provenance("valuation"),
      universe: "legu-all-a",
      metric: "pe-ttm-median",
      lookbackYears: 10,
      percentile: 80,
    },
    leverage: {
      provenance: provenance("leverage"),
      universe: "sse-szse-financing",
      currency: "CNY",
      unit: "yuan",
      observations: 60,
      balance: 925_000_000_000,
      peakIncludingCurrent: 1_000_000_000_000,
    },
  };
}

it("reproduces five-factor formula without rounding source precision or mixing score scales", () => {
  const result = marketSentiment(fixture());
  // 60*.25 + 75*.20 + 40*.25 + 80*.15 + 50*.15 = 59.5.
  expect(result.score).toBeCloseTo(59.5, 12);
  expect(result.label).toBe("偏热");
  expect(result.used).toBe(5);
  expect(result.citations).toEqual([
    "activity",
    "strength",
    "valuation",
    "leverage",
  ]);
  expect(result.factors.map((f) => f.effectiveWeight)).toEqual([
    0.25, 0.2, 0.25, 0.15, 0.15,
  ]);
  expect(result.factors[2]!.source!.asOf).toBe("2026-09-07");
});

it("removes missing factors and renormalizes; never inserts a neutral score", () => {
  const input = fixture();
  input.valuation = input.leverage = null;
  const result = marketSentiment(input);
  expect(result.score).toBeCloseTo(40 / 0.7, 12);
  expect(result.used).toBe(3);
  expect(result.coverage).toBe("partial");
  expect(result.factors.map((f) => f.effectiveWeight)).toEqual([
    25 / 70,
    20 / 70,
    25 / 70,
    0,
    0,
  ]);
  expect(result.missing.map((m) => m.factor)).toEqual([
    "valuation",
    "leverage",
  ]);
  expect(result.score).not.toBe(55); // A neutral fill would produce 55.
});

it("zero numerator is valid; zero denominator is unavailable and is not infinity", () => {
  const input = fixture();
  input.activity!.up =
    input.activity!.realLimitUp =
    input.strength!.newHigh =
      0;
  let result = marketSentiment(input);
  expect(result.used).toBe(5);
  expect(result.factors.slice(0, 3).map((f) => f.value)).toEqual([0, 0, 0]);
  input.activity!.down =
    input.activity!.realLimitDown =
    input.strength!.newLow =
      0;
  result = marketSentiment(input);
  expect(result.used).toBe(2);
  expect(result.score).toBeCloseTo(65);
  expect(result.missing.every((m) => m.reason.includes("分母为零"))).toBe(true);
});

it("no evidence yields unavailable rather than zero, and no citations", () => {
  const result = marketSentiment({
    ...fixture(),
    activity: null,
    strength: null,
    valuation: null,
    leverage: null,
  });
  expect(result.score).toBeNull();
  expect(result.label).toBeNull();
  expect(result.coverage).toBe("unavailable");
  expect(result.citations).toEqual([]);
  expect(result.missing).toHaveLength(5);
});

it("excludes future and stale source dates with distinct reasons; age boundary is inclusive", () => {
  const input = fixture();
  input.activity!.provenance.asOf = "2026-09-09";
  input.valuation!.provenance.asOf = "2026-09-06";
  const result = marketSentiment(input);
  expect(result.used).toBe(2); // strength is exactly one calendar day old.
  expect(result.missing[0]!.reason).toContain("晚于研究截止日");
  expect(result.missing[2]!.reason).toContain("日历天数");
  expect(result.citations).toEqual(["strength", "leverage"]);
  input.maxAgeDays = 0;
  expect(marketSentiment(input).used).toBe(1);
});

it("rejects observation chronology and distinguishes source as-of from fetch time", () => {
  const input = fixture();
  input.leverage!.provenance.fetchedAt = input.observedAt + 1;
  expect(marketSentiment(input).missing[0]!.reason).toContain("采集时间晚于");
  input.activity!.provenance.fetchedAt = Date.parse(
    "2026-09-07T23:59:59+08:00",
  );
  expect(marketSentiment(input).missing[0]!.reason).toContain(
    "源日期晚于证据采集日",
  );
  input.cutoff = "2026-09-10";
  expect(() => marketSentiment(input)).toThrow("截止日不能晚于");
});

it("validates calendar dates, units, universe, finite counts and the actual 60-observation peak", () => {
  for (const mutate of [
    (v: any) => {
      v.activity.up = -1;
    },
    (v: any) => {
      v.activity.down = 1.5;
    },
    (v: any) => {
      v.activity.realLimitUp = NaN;
    },
    (v: any) => {
      v.activity.limitDefinition = "all-limit-ups";
    },
    (v: any) => {
      v.strength.universe = "hs300";
    },
    (v: any) => {
      v.strength.window = 60;
    },
    (v: any) => {
      v.valuation.lookbackYears = 5;
    },
    (v: any) => {
      v.valuation.percentile = 101;
    },
    (v: any) => {
      v.leverage.balance = Infinity;
    },
    (v: any) => {
      v.leverage.unit = "亿元";
    },
    (v: any) => {
      v.leverage.observations = 59;
    },
    (v: any) => {
      v.leverage.balance = v.leverage.peakIncludingCurrent + 1;
    },
    (v: any) => {
      v.activity.provenance.asOf = "2026-02-30";
    },
    (v: any) => {
      v.activity.provenance.payloadHash = "unchecked";
    },
    (v: any) => {
      v.cryptoFearGreed = 90;
    },
  ]) {
    const input = fixture();
    mutate(input);
    expect(() => marketSentiment(input)).toThrow();
  }
});

it("clamps leverage and uses explicit half-open proxy labels at boundaries", () => {
  const input = {
    ...fixture(),
    activity: null,
    strength: null,
    valuation: null,
  };
  input.leverage!.balance = 0;
  expect(marketSentiment(input).score).toBe(0);
  input.leverage!.balance = input.leverage!.peakIncludingCurrent;
  expect(marketSentiment(input).score).toBe(100);
  for (const [score, expected] of [
    [20, "恐惧"],
    [40, "偏冷"],
    [45, "中性"],
    [55, "偏热"],
    [65, "贪婪"],
    [75, "极度贪婪"],
    [85, "狂热"],
  ] as const) {
    const v = fixture();
    v.activity = v.strength = v.leverage = null;
    v.valuation!.percentile = score;
    expect(marketSentiment(v).label).toBe(expected);
  }
});

it("rejects unsafe count sums, out-of-range timestamps and conflicting citation identities", () => {
  const input = fixture();
  input.activity!.up = Number.MAX_SAFE_INTEGER;
  expect(() => marketSentiment(input)).toThrow("安全整数");
  input.activity!.up = 3000;
  input.observedAt = Number.MAX_SAFE_INTEGER;
  expect(() => marketSentiment(input)).toThrow();
  input.observedAt = fixture().observedAt;
  input.strength!.provenance.evidenceId = "activity";
  expect(() => marketSentiment(input)).toThrow("同一证据ID");
});

it("evidence is reproducible, retains raw normalized inputs, and never disguises mixed dates", () => {
  const input = fixture(),
    evidence = marketSentimentEvidence(input);
  expect(evidence).toEqual(marketSentimentEvidence(input));
  expect(evidence.envelope!.asOf).toBeNull();
  expect(evidence.envelope!.publishedAt).toBeNull();
  expect(evidence.envelope!.quality).toBe("partial");
  const payload = JSON.parse(evidence.text);
  expect(payload.input).toEqual(input);
  expect(payload.facts).toEqual(marketSentiment(input));
  expect(evidence.envelope!.payloadHash).toBe(
    createHash("sha256").update(evidence.text).digest("hex"),
  );
  input.activity!.up++;
  expect(marketSentimentEvidence(input).id).not.toBe(evidence.id);
  input.strength!.provenance.asOf = "2026-09-08";
  expect(marketSentimentEvidence(input).envelope!.asOf).toBe("2026-09-08");
});
