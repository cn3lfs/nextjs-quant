import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import valid from "./fixtures/breakout-valid.json";
import fake from "./fixtures/breakout-false.json";
import short from "./fixtures/breakout-insufficient.json";
import { analyzeBreakout, breakoutPatterns } from "../src/server/breakout";
import { breakoutMethod } from "../src/server/research-skills";
import { vcpFacts } from "../src/server/vcp";
import { boll, kdj, macd, rsi } from "../src/lib/indicators";
import { breakoutChartData } from "../src/lib/chart-data";
import { monitorStrategy } from "../src/server/monitor-strategy";
import { strategySchema, type Bar } from "../src/lib/domain";

// Real, unadjusted TDX files; full initial history preserved for recursive M1
// seeds. Manual confirmation is reserved for the manager, not filled by code.
// Effective breakout: bj920748 2025-03-07. Confirmed highs 02-13 28.00,
// 02-24 27.66, seven sessions apart. Nine sessions later line =
// 27.66 + (27.66-28)/7*9 = 27.222857142857. Bull body 26.60 ->28.70
// clears both line and 27.66. 4,890,100 / (49,403,888/20) =1.979641764.
// Next five closes 31.29/29.60/30.77/29.40/30.46 stay above the broken high;
// those future prices justify case selection only, never signal computation.
it("recalculates the effective real breakout, five checks and missing second target", () => {
  const p = analyzeBreakout(valid.bars).latest!;
  expect(p.date).toBe("2025-03-07");
  expect(
    p.long.line?.anchors.map((p) => [p.date, p.price, p.confirmedAt]),
  ).toEqual([
    ["2025-02-13", 28, "2025-02-18"],
    ["2025-02-24", 27.66, "2025-02-27"],
  ]);
  expect(p.long.line?.value).toBeCloseTo(27.66 + ((27.66 - 28) / 7) * 9, 10);
  expect(p.long.line?.touches).toBe(2);
  expect(p.long.keyLevel).toMatchObject({ price: 27.66, source: "swing-high" });
  expect(p.volume20).toBeCloseTo(49403888 / 20, 6);
  expect(p.volumeRatio).toBeCloseTo(4890100 / (49403888 / 20), 10);
  expect(p.long).toMatchObject({
    status: "是",
    quality: "4/5",
    checks: {
      trend: "是",
      level: "是",
      volume: "是",
      indicators: "是",
      candle: "否",
    },
    indicatorVotes: { MACD: "是", KDJ: "是", RSI: "是", BOLL: "是" },
    patterns: [],
  });
  expect(p.long.risk).toMatchObject({
    stop: { price: 23.8, source: "swing-low" },
    target1: { price: 30, source: "round" },
    target2: null,
    rewardMultiple: null,
    ratio: "未知",
  });
});

// False breakout: sh600519 2025-04-03. Highs 03-17 1657.99 /03-27 1598.25,
// 8 sessions apart; 5 later line=1598.25+(1598.25-1657.99)/8*5=1560.9125.
// Former support 1562.38 now overhead after falling below it. Close1568.88
// clears both, but 3,548,050/(63,665,106/20)=1.114598 <1.5. Only KDJ
// agrees, despite bullish engulfing. Next session close1500 loses both levels.
// Stop1562.38, T1=prior MA20 1572.8495, T2=1598.25; X=29.37/6.50.
it("rejects the real false breakout despite a bullish engulfing and 3/5 score", () => {
  const p = analyzeBreakout(fake.bars).latest!;
  expect(p.date).toBe("2025-04-03");
  expect(p.long.line?.value).toBeCloseTo(
    1598.25 + ((1598.25 - 1657.99) / 8) * 5,
    10,
  );
  expect(p.long.line?.anchors.map((p) => [p.date, p.price])).toEqual([
    ["2025-03-17", 1657.99],
    ["2025-03-27", 1598.25],
  ]);
  expect(p.long.keyLevel).toMatchObject({
    price: 1562.38,
    source: "swing-low",
  });
  expect(p.volume20).toBeCloseTo(63665106 / 20, 6);
  expect(p.volumeRatio).toBeCloseTo(3548050 / (63665106 / 20), 10);
  expect(p.long).toMatchObject({
    status: "否",
    quality: "3/5",
    checks: {
      trend: "是",
      level: "是",
      volume: "否",
      indicators: "否",
      candle: "是",
    },
    patterns: ["看涨吞没"],
    indicatorVotes: { MACD: "否", KDJ: "是", RSI: "否", BOLL: "否" },
  });
  expect(p.long.risk).toMatchObject({
    stop: { price: 1562.38 },
    target1: { price: 1572.8495 },
    target2: { price: 1598.25 },
    ratio: "1:4.52",
  });
  expect(p.long.risk.rewardMultiple).toBeCloseTo(
    (1598.25 - 1568.88) / (1568.88 - 1562.38),
    10,
  );
});

// Insufficient: sz002084 IPO history, 2006-11-24..2007-02-27 (59 sessions).
// Close26.05, volume3,619,322, relative volume1.7011 cannot compensate for
// unavailable full 60-session structure window and prior MA60. No invented level.
it("returns unknown on a real IPO history even when relative volume exceeds 1.5", () => {
  const p = analyzeBreakout(short.bars).latest!;
  expect(short.bars).toHaveLength(59);
  expect(p.date).toBe("2007-02-27");
  expect(p.close).toBe(26.05);
  expect(p.volumeRatio).toBeGreaterThan(1.5);
  expect(p.levels).toEqual([]);
  for (const s of [p.long, p.short]) {
    expect(Object.values(s.checks)).toEqual(Array(5).fill("未知"));
    expect(s).toMatchObject({
      status: "未知",
      score: null,
      quality: "未知",
      line: null,
      keyLevel: null,
      risk: { ratio: "未知" },
    });
  }
});

it("records the reread skill hashes using the existing research-skills mechanism", async () => {
  expect(analyzeBreakout([]).method).toEqual(await breakoutMethod());
  for (const f of [valid, fake, short])
    expect(
      createHash("sha256").update(JSON.stringify(f.bars)).digest("hex"),
    ).toBe(f.barsHash);
});
it("reuses diagnostic-2 confirmed extrema and quarantines all data before an ambiguity", () => {
  const bars = structuredClone(valid.bars),
    i = bars.length - 1,
    start = i - 60;
  const facts = vcpFacts({
    id: "test",
    hash: "",
    symbol: valid.symbol,
    period: "day",
    adjustment: "none",
    source: "tdx-local",
    createdAt: 0,
    bars: bars.slice(0, i),
  });
  const barrier = facts.ambiguousDates!.at(-1);
  expect(analyzeBreakout(bars).latest!.swings).toEqual(
    facts
      .extrema!.filter((p) => !barrier || p.date > barrier)
      .map((p) => ({ ...p, index: p.index + start })),
  );
  bars[i - 8]!.high = 1000;
  bars[i - 8]!.low = 0.01;
  const p = analyzeBreakout(bars).latest!;
  expect(p.ambiguousDates).toContain(bars[i - 8]!.date);
  expect(p.swings.every((s) => s.index > i - 8)).toBe(true);
  expect(p.long.line).toBeNull();
  expect(p.long.status).toBe("未知");
});
it("uses M1 indicator direction with the full snapshot seed", () => {
  for (const f of [valid, fake]) {
    const p = analyzeBreakout(f.bars).latest!,
      m = macd(f.bars).at(-1)!,
      k = kdj(f.bars).at(-1)!,
      r = rsi(f.bars).at(-1)!,
      b = boll(f.bars).at(-1)!;
    const check = (n: boolean) => (n ? "是" : "否");
    expect(p.long.indicatorVotes).toEqual({
      MACD: check(m.dif! > m.dea!),
      KDJ: check(k.k! > k.d!),
      RSI: check(r.rsi6! > 50),
      BOLL: check(p.close > b.mid!),
    });
  }
});
it("is deterministic, immutable and future-leak free (M1 prefix-equality harness)", () => {
  for (const f of [valid, fake, short]) {
    const bars = Object.freeze(f.bars.map((b) => Object.freeze({ ...b })));
    const from = Math.max(0, bars.length - 65),
      before = analyzeBreakout(bars, from);
    expect(analyzeBreakout(bars, from)).toEqual(before);
    const future = f.future.map((b, i) => ({
      ...b,
      high: b.high * (i + 10),
      low: b.low / 10,
      volume: b.volume * 100,
    }));
    expect(
      analyzeBreakout([...bars, ...future], from).points.slice(
        0,
        before.points.length,
      ),
    ).toEqual(before.points);
    for (const p of before.points)
      expect(p).toEqual(analyzeBreakout(bars.slice(0, p.index + 1)).latest);
  }
});
it("rejects shadow-only breaks, exact line touches, zero baseline and malformed/flat inputs", () => {
  const bars = structuredClone(valid.bars),
    last = bars.at(-1)!;
  last.close = last.open;
  last.high = 50;
  expect(analyzeBreakout(bars).latest!.long.checks.trend).toBe("否");
  last.close = 27.66 + ((27.66 - 28) / 7) * 9;
  expect(analyzeBreakout(bars).latest!.long.checks.trend).toBe("否");
  bars.forEach((b) => {
    b.volume = 0;
  });
  expect(analyzeBreakout(bars).latest!.long.checks.volume).toBe("未知");
  bars[0]!.close = NaN;
  expect(analyzeBreakout(bars).latest!.long.status).toBe("未知");
  const flat = valid.bars.map((b) => ({
    ...b,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
  }));
  expect(analyzeBreakout(flat).latest!.long.checks.indicators).toBe("未知");
  expect(analyzeBreakout([]).latest).toBeNull();
});
it("renders confirmed breakthrough markers and source-tagged levels without backdating availability", () => {
  const result = analyzeBreakout(valid.bars, 310),
    overlay = breakoutChartData(result, valid.bars, 315);
  expect(overlay.markers.at(-1)).toMatchObject({
    time: "2025-03-07",
    shape: "arrowUp",
    text: "双突破↑ 4/5",
  });
  expect(overlay.lines.some((l) => l.title.includes("swing-high 27.66"))).toBe(
    true,
  );
  expect(
    overlay.lines.find((l) => l.title.includes("swing-high 27.66"))!.data[0]!
      .time,
  ).toBe("2025-02-27");
  expect(
    breakoutChartData(result, valid.bars, 315, 373).markers.some(
      (m) => m.time === "2025-03-07",
    ),
  ).toBe(false);
});
it("enters the M4 strategy slot with baseline and dedup semantics, without an MA fallback", async () => {
  const strategy = strategySchema.parse({ type: "dual-breakout", params: {} });
  const baseline = await monitorStrategy(
    valid.bars.slice(0, -1),
    strategy,
    undefined,
  );
  expect(baseline.value?.matched).toBe(false);
  const previous = {
    date: valid.bars.at(-2)!.date,
    matched: false,
    signalKeys: baseline.keys!,
  };
  const signal = await monitorStrategy(valid.bars, strategy, previous);
  expect(signal.value?.matched).toBe(true);
  expect(signal.breakout?.latest?.long.quality).toBe("4/5");
  const duplicate = await monitorStrategy(valid.bars, strategy, {
    ...previous,
    date: valid.cutoff,
    matched: true,
    signalKeys: signal.keys!,
  });
  expect(duplicate.value?.matched).toBe(false);
  expect(
    (await monitorStrategy(short.bars, strategy, previous)).value?.matched,
  ).toBe(false);
});

function candle(
  date: number,
  open: number,
  close: number,
  high = Math.max(open, close),
  low = Math.min(open, close),
): Bar {
  return {
    date: `2025-01-${String(date).padStart(2, "0")}`,
    open,
    close,
    high,
    low,
    volume: 100,
    amount: 100,
  };
}
it("recognizes only the minimal reversal patterns, including bearish symmetry and context", () => {
  const falling = [candle(1, 15, 14), candle(2, 14, 13), candle(3, 13, 12)];
  const star = [
    ...falling,
    candle(4, 12, 10),
    candle(5, 9, 9.3),
    candle(6, 9.5, 11.5),
  ];
  expect(breakoutPatterns(star, 5, "long")).toContain("启明星");
  const mirror = star.map((b) => ({
    ...b,
    open: 40 - b.open,
    close: 40 - b.close,
    high: 40 - b.low,
    low: 40 - b.high,
  }));
  expect(breakoutPatterns(mirror, 5, "short")).toContain("黄昏之星");
  const hammer = [
    ...falling,
    candle(4, 12, 11),
    candle(5, 11, 10),
    candle(6, 10, 10.5, 10.6, 8.9),
  ];
  expect(breakoutPatterns(hammer, 5, "long")).toContain("锤子线");
  const engulf = [
    ...falling,
    candle(4, 12, 11),
    candle(5, 11, 10),
    candle(6, 9.9, 11.2),
  ];
  expect(breakoutPatterns(engulf, 5, "long")).toContain("看涨吞没");
  const bear = engulf.map((b) => ({
    ...b,
    open: 40 - b.open,
    close: 40 - b.close,
    high: 40 - b.low,
    low: 40 - b.high,
  }));
  expect(breakoutPatterns(bear, 5, "short")).toContain("看跌吞没");
  star[4] = candle(5, 10, 10.3);
  expect(breakoutPatterns(star, 5, "long")).not.toContain("启明星");
});
