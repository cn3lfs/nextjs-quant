import { expect, it } from "vitest";
import {
  pollutionDecision,
  pollutionLimitState,
  pollutionEvidenceAt,
  cleanBlockVolume,
  researchVolumePollutionSeries,
  volumePollutionIds,
  type PollutionEvidence,
  type VolumePollutionId,
} from "../src/lib/research-volume-pollution";
function fixture(n = 65) {
  const bars = Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    close: 10,
    high: 10.2,
    low: 9.8,
    volume: 1000,
    amount: 10000,
  }));
  const i = n - 1;
  bars[i] = {
    ...bars[i]!,
    open: 10,
    close: 10.5,
    high: 11,
    low: 10,
    volume: 2000,
    amount: 21000,
  };
  const rows: PollutionEvidence[] = bars.map((b, j) => ({
    date: b.date,
    availableAt: `${b.date}T15:00:00+08:00`,
    source: "fixed fixture",
    limit: {
      up: 11,
      down: 9,
      path: [
        { at: `${b.date}T09:30:00+08:00`, price: 10 },
        { at: `${b.date}T15:00:00+08:00`, price: b.close },
      ],
      complete: true,
      openCount: 0,
      sealShares: 3000,
      volumeShares: b.volume,
      boards: 1,
      turnover: 5,
    },
    settlement: { kind: "stock", market: "sh", days: 1, source: "exchange" },
    block: {
      complete: true,
      included: true,
      shares: 0,
      amount: 0,
      totalShares: b.volume,
      totalAmount: b.amount,
      scope: "daily",
    },
    auction: {
      complete: true,
      last3Shares: 100,
      totalShares: b.volume,
      indexRebalance: false,
      etfCreation: false,
    },
    listing: {
      date: bars[0]!.date,
      tradingDates: bars.slice(0, j + 1).map((v) => v.date),
      complete: true,
    },
    resumption: {
      complete: true,
      date: null,
      suspendedSessions: 0,
      sessionsSince: 0,
      beforeVolumes: [],
    },
    orders: { complete: true, regularFraction: 0.2 },
    trades: { count: 100, volumeShares: b.volume },
    news: { complete: true, catalystVerified: true, volumeAuthentic: true },
    events: { complete: true, items: [] },
    seasonal: { complete: true, quarterEndDistance: 10 },
    float: { complete: true, shares: 100000, volumeShares: b.volume },
  }));
  return { bars, rows, i, e: rows[i]! };
}
function path(
  e: PollutionEvidence,
  prices: number[],
  bar: { open: number; close: number; high: number; low: number },
) {
  Object.assign(bar, {
    open: prices[0]!,
    close: prices.at(-1)!,
    high: Math.max(...prices),
    low: Math.min(...prices),
  });
  e.limit!.path = prices.map((price, j) => ({
    price,
    at: `${e.date}T${j === 0 ? "09:30" : j === prices.length - 1 ? "15:00" : `1${j}:00`}:00+08:00`,
  }));
  e.limit!.openCount = prices
    .slice(1)
    .filter((v, j) => prices[j] === 11 && v !== 11).length;
}
it.each(volumePollutionIds)("%s rejects absent required evidence", (id) => {
  const { bars, i } = fixture();
  expect(pollutionDecision(id, bars, i, []).reason).not.toBeNull();
});
it("all timestamp evidence is close-as-of, rejecting post-close LHB even on same date", () => {
  const { e } = fixture();
  expect(pollutionEvidenceAt([e], e.date)).toBeDefined();
  e.availableAt = `${e.date}T16:00:00+08:00`;
  expect(pollutionEvidenceAt([e], e.date)).toBeUndefined();
});
it("one-price book replaces contracted volume interpretation and preserves side", () => {
  const { bars, rows, i, e } = fixture();
  path(e, [11, 11], bars[i]!);
  expect(pollutionDecision("vp-limit-book", bars, i, rows)).toMatchObject({
    allow: true,
    entry: true,
  });
  e.limit!.sealShares = 100;
  expect(pollutionDecision("vp-limit-book", bars, i, rows).allow).toBe(false);
  path(e, [9, 9], bars[i]!);
  expect(pollutionDecision("vp-limit-book", bars, i, rows).exit).toBe(true);
  e.limit!.openCount = 2;
  expect(pollutionLimitState(e, e.date)).toBeNull();
});
it("reseal and two extreme path orders require actual chronological prices", () => {
  const { bars, rows, i, e } = fixture();
  path(e, [11, 10, 11], bars[i]!);
  expect(pollutionDecision("vp-limit-reseal-path", bars, i, rows).allow).toBe(
    true,
  );
  path(e, [11, 11], bars[i]!);
  expect(pollutionDecision("vp-limit-reseal-path", bars, i, rows).allow).toBe(
    false,
  );
  for (const prices of [
    [11, 9, 10],
    [9, 11, 10],
  ]) {
    path(e, prices, bars[i]!);
    expect(
      pollutionDecision("vp-limit-roundtrip-half", bars, i, rows).fraction,
    ).toBe(0.5);
  }
  path(e, [10, 10.5], bars[i]!);
  expect(
    pollutionDecision("vp-limit-roundtrip-half", bars, i, rows).fraction,
  ).toBe(1);
});
it("first/middle/accelerating limits use distinct volume and turnover gates", () => {
  const { bars, rows, i, e } = fixture();
  path(e, [10, 11], bars[i]!);
  expect(pollutionDecision("vp-limit-stages", bars, i, rows).allow).toBe(true);
  e.limit!.boards = 2;
  expect(pollutionDecision("vp-limit-stages", bars, i, rows).allow).toBe(false);
  path(e, [11, 10, 11], bars[i]!);
  expect(pollutionDecision("vp-limit-stages", bars, i, rows).allow).toBe(true);
  e.limit!.boards = 3;
  bars[i]!.volume = 500;
  expect(pollutionDecision("vp-limit-stages", bars, i, rows).allow).toBe(true);
  bars[i]!.volume = 1000;
  expect(pollutionDecision("vp-limit-stages", bars, i, rows).allow).toBe(false);
});
it("failed board with expansion and 40% upper wick exits", () => {
  const { bars, rows, i, e } = fixture();
  path(e, [10, 11, 10.5], bars[i]!);
  expect(pollutionDecision("vp-limit-wick-exit", bars, i, rows).exit).toBe(
    true,
  );
  bars[i]!.high = 10.7;
  expect(pollutionDecision("vp-limit-wick-exit", bars, i, rows).exit).toBe(
    false,
  );
});
it("settlement identity refuses unsupported T+0 instead of pretending T+1", () => {
  const { bars, rows, i, e } = fixture();
  expect(pollutionDecision("vp-settlement-evidence", bars, i, rows).allow).toBe(
    true,
  );
  e.settlement!.days = 0;
  expect(
    pollutionDecision("vp-settlement-evidence", bars, i, rows).reason,
  ).toContain("不适用");
});
it("confirmed included blocks subtract both measures and recalculate full baseline", () => {
  const { bars, rows, i, e } = fixture();
  expect(pollutionDecision("vp-block-clean", bars, i, rows).ratio).toBe(2);
  e.block!.shares = 1500;
  e.block!.amount = 15000;
  expect(pollutionDecision("vp-block-clean", bars, i, rows).allow).toBe(false);
  expect(cleanBlockVolume(e)).toMatchObject({ shares: 500, amount: 6000 });
  e.block!.included = false;
  expect(cleanBlockVolume(e)!.shares).toBe(2000);
  e.block!.shares = 3000;
  expect(cleanBlockVolume(e)).toBeNull();
});
it("auction volume alone is not enough; verified index/ETF event and concentration jointly block", () => {
  const { bars, rows, i, e } = fixture();
  e.auction!.last3Shares = 1000;
  expect(pollutionDecision("vp-auction-exclude", bars, i, rows).allow).toBe(
    true,
  );
  e.auction!.indexRebalance = true;
  expect(pollutionDecision("vp-auction-exclude", bars, i, rows).allow).toBe(
    false,
  );
  e.auction!.last3Shares = 999;
  expect(pollutionDecision("vp-auction-exclude", bars, i, rows).allow).toBe(
    true,
  );
});
it("IPO uses all its own history, short histories can execute at half size", () => {
  const { bars, rows, i } = fixture(3);
  expect(
    researchVolumePollutionSeries("vp-ipo-own", bars, rows)[i],
  ).toMatchObject({ entry: true, entryFraction: 0.5 });
  const older = fixture(60);
  expect(
    pollutionDecision("vp-ipo-own", older.bars, older.i, older.rows).reason,
  ).toContain("60");
  rows[i]!.listing!.tradingDates.splice(1, 0, "2022-01-01");
  expect(pollutionDecision("vp-ipo-own", bars, i, rows).reason).not.toBeNull();
});
it("resumption isolates first five sessions and waits for volume normalization", () => {
  const { bars, rows, i, e } = fixture();
  e.resumption = {
    complete: true,
    date: bars[i - 5]!.date,
    suspendedSessions: 10,
    sessionsSince: 4,
    beforeVolumes: Array(20).fill(1000),
  };
  expect(pollutionDecision("vp-resumption-normal", bars, i, rows).allow).toBe(
    false,
  );
  e.resumption.sessionsSince = 5;
  expect(pollutionDecision("vp-resumption-normal", bars, i, rows).allow).toBe(
    true,
  );
  bars[i]!.volume = 2001;
  expect(pollutionDecision("vp-resumption-normal", bars, i, rows).allow).toBe(
    false,
  );
});
it("order shape and actual mean trade size are independent risk hypotheses", () => {
  const { bars, rows, i, e } = fixture();
  bars[i]!.close = 10;
  e.orders!.regularFraction = 0.8;
  expect(pollutionDecision("vp-order-shape-risk", bars, i, rows).allow).toBe(
    false,
  );
  e.orders!.regularFraction = 0.79;
  expect(pollutionDecision("vp-order-shape-risk", bars, i, rows).allow).toBe(
    true,
  );
  e.trades!.count = 50;
  e.trades!.volumeShares = 1500;
  expect(pollutionDecision("vp-trade-size-risk", bars, i, rows).allow).toBe(
    false,
  );
  e.trades!.count = 51;
  expect(pollutionDecision("vp-trade-size-risk", bars, i, rows).allow).toBe(
    true,
  );
});
it("isolated volume requires actual next day continuation and verified news, no candidate backfill", () => {
  const { bars, rows, i, e } = fixture();
  bars[i - 2]!.volume = 100;
  bars[i - 1]!.volume = 3000;
  expect(
    pollutionDecision("vp-isolated-news-confirm", bars, i, rows).allow,
  ).toBe(true);
  e.news!.catalystVerified = false;
  expect(
    pollutionDecision("vp-isolated-news-confirm", bars, i, rows).allow,
  ).toBe(false);
  e.news!.complete = false;
  expect(
    pollutionDecision("vp-isolated-news-confirm", bars, i, rows).reason,
  ).not.toBeNull();
});
it.each([
  ["vp-event-lhb-filter", "lhb"],
  ["vp-event-unlock-filter", "unlock"],
  ["vp-event-index-filter", "index-in"],
  ["vp-event-index-filter", "index-out"],
] as const)("%s handles %s as-of events", (id, kind) => {
  const { bars, rows, i, e } = fixture();
  expect(pollutionDecision(id, bars, i, rows).allow).toBe(true);
  e.events!.items = [
    {
      kind,
      availableAt: e.availableAt,
      effectiveDate: e.date,
      ageSessions: 0,
      speculative: true,
      oldFloat: 100,
      newFloat: 200,
    },
  ];
  expect(pollutionDecision(id, bars, i, rows).allow).toBe(false);
  e.events!.items[0]!.availableAt = `${e.date}T17:00:00+08:00`;
  expect(pollutionDecision(id, bars, i, rows).reason).not.toBeNull();
});
it("merger reduction ends after five sessions; seasonality uses preknown calendar distance", () => {
  const { bars, rows, i, e } = fixture();
  e.events!.items = [
    {
      kind: "merger",
      availableAt: e.availableAt,
      effectiveDate: e.date,
      ageSessions: 4,
    },
  ];
  expect(
    pollutionDecision("vp-event-merger-half", bars, i, rows).fraction,
  ).toBe(0.5);
  e.events!.items[0]!.ageSessions = 5;
  expect(
    pollutionDecision("vp-event-merger-half", bars, i, rows).fraction,
  ).toBe(1);
  e.seasonal!.quarterEndDistance = 2;
  expect(
    pollutionDecision("vp-event-seasonal-filter", bars, i, rows).allow,
  ).toBe(false);
  e.seasonal!.quarterEndDistance = 3;
  expect(
    pollutionDecision("vp-event-seasonal-filter", bars, i, rows).allow,
  ).toBe(true);
});
it("six-step composite executes corrections in order and missing evidence cannot masquerade as clean", () => {
  const { bars, rows, i, e } = fixture();
  const r = pollutionDecision("vp-pollution-six", bars, i, rows);
  expect(r).toMatchObject({ allow: true, reason: null, ratio: 2 });
  expect(r.trace.indexOf("vp-block-clean")).toBeLessThan(
    r.trace.indexOf("vp-auction-exclude"),
  );
  delete e.news;
  expect(pollutionDecision("vp-pollution-six", bars, i, rows).reason).toContain(
    "消息",
  );
});
it("six-step one-price book does not silently reinstate the rejected ordinary-volume interpretation", () => {
  const { bars, rows, i, e } = fixture();
  path(e, [11, 11], bars[i]!);
  bars[i]!.volume = 100;
  e.limit!.volumeShares = 100;
  e.block!.totalShares = 100;
  e.block!.totalAmount = 1100;
  e.auction!.totalShares = 100;
  e.auction!.last3Shares = 10;
  e.float!.volumeShares = 100;
  e.trades!.volumeShares = 100;
  const r = researchVolumePollutionSeries("vp-pollution-six", bars, rows)[i]!;
  expect(r.reason).toBeNull();
  expect(r.entry).toBe(true);
});
