import { expect, it } from "vitest";
import {
  marketAdmissionDecision,
  marketAdmissionInputsSchema,
  type MarketAdmissionId,
} from "../src/lib/research-market-admission";

function fixture() {
  const calendar = Array.from({ length: 90 }, (_, i) =>
    new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
  );
  const date = calendar[59]!;
  return {
    symbol: "sh600000",
    date,
    at: `${date}T14:00:00+08:00`,
    previousClose: 100,
    observedPrice: 107.9,
    calendar,
    rows: marketAdmissionInputsSchema.parse([
      {
        symbol: "sh600000",
        date,
        source: "synthetic history",
        version: "fixture-1",
        effectiveAt: `${date}T09:25:00+08:00`,
        availableAt: `${date}T09:25:00+08:00`,
        capturedAt: `${date}T15:00:00+08:00`,
        limitFraction: 0.1,
        st: false,
        listedDate: calendar[0],
        resumption: { coverageComplete: true, date: calendar[57] },
        reports: {
          coverageComplete: true,
          windowStart: calendar[0],
          windowEnd: calendar[89],
          events: [],
        },
        auction: {
          stage: "final",
          observedAt: `${date}T09:25:00+08:00`,
          price: 101,
        },
      },
    ]),
  };
}
it.each([
  ["AR01-time-window", "14:00", "14:30"],
  ["AR01-morning", "10:00", "10:30"],
  ["AR01-afternoon", "13:00", "13:30"],
] as const)(
  "%s is an explicit left-closed comparison window",
  (id, start, end) => {
    const f = fixture();
    f.at = `${f.date}T${start}:00+08:00`;
    expect(marketAdmissionDecision(id, f).allow).toBe(true);
    f.at = `${f.date}T${end}:00+08:00`;
    expect(marketAdmissionDecision(id, f).allow).toBe(false);
  },
);
it.each([0.05, 0.1, 0.2, 0.3])(
  "AR02 historical limit %s uses strict 80%% gate",
  (limit) => {
    const f = fixture();
    f.rows[0]!.limitFraction = limit;
    f.observedPrice = 100 * (1 + limit * 0.8);
    expect(marketAdmissionDecision("AR02-gain-filter", f).allow).toBe(false);
    f.observedPrice -= 0.01;
    expect(marketAdmissionDecision("AR02-gain-filter", f).allow).toBe(true);
    f.rows[0]!.limitFraction = null;
    expect(marketAdmissionDecision("AR02-gain-filter", f).status).toBe(
      "missing",
    );
  },
);
it("AR03 rejects historical ST, not a current security label", () => {
  const f = fixture();
  expect(marketAdmissionDecision("AR03-st-filter", f).allow).toBe(true);
  f.rows[0]!.st = true;
  expect(marketAdmissionDecision("AR03-st-filter", f).allow).toBe(false);
  delete f.rows[0]!.st;
  expect(marketAdmissionDecision("AR03-st-filter", f).status).toBe("missing");
});
it.each([
  ["AR04-ipo-age", 60],
  ["AR05-resumption", 3],
] as const)("%s counts first session as one, inclusive %i", (id, count) => {
  const f = fixture();
  expect(marketAdmissionDecision(id, f).allow).toBe(true);
  if (id === "AR04-ipo-age") f.rows[0]!.listedDate = f.calendar[1];
  else f.rows[0]!.resumption!.date = f.calendar[58]!;
  expect(marketAdmissionDecision(id, f).allow).toBe(false);
  if (id === "AR04-ipo-age") f.rows[0]!.listedDate = "2021-01-01";
  else delete f.rows[0]!.resumption;
  expect(marketAdmissionDecision(id, f).status).toBe("missing");
});
it("AR06 complete empty schedule passes; known +/-5 blocks, +/-6 passes, future disclosure cannot backfill", () => {
  const f = fixture();
  expect(marketAdmissionDecision("AR06-report-window", f).allow).toBe(true);
  for (const offset of [-6, -5, 5, 6]) {
    f.rows[0]!.reports!.events = [
      { date: f.calendar[59 + offset]!, announcedAt: f.rows[0]!.availableAt },
    ];
    expect(marketAdmissionDecision("AR06-report-window", f).allow).toBe(
      Math.abs(offset) > 5,
    );
  }
  f.rows[0]!.reports!.events[0]!.announcedAt = `${f.calendar[60]}T09:00:00+08:00`;
  expect(marketAdmissionDecision("AR06-report-window", f).status).toBe(
    "missing",
  );
});
it("AR07 has disclosed engineering size thresholds", () => {
  const f = fixture();
  for (const [time, allow, multiplier] of [
    ["09:55", false, 1],
    ["10:00", true, 1],
    ["14:00", true, 0.5],
    ["14:30", true, 0.25],
  ] as const) {
    f.at = `${f.date}T${time}:00+08:00`;
    expect(marketAdmissionDecision("AR07-late-size", f)).toMatchObject({
      allow,
      multiplier,
    });
  }
});
it("AR08 final 09:25 proof, not first five-minute close, is mandatory", () => {
  const f = fixture();
  expect(marketAdmissionDecision("AR08-auction-confirm", f).allow).toBe(true);
  f.rows[0]!.auction!.price = 99;
  f.observedPrice = 200;
  expect(marketAdmissionDecision("AR08-auction-confirm", f).allow).toBe(false);
  for (const stage of ["cancellable", "indicative"] as const) {
    f.rows[0]!.auction!.stage = stage;
    expect(marketAdmissionDecision("AR08-auction-confirm", f).status).toBe(
      "missing",
    );
  }
});
it.each([
  "AR02-gain-filter",
  "AR03-st-filter",
  "AR04-ipo-age",
  "AR05-resumption",
  "AR06-report-window",
  "AR08-auction-confirm",
] as MarketAdmissionId[])(
  "%s rejects absent/ambiguous/future evidence",
  (id) => {
    const f = fixture();
    expect(marketAdmissionDecision(id, { ...f, rows: [] }).status).toBe(
      "missing",
    );
    expect(
      marketAdmissionDecision(id, { ...f, rows: [...f.rows, ...f.rows] })
        .status,
    ).toBe("missing");
    f.rows[0]!.availableAt = `${f.date}T14:01:00+08:00`;
    expect(marketAdmissionDecision(id, f).status).toBe("missing");
  },
);
