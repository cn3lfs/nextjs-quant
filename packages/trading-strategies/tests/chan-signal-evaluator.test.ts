import { expect, it } from "vitest";
import {
  classifyCzscSignals,
  evaluateChanSignal,
} from "../src/research/chan/chan-signal-evaluator.js";
import {
  CZSC_CTX,
  czscSourceCommit,
  type CzscCenter,
  type CzscFamily,
  type CzscNativeProjection,
  type CzscPoint,
  type CzscResult,
  type CzscSignalStructure,
} from "../src/research/chan/czsc.js";
import { candle } from "./ohlc-fixtures.js";

const sides = [
  {
    sign: 1,
    direction: "long",
    suffix: "买",
    first: "1B",
    departure: "P1B",
    second: "2B",
    overlap: "L2B",
    third: "3B",
    smallTurn: "STB",
    nested: "NB",
    transition: "ZYB",
    kiss: "KB",
  },
  {
    sign: -1,
    direction: "short",
    suffix: "卖",
    first: "1S",
    departure: "P1S",
    second: "2S",
    overlap: "L2S",
    third: "3S",
    smallTurn: "STS",
    nested: "NS",
    transition: "ZYS",
    kiss: "KS",
  },
] as const;
type Side = (typeof sides)[number];
type NativeSignal = CzscFamily["signals"][number];

const date = (index: number) => candle(index, 100).date;
const priceFor = ({ sign }: Side, longPrice: number) =>
  100 + sign * (longPrice - 100);

function endpoint(
  side: Side,
  index: number,
  confirmedAt: number,
  price: number,
  direction: 1 | -1,
): CzscPoint {
  return {
    index,
    date: date(index),
    confirmedAt,
    price: priceFor(side, price),
    direction: side.sign * direction,
  };
}

function barsWithEndpoints(points: readonly CzscPoint[] = []) {
  const bars = Array.from({ length: 28 }, (_, i) => candle(i, 100));
  for (const p of points) {
    const close = p.price - p.direction;
    bars[p.index] = candle(
      p.index,
      close,
      p.direction < 0 ? { low: p.price } : { high: p.price },
    );
  }
  return bars;
}

function centerFor(side: Side): CzscCenter {
  // The center is 98..102 in either direction. Its wider range is 96..108
  // on the buy side and 92..104 on the sell side.
  const [DD, GG]: [number, number] = side.sign > 0 ? [96, 108] : [92, 104];
  return {
    start: 1,
    end: 6,
    startDate: date(1),
    endDate: date(6),
    direction: -side.sign,
    confirmedAt: 7,
    ZD: 98,
    ZG: 102,
    DD,
    GG,
  };
}

function family(facts: Partial<CzscFamily>): CzscFamily {
  return {
    config: 0,
    points: [],
    centers: [],
    signals: [],
    movements: [],
    qualities: [],
    divergences: [],
    ...facts,
  };
}

function result(...families: CzscFamily[]): CzscResult {
  return {
    status: "structure",
    hash: "unit-fixture",
    sourceCommit: czscSourceCommit,
    families,
  };
}

function nativeSignal(
  side: Side,
  p: CzscPoint,
  kind: 1 | 2 | 3,
  stop: number,
): NativeSignal {
  return {
    index: p.index,
    date: p.date,
    kind: kind * side.sign,
    confirmedAt: p.confirmedAt ?? p.index,
    stop: priceFor(side, stop),
    centerId: 1,
    quality: 1,
    revokedAt: -1,
  };
}

function nativeProjection(
  config: CzscFamily["config"],
  facts: Partial<CzscNativeProjection>,
): CzscNativeProjection {
  return {
    version: czscSourceCommit,
    config,
    trends: [],
    highCandidates: [],
    completedSequence: "unavailable",
    ...facts,
  };
}

it.each(sides)(
  "classifies trend $first and retest $third with confirmed center targets",
  (side) => {
    const { direction, suffix, first, third } = side;
    const turn = endpoint(side, 8, 10, 90, -1);
    const retest = endpoint(side, 14, 16, 104, -1);
    const center = centerFor(side);
    const signals = [
      nativeSignal(side, turn, 1, 89),
      nativeSignal(side, retest, 3, 102),
    ];
    const snapshot = family({
      config: 1100,
      points: [turn, retest],
      centers: [center],
      signals,
    });
    const projection = result(snapshot);
    const bars = barsWithEndpoints(snapshot.points);
    expect(classifyCzscSignals(projection, bars)).toMatchObject([
      {
        code: first,
        shortLabel: "段1" + suffix,
        direction,
        config: 1100,
        index: 8,
        confirmedAt: 10,
        date: date(8),
        price: priceFor(side, 90),
        stopPrice: priceFor(side, 89),
        targetPrice: priceFor(side, 96),
        center,
      },
      {
        code: third,
        shortLabel: "段3" + suffix,
        direction,
        config: 1100,
        index: 14,
        confirmedAt: 16,
        date: date(14),
        price: priceFor(side, 104),
        stopPrice: priceFor(side, 102),
        targetPrice: priceFor(side, 108),
        center,
      },
    ]);
    expect(
      evaluateChanSignal(projection, bars, { codes: [third], index: 15 })
        .matched,
    ).toBe(false);
    expect(
      evaluateChanSignal(projection, bars, {
        codes: [third],
        configs: [1100],
        index: 16,
      }),
    ).toMatchObject({
      matched: true,
      direction,
      stopPrice: priceFor(side, 102),
      targetPrice: priceFor(side, 108),
    });
    expect(
      evaluateChanSignal(projection, bars, { codes: [third], index: 17 })
        .matched,
    ).toBe(false);

    // A center whose last member/finalization is still in the future cannot
    // retroactively supply a target to the first point.
    const extended = result({
      ...snapshot,
      centers: [{ ...center, end: 11, endDate: date(11), confirmedAt: 12 }],
    });
    expect(classifyCzscSignals(extended, bars)).toMatchObject([
      {
        code: first,
        stopPrice: priceFor(side, 89),
        center: null,
        targetPrice: null,
      },
      { code: third, targetPrice: priceFor(side, 108) },
    ]);
  },
);

function departureFamily(
  side: Side,
  retest: number,
  third: boolean,
): CzscFamily {
  const direction = side.sign === 1 ? -1 : 1;
  return family({
    points: [
      endpoint(side, 8, 10, 90, -1),
      endpoint(side, 12, 14, 110, 1),
      endpoint(side, 16, 18, retest, -1),
      endpoint(side, 19, 21, 112, 1),
    ],
    centers: [centerFor(side)],
    breakouts: [
      {
        centerId: 1,
        direction,
        leavePointId: 1,
        retestPointId: third ? 3 : 0,
        third,
        confirmedAt: 20,
        divergence: {
          areaRatio: 0.6,
          priceRatio: 0.8,
          speedRatio: 0.7,
          flags: 16,
          semantic: 2,
        },
      },
    ],
  });
}

it.each(sides)(
  "derives $departure and $second from a single-center divergent departure and held retest",
  (side) => {
    const snapshot = departureFamily(side, 94, false);
    const projection = result(snapshot);
    const bars = barsWithEndpoints(snapshot.points);
    expect(classifyCzscSignals(projection, bars, { asOfIndex: 13 })).toEqual(
      [],
    );
    const knownAtTurn = classifyCzscSignals(projection, bars, {
      asOfIndex: 14,
    });
    expect(knownAtTurn).toMatchObject([
      {
        code: side.departure,
        shortLabel: "笔盘背1" + side.suffix,
        direction: side.direction,
        index: 8,
        confirmedAt: 14,
        price: priceFor(side, 90),
        stopPrice: priceFor(side, 90),
        targetPrice: priceFor(side, 96),
      },
    ]);
    expect(classifyCzscSignals(projection, bars, { asOfIndex: 20 })).toEqual(
      knownAtTurn,
    );
    expect(
      classifyCzscSignals(projection, bars, { asOfIndex: 21 }),
    ).toMatchObject([
      { code: side.departure },
      {
        code: side.second,
        shortLabel: "笔2" + side.suffix,
        direction: side.direction,
        index: 16,
        confirmedAt: 21,
        price: priceFor(side, 94),
        stopPrice: priceFor(side, 90),
        targetPrice: priceFor(side, 96),
      },
    ]);

    const failedRetest = departureFamily(side, 89, false);
    expect(
      classifyCzscSignals(
        result(failedRetest),
        barsWithEndpoints(failedRetest.points),
      ).map((s) => s.code),
    ).toEqual([side.departure]);
    const breakout = snapshot.breakouts![0]!;
    const withoutSingleCenterEvidence = result({
      ...snapshot,
      breakouts: [
        { ...breakout, divergence: { ...breakout.divergence!, flags: 0 } },
      ],
    });
    expect(classifyCzscSignals(withoutSingleCenterEvidence, bars)).toEqual([]);
  },
);

it.each(sides)(
  "classifies $overlap only when the secondary retest is also the linked third point",
  (side) => {
    // The reaction at 104 is outside the upper center edge (102). Reversal
    // and the confirmed third point share the retest ordinal.
    const snapshot = departureFamily(side, 104, true);
    const bars = barsWithEndpoints(snapshot.points);
    expect(classifyCzscSignals(result(snapshot), bars)).toMatchObject([
      { code: side.departure },
      {
        code: side.overlap,
        shortLabel: "笔2+3" + side.suffix,
        direction: side.direction,
        index: 16,
        confirmedAt: 21,
        price: priceFor(side, 104),
        stopPrice: priceFor(side, 90),
        targetPrice: priceFor(side, 108),
      },
    ]);
    const breakout = snapshot.breakouts![0]!;
    const differentRetest = result({
      ...snapshot,
      breakouts: [{ ...breakout, retestPointId: 4 }],
    });
    expect(
      classifyCzscSignals(differentRetest, bars).map((s) => s.code),
    ).toEqual([side.departure, side.second]);
  },
);

function signalStructure(contextFlags: number): CzscSignalStructure {
  return {
    contextFlags,
    pointId: 1,
    trendId: 0,
    breakoutId: 1,
    leavePointId: 0,
    retestPointId: 1,
    secondBasePointId: 0,
    secondTurnPointId: 0,
    smallTurnBasePointId: 0,
    smallTurnLeavePointId: 0,
    smallTurnRetestPointId: 0,
    previousStartPointId: 0,
    previousEndPointId: 0,
    currentStartPointId: 0,
    currentEndPointId: 0,
    centerLifecycle: -1,
  };
}

it.each(sides)(
  "also decodes native $departure, $overlap and $smallTurn evidence",
  (side) => {
    const first = endpoint(side, 8, 10, 90, -1);
    const retest = endpoint(side, 14, 16, 104, -1);
    const smallTurn = endpoint(side, 20, 22, 106, -1);
    const points = [first, retest, smallTurn];
    const signals = [
      {
        ...nativeSignal(side, first, 1, 90),
        divergence: {
          areaRatio: 0.6,
          priceRatio: 0.8,
          speedRatio: 0.7,
          flags: 16,
          semantic: 2,
        },
      },
      {
        ...nativeSignal(side, retest, 2, 90),
        structure: signalStructure(CZSC_CTX.overlap),
      },
      {
        ...nativeSignal(side, smallTurn, 3, 104),
        structure: signalStructure(CZSC_CTX.smallTurn),
      },
    ];
    const snapshot = result(
      family({ points, signals, centers: [centerFor(side)] }),
    );
    expect(
      classifyCzscSignals(snapshot, barsWithEndpoints(points)).map(
        (s) => s.code,
      ),
    ).toEqual([side.departure, side.overlap, side.smallTurn]);
  },
);

function nestedFamilies(side: Side) {
  const lowPoint = endpoint(side, 8, 10, 90, -1);
  const laterTurn = endpoint(side, 14, 16, 106, 1);
  const highPoint = endpoint(side, 8, 13, 90, -1);
  const lowFamily = family({
    points: [lowPoint, laterTurn],
    signals: [nativeSignal(side, lowPoint, 1, 89)],
    native: nativeProjection(0, {
      highCandidates: [
        {
          id: 17,
          config: 1100,
          index: 8,
          kind: side.sign,
          pointId: 1,
          pointConfirmedAt: highPoint.confirmedAt,
          segmentStartPointId: 0,
          segmentEndPointId: 1,
          segmentStart: 0,
          segmentEnd: 8,
          semantic: 1,
          divergence: true,
          trendId: 0,
          centerId: 0,
          source: 1,
          priority: 1,
          quality: 2,
          unit: 2,
          newExtreme: true,
          weakSpace: true,
          weakSpeed: true,
          weakMacd: true,
          currentStart: 0,
          currentEnd: 8,
        },
      ],
    }),
    diagnostics: {
      version: czscSourceCommit,
      ma: [],
      lifecycle: [],
      nested: [
        {
          lowConfig: 0,
          sourceConfig: 1100,
          index: 8,
          level: 2,
          sourceCandidateId: 17,
          lowStartPointId: 0,
          lowEndPointId: 1,
          semantic: 1,
          confirmFlags: 3 | 8,
          direction: side.sign,
        },
      ],
    },
  });
  return {
    lowFamily,
    highFamily: family({ config: 1100, points: [highPoint] }),
  };
}

it.each(sides)(
  "waits for both levels for $nested and follow-through for $smallTurn",
  (side) => {
    const { lowFamily, highFamily } = nestedFamilies(side);
    const bars = barsWithEndpoints(lowFamily.points);
    const snapshot = result(lowFamily, highFamily);
    const classifyAt = (asOfIndex: number) =>
      classifyCzscSignals(snapshot, bars, { asOfIndex });
    expect(classifyAt(12).map((s) => s.code)).toEqual([side.first]);
    for (const asOfIndex of [12, 13, 16])
      expect(
        classifyCzscSignals(result(lowFamily), bars, { asOfIndex }),
      ).toEqual(classifyAt(asOfIndex));
    expect(classifyAt(13)).toMatchObject([
      { code: side.first },
      {
        code: side.nested,
        shortLabel: "区间套" + side.suffix,
        direction: side.direction,
        index: 8,
        confirmedAt: 13,
        quality: 2,
        price: priceFor(side, 90),
        stopPrice: priceFor(side, 90),
        targetPrice: null,
      },
    ]);
    expect(classifyAt(15)).toEqual(classifyAt(13));
    expect(classifyAt(16)).toMatchObject([
      { code: side.first },
      { code: side.nested },
      {
        code: side.smallTurn,
        shortLabel: "笔小转大" + side.suffix,
        direction: side.direction,
        index: 8,
        confirmedAt: 16,
        quality: 2,
        price: priceFor(side, 90),
        stopPrice: priceFor(side, 90),
        targetPrice: null,
      },
    ]);
  },
);

it.each(sides)(
  "requires a nearby reversal confirmation after trend completion for $transition",
  (side) => {
    const retest = endpoint(side, 14, 16, 104, -1);
    const bars = barsWithEndpoints([retest]);
    const trend = {
      id: 1,
      config: 0 as const,
      unit: 1,
      type: -side.sign,
      start: 0,
      end: 11,
      firstCenterId: 1,
      lastCenterId: 1,
      memberCenterIds: [1],
      completedAt: 17,
      completedByIndex: -1,
      confirmedAt: 17,
    };
    const snapshot = family({
      points: [retest],
      centers: [centerFor(side)],
      signals: [nativeSignal(side, retest, 3, 102)],
    });
    const withTrend = (overrides: Partial<typeof trend> = {}) =>
      result({
        ...snapshot,
        native: nativeProjection(0, { trends: [{ ...trend, ...overrides }] }),
      });
    expect(
      classifyCzscSignals(withTrend(), bars, { asOfIndex: 16 }).map(
        (s) => s.code,
      ),
    ).toEqual([side.third]);
    expect(
      classifyCzscSignals(withTrend(), bars, { asOfIndex: 17 }),
    ).toMatchObject([
      { code: side.third },
      {
        code: side.transition,
        shortLabel: "中阴" + side.suffix,
        direction: side.direction,
        index: 14,
        confirmedAt: 17,
        price: priceFor(side, 104),
        stopPrice: priceFor(side, 102),
        targetPrice: priceFor(side, 108),
      },
    ]);
    for (const overrides of [
      { type: side.sign },
      { completedAt: 20, confirmedAt: 20 },
    ]) {
      expect(
        classifyCzscSignals(withTrend(overrides), bars).map((s) => s.code),
      ).toEqual([side.third]);
    }
  },
);

it.each(sides)(
  "fires $kiss on the first effective MA reopening and uses the candle extreme as stop",
  (side) => {
    const bar = candle(
      9,
      priceFor(side, 101),
      side.sign > 0 ? { low: 99 } : { high: 101 },
    );
    const bars = barsWithEndpoints();
    bars[9] = bar;
    const diagnostics = {
      version: czscSourceCommit,
      lifecycle: [],
      nested: [],
      ma: [
        {
          index: 8,
          difference: side.sign,
          kiss: 2,
          volumeKiss: 0,
          instantWarning: 0,
        },
        {
          index: 9,
          difference: side.sign * 2,
          kiss: 0,
          volumeKiss: 0,
          instantWarning: 0,
        },
      ],
    } satisfies CzscFamily["diagnostics"];
    const snapshot = result(family({ diagnostics }));
    expect(classifyCzscSignals(snapshot, bars, { asOfIndex: 8 })).toEqual([]);
    expect(classifyCzscSignals(snapshot, bars, { asOfIndex: 9 })).toMatchObject(
      [
        {
          code: side.kiss,
          shortLabel: "均线吻" + side.suffix,
          direction: side.direction,
          index: 9,
          confirmedAt: 9,
          price: priceFor(side, 101),
          stopPrice: priceFor(side, 99),
          targetPrice: null,
        },
      ],
    );
    expect(
      classifyCzscSignals(snapshot, bars, { includeMaKiss: false }),
    ).toEqual([]);
    const ineffective = family({
      diagnostics: {
        ...diagnostics,
        ma: [diagnostics.ma[0]!, { ...diagnostics.ma[1]!, volumeKiss: 4 }],
      },
    });
    expect(classifyCzscSignals(result(ineffective), bars)).toEqual([]);
  },
);

it.each(sides)(
  "excludes revoked $first at zero and blocks derived $nested and $smallTurn from later revocations",
  (side) => {
    const { lowFamily, highFamily } = nestedFamilies(side);
    const atZero = endpoint(side, 0, 0, 92, -1);
    const active = lowFamily.signals[0]!;
    const signals = [
      { ...nativeSignal(side, atZero, 1, 91), revokedAt: 0 },
      active,
      { ...active, revokedAt: 11 },
    ];
    const points = [atZero, ...lowFamily.points];
    const bars = barsWithEndpoints(points);
    expect(
      classifyCzscSignals(result(family({ points, signals })), bars),
    ).toEqual([]);

    // With only the revoked linked source, neither nested confirmation may
    // manufacture a replacement, even once both levels and follow-through exist.
    const revoked = { ...lowFamily, signals: [{ ...active, revokedAt: 11 }] };
    expect(classifyCzscSignals(result(revoked, highFamily), bars)).toEqual([]);

    const departure = departureFamily(side, 94, false);
    const withRevokedFirst = {
      ...departure,
      signals: [{ ...active, revokedAt: 11 }],
    };
    expect(
      classifyCzscSignals(
        result(withRevokedFirst),
        barsWithEndpoints(departure.points),
      ).map((s) => s.code),
    ).toEqual([]);
  },
);

it.each([-1, 7, 17])(
  "rejects unavailable nested and native pivot prices (confirmation %i)",
  (confirmedAt) => {
    const { lowFamily, highFamily } = nestedFamilies(sides[0]);
    lowFamily.points[0]!.confirmedAt = confirmedAt;
    expect(
      classifyCzscSignals(
        result(lowFamily, highFamily),
        barsWithEndpoints(lowFamily.points),
      ),
    ).toEqual([]);
  },
);

it("rejects explicitly unconfirmed native signals even without an as-of cutoff", () => {
  const { lowFamily } = nestedFamilies(sides[0]);
  lowFamily.signals[0]!.confirmedAt = -1;
  expect(
    classifyCzscSignals(result(lowFamily), barsWithEndpoints(lowFamily.points)),
  ).toEqual([]);
});

it.each([0, 2])(
  "blocks all derived breakout labels for a revoked observation at endpoint %i",
  (ordinal) => {
    const snapshot = departureFamily(sides[0], 104, true);
    snapshot.signals.push({
      ...nativeSignal(sides[0], snapshot.points[ordinal]!, 3, 100),
      revokedAt: 24,
    });
    expect(
      classifyCzscSignals(result(snapshot), barsWithEndpoints(snapshot.points)),
    ).toEqual([]);
  },
);

it("waits for linked third confirmation and rejects premature retest evidence", () => {
  const snapshot = departureFamily(sides[0], 104, true);
  const bars = barsWithEndpoints(snapshot.points);
  const codes = (at: number) =>
    classifyCzscSignals(result(snapshot), bars, { asOfIndex: at }).map((s) => [
      s.code,
      s.confirmedAt,
    ]);
  snapshot.breakouts![0]!.confirmedAt = 24;
  expect(codes(23)).toEqual([["P1B", 14]]);
  expect(codes(24)).toEqual([
    ["P1B", 14],
    ["L2B", 24],
  ]);
  snapshot.breakouts![0]!.confirmedAt = 15;
  expect(codes(24)).toEqual([
    ["P1B", 14],
    ["2B", 21],
  ]);
  snapshot.points[2]!.confirmedAt = 22;
  expect(codes(24)).toEqual([["P1B", 14]]);
  snapshot.points[0]!.confirmedAt = -1;
  expect(codes(24)).toEqual([]);
});

it("dates a synthetic native signal at its endpoint when the fixture omits pivot confirmation", () => {
  const point = endpoint(sides[0], 8, 8, 90, -1);
  delete point.confirmedAt;
  const signal = nativeSignal(sides[0], point, 1, 89);
  expect(signal.confirmedAt).toBe(8);
  const snapshot = result(family({ points: [point], signals: [signal] }));
  expect(
    classifyCzscSignals(snapshot, barsWithEndpoints([point])),
  ).toMatchObject([{ code: "1B", index: 8, confirmedAt: 8 }]);
});
