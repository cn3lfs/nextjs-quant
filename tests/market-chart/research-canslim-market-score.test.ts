import { canslimMarketTierIds } from "trading-strategies/research/canslim/research-canslim-market-strategies";
import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import {
  canslimMarketBinaryIds as canslimMarketIds,
  type CanslimMarketId,
} from "trading-strategies/research/canslim/research-canslim-market-strategies";
import { researchCanslimMarketScore } from "trading-strategies/research/canslim/research-canslim-market-score";

const bars = (): Bar[] =>
  Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
function fixture(id: CanslimMarketId) {
  const stocks = bars(),
    index = bars();
  if (id.endsWith("ma250")) index[260]!.close = 102;
  else if (id.endsWith("follow10"))
    Object.assign(index[260]!, { close: 101.5, volume: 151 });
  else {
    for (let i = 260; i < index.length; i++) {
      index[i]!.close = 100 - Math.min(5, i - 259);
      if (i < 265) index[i]!.volume = 100 + (i - 259) * 20;
    }
  }
  const market = {
    symbol: "sh000300",
    source: "fixture",
    hash: "fixture",
    bars: index,
  };
  const calendar = stocks.map((b) => b.date);
  return { stocks, index, market, calendar };
}
it.each(canslimMarketIds)(
  "%s preserves missing data and does not substitute another index or stock",
  (id) => {
    const { stocks, index, market, calendar } = fixture(id);
    expect(
      researchCanslimMarketScore(id, stocks, calendar).every(
        (p) => p.diagnostic.points === null,
      ),
    ).toBe(true);
    expect(
      researchCanslimMarketScore(id, stocks, calendar, {
        ...market,
        symbol: "sh000001",
      }).every((p) => p.diagnostic.points === null),
    ).toBe(true);
    const day = id.endsWith("distribution20") ? 280 : 260;
    index[day]!.volume = 0;
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market)[day],
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
    index[day]!.volume = 100;
    index.splice(day - 2, 1);
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market)[day],
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
  },
);
it("keeps MA equality, 1.5% price equality and strict 1.5 volume boundary distinct", () => {
  const { stocks, index, market, calendar } = fixture(
    "canslim-market-entry-follow10",
  );
  index[260]!.volume = 150;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(0);
  index[260]!.volume = 150.001;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(8);
  index[260]!.close = 101.499;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(0);
  expect(
    researchCanslimMarketScore("canslim-market-entry-ma250", stocks, calendar, {
      ...market,
      bars: bars(),
    })[260]!.diagnostic.points,
  ).toBe(0);
});

it.each(["canslim-market-tier-ma250", "canslim-market-tier-ma200"] as const)(
  "%s keeps the three-point and falling-average seven-point branches",
  (id) => {
    const input = bars();
    input.forEach((b, i) => {
      b.high = 250;
      b.close = i < 180 ? 200 : 100;
    });
    input[299]!.close = 130;
    const stock = bars(),
      calendar = stock.map((b) => b.date),
      market = {
        symbol: "sh000300",
        source: "fixture",
        hash: "fixture",
        bars: input,
      };
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic
        .points,
    ).toBe(3);
    input[299]!.close = 90;
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic
        .points,
    ).toBe(0);
    for (let i = 296; i < 300; i++) input[i]!.close = 180;
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic,
    ).toMatchObject({
      points: 7,
      details: { rising: false, aboveFourDays: true },
    });
  },
);

it.each(canslimMarketIds)(
  "%s scores only matching CSI300 prefixes without future leakage",
  (id) => {
    const { stocks, index, market, calendar } = fixture(id);
    const day = id.endsWith("distribution20") ? 280 : 260;
    const full = researchCanslimMarketScore(id, stocks, calendar, market);
    expect(full.filter((p) => p.entry).map((p) => p.date)).toEqual([
      stocks[day]!.date,
    ]);
    expect(full[day - 1]!.diagnostic.points).toBe(0);
    expect(full[day]!.diagnostic.points).toBe(
      id.endsWith("ma250") ? 10 : id.endsWith("follow10") ? 8 : 5,
    );
    for (const end of [260, 261, 280, 281])
      expect(
        researchCanslimMarketScore(
          id,
          stocks.slice(0, end),
          calendar.slice(0, end),
          { ...market, bars: index.slice(0, end) },
        ),
      ).toEqual(full.slice(0, end));
    index[290]!.close = 1000;
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market).slice(0, 290),
    ).toEqual(full.slice(0, 290));
  },
);
it.each(canslimMarketTierIds)(
  "%s retains source tiers and calculation thresholds",
  (id) => {
    const input = bars();
    if (id.endsWith("ma250") || id.endsWith("ma200"))
      for (let i = 260; i < input.length; i++) input[i]!.close = 110;
    else if (id.endsWith("follow10"))
      input.forEach((b, i) => {
        b.low = i === 260 ? 90 : i > 260 ? 95 : 99;
        b.close = i === 260 ? 99 : i < 264 ? 100 : 102;
        b.volume = i === 264 ? 151 : 100;
      });
    else
      for (const i of [260, 262, 264]) {
        input[i]!.close = 99;
        input[i]!.volume = 150;
      }
    const stock = bars(),
      calendar = stock.map((b) => b.date),
      market = {
        symbol: "sh000300",
        source: "fixture",
        hash: "fixture",
        bars: input,
      };
    const full = researchCanslimMarketScore(id, stock, calendar, market);
    const day =
      id.endsWith("ma250") || id.endsWith("ma200")
        ? 263
        : id.endsWith("follow10")
          ? 264
          : 280;
    expect(full[day]!.entry).toBe(true);
    if (id.endsWith("ma250") || id.endsWith("ma200")) {
      expect(full[259]!.diagnostic.points).toBe(5);
      expect(full.slice(260, 263).map((p) => p.diagnostic.points)).toEqual([
        7, 7, 7,
      ]);
      expect(full[263]!.diagnostic.points).toBe(10);
    } else if (id.endsWith("follow10")) {
      expect(full[264]!.diagnostic.points).toBe(8);
      input[267]!.low = 94;
      const changed = researchCanslimMarketScore(id, stock, calendar, market);
      expect(changed[267]!.diagnostic.points).toBe(0);
      expect(changed.slice(0, 267)).toEqual(full.slice(0, 267));
      input[267]!.low = 95;
      input[264]!.volume = 150;
      expect(
        researchCanslimMarketScore(id, stock, calendar, market)[264]!.diagnostic
          .points,
      ).toBe(4);
      input[264]!.volume = 151;
    } else {
      expect(full[264]!.diagnostic.points).toBe(0);
      expect(full[265]!.diagnostic.points).toBe(3);
      expect(full[280]!.diagnostic.points).toBe(5);
    }
    expect(
      researchCanslimMarketScore(
        id,
        stock.slice(0, day + 1),
        calendar.slice(0, day + 1),
        { ...market, bars: input.slice(0, day + 1) },
      ),
    ).toEqual(full.slice(0, day + 1));
  },
);
