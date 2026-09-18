import { expect, it } from "vitest";
import { chanRecursiveObservations } from "../src/lib/research-chan-recursive";
import type { CzscRecursive, CzscResult } from "../src/lib/czsc";
import type { Bar } from "../src/lib/domain";
import { researchChanZhongyin } from "../src/server/research-chan-zhongyin";
import { researchSpecSchema } from "../src/lib/strategy-research";
export const bars: Bar[] = Array.from({ length: 9 }, (_, i) => ({
  date: `2020-01-${String(i + 1).padStart(2, "0")}`,
  open: 10,
  close: 10,
  high: 11,
  low: 9,
  volume: 100,
  amount: 1000,
}));
function table(n: number, ended = true): CzscRecursive {
  return {
    anchor: 1,
    config: 0,
    nodes:
      n < 3
        ? []
        : [
            {
              id: 1,
              level: 0,
              start: 0,
              end: Math.min(3, n - 1),
              centerStart: 0,
              centerEnd: 2,
              established: 2,
              connection: n >= 5 ? 3 : null,
              completed: n >= 5 ? 4 : null,
              successorId: 0,
              children: [],
              high: 11,
              low: 6,
              ZG: 8,
              ZD: 7,
            },
          ],
    completions:
      n < 5
        ? []
        : [
            {
              id: 1,
              trendId: 1,
              space: 1,
              connectionPointId: 0,
              connection: 3,
              requiredPointId: 0,
              required: 4,
              observed: n - 1,
              successorId: 0,
              successorEstablished: null,
              level: 0,
            },
          ],
    transitions:
      n < 5
        ? []
        : [
            {
              id: 1,
              completionId: 1,
              variant: 1,
              entered: 4,
              ended: n >= 7 && ended ? 5 : null,
              observed: n - 1,
              contraction: null,
              available: true,
            },
            {
              id: 2,
              completionId: 1,
              variant: 2,
              entered: 4,
              ended: n >= 8 && ended ? 6 : null,
              observed: n - 1,
              contraction: 5,
              available: true,
            },
          ],
  };
}
it("freezes first observed candidate/completion/establishment independently, never at evidence endpoint", () => {
  const ledger = chanRecursiveObservations("fixed-input");
  const a = ledger.observe(bars.slice(0, 4), table(4));
  expect(a[0]).toMatchObject({ candidateAt: bars[3]!.date, confirmedAt: null });
  const b = ledger.observe(bars.slice(0, 6), table(6));
  expect(b[0]).toMatchObject({
    candidateAt: bars[3]!.date,
    confirmedAt: bars[5]!.date,
    kind: "completed",
  });
  const c = ledger.observe(bars.slice(0, 7), table(7));
  expect(c[0]).toMatchObject({
    candidateAt: bars[5]!.date,
    confirmedAt: bars[6]!.date,
    kind: "zhongyin-structural-end",
  });
  expect(ledger.observe(bars.slice(0, 8), table(8))[0]!.kind).toBe(
    "zhongyin-boll20-end",
  );
  expect(ledger.observe(bars, table(9))).toEqual([]);
  expect(b[0]!.confirmedAt).toBe(bars[5]!.date);
});
it("ignores snapshot-local ID drift, rejects input revisions and mixed anchors", () => {
  const ledger = chanRecursiveObservations("version");
  ledger.observe(bars.slice(0, 6), table(6));
  const t = table(7);
  t.nodes[0]!.id = 99;
  t.completions[0]!.trendId = 99;
  expect(ledger.observe(bars.slice(0, 7), t).map((e) => e.kind)).toEqual([
    "zhongyin-structural-end",
  ]);
  const other = table(8);
  other.anchor = 2;
  expect(() => ledger.observe(bars.slice(0, 8), other)).toThrow("分表");
  const revised = structuredClone(bars.slice(0, 8));
  revised[0]!.close = 9;
  expect(() => ledger.observe(revised, table(8))).toThrow("修订");
});
function result(n: number, ended = true, buyAt = 7): CzscResult {
  return {
    status: "structure",
    hash: "fixture",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        points: [],
        movements: [],
        qualities: [],
        divergences: [],
        centers: [
          {
            start: 0,
            end: 2,
            startDate: bars[0]!.date,
            endDate: bars[2]!.date,
            direction: 1,
            ZD: 7,
            ZG: 8,
            GG: 11,
            DD: 6,
          },
        ],
        signals:
          n >= buyAt
            ? [
                {
                  index: 3,
                  date: bars[3]!.date,
                  kind: 3,
                  quality: 1,
                  centerId: 1,
                },
              ]
            : [],
        native: {
          version: "native-projections-c2-1",
          config: 0,
          trends: [],
          highCandidates: [],
          completedSequence: "unavailable",
          recursive: table(n, ended),
        },
      },
    ],
  };
}
const spec = (strategy = "chan-zhongyin-daily-native") =>
  researchSpecSchema.parse({
    strategy,
    start: bars[4]!.date,
    end: bars[8]!.date,
    validationStart: bars[7]!.date,
    symbols: ["sh600000"],
  });
it("CH10 structural combination enters only with newly observed end and third buy; delayed BOLL stays separate", async () => {
  const run = (s = spec(), end = true, buyAt = 7) =>
    researchChanZhongyin(
      "sh600000",
      bars,
      undefined,
      s,
      async (p) => result(p.length, end, buyAt),
      () => false,
      () => {},
    );
  const primary = await run();
  expect(primary).toHaveLength(1);
  expect(primary[0]!.observedDate).toBe(bars[6]!.date);
  expect(await run(spec(), false)).toEqual([]);
  expect(await run(spec("chan-zhongyin-boll-daily-native"))).toEqual([]);
  expect(
    await run(spec("chan-zhongyin-boll-daily-native"), true, 8),
  ).toHaveLength(1);
});
it("CH10 five-minute method refuses daily substitution and out-of-window requests", async () => {
  await expect(
    researchChanZhongyin(
      "sh600000",
      bars,
      undefined,
      spec("chan-zhongyin-five-native"),
      async (p) => result(p.length),
      () => false,
      () => {},
    ),
  ).rejects.toThrow("真实五分钟");
  await expect(
    researchChanZhongyin(
      "sh600000",
      bars,
      bars,
      spec("chan-zhongyin-five-native"),
      async (p) => result(p.length),
      () => false,
      () => {},
    ),
  ).rejects.toThrow("周期");
});

it("CH10 five-minute positive path keeps its own named table and freezes intraday confirmation", async () => {
  const day = { ...bars[0]!, date: "2020-01-06", volume: 4800, amount: 48000 };
  const minute = Array.from({ length: 48 }, (_, i) => {
    const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return {
      ...day,
      date: `${day.date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
      volume: 100,
      amount: 1000,
    };
  });
  const s = researchSpecSchema.parse({
    strategy: "chan-zhongyin-five-native",
    start: day.date,
    end: "2020-01-08",
    validationStart: "2020-01-07",
    symbols: ["sh600000"],
  });
  const fn = async (prefix: readonly Bar[], anchor?: 1 | 2) => {
    expect(anchor).toBe(2);
    const r = result(prefix.length);
    const f = r.families[0]!;
    f.native!.recursive!.anchor = 2;
    f.centers[0]!.startDate = minute[0]!.date;
    f.centers[0]!.endDate = minute[2]!.date;
    for (const p of f.signals) p.date = minute[p.index]!.date;
    return r;
  };
  const found = await researchChanZhongyin(
    "sh600000",
    [day],
    minute,
    s,
    fn,
    () => false,
    () => {},
  );
  expect(found).toHaveLength(1);
  expect(found[0]!.key).toContain("five-minute-anchor-v1");
  expect(JSON.parse(found[0]!.evidence).confirmedAt).toBe(minute[6]!.date);
  await expect(
    researchChanZhongyin(
      "sh600000",
      [day],
      minute.slice(1),
      s,
      fn,
      () => false,
      () => {},
    ),
  ).rejects.toThrow("缺bar");
});

it("research runner forwards five-minute input and explicit anchor to the serial projection callback", async () => {
  const { runStrategyResearch } = await import("../src/server/research-run");
  const day = { ...bars[0]!, date: "2020-01-06", volume: 4800, amount: 48000 };
  const minutes = Array.from({ length: 48 }, (_, i) => {
    const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return {
      ...day,
      date: `${day.date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
      volume: 100,
      amount: 1000,
    };
  });
  const request = researchSpecSchema.parse({
    strategy: "chan-zhongyin-five-native",
    start: day.date,
    end: "2020-01-08",
    validationStart: "2020-01-07",
    symbols: ["sh600000"],
  });
  const dataset: import("../src/server/research-dataset").ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: ["sh600000"],
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars: [day] },
    calendar: [day.date],
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars: [day],
        minuteBars: minutes,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    // A GBBQ source is present but reports zero actions for this synthetic
    // stock; "missing" would mean no GBBQ source at all, which the coverage
    // gate in research-adjustment-coverage.ts now correctly excludes every
    // stock for.
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
  };
  let calls = 0;
  const output = await runStrategyResearch(
    request,
    dataset,
    null,
    async (prefix, anchor) => {
      calls++;
      expect(anchor).toBe(2);
      expect(prefix.at(-1)!.date).toContain("T");
      return {
        status: "no-structure",
        sourceCommit: "b67f3c6",
        hash: "fixture",
        families: [
          {
            config: 0,
            points: [],
            centers: [],
            signals: [],
            movements: [],
            qualities: [],
            divergences: [],
            native: {
              version: "native-projections-c2-1",
              config: 0,
              trends: [],
              highCandidates: [],
              completedSequence: "unavailable",
              recursive: {
                anchor: 2,
                config: 0,
                nodes: [],
                completions: [],
                transitions: [],
              },
            },
          },
        ],
      };
    },
  );
  expect(calls).toBe(48);
  expect(output.exclusions).toEqual([]);
});
