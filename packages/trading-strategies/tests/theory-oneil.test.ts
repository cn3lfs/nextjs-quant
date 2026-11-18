import { describe, expect, it } from "vitest";
import {
  cupHandleParams,
  evaluateOneilAscendingBase,
  evaluateOneilBaseOnBase,
  evaluateOneilContractions,
  evaluateOneilCupHandle,
  evaluateOneilDoubleBottom,
  evaluateOneilFlatBase,
  evaluateOneilHighTightFlag,
  evaluateOneilMarketDirection,
  marketDirectionParams,
  type MarketDirectionBar,
} from "../src/theory-oneil.js";

const time = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1 + offset)).toISOString();
const day = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
const asOf = time(300);
const swing = (kind: "high" | "low", price: number, offset: number) => ({
  kind,
  price,
  confirmedAt: time(offset),
});
const breakout = (
  close: number,
  volume: number,
  prior: number | null,
  offset = 200,
) => ({ close, volume, priorAverageVolume: prior, at: time(offset) });

describe("F09.04 cup with handle", () => {
  const input = () => ({
    asOf,
    priorAdvanceStart: swing("low", 10, 1),
    leftHigh: swing("high", 20, 10),
    cupLow: swing("low", 16, 40),
    rightHigh: swing("high", 19.5, 80),
    weeks: 12,
    uShape: {
      bottomDwellWeeks: 4,
      leftWeeks: 5,
      rightWeeks: 3,
      singleBarRecovery: false,
    },
    handle: {
      high: swing("high", 19.2, 90),
      low: swing("low", 18.2, 100),
      pivot: swing("high", 19.1, 95),
      averageVolume: 500,
      priorAverageVolume: 1000,
    },
    breakout: breakout(19.5, 2000, 1000, 110),
  });

  it("accepts a rounded cup with a shrinking upper-half handle and registered breakout", () => {
    const result = evaluateOneilCupHandle(input());
    expect(result.status).toBe("known");
    expect(result.candidate).toMatchObject({
      branch: "cup-handle",
      pivot: 19.1,
      protection: 18.2,
      triggered: true,
      registerable: false,
      exitRule: null,
      capitalContract: null,
    });
    expect(result.candidate?.evidence.sourceThresholds).toMatchObject({
      minWeeks: 6,
      maxWeeks: 65,
    });
  });

  it("rejects a breakout that happened before handle confirmation", () => {
    const result = evaluateOneilCupHandle({
      ...input(),
      breakout: breakout(19.5, 2000, 1000, 95),
    });
    expect(result.reason).toBe("breakout-before-structure-confirmed");
  });

  it("treats an absent U-shape record as unknown and a malformed one as unknown", () => {
    expect(evaluateOneilCupHandle({ ...input(), uShape: null }).reason).toBe(
      "u-shape-evidence-missing",
    );
    expect(
      evaluateOneilCupHandle({
        ...input(),
        uShape: {
          bottomDwellWeeks: 0,
          leftWeeks: 5,
          rightWeeks: 3,
          singleBarRecovery: false,
        },
      }).reason,
    ).toBe("u-shape-evidence-invalid");
  });

  it("rejects a single-bar V recovery and shallow/wrong endpoint inputs", () => {
    expect(
      evaluateOneilCupHandle({
        ...input(),
        uShape: { ...input().uShape!, singleBarRecovery: true },
      }).reason,
    ).toBe("single-bar-recovery-not-cup");
    expect(
      evaluateOneilCupHandle({
        ...input(),
        cupLow: swing("low", 19.4, 40),
      }).reason,
    ).toBe("cup-depth-outside-8-50-percent");
    expect(
      evaluateOneilCupHandle({
        ...input(),
        priorAdvanceStart: swing("low", 18, 1),
      }).reason,
    ).toBe("prior-advance-below-30-percent");
    expect(() =>
      evaluateOneilCupHandle({
        ...input(),
        priorAdvanceStart: swing("high", 10, 1),
      }),
    ).toThrow(/low pivot/);
  });

  it("returns unknown, not a throw, for future or missing confirmations", () => {
    expect(
      evaluateOneilCupHandle({
        ...input(),
        rightHigh: swing("high", 19.5, 400),
      }).reason,
    ).toBe("rightHigh-not-confirmed-by-asOf");
    expect(
      evaluateOneilCupHandle({
        ...input(),
        leftHigh: undefined as never,
      }).reason,
    ).toBe("leftHigh-missing");
    expect(() =>
      evaluateOneilCupHandle({
        ...input(),
        leftHigh: { ...swing("high", Number.NaN, 10) },
      }),
    ).toThrow(/finite positive/);
  });

  it("cannot override source-fixed duration through A params", () => {
    expect(
      evaluateOneilCupHandle({ ...input(), weeks: 3 }, {
        ...cupHandleParams,
        minWeeks: 1,
      } as never).reason,
    ).toBe("cup-duration-outside-6-65-weeks");
  });

  it("labels a handle-less cup as an A no-handle branch with predefined protection", () => {
    const result = evaluateOneilCupHandle({
      ...input(),
      handle: null,
      breakout: breakout(20.5, 2000, 1000, 110),
    });
    expect(result.candidate).toMatchObject({
      branch: "no-handle-cup",
      pivot: 20,
      protection: 19,
    });
  });

  it("keeps prefix results stable and repeated evaluation pure", () => {
    const waiting = evaluateOneilCupHandle({ ...input(), breakout: null });
    expect(waiting.status).toBe("known");
    expect(waiting.candidate?.triggered).toBe(false);
    const triggered = evaluateOneilCupHandle(input());
    expect(triggered).toEqual(evaluateOneilCupHandle(input()));
  });
});

describe("F09.05 double bottom", () => {
  const input = () => ({
    asOf,
    leftHigh: swing("high", 20, 1),
    firstLow: swing("low", 16, 20),
    middlePeak: swing("high", 18, 40),
    secondLow: swing("low", 15.5, 60),
    weeks: 12,
    barsSinceSecondLow: 5,
    newLowAfterSecond: null,
    marketCondition: true,
    breakout: breakout(18.5, 2000, 1000, 80),
  });

  it("requires L2 strictly below L1 and uses M as the pivot", () => {
    const result = evaluateOneilDoubleBottom(input());
    expect(result.status).toBe("known");
    expect(result.candidate).toMatchObject({
      branch: "double-bottom",
      pivot: 18,
      triggered: true,
    });
  });

  it("rejects a breakout before L2 confirmation", () => {
    expect(
      evaluateOneilDoubleBottom({
        ...input(),
        breakout: breakout(18.5, 2000, 1000, 50),
      }).reason,
    ).toBe("breakout-before-structure-confirmed");
  });

  it("rejects equal or higher second lows and broken second lows", () => {
    expect(
      evaluateOneilDoubleBottom({
        ...input(),
        secondLow: swing("low", 16, 60),
      }).reason,
    ).toBe("strict-double-bottom-requires-L2-below-L1");
    expect(
      evaluateOneilDoubleBottom({
        ...input(),
        newLowAfterSecond: swing("low", 15, 70),
      }).reason,
    ).toBe("second-low-broken-before-breakout");
  });

  it("expires a stale candidate even when an untriggered breakout object is present", () => {
    expect(
      evaluateOneilDoubleBottom({ ...input(), barsSinceSecondLow: 30 }).reason,
    ).toBe("candidate-expired-before-breakout");
    expect(
      evaluateOneilDoubleBottom({
        ...input(),
        barsSinceSecondLow: 30,
        breakout: breakout(17, 500, 1000, 100),
      }).reason,
    ).toBe("candidate-expired-before-breakout");
  });

  it("returns unknown for missing market evidence", () => {
    expect(
      evaluateOneilDoubleBottom({ ...input(), marketCondition: null }).reason,
    ).toBe("market-condition-unknown");
  });

  it("keeps pre-breakout and post-breakout evaluations independent", () => {
    const waiting = evaluateOneilDoubleBottom({ ...input(), breakout: null });
    const triggered = evaluateOneilDoubleBottom(input());
    expect(waiting.candidate?.triggered).toBe(false);
    expect(triggered.candidate?.triggered).toBe(true);
    expect(triggered).toEqual(evaluateOneilDoubleBottom(input()));
  });
});

describe("F09.06 flat base and base on base", () => {
  const flat = () => ({
    asOf,
    weeks: 6,
    high: swing("high", 100, 1),
    low: swing("low", 88, 20),
    priorUptrend: true,
    breakout: breakout(101, 3000, 1000, 40),
  });

  it("accepts a 12% deep flat base with the pre-registered 1.4x volume", () => {
    const result = evaluateOneilFlatBase(flat());
    expect(result.status).toBe("known");
    expect(result.candidate).toMatchObject({ branch: "flat-base", pivot: 100 });
  });

  it("has no invented 65-week maximum", () => {
    expect(evaluateOneilFlatBase({ ...flat(), weeks: 200 }).status).toBe(
      "known",
    );
    expect(evaluateOneilFlatBase({ ...flat(), weeks: 4 }).reason).toBe(
      "flat-base-duration-below-5-weeks",
    );
  });

  it("rejects depth above 15%, missing prior evidence and unregistered multiples", () => {
    expect(
      evaluateOneilFlatBase({ ...flat(), low: swing("low", 70, 20) }).reason,
    ).toBe("flat-base-depth-above-15-percent");
    expect(
      evaluateOneilFlatBase({ ...flat(), priorUptrend: null }).reason,
    ).toBe("prior-advance-evidence-missing");
    expect(() =>
      evaluateOneilFlatBase(flat(), {
        breakoutVolumeMultiple: 1.6 as never,
        averageVolumeWindow: 50,
        chaseLimit: 0.05,
      }),
    ).toThrow(/1.4 or 1.5/);
    expect(() =>
      evaluateOneilFlatBase(flat(), {
        breakoutVolumeMultiple: 1.4,
        averageVolumeWindow: Number.NaN,
        chaseLimit: 0.05,
      }),
    ).toThrow(/finite positive/);
  });

  const bob = () => ({
    asOf,
    firstBreakout: { price: 100, at: time(10) },
    firstAdvanceHigh: { price: 106, confirmedAt: time(20) },
    base2: {
      high: swing("high", 107, 30),
      low: swing("low", 99.5, 40),
      confirmedAt: time(45),
    },
    barsSinceConfirmed: 3,
    breakout: breakout(108, 3000, 1000, 50),
  });

  it("distinguishes a tight base above P1 from an unfinished B1 pullback", () => {
    expect(evaluateOneilBaseOnBase(bob()).candidate).toMatchObject({
      branch: "base-on-base",
      pivot: 107,
      triggered: true,
    });
    expect(
      evaluateOneilBaseOnBase({
        ...bob(),
        firstAdvanceHigh: { price: 115, confirmedAt: time(20) },
      }).reason,
    ).toBe("subsequent-base-not-base-on-base");
    expect(
      evaluateOneilBaseOnBase({
        ...bob(),
        firstAdvanceHigh: null,
      }).reason,
    ).toBe("first-advance-evidence-missing");
  });

  it("expires its candidate and rejects a pre-confirmation breakout", () => {
    expect(
      evaluateOneilBaseOnBase({ ...bob(), barsSinceConfirmed: 30 }).reason,
    ).toBe("candidate-expired-before-breakout");
    expect(
      evaluateOneilBaseOnBase({
        ...bob(),
        breakout: breakout(108, 3000, 1000, 42),
      }).reason,
    ).toBe("breakout-before-structure-confirmed");
  });
});

describe("F09.07 ascending base and high tight flag", () => {
  const ascending = () => ({
    asOf,
    weeks: 12,
    points: [
      { high: swing("high", 100, 1), low: swing("low", 88, 5) },
      { high: swing("high", 110, 20), low: swing("low", 99, 25) },
      { high: swing("high", 120, 40), low: swing("low", 108, 45) },
    ] as const,
    preBaseAdvance: 0.3,
    breakout: breakout(121, 3000, 1000, 60),
  });

  it("requires three rising lows and 10-20% pullbacks", () => {
    const result = evaluateOneilAscendingBase(ascending());
    expect(result.status).toBe("known");
    expect(result.candidate).toMatchObject({ pivot: 120, protection: 108 });
    expect(
      evaluateOneilAscendingBase({
        ...ascending(),
        points: [
          { high: swing("high", 100, 1), low: swing("low", 88, 5) },
          { high: swing("high", 110, 20), low: swing("low", 88, 25) },
          { high: swing("high", 120, 40), low: swing("low", 108, 45) },
        ] as const,
      }).reason,
    ).toBe("ascending-lows-not-rising");
    expect(
      evaluateOneilAscendingBase({ ...ascending(), preBaseAdvance: null })
        .reason,
    ).toBe("pre-base-advance-evidence-missing");
  });

  const flag = () => ({
    asOf,
    poleStart: swing("low", 10, 1),
    poleHigh: swing("high", 21, 10),
    poleWeeks: 6,
    flagHigh: swing("high", 21, 20),
    flagLow: swing("low", 17, 30),
    flagWeeks: 4,
    breakout: breakout(21.5, 3000, 1000, 40),
  });

  it("keeps the high tight flag as a distinct A branch", () => {
    const result = evaluateOneilHighTightFlag(flag());
    expect(result.status).toBe("known");
    expect(result.candidate).toMatchObject({
      branch: "high-tight-flag",
      pivot: 21,
      protection: 17,
    });
    expect(
      evaluateOneilHighTightFlag({
        ...flag(),
        poleStart: swing("low", 12, 1),
      }).reason,
    ).toBe("pole-advance-below-100-percent");
    expect(evaluateOneilHighTightFlag({ ...flag(), flagWeeks: 6 }).reason).toBe(
      "flag-outside-3-5-weeks",
    );
  });

  it("counts overlapping ascending/flag risk once and stays prefix pure", () => {
    const both = evaluateOneilContractions({
      ascendingBase: ascending(),
      highTightFlag: flag(),
    });
    expect(both.results).toHaveLength(2);
    expect(both.riskGroups).toEqual([
      { group: "oneil-ascending-or-flag-overlap", count: 1 },
    ]);
    const waiting = evaluateOneilContractions({
      ascendingBase: { ...ascending(), breakout: null },
    });
    expect(waiting.results[0]?.candidate?.triggered).toBe(false);
    expect(waiting.results[0]).toEqual(
      evaluateOneilContractions({
        ascendingBase: { ...ascending(), breakout: null },
      }).results[0],
    );
  });
});

describe("F09.08 market direction", () => {
  function bars(): MarketDirectionBar[] {
    const rows: MarketDirectionBar[] = [];
    for (let i = 0; i < 10; i++)
      rows.push({ date: day(i), close: 100, low: 99, volume: 1000 });
    rows.push({ date: day(10), close: 94, low: 93, volume: 1000 });
    rows.push({ date: day(11), close: 95, low: 94.5, volume: 1000 });
    rows.push({ date: day(12), close: 95.5, low: 95, volume: 1000 });
    rows.push({ date: day(13), close: 95.6, low: 95, volume: 1000 });
    rows.push({ date: day(14), close: 97.1, low: 96.5, volume: 2000 });
    rows.push({ date: day(15), close: 98.2, low: 97, volume: 3000 });
    return rows;
  }
  // These fixtures intentionally keep a 10-bar lead-in; production default 20
  // is tested separately below and remains unchanged.
  const params = (lookback = 10, distributionWindow = 5) => ({
    ...marketDirectionParams,
    lookback,
    distributionWindow,
  });

  it("confirms a follow-through day at rally day 4 with >=1.25% and higher volume, once", () => {
    const result = evaluateOneilMarketDirection(bars(), params());
    const ftd = result.days[14]!;
    expect(ftd.followThrough).toBe(true);
    expect(ftd.riskActivated).toBe(true);
    expect(ftd.rallyDay).toBe(4);
    expect(result.days[15]!.riskActivated).toBe(false);
    expect(result.days[15]!.state).toBe("confirmed");
  });

  it("accepts the exact 1.25% boundary but not day 3 or equal volume", () => {
    const exact = bars();
    exact[13] = { ...exact[13]!, close: 100, low: 99, volume: 1000 };
    exact[14] = { ...exact[14]!, close: 101.25, low: 100.5, volume: 2000 };
    expect(
      evaluateOneilMarketDirection(exact, params()).days[14]!.followThrough,
    ).toBe(true);
    const equalVolume = bars();
    equalVolume[14] = { ...equalVolume[14]!, volume: 1000 };
    expect(
      evaluateOneilMarketDirection(equalVolume, params()).days[14]!
        .followThrough,
    ).toBe(false);
    const dayThree = bars();
    dayThree[11] = { ...dayThree[11]!, close: 94, low: 93.5 };
    dayThree[12] = { ...dayThree[12]!, close: 95, low: 95 };
    expect(
      evaluateOneilMarketDirection(dayThree, params()).days[14]!.rallyDay,
    ).toBe(3);
    expect(
      evaluateOneilMarketDirection(dayThree, params()).days[14]!.followThrough,
    ).toBe(false);
  });

  it("does not confirm an early rally day and keeps the attempt open", () => {
    const rows = bars();
    rows[12] = { ...rows[12]!, close: 97.5, volume: 2000 };
    rows[14] = { ...rows[14]!, close: 96.7 };
    const result = evaluateOneilMarketDirection(rows, params());
    expect(result.days[12]!.followThrough).toBe(false);
    expect(result.days[12]!.state).toBe("rally");
  });

  it("returns an explicit unknown, not 'no event', when follow-through volume is missing", () => {
    const rows = bars();
    rows[14] = { ...rows[14]!, volume: null };
    const result = evaluateOneilMarketDirection(rows, params());
    expect(result.days[14]!.unknown).toBe("follow-through-volume-unknown");
    expect(result.days[14]!.state).toBe("rally");
  });

  it("counts distribution days and marks incomparable distribution volume unknown", () => {
    const rows = bars().slice(0, 10);
    let close = 100;
    for (let i = 0; i < 4; i++) {
      close *= 0.99;
      rows.push({
        date: day(10 + i),
        close,
        low: close - 0.1,
        volume: 2000 + i * 1000,
      });
    }
    const result = evaluateOneilMarketDirection(rows, params());
    expect(result.days[13]!.distributionCount).toBe(4);
    expect(result.days[13]!.riskReduced).toBe(true);
    const missing = bars().slice(0, 10);
    missing.push({
      date: day(10),
      close: 99,
      low: 98.9,
      volume: null,
    });
    const unknown = evaluateOneilMarketDirection(missing, params()).days[10]!;
    expect(unknown.unknown).toBe("distribution-volume-unknown");
    expect(unknown.distributionCount).toBe(0);
    expect(unknown.distributionUnknown).toBe(1);
  });

  it("refuses a rally with only a short prior-N window under production defaults", () => {
    const short = bars().slice(0, 12);
    const result = evaluateOneilMarketDirection(short);
    expect(result.days[11]!.state).toBe("none");
    expect(result.days[11]!.rallyDay).toBe(0);
    expect(result.days[11]!.followThrough).toBe(false);
    expect(result.days[11]!.unknown).toBe("insufficient-lookback");
  });

  it("allows a rally after the full prior-20-day window exists", () => {
    const rows: MarketDirectionBar[] = [];
    for (let i = 0; i < 20; i++)
      rows.push({ date: day(i), close: 100, low: 99, volume: 1000 });
    rows.push({ date: day(20), close: 94, low: 93, volume: 1000 });
    rows.push({ date: day(21), close: 95, low: 94.5, volume: 1000 });
    const result = evaluateOneilMarketDirection(rows);
    expect(result.days[21]!.state).toBe("rally");
    expect(result.days[21]!.rallyDay).toBe(1);
    expect(result.days[21]!.unknown).toBeNull();
  });

  it("still reduces risk on a short prefix when the known count already reaches h", () => {
    const rows = bars().slice(0, 10);
    let close = 100;
    for (let i = 0; i < 4; i++) {
      close *= 0.99;
      rows.push({
        date: day(10 + i),
        close,
        low: close - 0.1,
        volume: 2000 + i * 1000,
      });
    }
    const result = evaluateOneilMarketDirection(rows);
    expect(result.days[13]!.distributionCount).toBe(4);
    expect(result.days[13]!.distributionWindowComplete).toBe(false);
    expect(result.days[13]!.riskReduced).toBe(true);
  });

  it("does not reduce risk below h and keeps unknown-window evidence visible", () => {
    const short = bars().slice(0, 10);
    let close = 100;
    for (let i = 0; i < 3; i++) {
      close *= 0.99;
      short.push({
        date: day(10 + i),
        close,
        low: close - 0.1,
        volume: 2000 + i * 1000,
      });
    }
    const low = evaluateOneilMarketDirection(short);
    expect(low.days[12]!.distributionCount).toBe(3);
    expect(low.days[12]!.distributionWindowComplete).toBe(false);
    expect(low.days[12]!.riskReduced).toBe(false);
    // A complete 25-day window with 3 known distributions plus one unknown
    // potential distribution must not claim the count is provably low.
    const rows: MarketDirectionBar[] = [];
    for (let i = 0; i < 22; i++)
      rows.push({ date: day(i), close: 100, low: 99, volume: 1000 });
    close = 100;
    for (let i = 0; i < 3; i++) {
      close *= 0.99;
      rows.push({
        date: day(22 + i),
        close,
        low: close - 0.1,
        volume: 2000 + i * 1000,
      });
    }
    const lastClose = close * 0.99;
    rows.push({
      date: day(25),
      close: lastClose,
      low: lastClose - 0.1,
      volume: null,
    });
    const unknown = evaluateOneilMarketDirection(rows).days[25]!;
    expect(unknown.distributionWindowComplete).toBe(true);
    expect(unknown.distributionCount).toBe(3);
    expect(unknown.distributionUnknown).toBe(1);
    expect(unknown.riskReduced).toBe(false);
    expect(unknown.unknown).toBe("distribution-volume-unknown");
  });

  it("needs N+1 prices for N complete distribution observations", () => {
    const rows = bars().slice(0, 8);
    const result = evaluateOneilMarketDirection(rows, {
      ...params(),
      lookback: 5,
      distributionWindow: 5,
    });
    expect(result.days[4]!.distributionWindowComplete).toBe(false);
    expect(result.days[5]!.distributionWindowComplete).toBe(true);
  });

  it("is prefix causal and repeated evaluation is identical; reordered bars throw", () => {
    const rows = bars();
    const full = evaluateOneilMarketDirection(rows, params());
    const prefix = evaluateOneilMarketDirection(rows.slice(0, 15), params());
    expect(prefix.days).toEqual(full.days.slice(0, 15));
    expect(evaluateOneilMarketDirection(rows, params())).toEqual(full);
    expect(() => evaluateOneilMarketDirection([rows[1]!, rows[0]!])).toThrow(
      /Invalid market-direction bar/,
    );
    expect(() =>
      evaluateOneilMarketDirection([
        { ...rows[0]!, date: "2026-02-30" },
        rows[1]!,
      ]),
    ).toThrow(/Invalid market-direction bar/);
  });
});
