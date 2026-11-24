import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGbbqFile } from "tstdx/local";
import {
  evaluateBarReplaySession,
  settleBarReplaySession,
} from "~/lib/chart/bar-replay";
import type { Bar } from "~/lib/domain";
import {
  getBarReplayCandidates,
  getBarReplayFrame,
  revealBarReplaySession,
} from "~/server/charts/bar-replay-session";
import { closeCzsc } from "~/server/strategies/chan/czsc";
import gbbq from "../../fixtures/tdx-gbbq.json";

const symbol = "sz000001";
const cutoffDate = "1991-08-16";
const exDate = "1991-08-17";
const futureDates = ["1991-08-19", "1991-08-20"] as const;
const fallingEnd = "1991-08-21";
const prefixDates = Array.from(
  { length: 138 },
  (_, index) => new Date(Date.UTC(1991, 3, 1 + index)),
)
  .filter((date) => date.getUTCDay() > 0 && date.getUTCDay() < 6)
  .map((date) => date.toISOString().slice(0, 10));

function dayRecord(date: string, cents: number, volume = 1000) {
  const row = Buffer.alloc(32);
  row.writeUInt32LE(Number(date.replaceAll("-", "")), 0);
  [cents, cents + 20, cents - 20, cents].forEach((value, i) =>
    row.writeUInt32LE(value, 4 * (i + 1)),
  );
  row.writeFloatLE((cents * volume) / 100, 20);
  row.writeUInt32LE(volume, 24);
  return row;
}

/** Reuse real encrypted records, framing just the dates required by this fixture. */
function gbbqRecords(includeFuture: boolean) {
  const original = Buffer.from(gbbq.gbbqBase64, "base64");
  const one = Buffer.alloc(33);
  one.writeUInt32LE(1);
  const records: Buffer[] = [];
  for (let offset = 4; offset < original.length; offset += 29) {
    const record = original.subarray(offset, offset + 29);
    record.copy(one, 4);
    const event = parseGbbqFile(one).events.get(symbol)?.[0];
    if (
      event?.date === "1991-05-02" ||
      (includeFuture && event?.date === exDate)
    )
      records.push(record);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(records.length);
  return Buffer.concat([count, ...records]);
}

describe("bar replay TDX visibility", () => {
  let directory: string, rising: string, falling: string, suspended: string;
  let last: number;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "bar-replay-"));
    rising = join(directory, "rising");
    falling = join(directory, "falling");
    suspended = join(directory, "suspended");
    const close = (date: string, i: number) =>
      Math.round((date < "1991-05-02" ? 1000 : 690) + 55 * Math.sin(i / 4.5));
    last = close(cutoffDate, prefixDates.length - 1);
    const prefix = prefixDates.map((date, i) =>
      dayRecord(date, close(date, i)),
    );
    const sources = [
      {
        root: rising,
        multiplier: 1.5,
        suffix: futureDates,
        includeAction: true,
      },
      {
        root: falling,
        multiplier: 0.5,
        suffix: [...futureDates, fallingEnd],
        includeAction: false,
      },
      {
        root: suspended,
        multiplier: 1.5,
        suffix: [futureDates[1]],
        includeAction: true,
      },
    ];
    await Promise.all(
      sources.map(async ({ root, multiplier, suffix, includeAction }) => {
        const quotes = join(root, "vipdoc", "sz", "lday");
        const actions = join(root, "T0002", "hq_cache");
        await Promise.all([
          mkdir(quotes, { recursive: true }),
          mkdir(actions, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            join(quotes, `${symbol}.day`),
            Buffer.concat([
              ...prefix,
              ...suffix.map((date) =>
                dayRecord(
                  date,
                  Math.round(last * multiplier),
                  includeAction ? 2000 : 3500,
                ),
              ),
            ]),
          ),
          writeFile(join(actions, "gbbq"), gbbqRecords(includeAction)),
        ]);
      }),
    );
  });
  afterAll(async () => {
    await closeCzsc();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([false, true])(
    "isolates divergent prices and corporate actions on both sides of cutoff (CZSC=%s)",
    async (includeCzsc) => {
      const request = {
        symbol,
        cutoffDate,
        adjustment: "forward",
        includeCzsc,
      } as const;
      const [left, right] = await Promise.all([
        getBarReplayFrame({ ...request, root: rising }),
        getBarReplayFrame({ ...request, root: falling }),
      ]);
      expect(left).toStrictEqual(right);
      expect(left.bars.map((bar) => bar.date)).toEqual(prefixDates);

      // The pre-action factor uses the actual session before the ex-date.
      const raw = await getBarReplayFrame({ symbol, cutoffDate, root: rising });
      const preAction = raw.bars.find(
        (_, i) => raw.bars[i + 1]?.date === "1991-05-02",
      )!;
      expect(left.bars[0]!.close).toBeCloseTo(
        (10 * (preAction.close - 0.3)) / (1.4 * preAction.close),
        7,
      );
      expect(left.bars.at(-1)?.close).toBe(last / 100);
      expect(left.indicators.ma[20].at(-1)).toEqual(expect.any(Number));
      expect(left.indicators.macd).not.toEqual(raw.indicators.macd);
      expect(left.indicators.boll).not.toEqual(raw.indicators.boll);
      expect(left.hasMore).toBe(true);
      if (includeCzsc) {
        expect(left.czsc?.apiVersion).toBe(22);
        expect(Object.keys(left.czsc!.families)).toHaveLength(2);
      } else expect(left.czsc).toBeNull();
      for (const end of [futureDates[1], fallingEnd]) {
        expect(JSON.stringify(left)).not.toContain(end);
        expect(JSON.stringify(right)).not.toContain(end);
      }
      expect(
        (JSON.stringify(left).match(/\d{4}-\d{2}-\d{2}/g) ?? []).every(
          (date) => date <= cutoffDate,
        ),
      ).toBe(true);
    },
  );

  it.each([exDate, futureDates[0]])(
    "anchors forward prices to the effective action by %s without a visible bar on that date",
    async (suspendedCutoff) => {
      const request = {
        symbol,
        root: suspended,
        adjustment: "forward",
      } as const;
      const before = await getBarReplayFrame({ ...request, cutoffDate });
      const after = await getBarReplayFrame({
        ...request,
        cutoffDate: suspendedCutoff,
      });
      expect(after.cutoffDate).toBe(suspendedCutoff);
      expect(after.bars.map((bar) => bar.date)).toEqual(prefixDates);
      // The fixture's 2-for-1 split halves historical prices as soon as it is effective.
      expect(after.bars[0]!.close).toBeCloseTo(before.bars[0]!.close / 2, 9);
      expect(after.bars.at(-1)!.close).toBeCloseTo(last / 200, 9);
      expect(after.hasMore).toBe(true);
      expect(JSON.stringify(after)).not.toContain(futureDates[1]);
    },
  );

  it("advances one day and settles pending next-open orders only in the new frame", async () => {
    const session = {
      startDate: cutoffDate,
      orders: [{ date: cutoffDate, side: "buy", quantity: 100 }],
    } as const;
    const request = {
      symbol,
      cutoffDate,
      root: rising,
      session: { ...session, orders: [...session.orders] },
    };
    const hidden = await getBarReplayFrame(request);
    expect(hidden.simulation?.fills).toEqual([]);
    expect(hidden.simulation?.pending).toHaveLength(1);
    expect(JSON.stringify(hidden)).not.toContain(futureDates[0]);
    const step = await getBarReplayFrame({
      ...request,
      step: true,
      adjustment: "forward",
    });
    expect(step.cutoffDate).toBe(futureDates[0]);
    expect(step.simulation?.fills[0]).toMatchObject({
      executionDate: futureDates[0],
      price: Math.round(last * 1.5) / 100,
    });
    const beforeAction = await getBarReplayFrame({
      ...request,
      adjustment: "forward",
    });
    expect(step.bars[0]!.close).toBeCloseTo(beforeAction.bars[0]!.close / 2, 9);
    const opposite = await getBarReplayFrame({
      ...request,
      root: falling,
      step: true,
      adjustment: "forward",
    });
    expect(opposite.bars[0]!.close).toBe(beforeAction.bars[0]!.close);
    expect(opposite.bars.at(-1)!.close).toBe(Math.round(last * 0.5) / 100);
    expect(opposite.indicators).not.toEqual(step.indicators);
    expect(JSON.stringify(step)).not.toContain(futureDates[1]);
    const reveal = await revealBarReplaySession({
      ...request,
      cutoffDate: futureDates[0],
    });
    expect(reveal.user.fills).toEqual(step.simulation?.fills);
    expect(reveal.user.totalReturn).toEqual(step.simulation?.totalReturn);
  });

  it("returns only eligibility and the first date for different future lengths and endpoints", async () => {
    const candidates = await Promise.all([
      getBarReplayCandidates(symbol, rising),
      getBarReplayCandidates(symbol, falling),
    ]);
    for (const candidate of candidates) {
      expect(candidate).toStrictEqual({
        available: true,
        firstDate: prefixDates[0],
      });
      for (const futureDate of [...futureDates, fallingEnd]) {
        expect(JSON.stringify(candidate)).not.toContain(futureDate);
      }
    }
  });
});

const simulationBars: Bar[] = [10, 9, 8, 11, 12, 12, 13, 14].map(
  (close, i) => ({
    date: `2024-03-${10 + i}`,
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 1000,
    amount: 1000 * close,
  }),
);

it("blocks T+1 violations, odd lots and unfunded orders, with transparent discipline scoring", () => {
  const result = settleBarReplaySession({
    symbol,
    bars: simulationBars,
    session: {
      startDate: simulationBars[0]!.date,
      initialCash: 2000,
      executionRule: "same-close",
      orders: [
        { date: simulationBars[0]!.date, side: "buy", quantity: 100 },
        { date: simulationBars[0]!.date, side: "sell", quantity: 100 },
        { date: simulationBars[1]!.date, side: "buy", quantity: 101 },
        { date: simulationBars[1]!.date, side: "buy", quantity: 200 },
        { date: simulationBars[2]!.date, side: "sell", quantity: 100 },
        { date: simulationBars[3]!.date, side: "buy", quantity: 100 },
      ],
    },
  });
  expect(result.rejections.map((row) => row.reason)).toEqual([
    "t-plus-one",
    "lot-size",
    "cash",
  ]);
  expect(result.discipline).toMatchObject({
    score: 70,
    stopOpportunities: 1,
    stopExecutions: 1,
    chaseFills: 1,
    tPlusOneRejections: 1,
  });
  expect(result.equity[0]!.value).toBeCloseTo(1994.99, 6);
  expect(result.maxDrawdown).toBeGreaterThan(0.1);
});

it("scores matched decision dates once per side, and leaves missed follow-up and empty metrics nullable", () => {
  const theorySignals = [
    { date: simulationBars[1]!.date, side: "buy" },
    { date: simulationBars[2]!.date, side: "sell" },
    { date: simulationBars[5]!.date, side: "buy" },
  ] as const;
  const base = { symbol, bars: simulationBars, theorySignals };
  const result = evaluateBarReplaySession({
    ...base,
    session: {
      startDate: simulationBars[0]!.date,
      orders: [{ date: simulationBars[0]!.date, side: "buy", quantity: 100 }],
    },
  });
  expect(result.timing).toEqual({
    precision: 1,
    recall: 1 / 3,
    f1: 0.5,
    matches: 1,
    userSignals: 1,
    theorySignals: 3,
    toleranceSessions: 2,
  });
  expect(result.missed).toEqual([
    {
      ...theorySignals[1],
      followUpDate: simulationBars[7]!.date,
      forwardReturn: 0.75,
    },
    { ...theorySignals[2], followUpDate: null, forwardReturn: null },
  ]);
  expect(result.returnDifference).toBeCloseTo(
    result.user.totalReturn! - result.theory.totalReturn!,
  );
  expect(result.maxDrawdownDifference).toBeCloseTo(
    result.user.maxDrawdown! - result.theory.maxDrawdown!,
  );
  const empty = evaluateBarReplaySession({
    ...base,
    theorySignals: [],
    session: { startDate: simulationBars[0]!.date },
  });
  expect(empty.timing).toMatchObject({
    precision: null,
    recall: null,
    f1: null,
  });
});

it("does not report an economic return after crossing an unsupported action in a position", () => {
  const result = settleBarReplaySession({
    symbol,
    bars: simulationBars,
    actionDates: [simulationBars[2]!.date],
    session: {
      startDate: simulationBars[0]!.date,
      orders: [{ date: simulationBars[0]!.date, side: "buy", quantity: 100 }],
    },
  });
  expect(result.blockedReason).toContain(simulationBars[2]!.date);
  expect(result.totalReturn).toBeNull();
  expect(result.maxDrawdown).toBeNull();
});
