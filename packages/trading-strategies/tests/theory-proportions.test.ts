import { describe, expect, it } from "vitest";
import { confirmationEpoch } from "../src/theory-confirmation";
import {
  fibTargets,
  harmonicPatterns,
  type HarmonicPoint,
  type ProportionAnchor,
} from "../src/theory-proportions";

const asOf = Date.UTC(2026, 10, 17, 8);
const at = (day: number) => Date.UTC(2026, 10, day, 8);

const anchor = (
  price: number,
  formedDay: number,
  confirmedDay = formedDay,
): ProportionAnchor => ({
  price,
  formedAt: at(formedDay),
  confirmedAt: at(confirmedDay),
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const fibBase = {
  a: anchor(100, 1, 2),
  b: anchor(120, 2, 3),
  c: anchor(110, 3, 4),
} as const;

describe("F06.05 fibTargets", () => {
  it("computes 132.36 for a two-point extension and 142.36 for a three-point projection", () => {
    const extension = fibTargets({
      mode: "EXTENSION",
      ratios: [1.618],
      anchors: fibBase,
      asOf,
    });
    expect(extension.status).toBe("ACTIVE");
    expect(extension.parameterIdentity).toEqual({
      mode: "EXTENSION",
      ratios: [1.618],
    });
    expect(extension.targets).toHaveLength(1);
    expect(extension.targets[0]!.price).toBeCloseTo(132.36, 10);

    const projection = fibTargets({
      mode: "PROJECTION",
      ratios: [1.618],
      anchors: fibBase,
      asOf,
    });
    expect(projection.status).toBe("ACTIVE");
    expect(projection.targets[0]!.price).toBeCloseTo(142.36, 10);
    expect(projection.projectionC).toBe(110);
  });

  it("requires the later C only for PROJECTION and freezes ratio thresholds", () => {
    const noC = { a: fibBase.a, b: fibBase.b };
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [1.618], anchors: noC, asOf })
        .status,
    ).toBe("ACTIVE");
    expect(
      fibTargets({ mode: "PROJECTION", ratios: [1.618], anchors: noC, asOf })
        .status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [1], anchors: noC, asOf }).status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({ mode: "PROJECTION", ratios: [0], anchors: noC, asOf })
        .status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({ mode: "PROJECTION", ratios: [1], anchors: fibBase, asOf })
        .status,
    ).toBe("ACTIVE");
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [], anchors: noC, asOf }).status,
    ).toBe("UNKNOWN");
  });

  it("uses formedAt order and requires formedAt <= confirmedAt <= asOf", () => {
    const swapped = { a: anchor(100, 2, 3), b: anchor(120, 1, 2) };
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [1.618], anchors: swapped, asOf })
        .status,
    ).toBe("UNKNOWN");

    const earlyC = { ...fibBase, c: anchor(110, 1, 2) };
    expect(
      fibTargets({
        mode: "PROJECTION",
        ratios: [1.618],
        anchors: earlyC,
        asOf,
      }).status,
    ).toBe("UNKNOWN");

    const future = { a: fibBase.a, b: anchor(120, 2, 18) };
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [1.618], anchors: future, asOf })
        .status,
    ).toBe("UNKNOWN");

    const inverted = { a: anchor(100, 3, 2), b: fibBase.b };
    expect(
      fibTargets({
        mode: "EXTENSION",
        ratios: [1.618],
        anchors: inverted,
        asOf,
      }).status,
    ).toBe("UNKNOWN");

    // Formation order is what matters; a later-formed B may confirm first.
    const nonMonotonicConfirmation = {
      a: anchor(100, 1, 5),
      b: anchor(120, 2, 3),
    };
    expect(
      fibTargets({
        mode: "EXTENSION",
        ratios: [1.618],
        anchors: nonMonotonicConfirmation,
        asOf,
      }).status,
    ).toBe("ACTIVE");

    const badIso = {
      a: { ...fibBase.a, confirmedAt: "2026-11-02" },
      b: fibBase.b,
    };
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [1.618], anchors: badIso, asOf })
        .status,
    ).toBe("UNKNOWN");
  });

  it("returns every target and emits long-only TARGET_REACHED/REDUCE references", () => {
    const input = {
      mode: "EXTENSION" as const,
      ratios: [1.1, 1.618, 2],
      anchors: { a: fibBase.a, b: fibBase.b },
      asOf,
      completedClose: 133,
      heldLong: true,
    };
    const result = fibTargets(input);
    expect(result.status).toBe("ACTIVE");
    expect(result.targets.map((level) => level.ratio)).toEqual([1.1, 1.618, 2]);
    expect(result.targets.map((level) => level.reached)).toEqual([
      true,
      true,
      false,
    ]);
    expect(result.targets[0]!.price).toBeCloseTo(122, 10);
    expect(result.targets[1]!.price).toBeCloseTo(132.36, 10);
    expect(result.targets[2]!.price).toBeCloseTo(140, 10);
    expect(result.targets[0]!.references).toEqual(["TARGET_REACHED", "REDUCE"]);
    expect(result.targets[2]!.references).toEqual([]);
    expect(result).not.toHaveProperty("orderSize");
    expect(result).not.toHaveProperty("newEntry");

    const flat = fibTargets({ ...input, heldLong: false });
    expect(flat.targets[0]!.reached).toBe(true);
    expect(flat.targets[0]!.references).toEqual([]);
  });

  it("invalidates a projection only below C and leaves EXTENSION without a C rule", () => {
    const projection = fibTargets({
      mode: "PROJECTION",
      ratios: [1.618],
      anchors: fibBase,
      asOf,
      completedClose: 109.99,
    });
    expect(projection.status).toBe("INVALIDATED");
    expect(projection.targets).toHaveLength(1);
    expect(projection.targets[0]!.price).toBeCloseTo(142.36, 10);

    const atC = fibTargets({
      mode: "PROJECTION",
      ratios: [1.618],
      anchors: fibBase,
      asOf,
      completedClose: 110,
    });
    expect(atC.status).toBe("ACTIVE");

    const extension = fibTargets({
      mode: "EXTENSION",
      ratios: [1.618],
      anchors: fibBase,
      asOf,
      completedClose: 50,
    });
    expect(extension.status).toBe("ACTIVE");
    expect(extension.targets[0]!.price).toBeCloseTo(132.36, 10);
  });

  it("gives an explicit protective exit priority while preserving computable targets", () => {
    const protectedProjection = fibTargets({
      mode: "PROJECTION",
      ratios: [1.618, 2],
      anchors: fibBase,
      asOf,
      completedClose: 200,
      heldLong: true,
      protectiveExit: true,
    });
    expect(protectedProjection.status).toBe("PROTECTIVE_EXIT");
    expect(protectedProjection.targets.map((level) => level.ratio)).toEqual([
      1.618, 2,
    ]);
    expect(
      protectedProjection.targets.every(
        (level) => level.references.length === 0,
      ),
    ).toBe(true);
    expect(protectedProjection.projectionC).toBe(110);

    const missing = fibTargets({
      mode: "PROJECTION",
      ratios: [1.618],
      anchors: { a: fibBase.a, b: fibBase.b },
      asOf,
      protectiveExit: true,
    });
    expect(missing.status).toBe("PROTECTIVE_EXIT");
    expect(missing.targets).toEqual([]);
    expect(missing.parameterIdentity).toEqual({
      mode: "PROJECTION",
      ratios: [1.618],
    });
  });

  it("freezes parameter identity, rejects non-finite inputs and never mutates inputs", () => {
    const frozen = deepFreeze({
      mode: "EXTENSION" as const,
      ratios: [1.1, 1.618],
      anchors: { a: fibBase.a, b: fibBase.b },
      asOf,
    });
    const before = structuredClone(frozen);
    fibTargets(frozen);
    expect(frozen).toEqual(before);

    const mutableRatios = [1.1, 1.618];
    const result = fibTargets({
      mode: "EXTENSION",
      ratios: mutableRatios,
      anchors: { a: fibBase.a, b: fibBase.b },
      asOf,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.parameterIdentity!.ratios)).toBe(true);
    mutableRatios.push(2);
    expect(result.parameterIdentity!.ratios).toEqual([1.1, 1.618]);

    const valid = { a: fibBase.a, b: fibBase.b };
    expect(
      fibTargets({
        mode: "EXTENSION",
        ratios: [Infinity],
        anchors: valid,
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({ mode: "EXTENSION", ratios: [NaN], anchors: valid, asOf })
        .status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({
        mode: "EXTENSION",
        ratios: [1.618],
        anchors: { a: { ...fibBase.a, price: NaN }, b: fibBase.b },
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(
      fibTargets({
        mode: "EXTENSION",
        ratios: [Number.MAX_VALUE],
        anchors: valid,
        asOf,
      }).status,
    ).toBe("UNKNOWN");
  });
});

const hp = (
  kind: HarmonicPoint["kind"],
  price: number,
  formedDay: number,
  confirmedDay = formedDay + 1,
): HarmonicPoint => ({
  kind,
  price,
  formedAt: at(formedDay),
  confirmedAt: at(confirmedDay),
});

const bullish = (
  x: number,
  a: number,
  b: number,
  c: number,
  d: number,
): HarmonicPoint[] => [
  hp("low", x, 1),
  hp("high", a, 2),
  hp("low", b, 3),
  hp("high", c, 4),
  hp("low", d, 5),
];

const bearish = (
  x: number,
  a: number,
  b: number,
  c: number,
  d: number,
): HarmonicPoint[] =>
  bullish(x, a, b, c, d).map((point) => ({
    ...point,
    kind: point.kind === "high" ? "low" : "high",
    price: 300 - point.price,
  }));

const patternCases = [
  {
    pattern: "GARTLEY",
    prices: [100, 200, 135.2, 186.2, 121.4],
    tolerance: 0.031,
  },
  { pattern: "BAT", prices: [100, 200, 140, 170, 110], tolerance: 0.02 },
  {
    pattern: "BUTTERFLY",
    prices: [100, 200, 121.4, 182.822, 83],
    tolerance: 0.101,
  },
  { pattern: "CRAB", prices: [100, 200, 150, 192.7, 38.2], tolerance: 0.001 },
] as const;

describe("F06.08 harmonicPatterns", () => {
  it("matches all four v2 tables with mirrored bullish/bearish swing order", () => {
    for (const fixture of patternCases) {
      const [x, a, b, c, d] = fixture.prices;
      for (const [side, points] of [
        ["bullish", bullish(x, a, b, c, d)],
        ["bearish", bearish(x, a, b, c, d)],
      ] as const) {
        const result = harmonicPatterns({
          points,
          tolerance: fixture.tolerance,
          asOf,
        });
        expect(result.status, `${fixture.pattern} ${side}`).toBe("MATCH");
        expect(result.patterns, `${fixture.pattern} ${side}`).toEqual([
          fixture.pattern,
        ]);
        expect(result.side, `${fixture.pattern} ${side}`).toBe(side);
        expect(result.reference).toBe("NO_DIRECT_TRADE");
      }
    }
  });

  it("reports the frozen v2 ratios and D availability", () => {
    const result = harmonicPatterns({
      points: bullish(100, 200, 135.2, 186.2, 121.4),
      tolerance: 0.031,
      asOf,
    });
    expect(result.ratios!.b).toBeCloseTo(0.648, 10);
    expect(result.ratios!.d).toBeCloseTo(0.786, 10);
    expect(result.ratios!.a).toBeCloseTo(1, 10);
    expect(result.ratios!.c).toBeCloseTo(1.2705882352941176, 10);
    expect(result.dConfirmedAt).toBe(confirmationEpoch(at(6)));
    expect(result.availableAt).toBe(confirmationEpoch(at(6)));
    expect(result.parameterIdentity).toEqual({ tolerance: 0.031 });
    expect(Object.isFrozen(result.ratios)).toBe(true);
  });

  it("fixtures satisfy every joint ratio and geometry condition of their label", () => {
    const cases = [
      {
        label: "GARTLEY",
        points: bullish(100, 200, 135.2, 186.2, 121.4),
        tolerance: 0.031,
        checks: (b: number, d: number, c: number, a: number) =>
          Math.abs(b - 0.618) <= 0.031 &&
          Math.abs(d - 0.786) <= 0.031 &&
          Math.abs(a - 1) <= 0.031 &&
          (Math.abs(c - 1.27) <= 0.031 || Math.abs(c - 1.618) <= 0.031),
      },
      {
        label: "BAT",
        points: bullish(100, 200, 140, 170, 110),
        tolerance: 0.02,
        checks: (b: number, d: number, c: number, a: number) =>
          b < 0.618 &&
          Math.abs(d - 0.886) <= 0.02 &&
          c >= 1.618 - 0.02 &&
          c <= 2.618 + 0.02 &&
          a >= 1,
      },
      {
        label: "BUTTERFLY",
        points: bullish(100, 200, 121.4, 182.822, 83),
        tolerance: 0.101,
        checks: (b: number, d: number, c: number, a: number) =>
          Math.abs(b - 0.786) <= 0.101 &&
          Math.abs(d - 1.27) <= 0.101 &&
          a >= 1 - 0.101 &&
          a <= 1.27 + 0.101 &&
          Math.abs(c - 1.618) <= 0.101,
      },
      {
        label: "CRAB",
        points: bullish(100, 200, 150, 192.7, 38.2),
        tolerance: 0.001,
        checks: (b: number, d: number, c: number, a: number) =>
          b >= 0.382 - 0.001 &&
          b <= 0.618 + 0.001 &&
          Math.abs(d - 1.618) <= 0.001 &&
          (Math.abs(c - 2.618) <= 0.001 ||
            Math.abs(c - 3.14) <= 0.001 ||
            Math.abs(c - 3.618) <= 0.001) &&
          a >= 1,
      },
    ];
    for (const fixture of cases) {
      const result = harmonicPatterns({
        points: fixture.points,
        tolerance: fixture.tolerance,
        asOf,
      });
      expect(result.status).toBe("MATCH");
      expect(result.patterns).toEqual([fixture.label]);
      expect(
        fixture.checks(
          result.ratios!.b,
          result.ratios!.d,
          result.ratios!.c,
          result.ratios!.a,
        ),
      ).toBe(true);
    }
  });

  it("keeps every matching label and marks ambiguous matches", () => {
    const gartleyBat = harmonicPatterns({
      points: bullish(100, 200, 139, 177.4, 116.4),
      tolerance: 0.1,
      asOf,
    });
    expect(gartleyBat.status).toBe("AMBIGUOUS");
    expect(gartleyBat.patterns).toEqual(["GARTLEY", "BAT"]);
    expect(gartleyBat.ambiguous).toBe(true);
    expect(gartleyBat.abEqualsCd).toBe(true);

    const butterflyCrab = harmonicPatterns({
      points: bullish(100, 200, 130, 193.63, 60),
      tolerance: 0.7,
      asOf,
    });
    expect(butterflyCrab.status).toBe("AMBIGUOUS");
    expect(butterflyCrab.patterns).toEqual(["BUTTERFLY", "CRAB"]);
    expect(butterflyCrab.abEqualsCd).toBe(false);
  });

  it("reports AB_EQ_CD separately and never lets it bypass the four tables", () => {
    const only = harmonicPatterns({
      points: bullish(100, 200, 110, 190, 100),
      tolerance: 0.01,
      asOf,
    });
    expect(only.status).toBe("NO_PATTERN");
    expect(only.patterns).toEqual([]);
    expect(only.abEqualsCd).toBe(true);
    expect(only.ambiguous).toBe(false);
  });

  it("keeps AB_EQ_CD independent of four-family C/D geometry", () => {
    const prices = [100, 150, 120, 160, 130] as const;
    for (const [side, points] of [
      ["bullish", bullish(...prices)],
      ["bearish", bearish(...prices)],
    ] as const) {
      const result = harmonicPatterns({
        points,
        tolerance: 0.01,
        asOf,
      });
      expect(result.status, side).toBe("NO_PATTERN");
      expect(result.patterns, side).toEqual([]);
      expect(result.abEqualsCd, side).toBe(true);
      expect(result.ambiguous, side).toBe(false);
      expect(result.side, side).toBe(side);
      expect(result.ratios!.a).toBeCloseTo(1, 10);
      expect(result.ratios!.b).toBeCloseTo(0.6, 10);
      expect(result.ratios!.d).toBeCloseTo(0.4, 10);
      expect(result.ratios!.c).toBeCloseTo(0.75, 10);
      expect(result.dConfirmedAt).toBe(confirmationEpoch(at(6)));
      expect(result.availableAt).toBe(confirmationEpoch(at(6)));
      expect(result.reference).toBe("NO_DIRECT_TRADE");
    }
  });

  it("requires alternating prices for AB_EQ_CD even when a is about 1", () => {
    const prices = [100, 150, 160, 140, 130] as const;
    for (const points of [bullish(...prices), bearish(...prices)]) {
      const result = harmonicPatterns({ points, tolerance: 0.01, asOf });
      expect(result.status).toBe("NO_PATTERN");
      expect(result.patterns).toEqual([]);
      expect(result.abEqualsCd).toBe(false);
      expect(result.ratios!.a).toBeCloseTo(1, 10);
      expect(result.reference).toBe("NO_DIRECT_TRADE");
    }
  });

  it("enforces literal a>=1 for Bat and Crab instead of relaxing it by tolerance", () => {
    const batBelowOne = harmonicPatterns({
      points: bullish(100, 200, 140, 169.4, 110),
      tolerance: 0.02,
      asOf,
    });
    expect(batBelowOne.ratios!.a).toBeCloseTo(0.99, 10);
    expect(batBelowOne.ratios!.b).toBeLessThan(0.618);
    expect(Math.abs(batBelowOne.ratios!.d - 0.886)).toBeLessThanOrEqual(0.02);
    expect(batBelowOne.ratios!.c).toBeGreaterThanOrEqual(1.618);
    expect(batBelowOne.ratios!.c).toBeLessThanOrEqual(2.618);
    expect(batBelowOne.patterns).not.toContain("BAT");
    expect(batBelowOne.status).toBe("NO_PATTERN");

    const crabBelowOne = harmonicPatterns({
      points: bullish(100, 200, 138.2, 157.682, 96.5),
      tolerance: 0.59,
      asOf,
    });
    expect(crabBelowOne.ratios!.a).toBeCloseTo(0.99, 10);
    expect(crabBelowOne.ratios!.b).toBeCloseTo(0.618, 10);
    expect(crabBelowOne.ratios!.d).toBeCloseTo(1.035, 10);
    expect(crabBelowOne.ratios!.c).toBeCloseTo(3.14, 3);
    expect(crabBelowOne.patterns).not.toContain("CRAB");
    expect(crabBelowOne.status).toBe("NO_PATTERN");
  });

  it("rejects same-table labels when D is on the wrong side of X", () => {
    const crossed = harmonicPatterns({
      points: bullish(100, 200, 130, 193.63, 60),
      tolerance: 0.7,
      asOf,
    });
    expect(crossed.patterns).not.toContain("GARTLEY");
    expect(crossed.patterns).not.toContain("BAT");
  });

  it("returns UNKNOWN only for missing, future, invalid-time or zero-denominator evidence", () => {
    const points = bullish(100, 200, 135.2, 186.2, 121.4);
    expect(
      harmonicPatterns({ points: points.slice(0, 4), tolerance: 0.031, asOf })
        .status,
    ).toBe("UNKNOWN");
    expect(
      harmonicPatterns({
        points: [...points, hp("high", 200, 6)],
        tolerance: 0.031,
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(harmonicPatterns({ points, tolerance: -0.001, asOf }).status).toBe(
      "UNKNOWN",
    );
    expect(harmonicPatterns({ points, tolerance: NaN, asOf }).status).toBe(
      "UNKNOWN",
    );
    expect(harmonicPatterns({ points, tolerance: Infinity, asOf }).status).toBe(
      "UNKNOWN",
    );

    const future = points.map((point, index) =>
      index === 4 ? { ...point, confirmedAt: at(18) } : point,
    );
    expect(
      harmonicPatterns({ points: future, tolerance: 0.031, asOf }).status,
    ).toBe("UNKNOWN");

    const badKind = points.map((point, index) =>
      index === 0 ? { ...point, kind: "close" as never } : point,
    );
    expect(
      harmonicPatterns({ points: badKind, tolerance: 0.031, asOf }).status,
    ).toBe("UNKNOWN");

    const zeroDenominator = [
      hp("low", 100, 1),
      hp("high", 100, 2),
      hp("low", 80, 3),
      hp("high", 120, 4),
      hp("low", 90, 5),
    ];
    const zero = harmonicPatterns({
      points: zeroDenominator,
      tolerance: 0.1,
      asOf,
    });
    expect(zero.status).toBe("UNKNOWN");
    expect(zero.ratios).toBeNull();
    expect(zero.side).toBe("bullish");
    expect(zero.dConfirmedAt).toBe(confirmationEpoch(at(6)));
    expect(zero.availableAt).toBe(confirmationEpoch(at(6)));
    expect(zero.reference).toBe("NO_DIRECT_TRADE");
  });

  it("returns NO_PATTERN for known completed geometry that fails P2 alternation", () => {
    const nonAlternatingKinds = [
      hp("low", 100, 1),
      hp("low", 200, 2),
      hp("low", 135.2, 3),
      hp("high", 186.2, 4),
      hp("low", 121.4, 5),
    ];
    const result = harmonicPatterns({
      points: nonAlternatingKinds,
      tolerance: 0.031,
      asOf,
    });
    expect(result.status).toBe("NO_PATTERN");
    expect(result.patterns).toEqual([]);
    expect(result.abEqualsCd).toBe(false);
    expect(result.ratios).not.toBeNull();
    expect(result.ratios!.a).toBeCloseTo(1, 10);
    expect(result.dConfirmedAt).toBe(confirmationEpoch(at(6)));
    expect(result.availableAt).toBe(confirmationEpoch(at(6)));
    expect(result.reference).toBe("NO_DIRECT_TRADE");
  });

  it("requires strict formedAt order, not sorted confirmation times", () => {
    const points = bullish(100, 200, 135.2, 186.2, 121.4);

    const swapped = [points[1]!, points[0]!, ...points.slice(2)];
    expect(
      harmonicPatterns({ points: swapped, tolerance: 0.031, asOf }).status,
    ).toBe("UNKNOWN");

    const sameFormed = points.map((point, index) =>
      index === 1 ? { ...point, formedAt: points[0]!.formedAt } : point,
    );
    expect(
      harmonicPatterns({ points: sameFormed, tolerance: 0.031, asOf }).status,
    ).toBe("UNKNOWN");

    const formedAfterConfirmed = points.map((point, index) =>
      index === 0 ? { ...point, formedAt: at(5), confirmedAt: at(4) } : point,
    );
    expect(
      harmonicPatterns({
        points: formedAfterConfirmed,
        tolerance: 0.031,
        asOf,
      }).status,
    ).toBe("UNKNOWN");

    const noTimezone = points.map((point, index) =>
      index === 0 ? { ...point, confirmedAt: "2026-11-02" } : point,
    );
    expect(
      harmonicPatterns({ points: noTimezone, tolerance: 0.031, asOf }).status,
    ).toBe("UNKNOWN");
  });

  it("is prefix-causal and reports D confirmedAt plus max confirmation availability", () => {
    const points = bullish(100, 200, 135.2, 186.2, 121.4).map((point, index) =>
      index === 1
        ? { ...point, confirmedAt: at(9) }
        : index === 4
          ? { ...point, confirmedAt: at(7) }
          : point,
    );
    expect(
      harmonicPatterns({ points, tolerance: 0.031, asOf: at(8) }).status,
    ).toBe("UNKNOWN");

    const ready = harmonicPatterns({
      points,
      tolerance: 0.031,
      asOf: at(9),
    });
    expect(ready.status).toBe("MATCH");
    expect(ready.side).toBe("bullish");
    expect(ready.dConfirmedAt).toBe(confirmationEpoch(at(7)));
    expect(ready.availableAt).toBe(confirmationEpoch(at(9)));
  });

  it("does not mutate deep-frozen inputs and freezes its output", () => {
    const input = deepFreeze({
      points: bullish(100, 200, 135.2, 186.2, 121.4),
      tolerance: 0.031,
      asOf,
    });
    const before = structuredClone(input);
    const result = harmonicPatterns(input);
    expect(input).toEqual(before);
    expect(result.status).toBe("MATCH");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.patterns)).toBe(true);
    expect(Object.isFrozen(result.parameterIdentity)).toBe(true);
  });
});
