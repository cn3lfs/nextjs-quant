import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import type { CzscResult, CzscSignalStructure } from "../../../../src/lib/research/methods/chan/czsc";
import {
  chanNativeCandidates,
  chanMaMethodPoint,
  compactChanMaMethodPoint,
  chanWolfPoint,
} from "../../../../src/lib/research/methods/chan/research-chan-native";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../../src/server/backtest/research-portfolio";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import type { WyckoffStructureInput } from "../../../../src/lib/research/methods/wyckoff/research-wyckoff";
const bars: Bar[] = Array.from({ length: 66 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 11,
  close: 11,
  high: 12,
  low: 10,
  volume: 100,
  amount: 1100,
}));
function context() {
  const meta: CzscSignalStructure = {
    contextFlags: 2048 | 4096,
    pointId: 5,
    trendId: 1,
    breakoutId: 1,
    leavePointId: 4,
    retestPointId: 5,
    secondBasePointId: 3,
    secondTurnPointId: 4,
    smallTurnBasePointId: 3,
    smallTurnLeavePointId: 4,
    smallTurnRetestPointId: 5,
    previousStartPointId: 1,
    previousEndPointId: 2,
    currentStartPointId: 4,
    currentEndPointId: 5,
    centerLifecycle: 0,
  };
  const input = bars
    .slice(0, 60)
    .map((b) => ({ ...b, open: 11, close: 11, low: 10, high: 12 }));
  const result: CzscResult = {
    status: "structure",
    hash: "fixture",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        points: [5, 10, 30, 35, 40].map((index, i) => ({
          index,
          date: input[index]!.date,
          price: i % 2 ? 12 : 10,
          direction: i % 2 ? 1 : -1,
        })),
        centers: [
          {
            start: 10,
            end: 20,
            startDate: input[10]!.date,
            endDate: input[20]!.date,
            ZD: 8,
            ZG: 9,
            DD: 7,
            GG: 12,
            direction: 1,
          },
        ],
        signals: [
          {
            index: 40,
            date: input[40]!.date,
            kind: 2,
            quality: 1,
            centerId: 1,
            structure: meta,
            divergence: {
              semantic: 1,
              flags: 17,
              areaRatio: 0.5,
              priceRatio: 0.5,
              speedRatio: 0.5,
            },
          },
        ],
        movements: [],
        qualities: [],
        divergences: [],
      },
    ],
  };
  return { input, result, signal: result.families[0]!.signals[0]! };
}

it("CH04 registers actual overlap criterion; missing second chain or a single context flag is not overlap", () => {
  const { result, input, signal } = context();
  expect(
    chanNativeCandidates("chan-overlap-native", result, input, 0).signals,
  ).toHaveLength(1);
  signal.structure!.secondBasePointId = 0;
  expect(
    chanNativeCandidates("chan-overlap-native", result, input, 0).gaps.length,
  ).toBeGreaterThan(0);
  signal.structure!.secondBasePointId = 3;
  signal.structure!.contextFlags = 2048;
  expect(
    chanNativeCandidates("chan-overlap-native", result, input, 0).signals,
  ).toEqual([]);
});
function maInput(
  differences: number[],
  kisses: number[] = differences.map(() => 0),
) {
  const input = differences.map((_, i) => ({ ...bars[i]!, low: 10 - i * 0.1 }));
  const { result } = context();
  const f = result.families[0]!;
  f.signals = [];
  f.diagnostics = {
    version: "native-projections-b67f3c6-1",
    ma: differences.map((difference, index) => ({
      index,
      difference,
      kiss: kisses[index]!,
      volumeKiss: 0,
      instantWarning: 0,
    })),
    lifecycle: [],
    nested: [],
  };
  return { result, input };
}
it("CH16 only first completed positive kiss qualifies; volumeKiss4, second kiss and negative difference fail", () => {
  const { result, input } = maInput([1, 2, 1, 2], [0, 0, 2, 0]);
  expect(chanMaMethodPoint("chan-ma-kiss-native", result, input, 0).entry).toBe(
    true,
  );
  result.families[0]!.diagnostics!.ma[2]!.volumeKiss = 4;
  expect(chanMaMethodPoint("chan-ma-kiss-native", result, input, 0).entry).toBe(
    false,
  );
  const second = maInput([1, 1, 2, 1, 2], [0, 2, 0, 2, 0]);
  expect(
    chanMaMethodPoint("chan-ma-kiss-native", second.result, second.input, 0)
      .entry,
  ).toBe(false);
  const exit = maInput([1, -1]);
  expect(
    chanMaMethodPoint("chan-ma-kiss-native", exit.result, exit.input, 0).exit,
  ).toBe(true);
});
it("CH17 completed area and instantaneous average are separate rows, strict weakness and new lows required", () => {
  const area = maInput([-4, -4, -1, -2, -2, -1], [0, 0, 3, 0, 0, 3]);
  expect(
    chanMaMethodPoint("chan-ma-area-native", area.result, area.input, 0),
  ).toMatchObject({ entry: true, exit: false });
  expect(
    chanMaMethodPoint("chan-ma-average-native", area.result, area.input, 0)
      .entry,
  ).toBe(false);
  area.result.families[0]!.diagnostics!.ma[3]!.difference = -4;
  area.result.families[0]!.diagnostics!.ma[4]!.difference = -4;
  expect(
    chanMaMethodPoint("chan-ma-area-native", area.result, area.input, 0).entry,
  ).toBe(false);
  const average = maInput([-4, -4, -1, -3, -1], [0, 0, 3, 0, 0]);
  expect(
    chanMaMethodPoint(
      "chan-ma-average-native",
      average.result,
      average.input,
      0,
    ).entry,
  ).toBe(true);
  average.input[3]!.low = 11;
  average.input[4]!.low = 11;
  expect(
    chanMaMethodPoint(
      "chan-ma-average-native",
      average.result,
      average.input,
      0,
    ).entry,
  ).toBe(false);
  delete average.result.families[0]!.diagnostics;
  expect(
    chanMaMethodPoint(
      "chan-ma-average-native",
      average.result,
      average.input,
      0,
    ).reason,
  ).toContain("结构缺口");
});
it("CHAN-MA research observations compact repeated diagnostics without changing the decision", () => {
  const { result, input } = maInput([-4, -4, -1, -3, -1], [0, 0, 3, 0, 0]);
  const decision = chanMaMethodPoint(
    "chan-ma-average-native",
    result,
    input,
    0,
  );
  const compact = compactChanMaMethodPoint(decision);
  expect(compact).toMatchObject({
    entry: decision.entry,
    exit: decision.exit,
    reason: decision.reason,
  });
  expect(compact.evidence).toMatchObject({
    rowCount: decision.evidence!.rows.length,
    previousRow: decision.evidence!.rows.at(-2),
    lastRow: decision.evidence!.rows.at(-1),
  });
  expect(compact.evidence).not.toHaveProperty("rows");
  expect(compact.evidence).not.toHaveProperty("chunks");
});
it("CH14 symmetric native sell belongs to its center; actual long holding exits after sell confirmation and no short is opened", async () => {
  const spec = researchSpecSchema.parse({
    strategy: "chan-hold-cash-native",
    start: bars[61]!.date,
    end: bars[65]!.date,
    validationStart: bars[65]!.date,
    holdingDays: 60,
  });
  const native = async (prefix: readonly Bar[]) => {
    const { result } = context();
    const f = result.families[0]!;
    f.signals = [];
    if (prefix.length >= 63)
      f.signals.push({
        index: 40,
        date: bars[40]!.date,
        kind: 2,
        quality: 1,
        centerId: 1,
      });
    if (prefix.length >= 64) {
      f.centers.push({ ...f.centers[0]!, ZD: 13, ZG: 14 });
      f.signals.push({
        index: 50,
        date: bars[50]!.date,
        kind: -3,
        quality: 1,
        centerId: 2,
      });
    }
    return result;
  };
  const events = await researchSignals("sh600000", bars, spec, native);
  expect(events.map((e) => e.side ?? "entry")).toEqual(["entry", "exit"]);
  const rules = {
    evidence: "fixture",
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
    tradable: true,
    limitUp: null,
    limitDown: null,
  };
  const result = researchPortfolio(
    spec,
    events,
    bars.map((b) => b.date),
    new Map([["sh600000", bars]]),
    (_s, d) => ({ ...rules, tradable: d !== bars[64]!.date }),
  );
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0]!.exitDate).toBe(bars[65]!.date);
  expect(result.attempts).toContainEqual(
    expect.objectContaining({ date: bars[64]!.date, side: "sell" }),
  );
  const fake = await native(bars);
  fake.families[0]!.signals[1]!.centerId = 0;
  expect(
    chanNativeCandidates("chan-hold-cash-native", fake, bars, 0).gaps[0],
  ).toContain("结构缺口");
});
it("CH15 daily stock MACD zero-axis filter uses strict both-lines signs", () => {
  const trend = (dir: number) =>
    bars.map((b, i) => ({
      ...b,
      open: 100 + dir * i * 0.2,
      close: 100 + dir * i * 0.2,
      high: 101 + dir * i * 0.2,
      low: 99 + dir * i * 0.2,
    }));
  expect(chanWolfPoint(trend(1))).toMatchObject({
    entryAllowed: true,
    exit: false,
  });
  expect(chanWolfPoint(trend(-1))).toMatchObject({
    entryAllowed: false,
    exit: true,
  });
  const broken = trend(-1);
  broken.at(-1)!.volume = 0;
  expect(chanWolfPoint(broken)).toMatchObject({
    entryAllowed: false,
    exit: false,
  });
  expect(chanWolfPoint(trend(0))).toMatchObject({
    entryAllowed: false,
    exit: false,
  });
});
it("CH05 calls serial full completed-week prefixes and confirms only newly proved semantic2 A/C; never feeds daily bars to DLL", async () => {
  const input: Bar[] = [];
  for (let t = Date.UTC(2020, 0, 6); input.length < 310; t += 86400000) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay()))
      input.push({ ...bars[0]!, date: d.toISOString().slice(0, 10) });
  }
  const row = (i: number): WyckoffStructureInput => ({
    symbol: "sh600000",
    date: input[i]!.date,
    source: "fixture",
    availableAt: `${input[i]!.date}T15:00:00+08:00`,
    stock: {
      id: "weekly-raw",
      symbol: "sh600000",
      period: "day",
      source: "fixture",
      adjustment: "none",
      hash: "fixture",
      createdAt: 0,
      bars: input.slice(0, i + 1),
    },
    calendar: {
      days: input.map((b) => b.date),
      closedDays: [],
      source: "fixture",
      hash: "fixture",
      availableAt: "2019-01-01T00:00:00+08:00",
    },
  });
  const rows = [row(299), row(304), row(309)],
    sizes: number[] = [];
  const native = async (prefix: readonly Bar[]) => {
    sizes.push(prefix.length);
    const { result } = context();
    const f = result.families[0]!;
    f.points.forEach((p) => (p.date = prefix[p.index]!.date));
    f.centers.forEach((c) => {
      c.startDate = prefix[c.start]!.date;
      c.endDate = prefix[c.end]!.date;
    });
    const s = f.signals[0]!;
    s.date = prefix[s.index]!.date;
    s.kind = 1;
    s.divergence!.semantic = 2;
    s.structure!.previousStartPointId = 2;
    s.structure!.previousEndPointId = 3;
    if (prefix.length === 60) f.signals = [];
    return result;
  };
  const spec = researchSpecSchema.parse({
    strategy: "chan-consolidation-weekly-native",
    start: rows[1]!.date,
    end: rows[2]!.date,
    validationStart: rows[2]!.date,
    wyckoffStructureInputs: rows,
  });
  const observations: unknown[] = [];
  const events = await researchSignals(
    "sh600000",
    input,
    spec,
    native,
    undefined,
    undefined,
    undefined,
    undefined,
    (r) => observations.push(r),
  );
  expect(sizes, JSON.stringify(observations)).toEqual([60, 61, 62]);
  expect(events).toHaveLength(1);
  expect(events[0]!.observedDate).toBe(rows[1]!.date);
  const crossed = async (prefix: readonly Bar[]) => {
    const r = await native(prefix);
    r.families[0]!.signals.forEach((s) => {
      s.structure!.previousStartPointId = 1;
      s.structure!.previousEndPointId = 2;
    });
    return r;
  };
  expect(await researchSignals("sh600000", input, spec, crossed)).toEqual([]);
  const wrong = async (prefix: readonly Bar[]) => {
    const r = await native(prefix);
    r.families[0]!.signals.forEach((s) => (s.divergence!.semantic = 1));
    return r;
  };
  expect(await researchSignals("sh600000", input, spec, wrong)).toEqual([]);
});
