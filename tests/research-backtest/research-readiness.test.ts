import { expect, it } from "vitest";

import {
  evaluateResearchReadiness,
  type ReadinessSeries,
  type ResearchReadinessInput,
} from "../../src/lib/research/research-readiness";

const bar = (date: string, close = 10) => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1_000,
});
const complete = (date: string) => ({
  availableAt: `${date}T15:00:00+08:00`,
  bar: bar(date),
});
const missing = (date: string, reason = "suspend") => ({
  availableAt: `${date}T15:00:00+08:00`,
  bar: null,
  reason,
});
const series = (patch: Partial<ReadinessSeries> = {}) => ({
  instrument: "sh600000",
  period: "day",
  sourceHash: "source-bars",
  adjustmentId: "forward-adjustment-1",
  calendarHash: "calendar-sh-1",
  expectedSlots: 3,
  expectedFirstAvailableAt: "2026-01-05T15:00:00+08:00",
  expectedLastAvailableAt: "2026-01-07T15:00:00+08:00",
  requiredBars: 2,
  slots: [
    complete("2026-01-05"),
    complete("2026-01-06"),
    complete("2026-01-07"),
  ],
  ...patch,
});
const base = (): ResearchReadinessInput => ({
  asOf: "2026-01-31",
  evaluatedAt: "2026-02-01T09:00:00+08:00",
  instrument: "sh600000",
  market: "cn-equity",
  engineering: { runnable: true, reason: null },
  ruleCheck: {
    evaluated: true,
    failed: false,
    evidenceRef: "evidence/rule-check.json",
    checkedAt: "2026-01-20T15:00:00+08:00",
  },
  window: { start: "2026-01-01", end: "2026-01-31" },
  series: [series()],
  warmup: { decisionStart: "2026-01-08" },
  financial: { requiredFacts: [], missingFacts: [] },
  pointInTime: { status: "verified", reason: null },
  holdout: {
    start: "2026-01-15",
    end: "2026-01-31",
    usedRanges: [],
    checks: [],
  },
  forward: {
    source: "natural-forward",
    evidenceRef: "forward/ledger.json",
    observedDates: [],
    minimumDays: 3,
  },
});

it("keeps the five axes separate instead of one ordinal status", () => {
  const input = base();
  input.ruleCheck = { evaluated: false };
  input.holdout = undefined;
  input.forward = undefined;
  const result = evaluateResearchReadiness(input);
  expect(result).not.toHaveProperty("status");
  expect(result.axes).toEqual([
    "engineering",
    "ruleCheck",
    "dataQualification",
    "independentValidation",
    "forwardObservation",
  ]);
  expect(result.engineering.status).toBe("runnable");
  expect(result.ruleCheck.status).toBe("not-checked");
  expect(result.dataQualification.status).toBe("qualified");
  expect(result.independentValidation.status).toBe("unknown");
  expect(result.forwardObservation.status).toBe("unknown");
});

it("requires explicit failed=false plus evidence for a checked rule", () => {
  const unspecified = base();
  unspecified.ruleCheck = {
    evaluated: true,
    evidenceRef: "evidence/rule-check.json",
  };
  expect(evaluateResearchReadiness(unspecified).ruleCheck.status).toBe(
    "unknown",
  );

  const noEvidence = base();
  noEvidence.ruleCheck = { evaluated: true, failed: false };
  expect(evaluateResearchReadiness(noEvidence).ruleCheck.status).toBe(
    "not-checked",
  );

  expect(evaluateResearchReadiness(base()).ruleCheck.status).toBe("checked");
});

it("reports incomplete slots on both data and rule-check axes", () => {
  const input = base();
  input.series = [
    series({
      slots: [
        complete("2026-01-05"),
        missing("2026-01-06"),
        complete("2026-01-07"),
      ],
    }),
  ];
  const result = evaluateResearchReadiness(input);
  expect(result.dataQualification.status).toBe("partial");
  expect(result.dataQualification.series[0]!.slots).toEqual({
    total: 3,
    complete: 2,
    incomplete: 1,
  });
  expect(result.dataQualification.series[0]!.incomplete).toEqual([
    { availableAt: "2026-01-06T15:00:00+08:00", reason: "suspend" },
  ]);
  expect(result.ruleCheck.status).toBe("checked-partial");
  expect(result.ruleCheck.incompleteSlots).toBe(1);
});

it("counts warmup only as consecutive complete slots before decisionStart", () => {
  const input = base();
  input.warmup = { decisionStart: "2026-01-08" };
  input.series = [
    series({
      expectedSlots: 6,
      expectedFirstAvailableAt: "2026-01-05T15:00:00+08:00",
      expectedLastAvailableAt: "2026-01-14T15:00:00+08:00",
      requiredBars: 2,
      slots: [
        complete("2026-01-05"),
        complete("2026-01-06"),
        missing("2026-01-07"),
        complete("2026-01-12"),
        complete("2026-01-13"),
        complete("2026-01-14"),
      ],
    }),
  ];
  const result = evaluateResearchReadiness(input);
  expect(
    result.dataQualification.series[0]!.warmup.consecutiveCompleteBeforeStart,
  ).toBe(0);
  expect(result.dataQualification.warmup.status).toBe("unmet");
  expect(result.dataQualification.status).toBe("partial");
  // A later three-bar run does not establish initial readiness.
  expect(result.dataQualification.reasons.join(" ")).toContain("预热");
});

it("rejects mixing instruments and out-of-window observations", () => {
  const mixed = base();
  mixed.series = [series({ instrument: "sz000001" })];
  expect(() => evaluateResearchReadiness(mixed)).toThrow();

  const outsideWindow = base();
  outsideWindow.series = [
    series({
      slots: [
        complete("2025-12-31"),
        complete("2026-01-06"),
        complete("2026-01-07"),
      ],
    }),
  ];
  expect(() => evaluateResearchReadiness(outsideWindow)).toThrow();

  const windowPastAsOf = base();
  windowPastAsOf.window = { start: "2026-01-01", end: "2026-02-01" };
  expect(() => evaluateResearchReadiness(windowPastAsOf)).toThrow();
});

it("never qualifies empty slots, missing identities or expected-slot mismatches", () => {
  const empty = base();
  empty.series = [];
  expect(evaluateResearchReadiness(empty).dataQualification.status).toBe(
    "unqualified",
  );

  const missingIdentity = base();
  missingIdentity.series = [series({ sourceHash: null })];
  expect(
    evaluateResearchReadiness(missingIdentity).dataQualification.status,
  ).toBe("unqualified");

  const wrongCount = base();
  wrongCount.series = [series({ expectedSlots: 4 })];
  expect(evaluateResearchReadiness(wrongCount).dataQualification.status).toBe(
    "unqualified",
  );
});

it("treats financial facts and point-in-time limits explicitly", () => {
  const partial = base();
  partial.financial = {
    requiredFacts: ["netIncome", "totalAssets"],
    missingFacts: [{ fact: "totalAssets", reason: "report not published" }],
  };
  const partialResult = evaluateResearchReadiness(partial);
  expect(partialResult.dataQualification.status).toBe("unqualified");
  expect(partialResult.dataQualification.financial.status).toBe("partial");

  // Unqualified must win over an earlier limited point-in-time downgrade.
  const limitedAndMissing = base();
  limitedAndMissing.pointInTime = {
    status: "limited",
    reason: "only current revision",
  };
  limitedAndMissing.financial = {
    requiredFacts: ["netIncome", "issuance"],
    missingFacts: [{ fact: "issuance", reason: "no issuance evidence" }],
  };
  const severity = evaluateResearchReadiness(limitedAndMissing);
  expect(severity.dataQualification.pointInTime.status).toBe("limited");
  expect(severity.dataQualification.financial.status).toBe("partial");
  expect(severity.dataQualification.status).toBe("unqualified");

  const allMissing = base();
  allMissing.financial = {
    requiredFacts: ["netIncome", "totalAssets"],
    missingFacts: [
      { fact: "netIncome", reason: "missing" },
      { fact: "totalAssets", reason: "missing" },
    ],
  };
  expect(evaluateResearchReadiness(allMissing).dataQualification.status).toBe(
    "unqualified",
  );

  const limited = base();
  limited.pointInTime = { status: "limited", reason: "only current revision" };
  expect(evaluateResearchReadiness(limited).dataQualification.status).toBe(
    "partial",
  );

  const absentFinancial = base();
  absentFinancial.financial = undefined;
  expect(
    evaluateResearchReadiness(absentFinancial).dataQualification.financial
      .status,
  ).toBe("unknown");
  expect(
    evaluateResearchReadiness(absentFinancial).dataQualification.status,
  ).toBe("partial");
});

it("requires every series to have at least one complete slot", () => {
  const input = base();
  input.series = [
    series(),
    series({
      period: "week",
      expectedSlots: 1,
      expectedFirstAvailableAt: "2026-01-07T15:00:00+08:00",
      expectedLastAvailableAt: "2026-01-07T15:00:00+08:00",
      requiredBars: 0,
      slots: [missing("2026-01-07")],
    }),
  ];
  const result = evaluateResearchReadiness(input);
  expect(result.dataQualification.status).toBe("unqualified");
  expect(result.dataQualification.reasons.join(" ")).toContain(
    "至少一个必需序列没有任何完整槽",
  );
});

it("rejects a truncated window even when the supplied count matches", () => {
  const input = base();
  input.series = [
    series({
      expectedLastAvailableAt: "2026-01-09T15:00:00+08:00",
    }),
  ];
  const result = evaluateResearchReadiness(input);
  expect(result.dataQualification.status).toBe("unqualified");
  expect(result.dataQualification.series[0]!.truncated).toEqual({
    start: false,
    end: true,
  });
  expect(result.dataQualification.reasons.join(" ")).toContain("截断窗口");
});

it("uses UTC day boundaries for crypto and Beijing boundaries for CN equities", () => {
  const cryptoSlot = {
    availableAt: "2026-01-05T16:00:00Z",
    bar: bar("2026-01-05"),
  };
  const crypto = base();
  crypto.instrument = "BTCUSDT";
  crypto.market = "crypto";
  crypto.series = [
    series({
      instrument: "BTCUSDT",
      calendarHash: "calendar-crypto",
      expectedSlots: 1,
      expectedFirstAvailableAt: "2026-01-05T16:00:00Z",
      expectedLastAvailableAt: "2026-01-05T16:00:00Z",
      requiredBars: 1,
      slots: [cryptoSlot],
    }),
  ];
  crypto.warmup = { decisionStart: "2026-01-06" };
  const cryptoResult = evaluateResearchReadiness(crypto);
  // 16:00Z is before 00:00Z on Jan 6, so this completed day establishes warmup.
  expect(
    cryptoResult.dataQualification.series[0]!.warmup
      .consecutiveCompleteBeforeStart,
  ).toBe(1);
  expect(cryptoResult.dataQualification.warmup.status).toBe("met");

  const cn = base();
  cn.series = [
    series({
      expectedSlots: 1,
      expectedFirstAvailableAt: "2026-01-05T16:00:00Z",
      expectedLastAvailableAt: "2026-01-05T16:00:00Z",
      requiredBars: 1,
      slots: [cryptoSlot],
    }),
  ];
  cn.warmup = { decisionStart: "2026-01-06" };
  const cnResult = evaluateResearchReadiness(cn);
  // The same instant equals 00:00+08:00 on Jan 6 and is not strictly before start.
  expect(
    cnResult.dataQualification.series[0]!.warmup.consecutiveCompleteBeforeStart,
  ).toBe(0);
  expect(cnResult.dataQualification.warmup.status).toBe("unmet");
});

it("uses the full holdout window and never passes an exposed holdout", () => {
  const exposed = base();
  exposed.holdout = {
    start: "2026-01-15",
    end: "2026-01-31",
    usedRanges: [{ start: "2026-01-01", end: "2026-01-15" }],
    checks: [
      {
        id: "independent-1",
        outcome: "passed",
        evidenceRef: "evidence/independent.json",
        range: { start: "2026-01-16", end: "2026-01-30" },
      },
    ],
  };
  const exposedResult = evaluateResearchReadiness(exposed);
  expect(exposedResult.independentValidation.status).toBe("exposed");
  expect(exposedResult.independentValidation.touchedRanges).toEqual([
    {
      start: "2026-01-01",
      end: "2026-01-15",
      configHash: null,
    },
  ]);

  const unused = base();
  unused.holdout!.usedRanges = [{ start: "2026-01-01", end: "2026-01-14" }];
  expect(evaluateResearchReadiness(unused).independentValidation.status).toBe(
    "unused",
  );

  const passed = base();
  passed.holdout!.checks = [
    {
      id: "independent-1",
      outcome: "passed",
      evidenceRef: "evidence/independent.json",
      range: { start: "2026-01-16", end: "2026-01-30" },
    },
  ];
  expect(evaluateResearchReadiness(passed).independentValidation.status).toBe(
    "passed",
  );

  const noEvidence = base();
  noEvidence.holdout!.checks = [
    {
      id: "independent-1",
      outcome: "passed",
      range: { start: "2026-01-16", end: "2026-01-30" },
    },
  ];
  expect(
    evaluateResearchReadiness(noEvidence).independentValidation.status,
  ).toBe("incomplete");
});

it("bounds checks and used ranges by asOf and requires holdout start/end together", () => {
  const futureCheck = base();
  futureCheck.holdout!.checks = [
    {
      id: "future",
      outcome: "passed",
      evidenceRef: "evidence/future.json",
      range: { start: "2026-02-01", end: "2026-02-10" },
    },
  ];
  expect(() => evaluateResearchReadiness(futureCheck)).toThrow();

  const halfOpen = base();
  halfOpen.holdout!.end = null;
  expect(() => evaluateResearchReadiness(halfOpen)).toThrow();
});

it("does not count synthetic or historical-replay dates as forward observation", () => {
  const synthetic = base();
  synthetic.forward = {
    source: "synthetic",
    evidenceRef: "fixture/signal-ledger.json",
    observedDates: ["2026-01-20", "2026-01-21"],
    minimumDays: 3,
  };
  const result = evaluateResearchReadiness(synthetic);
  expect(result.forwardObservation.status).toBe("not-actual");
  expect(result.forwardObservation.observedDays).toBe(0);
  expect(result.forwardObservation.declaredDays).toBe(2);

  const noEvidence = base();
  noEvidence.forward = {
    source: "natural-forward",
    observedDates: ["2026-01-20"],
    minimumDays: 1,
  };
  expect(evaluateResearchReadiness(noEvidence).forwardObservation.status).toBe(
    "not-actual",
  );
});

it("counts only evidenced natural-forward dates and refuses duplicates", () => {
  const none = base();
  expect(evaluateResearchReadiness(none).forwardObservation.status).toBe(
    "none",
  );

  const accumulating = base();
  accumulating.forward!.observedDates = ["2026-01-20"];
  expect(
    evaluateResearchReadiness(accumulating).forwardObservation.status,
  ).toBe("accumulating");

  const met = base();
  met.forward!.observedDates = ["2026-01-20", "2026-01-21", "2026-01-22"];
  expect(evaluateResearchReadiness(met).forwardObservation.status).toBe(
    "minimum-met",
  );

  const duplicate = base();
  duplicate.forward!.observedDates = ["2026-01-20", "2026-01-20"];
  expect(() => evaluateResearchReadiness(duplicate)).toThrow();

  const future = base();
  future.forward!.observedDates = ["2026-02-01"];
  expect(() => evaluateResearchReadiness(future)).toThrow();
});

it("separates historical asOf from the actual evaluation time", () => {
  const input = base();
  input.asOf = "2020-12-31";
  input.evaluatedAt = "2026-11-17T10:00:00+08:00";
  input.window = { start: "2020-01-01", end: "2020-12-31" };
  input.series = [
    series({
      slots: [
        complete("2020-01-05"),
        complete("2020-01-06"),
        complete("2020-01-07"),
      ],
      expectedFirstAvailableAt: "2020-01-05T15:00:00+08:00",
      expectedLastAvailableAt: "2020-01-07T15:00:00+08:00",
    }),
  ];
  input.warmup = { decisionStart: "2020-01-08" };
  input.ruleCheck = {
    evaluated: true,
    failed: false,
    evidenceRef: "evidence/rule-check-2020.json",
    // A 2026 check of 2020 data is legitimate: asOf is not the run clock.
    checkedAt: "2026-11-16T10:00:00+08:00",
  };
  input.holdout = undefined;
  input.forward = undefined;
  const result = evaluateResearchReadiness(input);
  expect(result.asOf).toBe("2020-12-31");
  expect(result.evaluatedAt).toBe("2026-11-17T10:00:00+08:00");
  expect(result.ruleCheck.status).toBe("checked");
  expect(result.dataQualification.status).toBe("qualified");

  const futureCheck = base();
  futureCheck.ruleCheck = {
    ...futureCheck.ruleCheck!,
    checkedAt: "2026-02-02T09:00:00+08:00",
  };
  expect(() => evaluateResearchReadiness(futureCheck)).toThrow();
});

it("rejects timezone-less or date-only availability timestamps", () => {
  const missingZone = base();
  missingZone.evaluatedAt = "2026-02-01T09:00:00";
  expect(() => evaluateResearchReadiness(missingZone)).toThrow();

  const dateOnly = base();
  dateOnly.series = [
    series({
      slots: [
        { availableAt: "2026-01-05", bar: bar("2026-01-05") },
        complete("2026-01-06"),
        complete("2026-01-07"),
      ],
    }),
  ];
  expect(() => evaluateResearchReadiness(dateOnly)).toThrow();
});

it("rejects unknown keys so profit or pass flags cannot be silently adopted", () => {
  const withProfit = { ...base(), profitable: true } as ResearchReadinessInput;
  expect(() => evaluateResearchReadiness(withProfit)).toThrow();
  const withPass = base() as ResearchReadinessInput & { passed?: boolean };
  withPass.passed = true;
  expect(() => evaluateResearchReadiness(withPass)).toThrow();
});

it("uses an explicit decision instant inside the decision day", () => {
  const firstSlot = Date.parse("2026-01-01T00:05:00Z");
  const fiveMinutes = 5 * 60_000;
  // Ten full prior UTC days plus the current day's first decision bar:
  // 2881 end-labelled 5m slots, generated from the declared calendar.
  const slots = Array.from({ length: 2881 }, (_, index) => {
    const availableAt = new Date(firstSlot + index * fiveMinutes).toISOString();
    return { availableAt, bar: bar(availableAt) };
  });
  expect(slots).toHaveLength(2881);
  expect(slots.at(-1)!.availableAt).toBe("2026-01-11T00:05:00.000Z");
  const decisionInput = (decisionAvailableAt?: string) => {
    const input = base();
    input.instrument = "BTCUSDT";
    input.market = "crypto";
    input.window = { start: "2026-01-01", end: "2026-01-31" };
    input.series = [
      {
        instrument: "BTCUSDT",
        period: "5m",
        sourceHash: "btc-bars",
        adjustmentId: "spot",
        calendarHash: "utc-5m-calendar",
        expectedSlots: 2881,
        expectedFirstAvailableAt: slots[0]!.availableAt,
        expectedLastAvailableAt: slots.at(-1)!.availableAt,
        requiredBars: 2880,
        slots,
      },
    ];
    input.warmup = decisionAvailableAt
      ? { decisionStart: "2026-01-11", decisionAvailableAt }
      : { decisionStart: "2026-01-11" };
    return input;
  };

  const explicit = evaluateResearchReadiness(
    decisionInput("2026-01-11T00:05:00Z"),
  );
  const explicitSeries = explicit.dataQualification.series[0]!;
  // The 00:05 current decision bar is equal to the cutoff, so it is excluded.
  expect(explicitSeries.warmup.consecutiveCompleteBeforeStart).toBe(2880);
  expect(explicitSeries.warmup.status).toBe("met");
  expect(explicitSeries.slots).toEqual({
    total: 2881,
    complete: 2881,
    incomplete: 0,
  });
  expect(explicit.dataQualification.warmup).toMatchObject({
    decisionStart: "2026-01-11",
    decisionAvailableAt: "2026-01-11T00:05:00Z",
    status: "met",
  });
  expect(explicit.dataQualification.status).toBe("qualified");

  // Omitting the field keeps the old market-midnight cutoff: the 00:00Z bar is
  // not strictly before midnight, so only 2879 bars count.
  const defaultMidnight = evaluateResearchReadiness(decisionInput());
  expect(
    defaultMidnight.dataQualification.series[0]!.warmup
      .consecutiveCompleteBeforeStart,
  ).toBe(2879);
  expect(defaultMidnight.dataQualification.series[0]!.warmup.status).toBe(
    "unmet",
  );
  expect(defaultMidnight.dataQualification.warmup.decisionAvailableAt).toBe(
    "2026-01-11T00:00:00Z",
  );
});

it("rejects explicit decision instants outside the declared day or cutoffs", () => {
  const wrongMarketDay = base();
  wrongMarketDay.warmup = {
    decisionStart: "2026-01-08",
    decisionAvailableAt: "2026-01-09T00:05:00+08:00",
  };
  expect(() => evaluateResearchReadiness(wrongMarketDay)).toThrow();

  // 00:05+08:00 on Jan 11 is 16:05Z on Jan 10: a different crypto day.
  const wrongZoneDay = base();
  wrongZoneDay.market = "crypto";
  wrongZoneDay.warmup = {
    decisionStart: "2026-01-11",
    decisionAvailableAt: "2026-01-11T00:05:00+08:00",
  };
  expect(() => evaluateResearchReadiness(wrongZoneDay)).toThrow();

  const beyondWindow = base();
  beyondWindow.window = { start: "2026-01-01", end: "2026-01-10" };
  beyondWindow.warmup = {
    decisionStart: "2026-01-11",
    decisionAvailableAt: "2026-01-11T00:05:00+08:00",
  };
  expect(() => evaluateResearchReadiness(beyondWindow)).toThrow();

  const afterEvaluation = base();
  afterEvaluation.evaluatedAt = "2026-01-08T12:00:00+08:00";
  afterEvaluation.ruleCheck = {
    evaluated: true,
    failed: false,
    evidenceRef: "evidence/rule-check.json",
  };
  afterEvaluation.warmup = {
    decisionStart: "2026-01-08",
    decisionAvailableAt: "2026-01-08T13:00:00+08:00",
  };
  expect(() => evaluateResearchReadiness(afterEvaluation)).toThrow();

  // Date.parse would roll 2026-02-30 into March; the shared parser must not.
  const impossibleCalendar = base();
  impossibleCalendar.asOf = "2026-03-31";
  impossibleCalendar.evaluatedAt = "2026-04-01T09:00:00+08:00";
  impossibleCalendar.window = { start: "2026-03-01", end: "2026-03-31" };
  impossibleCalendar.series = [
    series({
      expectedSlots: 3,
      expectedFirstAvailableAt: "2026-03-02T15:00:00+08:00",
      expectedLastAvailableAt: "2026-03-04T15:00:00+08:00",
      slots: [
        complete("2026-03-02"),
        complete("2026-03-03"),
        complete("2026-03-04"),
      ],
    }),
  ];
  impossibleCalendar.warmup = {
    decisionStart: "2026-03-02",
    decisionAvailableAt: "2026-02-30T00:05:00Z",
  };
  expect(() => evaluateResearchReadiness(impossibleCalendar)).toThrow();

  const zoneLess = base();
  zoneLess.warmup = {
    decisionStart: "2026-01-08",
    decisionAvailableAt: "2026-01-08T00:05:00",
  };
  expect(() => evaluateResearchReadiness(zoneLess)).toThrow();

  const dateOnly = base();
  dateOnly.warmup = {
    decisionStart: "2026-01-08",
    decisionAvailableAt: "2026-01-08",
  };
  expect(() => evaluateResearchReadiness(dateOnly)).toThrow();
});

it("does not mutate a frozen input", () => {
  const input = base();
  const before = JSON.stringify(input);
  Object.freeze(input);
  const result = evaluateResearchReadiness(input);
  expect(JSON.stringify(input)).toBe(before);
  expect(result.forwardObservation.status).toBe("none");
});
