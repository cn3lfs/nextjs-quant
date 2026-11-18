import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  absoluteMomentumZeroCash,
  bearishBarReclaim,
  grahamNcavScreen,
  sepaPriceTrendTemplate,
  type BearishBarReclaimInput,
  type BearishReclaimCandidate,
} from "../src/theory-selection-components";

const at = (day: number, hour = 8) => Date.UTC(2026, 10, day, hour);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------------- */
/* Shared daily fixtures                                                      */
/* ------------------------------------------------------------------------- */

function dailyBars(count: number, close = 100): Bar[] {
  return Array.from({ length: count }, (_, index): Bar => {
    const date = new Date(Date.UTC(2020, 0, index + 1))
      .toISOString()
      .slice(0, 10);
    return {
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      amount: 100000,
    };
  });
}

function patchBar(bars: Bar[], index: number, patch: Partial<Bar>): Bar[] {
  return bars.map((bar, atIndex) =>
    atIndex === index ? { ...bar, ...patch } : { ...bar },
  );
}

function sepaBaseBars(): Bar[] {
  const bars = dailyBars(319);
  bars[318] = {
    ...bars[318]!,
    open: 100,
    high: 150,
    low: 100,
    close: 150,
  };
  return bars;
}

/* ------------------------------------------------------------------------- */
/* F09.02 SEPA price trend template                                           */
/* ------------------------------------------------------------------------- */

describe("F09.02 sepaPriceTrendTemplate", () => {
  it("computes MA50/150/200 and the 120-value MA200 slope by hand", () => {
    const bars = sepaBaseBars();
    const result = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 85,
    });

    expect(result.status).toBe("PASS");
    expect(result.priceStatus).toBe("PASS");
    expect(result.values).toMatchObject({
      close: 150,
      ma50: 101,
      ma200: 100.25,
      ma200First: 100,
      ma200Last: 100.25,
      platformRs: 85,
    });
    expect(result.values!.ma150).toBeCloseTo(15050 / 150, 12);
    expect(result.values!.ma200Slope).toBeGreaterThan(0);
    for (const value of Object.values(result.criteria))
      expect(value).toBe(true);
    expect(result.week52Window).toMatchObject({
      barCount: 252,
      firstDate: bars[67]!.date,
      lastDate: bars[318]!.date,
      high: 150,
      low: 100,
    });
    expect(result.financialEvidence).toBe("NOT_EVALUATED");
    expect(result.catalystEvidence).toBe("NOT_EVALUATED");
    expect(result.wholeSepa).toBe(false);
  });

  it("requires 319 bars so that 120 completed MA200 values exist", () => {
    const short = sepaPriceTrendTemplate({
      bars: dailyBars(318),
      week52Bars: 252,
      platformRs: 85,
    });
    expect(short.status).toBe("UNKNOWN");
    expect(short.values).toBeNull();
    expect(short.barCount).toBe(318);

    const enough = sepaPriceTrendTemplate({
      bars: sepaBaseBars(),
      week52Bars: 252,
      platformRs: 85,
      decisionBarIndex: 317,
    });
    expect(enough.status).toBe("UNKNOWN");
    expect(enough.barCount).toBe(318);
  });

  it("keeps slope-positive and last-above-first as separate criteria", () => {
    const bars = dailyBars(319, 100);
    for (let index = 200; index <= 209; index++)
      bars[index] = {
        ...bars[index]!,
        open: 50,
        high: 50,
        low: 50,
        close: 50,
      };
    for (let index = 210; index <= 318; index++)
      bars[index] = {
        ...bars[index]!,
        open: 104,
        high: 104,
        low: 104,
        close: 104,
      };

    const result = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 85,
    });
    expect(result.criteria.ma200SlopePositive).toBe(true);
    expect(result.criteria.ma200LastAboveFirst).toBe(false);
    expect(result.status).toBe("FAIL");
  });

  it("passes exact 1.30x low and 0.75x high thresholds", () => {
    const bars = patchBar(sepaBaseBars(), 100, {
      open: 100,
      high: 200,
      low: 100,
      close: 100,
    });
    const result = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 85,
    });
    expect(result.week52Window).toMatchObject({ high: 200, low: 100 });
    expect(result.criteria.closeAtLeast130PctWeek52Low).toBe(true);
    expect(result.criteria.closeAtLeast75PctWeek52High).toBe(true);
    expect(result.status).toBe("PASS");
  });

  it("freezes the declared 52-week window instead of hiding a calendar default", () => {
    let bars = patchBar(sepaBaseBars(), 0, {
      open: 100,
      high: 300,
      low: 100,
      close: 100,
    });
    bars = patchBar(bars, 100, {
      open: 100,
      high: 200,
      low: 100,
      close: 100,
    });

    const shortWindow = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 85,
    });
    expect(shortWindow.week52Window).toMatchObject({ high: 200, low: 100 });
    expect(shortWindow.status).toBe("PASS");

    const longWindow = sepaPriceTrendTemplate({
      bars,
      week52Bars: 319,
      platformRs: 85,
    });
    expect(longWindow.week52Window).toMatchObject({ high: 300, low: 100 });
    expect(longWindow.criteria.closeAtLeast75PctWeek52High).toBe(false);
    expect(longWindow.status).toBe("FAIL");

    expect(
      sepaPriceTrendTemplate({ bars, week52Bars: 0, platformRs: 85 }).status,
    ).toBe("UNKNOWN");
  });

  it("treats missing or out-of-range platform RS as UNKNOWN, never PASS or RPS", () => {
    const bars = sepaBaseBars();
    const missing = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: null,
    });
    expect(missing.priceStatus).toBe("PASS");
    expect(missing.criteria.platformRsAtLeast70).toBeNull();
    expect(missing.status).toBe("UNKNOWN");

    for (const platformRs of [-1, 101, Number.NaN]) {
      const result = sepaPriceTrendTemplate({
        bars,
        week52Bars: 252,
        platformRs,
      });
      expect(result.criteria.platformRsAtLeast70).toBeNull();
      expect(result.status).toBe("UNKNOWN");
    }

    const exact = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 100,
    });
    expect(exact.criteria.platformRsAtLeast70).toBe(true);
    expect(exact.status).toBe("PASS");
  });

  it("rejects duplicate, out-of-order and impossible daily date labels", () => {
    const base = sepaBaseBars();
    const duplicate = patchBar(base, 100, { date: base[99]!.date });
    expect(
      sepaPriceTrendTemplate({
        bars: duplicate,
        week52Bars: 252,
        platformRs: 85,
      }).status,
    ).toBe("UNKNOWN");

    const outOfOrder = patchBar(base, 100, { date: "2019-12-31" });
    expect(
      sepaPriceTrendTemplate({
        bars: outOfOrder,
        week52Bars: 252,
        platformRs: 85,
      }).status,
    ).toBe("UNKNOWN");

    const impossible = patchBar(base, 100, { date: "2020-02-30" });
    expect(
      sepaPriceTrendTemplate({
        bars: impossible,
        week52Bars: 252,
        platformRs: 85,
      }).status,
    ).toBe("UNKNOWN");
  });

  it("ignores bars after the decision index and does not mutate inputs", () => {
    const bars = sepaBaseBars();
    const expected = sepaPriceTrendTemplate({
      bars,
      week52Bars: 252,
      platformRs: 85,
    });

    const future = [
      ...bars,
      ...Array.from({ length: 11 }, (_, index): Bar => ({
        date: new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        amount: 1,
      })),
    ];
    const prefixed = sepaPriceTrendTemplate({
      bars: future,
      week52Bars: 252,
      platformRs: 85,
      decisionBarIndex: 318,
    });
    expect(prefixed).toEqual(expected);

    const frozen = deepFreeze(clone(bars));
    expect(() =>
      sepaPriceTrendTemplate({
        bars: frozen,
        week52Bars: 252,
        platformRs: 85,
      }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* F13.02 Graham NCAV arithmetic                                              */
/* ------------------------------------------------------------------------- */

describe("F13.02 grahamNcavScreen", () => {
  const base = {
    currentAssets: 150,
    liabilities: 70,
    preferredEquity: 0,
    preferredIncludedInLiabilities: true,
    commonShares: 10,
    price: 5,
    discount: 0.7,
    maxHoldingDays: 365,
    assetRecoverabilityAudited: true,
  } as const;

  it("computes NCAV=8 and passes P<=0.7*NCAV", () => {
    const result = grahamNcavScreen(base);
    expect(result.status).toBe("FILTER_PASS");
    expect(result.netCurrentAssets).toBe(80);
    expect(result.ncav).toBe(8);
    expect(result.thresholdPrice).toBeCloseTo(5.6, 12);
    expect(result.noNewEntry).toBe(false);
    expect(result.originalGrahamFormula).toBe(false);
  });

  it("prevents preferred-equity double subtraction and requires classification", () => {
    const included = grahamNcavScreen({
      ...base,
      preferredEquity: 30,
      preferredIncludedInLiabilities: true,
    });
    expect(included.preferredDeduction).toBe(0);
    expect(included.preferenceClassification).toBe("INCLUDED_IN_LIABILITIES");
    expect(included.ncav).toBe(8);

    const separate = grahamNcavScreen({
      ...base,
      preferredEquity: 30,
      preferredIncludedInLiabilities: false,
    });
    expect(separate.preferredDeduction).toBe(30);
    expect(separate.preferenceClassification).toBe("SEPARATE");
    expect(separate.ncav).toBe(5);
    expect(separate.status).toBe("WAIT");

    const unknown = grahamNcavScreen({
      ...base,
      preferredEquity: 30,
      preferredIncludedInLiabilities: null,
    });
    expect(unknown.preferenceClassification).toBeNull();
    expect(unknown.preferredDeduction).toBeNull();
    expect(unknown.ncav).toBeNull();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for null/invalid required facts", () => {
    const invalid = [
      { currentAssets: null },
      { liabilities: null },
      { preferredEquity: null },
      { commonShares: 0 },
      { price: 0 },
      { price: Number.NaN },
      { discount: 0 },
      { discount: 1 },
      { maxHoldingDays: 0 },
      { maxHoldingDays: 1.5 },
    ] as const;
    for (const patch of invalid) {
      const result = grahamNcavScreen({ ...base, ...patch });
      expect(result.status).toBe("UNKNOWN");
      expect(result.noNewEntry).toBe(true);
    }
  });

  it("blocks new entries when asset recoverability is unaudited", () => {
    const unresolved = grahamNcavScreen({
      ...base,
      assetRecoverabilityAudited: false,
    });
    expect(unresolved.status).toBe("UNRESOLVED");
    expect(unresolved.noNewEntry).toBe(true);
    expect(unresolved.ncav).toBe(8);

    const missing = grahamNcavScreen({
      ...base,
      assetRecoverabilityAudited: null,
    });
    expect(missing.status).toBe("UNRESOLVED");
    expect(missing.noNewEntry).toBe(true);
  });

  it("keeps known held-position exit references independent of screening", () => {
    const nonPositive = grahamNcavScreen({
      ...base,
      currentAssets: 50,
      held: true,
      holdingDays: 10,
    });
    expect(nonPositive.exitReference).toBe("EXIT_HELD_POSITION");
    expect(nonPositive.exitReasons).toContain("NCAV_NON_POSITIVE");
    expect(nonPositive.exitReasons).toContain("PRICE_AT_OR_ABOVE_NCAV");

    const aboveNcav = grahamNcavScreen({
      ...base,
      price: 9,
      held: true,
      holdingDays: 10,
    });
    expect(aboveNcav.exitReference).toBe("EXIT_HELD_POSITION");
    expect(aboveNcav.exitReasons).toEqual(["PRICE_AT_OR_ABOVE_NCAV"]);

    const expired = grahamNcavScreen({
      ...base,
      held: true,
      holdingDays: 365,
    });
    expect(expired.exitReasons).toEqual(["HOLDING_PERIOD_REACHED"]);

    const missingFactsButExpired = grahamNcavScreen({
      ...base,
      currentAssets: null,
      held: true,
      holdingDays: 365,
    });
    expect(missingFactsButExpired.status).toBe("UNKNOWN");
    expect(missingFactsButExpired.exitReference).toBe("EXIT_HELD_POSITION");
    expect(missingFactsButExpired.exitReasons).toEqual([
      "HOLDING_PERIOD_REACHED",
    ]);

    const notHeld = grahamNcavScreen({
      ...base,
      price: 9,
      held: false,
    });
    expect(notHeld.exitReference).toBeNull();
  });

  it("passes the exact threshold and never filters a non-positive NCAV", () => {
    const exact = grahamNcavScreen({ ...base, price: 5.6 });
    expect(exact.status).toBe("FILTER_PASS");
    const above = grahamNcavScreen({ ...base, price: 5.6001 });
    expect(above.status).toBe("WAIT");

    const nonPositive = grahamNcavScreen({
      ...base,
      currentAssets: 50,
      price: 0.1,
    });
    expect(nonPositive.ncav).toBe(-2);
    expect(nonPositive.status).toBe("WAIT");
  });

  it("does not FILTER_PASS while an actual position is held", () => {
    const result = grahamNcavScreen({ ...base, held: true, holdingDays: 1 });
    expect(result.status).toBe("WAIT");
  });
});

/* ------------------------------------------------------------------------- */
/* F10.03 absolute momentum, zero cash                                        */
/* ------------------------------------------------------------------------- */

describe("F10.03 absoluteMomentumZeroCash", () => {
  const period = {
    identity: "12M-month-end",
    start: Date.UTC(2025, 10, 1),
    end: Date.UTC(2026, 10, 1),
  } as const;
  const asOf = Date.UTC(2026, 10, 2);

  it("compares the supplied asset return with explicit zero cash", () => {
    const result = absoluteMomentumZeroCash({
      assetReturn: 0.03,
      threshold: 0,
      period,
      asOf,
    });
    expect(result.status).toBe("RISK_ASSET");
    expect(result.cashReturn).toBe(0);
    expect(result.excessOverZeroCash).toBe(0.03);
    expect(result.periodIdentity).toEqual({
      identity: "12M-month-end",
      start: period.start,
      end: period.end,
    });
    expect(result.model).toBe("ZERO_CASH_COMPARISON_COMPONENT");
    expect(result.originalCashExcessModel).toBe(false);
    expect(result.treasuryBillModel).toBe(false);
    expect(result.targetWeight).toBeNull();
  });

  it("treats ties and non-positive excess as defensive", () => {
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0,
        threshold: 0,
        period,
        asOf,
      }).status,
    ).toBe("DEFENSIVE");
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0.05,
        threshold: 0.05,
        period,
        asOf,
      }).status,
    ).toBe("DEFENSIVE");
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0.0501,
        threshold: 0.05,
        period,
        asOf,
      }).status,
    ).toBe("RISK_ASSET");
  });

  it("returns UNKNOWN for unknown return, threshold or period", () => {
    expect(
      absoluteMomentumZeroCash({
        assetReturn: null,
        threshold: 0,
        period,
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0.03,
        threshold: Number.NaN,
        period,
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0.03,
        threshold: 0,
        period: { ...period, end: period.start },
        asOf,
      }).status,
    ).toBe("UNKNOWN");
    expect(
      absoluteMomentumZeroCash({
        assetReturn: 0.03,
        threshold: 0,
        period,
        asOf: Date.UTC(2026, 9, 1),
      }).status,
    ).toBe("UNKNOWN");
  });
});

/* ------------------------------------------------------------------------- */
/* F11.10 close-confirmed full bearish-bar reclaim                            */
/* ------------------------------------------------------------------------- */

function reclaimBars(): Bar[] {
  return [
    {
      date: "2026-11-01",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      amount: 100000,
    },
    {
      date: "2026-11-02",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 2000,
      amount: 100000,
    },
    {
      date: "2026-11-03",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 3000,
      amount: 100000,
    },
    {
      date: "2026-11-04",
      open: 110,
      high: 112,
      low: 100,
      close: 105,
      volume: 4000,
      amount: 100000,
    },
    {
      date: "2026-11-05",
      open: 106,
      high: 116,
      low: 105,
      close: 115,
      volume: 6000,
      amount: 100000,
    },
  ];
}

function candidate(
  overrides: Partial<BearishReclaimCandidate> = {},
): BearishReclaimCandidate {
  return {
    dBarIndex: 3,
    confirmedAt: at(4),
    eligibleAt: at(4, 9),
    originalDecisionAt: at(5),
    consumed: false,
    ...overrides,
  };
}

function reclaimInput(
  overrides: Partial<BearishBarReclaimInput> = {},
): BearishBarReclaimInput {
  return {
    bars: reclaimBars(),
    mode: "full",
    currentCompletedAt: at(5),
    decisionAt: at(5, 8),
    candidate: candidate(),
    volumeMultiplier: 2,
    stopBuffer: 1,
    maxHoldingBars: 4,
    riskLimit: 0.15,
    plannedEntryPrice: 114,
    ...overrides,
  };
}

describe("F11.10 bearishBarReclaim", () => {
  it("requires an explicit flat position before an entry reference", () => {
    const missing = bearishBarReclaim(reclaimInput());
    expect(missing.status).toBe("UNKNOWN");
    expect(missing.newEntryBlocked).toBe("POSITION_UNKNOWN");
    expect(missing.entryReference).toBeNull();

    const missingWithPending = bearishBarReclaim(
      reclaimInput({ pendingExit: true }),
    );
    expect(missingWithPending.status).toBe("UNKNOWN");
    expect(missingWithPending.newEntryBlocked).toBe("POSITION_UNKNOWN");
    expect(missingWithPending.nextPendingExit).toBe(true);

    const flat = bearishBarReclaim(
      reclaimInput({ position: { held: false, canSell: false } }),
    );
    expect(flat.status).toBe("SIGNAL");
    expect(flat.entryReference).toBe("ENTRY_REFERENCE");
  });

  it("preserves a consumed candidate across unknown and malformed branches", () => {
    const missingPlan = bearishBarReclaim(
      reclaimInput({
        candidate: candidate({ consumed: true }),
        plannedEntryPrice: null,
      }),
    );
    expect(missingPlan.status).toBe("UNKNOWN");
    expect(missingPlan.newEntryBlocked).toBe("MISSING_PLANNED_PRICE");
    expect(missingPlan.entryReference).toBeNull();
    expect(missingPlan.candidateConsumedNext).toBe(true);

    const malformed = bearishBarReclaim(
      reclaimInput({
        candidate: candidate({
          consumed: true,
          confirmedAt: "2026-11-04",
        }),
      }),
    );
    expect(malformed.status).toBe("UNKNOWN");
    expect(malformed.newEntryBlocked).toBe("INVALID_CANDIDATE");
    expect(malformed.entryReference).toBeNull();
    expect(malformed.candidateConsumedNext).toBe(true);

    const badMode = bearishBarReclaim(
      reclaimInput({
        mode: "body" as never,
        candidate: candidate({ consumed: true }),
      }),
    );
    expect(badMode.newEntryBlocked).toBe("MODE_NOT_FULL");
    expect(badMode.candidateConsumedNext).toBe(true);
  });

  it("keeps a known held stop when current volume is missing", () => {
    const result = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, { volume: Number.NaN }),
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.newEntryBlocked).toBe("INVALID_BARS");
    expect(result.entryReference).toBeNull();
    expect(result.held.currentClose).toBe(115);
    expect(result.held.stopBreached).toBe(true);
    expect(result.exitReference).toBe("EXIT_REFERENCE");
    expect(result.exitReasons).toContain("STOP_BREACH");
    expect(result.nextPendingExit).toBe(true);
  });

  it("requires the frozen candidate D itself to be a bearish bar", () => {
    const result = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 3, {
          open: 100,
          high: 112,
          low: 99,
          close: 110,
        }),
      }),
    );
    expect(result.candidate).toMatchObject({ dBarIndex: 3, bearish: false });
    expect(result.entry!.closeAboveDHigh).toBe(true);
    expect(result.entry!.volumeAtLeastRequired).toBe(true);
    expect(result.status).toBe("NO_SIGNAL");
    expect(result.newEntryBlocked).toBe("NO_SIGNAL");
    expect(result.entryReference).toBeNull();
  });

  it("ignores bars after the decision index and freezes output", () => {
    const base = bearishBarReclaim(reclaimInput());
    const future = [
      ...reclaimBars(),
      {
        date: "2026-11-06",
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        amount: 1,
      },
    ];
    const prefixed = bearishBarReclaim(
      reclaimInput({ bars: future, decisionBarIndex: 4 }),
    );
    expect(prefixed).toEqual(base);
  });

  it("uses the frozen candidate D and the supplied plan entry price", () => {
    const result = bearishBarReclaim(
      reclaimInput({ position: { held: false, canSell: false } }),
    );
    expect(result.status).toBe("SIGNAL");
    expect(result.entryReference).toBe("ENTRY_REFERENCE");
    expect(result.newEntryBlocked).toBeNull();
    expect(result.candidate).toMatchObject({
      dBarIndex: 3,
      high: 112,
      low: 100,
      bearish: true,
      fresh: true,
      eligibleBeforeOriginalDecision: true,
    });
    expect(result.entry).toMatchObject({
      priorVolumeMean: 2500,
      requiredVolume: 5000,
      closeAboveDHigh: true,
      volumeAtLeastRequired: true,
      stopPrice: 99,
      plannedEntryPrice: 114,
      riskDistance: 15,
      riskWithinLimit: true,
    });
    expect(result.entry!.riskFraction).toBeCloseTo(15 / 114, 12);
    expect(result.candidateConsumedNext).toBe(true);
    expect(result.exitReference).toBeNull();
    expect(result.held.positionSeen).toBe(false);
  });

  it("excludes current volume from the prior mean and accepts exact thresholds", () => {
    const quiet = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, { volume: 10 }),
      }),
    );
    expect(quiet.status).toBe("NO_SIGNAL");
    expect(quiet.entry!.priorVolumeMean).toBe(2500);
    expect(quiet.entry!.requiredVolume).toBe(5000);
    expect(quiet.entry!.volumeAtLeastRequired).toBe(false);

    const exactVolume = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, { volume: 5000 }),
      }),
    );
    expect(exactVolume.entry!.volumeAtLeastRequired).toBe(true);

    const equalHigh = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, { close: 112 }),
      }),
    );
    expect(equalHigh.entry!.closeAboveDHigh).toBe(false);
    expect(equalHigh.status).toBe("NO_SIGNAL");

    const aboveHigh = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, { close: 112.0001 }),
        position: { held: false, canSell: false },
      }),
    );
    expect(aboveHigh.entry!.closeAboveDHigh).toBe(true);
    expect(aboveHigh.status).toBe("SIGNAL");
  });

  it("uses plan risk rather than the current close", () => {
    const result = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, {
          open: 190,
          high: 201,
          low: 189,
          close: 200,
        }),
        position: { held: false, canSell: false },
      }),
    );
    expect(result.status).toBe("SIGNAL");
    expect(result.entryReference).toBe("ENTRY_REFERENCE");
    expect(result.entry!.riskFraction).toBeCloseTo(15 / 114, 12);
    expect(result.entry!.riskFraction).not.toBeCloseTo((200 - 99) / 200, 12);
  });

  it("blocks entries on missing plan price or excessive plan risk", () => {
    const missing = bearishBarReclaim(
      reclaimInput({ plannedEntryPrice: null }),
    );
    expect(missing.status).toBe("UNKNOWN");
    expect(missing.newEntryBlocked).toBe("MISSING_PLANNED_PRICE");
    expect(missing.entryReference).toBeNull();

    const risky = bearishBarReclaim(
      reclaimInput({
        plannedEntryPrice: 200,
        position: { held: false, canSell: false },
      }),
    );
    expect(risky.status).toBe("SIGNAL");
    expect(risky.newEntryBlocked).toBe("RISK_ABOVE_LIMIT");
    expect(risky.entryReference).toBeNull();

    const belowStop = bearishBarReclaim(
      reclaimInput({
        plannedEntryPrice: 98,
        position: { held: false, canSell: false },
      }),
    );
    expect(belowStop.newEntryBlocked).toBe("PLAN_ENTRY_NOT_ABOVE_STOP");
    expect(belowStop.entryReference).toBeNull();
  });

  it("evaluates held protection before candidate or plan failures", () => {
    const missingPlan = bearishBarReclaim(
      reclaimInput({
        plannedEntryPrice: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(missingPlan.status).toBe("UNKNOWN");
    expect(missingPlan.newEntryBlocked).toBe("MISSING_PLANNED_PRICE");
    expect(missingPlan.entryReference).toBeNull();
    expect(missingPlan.exitReference).toBe("EXIT_REFERENCE");
    expect(missingPlan.exitReasons).toContain("STOP_BREACH");
    expect(missingPlan.nextPendingExit).toBe(true);

    const missingCandidate = bearishBarReclaim(
      reclaimInput({
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 0,
          canSell: true,
          frozenStopPrice: 90,
        },
      }),
    );
    expect(missingCandidate.status).toBe("UNKNOWN");
    expect(missingCandidate.newEntryBlocked).toBe("NO_CANDIDATE");
    expect(missingCandidate.exitReference).toBe("EXIT_REFERENCE");
    expect(missingCandidate.exitReasons).toEqual(["HOLDING_EXPIRED"]);
    expect(missingCandidate.nextPendingExit).toBe(true);

    const invalidTiming = bearishBarReclaim(
      reclaimInput({
        currentCompletedAt: at(5, 9),
        decisionAt: at(5, 8),
        position: {
          held: true,
          entryBarIndex: 0,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(invalidTiming.status).toBe("UNKNOWN");
    expect(invalidTiming.newEntryBlocked).toBe("INVALID_TIMING");
    expect(invalidTiming.exitReference).toBeNull();
    expect(invalidTiming.held.stopBreached).toBeNull();
    expect(invalidTiming.held.holdingExpired).toBeNull();
    expect(invalidTiming.held.holdingBars).toBeNull();
    expect(invalidTiming.nextPendingExit).toBe(false);
  });

  it("does not consume a future completed bar for a fresh stop or expiry", () => {
    const futureCompletion = bearishBarReclaim(
      reclaimInput({
        currentCompletedAt: at(5, 9),
        decisionAt: at(5, 8),
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 0,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(futureCompletion.status).toBe("UNKNOWN");
    expect(futureCompletion.newEntryBlocked).toBe("INVALID_TIMING");
    expect(futureCompletion.held.currentClose).toBeNull();
    expect(futureCompletion.held.stopBreached).toBeNull();
    expect(futureCompletion.held.holdingBars).toBeNull();
    expect(futureCompletion.held.holdingExpired).toBeNull();
    expect(futureCompletion.exitReference).toBeNull();
    expect(futureCompletion.exitReasons).toEqual([]);
    expect(futureCompletion.nextPendingExit).toBe(false);

    const latched = bearishBarReclaim(
      reclaimInput({
        currentCompletedAt: at(5, 9),
        decisionAt: at(5, 8),
        candidate: null,
        pendingExit: true,
        position: {
          held: true,
          entryBarIndex: 0,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(latched.exitReference).toBe("EXIT_REFERENCE");
    expect(latched.exitReasons).toEqual(["PENDING_EXIT"]);
    expect(latched.held.stopBreached).toBeNull();
    expect(latched.held.holdingExpired).toBeNull();
    expect(latched.nextPendingExit).toBe(true);
  });

  it("does not invent a holding count from invalid or duplicate dates", () => {
    const base = reclaimBars();
    for (const date of [base[0]!.date, "2026-10-31", "2026-02-30"]) {
      const result = bearishBarReclaim(
        reclaimInput({
          bars: patchBar(base, 1, { date }),
          candidate: null,
          position: {
            held: true,
            entryBarIndex: 0,
            canSell: true,
            frozenStopPrice: 120,
          },
        }),
      );
      // Historical date defects do not erase a current completed close below
      // the actual frozen stop, but they still cannot supply a holding count.
      expect(result.held.stopBreached).toBe(true);
      expect(result.held.holdingBars).toBeNull();
      expect(result.held.holdingExpired).toBeNull();
      expect(result.exitReference).toBe("EXIT_REFERENCE");
      expect(result.exitReasons).toEqual(["STOP_BREACH"]);
      expect(result.nextPendingExit).toBe(true);
    }
  });

  it("keeps the original position stop when the next day's D changes", () => {
    const bars = reclaimBars();
    bars[4] = {
      ...bars[4]!,
      open: 110,
      high: 112,
      low: 80,
      close: 105,
      volume: 4000,
    };
    bars.push({
      date: "2026-11-06",
      open: 99,
      high: 100,
      low: 97,
      close: 98,
      volume: 6000,
      amount: 100000,
    });

    const result = bearishBarReclaim(
      reclaimInput({
        bars,
        decisionBarIndex: 5,
        currentCompletedAt: at(6),
        decisionAt: at(6, 8),
        candidate: candidate({
          dBarIndex: 4,
          confirmedAt: at(5),
          eligibleAt: at(5, 9),
          originalDecisionAt: at(6),
        }),
        stopBuffer: 1,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 99,
        },
      }),
    );

    expect(result.held.frozenStopPrice).toBe(99);
    expect(result.held.stopBreached).toBe(true);
    expect(result.exitReference).toBe("EXIT_REFERENCE");
    expect(result.exitReasons).toContain("STOP_BREACH");
    expect(result.nextPendingExit).toBe(true);
  });

  it("blocks T+1 selling as pending and preserves it after price recovery", () => {
    const blocked = bearishBarReclaim(
      reclaimInput({
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 4,
          canSell: false,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(blocked.exitReference).toBe("EXIT_PENDING");
    expect(blocked.exitReasons).toContain("STOP_BREACH");
    expect(blocked.nextPendingExit).toBe(true);

    const recovered = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, {
          open: 106,
          high: 122,
          low: 105,
          close: 121,
        }),
        candidate: null,
        pendingExit: true,
        position: {
          held: true,
          entryBarIndex: 4,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(recovered.exitReference).toBe("EXIT_REFERENCE");
    expect(recovered.exitReasons).toEqual(["PENDING_EXIT"]);
    expect(recovered.nextPendingExit).toBe(true);

    const intentIsNotFlat = bearishBarReclaim(
      reclaimInput({
        bars: patchBar(reclaimBars(), 4, {
          open: 106,
          high: 122,
          low: 105,
          close: 121,
        }),
        candidate: null,
        pendingExit: true,
        position: {
          held: true,
          entryBarIndex: 4,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(intentIsNotFlat.exitReference).toBe("EXIT_REFERENCE");
    expect(intentIsNotFlat.nextPendingExit).toBe(true);

    const actualFlat = bearishBarReclaim(
      reclaimInput({
        candidate: null,
        pendingExit: true,
        position: { held: false, canSell: false },
      }),
    );
    expect(actualFlat.exitReference).toBeNull();
    expect(actualFlat.nextPendingExit).toBe(false);
  });

  it("rejects stale or timing-invalid candidates without switching D", () => {
    const stale = bearishBarReclaim(
      reclaimInput({ candidate: candidate({ dBarIndex: 2 }) }),
    );
    expect(stale.status).toBe("NO_SIGNAL");
    expect(stale.newEntryBlocked).toBe("STALE_CANDIDATE");
    expect(stale.entryReference).toBeNull();

    const earlyEligibility = bearishBarReclaim(
      reclaimInput({
        candidate: candidate({ eligibleAt: at(5) }),
      }),
    );
    expect(earlyEligibility.newEntryBlocked).toBe("STALE_CANDIDATE");

    const consumed = bearishBarReclaim(
      reclaimInput({
        candidate: candidate({ consumed: true }),
      }),
    );
    expect(consumed.status).toBe("SIGNAL");
    expect(consumed.newEntryBlocked).toBe("CANDIDATE_CONSUMED");
    expect(consumed.entryReference).toBeNull();
    expect(consumed.candidateConsumedNext).toBe(true);
  });

  it("validates used daily dates in the reclaim prefix", () => {
    const base = reclaimBars();
    for (const date of [base[0]!.date, "2026-10-31", "2026-02-30"]) {
      const result = bearishBarReclaim(
        reclaimInput({
          bars: patchBar(base, 1, { date }),
        }),
      );
      expect(result.status).toBe("UNKNOWN");
      expect(result.newEntryBlocked).toBe("INVALID_BARS");
    }
  });

  it("distinguishes missing interior history from a missing current bar", () => {
    const interiorBars = reclaimBars().map((bar, index) =>
      index === 1 ? null : bar,
    ) as unknown as Bar[];
    const currentBars = reclaimBars().map((bar, index) =>
      index === 4 ? null : bar,
    ) as unknown as Bar[];
    const position = {
      held: true,
      entryBarIndex: 0,
      canSell: true,
      frozenStopPrice: 120,
    } as const;

    const interiorInput = reclaimInput({
      bars: interiorBars,
      candidate: candidate({ consumed: true }),
      pendingExit: true,
      position,
    });
    expect(() => bearishBarReclaim(interiorInput)).not.toThrow();
    const interior = bearishBarReclaim(interiorInput);
    expect(interior.status).toBe("UNKNOWN");
    expect(interior.newEntryBlocked).toBe("INVALID_BARS");
    expect(interior.entryReference).toBeNull();
    expect(interior.held.stopBreached).toBe(true);
    expect(interior.held.holdingBars).toBeNull();
    expect(interior.held.holdingExpired).toBeNull();
    expect(interior.exitReasons).toEqual(["STOP_BREACH", "PENDING_EXIT"]);
    expect(interior.exitReference).toBe("EXIT_REFERENCE");
    expect(interior.nextPendingExit).toBe(true);
    expect(interior.candidateConsumedNext).toBe(true);

    const currentInput = reclaimInput({
      bars: currentBars,
      candidate: candidate({ consumed: true }),
      pendingExit: true,
      position,
    });
    expect(() => bearishBarReclaim(currentInput)).not.toThrow();
    const current = bearishBarReclaim(currentInput);
    expect(current.status).toBe("UNKNOWN");
    expect(current.newEntryBlocked).toBe("INVALID_BARS");
    expect(current.entryReference).toBeNull();
    expect(current.held.currentClose).toBeNull();
    expect(current.held.stopBreached).toBeNull();
    expect(current.held.holdingBars).toBeNull();
    expect(current.held.holdingExpired).toBeNull();
    expect(current.exitReasons).toEqual(["PENDING_EXIT"]);
    expect(current.exitReference).toBe("EXIT_REFERENCE");
    expect(current.nextPendingExit).toBe(true);
    expect(current.candidateConsumedNext).toBe(true);
  });

  it("keeps a current stop when only old history is unavailable", () => {
    const oldHistoryNull = reclaimBars().map((bar, index) =>
      index === 1 ? null : bar,
    ) as unknown as Bar[];

    const sellable = bearishBarReclaim(
      reclaimInput({
        bars: oldHistoryNull,
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(sellable.status).toBe("UNKNOWN");
    expect(sellable.newEntryBlocked).toBe("INVALID_BARS");
    expect(sellable.held.stopBreached).toBe(true);
    expect(sellable.held.holdingBars).toBeNull();
    expect(sellable.held.holdingExpired).toBeNull();
    expect(sellable.exitReference).toBe("EXIT_REFERENCE");
    expect(sellable.exitReasons).toEqual(["STOP_BREACH"]);
    expect(sellable.nextPendingExit).toBe(true);

    const blocked = bearishBarReclaim(
      reclaimInput({
        bars: oldHistoryNull,
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: false,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(blocked.held.stopBreached).toBe(true);
    expect(blocked.exitReference).toBe("EXIT_PENDING");
    expect(blocked.exitReasons).toEqual(["STOP_BREACH"]);
    expect(blocked.nextPendingExit).toBe(true);

    const currentNull = reclaimBars().map((bar, index) =>
      index === 4 ? null : bar,
    ) as unknown as Bar[];
    const unknownCurrent = bearishBarReclaim(
      reclaimInput({
        bars: currentNull,
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(unknownCurrent.held.stopBreached).toBeNull();
    expect(unknownCurrent.exitReference).toBeNull();
    expect(unknownCurrent.exitReasons).toEqual([]);
    expect(unknownCurrent.nextPendingExit).toBe(false);

    const futureCompletion = bearishBarReclaim(
      reclaimInput({
        currentCompletedAt: at(5, 9),
        decisionAt: at(5, 8),
        candidate: null,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(futureCompletion.held.stopBreached).toBeNull();
    expect(futureCompletion.exitReference).toBeNull();
    expect(futureCompletion.exitReasons).toEqual([]);
    expect(futureCompletion.nextPendingExit).toBe(false);
  });

  it("keeps protection when mode or position data is unusable", () => {
    const badMode = bearishBarReclaim(
      reclaimInput({
        mode: "body" as never,
        position: {
          held: true,
          entryBarIndex: 3,
          canSell: true,
          frozenStopPrice: 120,
        },
      }),
    );
    expect(badMode.newEntryBlocked).toBe("MODE_NOT_FULL");
    expect(badMode.exitReference).toBe("EXIT_REFERENCE");

    const badPosition = bearishBarReclaim(
      reclaimInput({
        position: { held: "yes" as never, canSell: true },
        pendingExit: true,
      }),
    );
    expect(badPosition.newEntryBlocked).toBe("INVALID_POSITION");
    expect(badPosition.nextPendingExit).toBe(true);
  });

  it("returns frozen outputs and never mutates inputs", () => {
    const input = deepFreeze(clone(reclaimInput()));
    const result = bearishBarReclaim(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidate)).toBe(true);
    expect(Object.isFrozen(result.entry)).toBe(true);
    expect(Object.isFrozen(result.held)).toBe(true);
    expect(Object.isFrozen(result.timing)).toBe(true);
    expect(Object.isFrozen(result.parameters)).toBe(true);
    expect(Object.isFrozen(result.exitReasons)).toBe(true);
  });
});
