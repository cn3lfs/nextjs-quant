import { createExtendedStudyRule } from "../../../../packages/trading-strategies/src/study-rules";
import { volumeCompletionIds } from "trading-strategies/research/volume/research-volume-completion";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { volumeMa } from "../../../../src/lib/indicators";
import { volumeGridIds } from "trading-strategies/research/volume/research-volume-grid";
import {
  classifyVolumePrice,
  researchVolumeSeries,
  volumeStrategyIds,
  volumeWarmupStart,
  type VolumeStrategyId,
} from "trading-strategies/research/volume/research-volume";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";

function bars(
  tail: { close: number; volume: number; open?: number }[],
  slope = 0.2,
): Bar[] {
  const points = [
    ...Array.from({ length: 61 }, (_, i) => ({
      close: 100 + i * slope,
      volume: 100,
      open: 100 + i * slope,
    })),
    ...tail,
  ];
  return points.map((v, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: v.open ?? v.close,
    close: v.close,
    volume: v.volume,
    amount: v.volume * v.close,
    high: Math.max(v.open ?? v.close, v.close) + 0.5,
    low: Math.min(v.open ?? v.close, v.close) - 0.5,
  }));
}
const examples: [VolumeStrategyId, Bar[], number][] = [
  [
    "vp-up-expanded-confirm",
    bars([
      { close: 115.36, volume: 300 },
      { close: 116, volume: 200 },
    ]),
    62,
  ],
  [
    "vp-flat-expanded-break",
    bars(
      [
        { close: 100, volume: 300 },
        { close: 101, volume: 300 },
      ],
      0,
    ),
    62,
  ],
  [
    "vp-up-contracted-confirm",
    bars([
      { close: 115.36, volume: 30 },
      { close: 116, volume: 150 },
    ]),
    62,
  ],
  [
    "vp-down-contracted-confirm",
    bars(
      [
        { close: 120.9, volume: 30 },
        { close: 122, volume: 250, open: 121 },
      ],
      0.4,
    ),
    62,
  ],
  [
    "vp-up-normal-confirm",
    bars([
      { close: 115.36, volume: 120 },
      { close: 119, volume: 300 },
    ]),
    62,
  ],
  [
    "vp-flat-contracted-break",
    bars(
      [
        { close: 100, volume: 20 },
        { close: 101, volume: 250 },
      ],
      0,
    ),
    62,
  ],
  ["vp-breakout-1-5", bars([{ close: 115.36, volume: 150 }]), 61],
  ["vp-breakout-2", bars([{ close: 115.36, volume: 200 }]), 61],
  ["vp-volume-ma-cross", bars([{ close: 112.2, volume: 150 }]), 61],
];
it.each(examples)(
  "%s waits for the specified confirmation using only the observed prefix",
  (id, input, index) => {
    const points = researchVolumeSeries(id, input);
    expect(points.flatMap((point, i) => (point.entry ? [i] : []))).toEqual([
      index,
    ]);
    if (index === 62) {
      expect(points[61]!.entry).toBe(false);
      expect(points[62]!.candidate!.date).toBe(input[61]!.date);
    }
    expect(researchVolumeSeries(id, input.slice(0, index))).toEqual(
      points.slice(0, index),
    );
    const future = [
      ...input,
      {
        ...input.at(-1)!,
        date: "2025-01-01",
        close: 1,
        open: 1,
        low: 0.5,
        high: 2,
        volume: 1000000,
      },
    ];
    expect(researchVolumeSeries(id, future).slice(0, input.length)).toEqual(
      points,
    );
    expect(researchMethodSnapshot(id).sources.length).toBeGreaterThanOrEqual(4);
  },
);

it("keeps grey price zones, source-specific bands and denominator conventions distinct", () => {
  expect(classifyVolumePrice(102 / 100 - 1, 0.01, 1.5)).toMatchObject({
    price: "grey",
    volume: "expanded",
  });
  expect(classifyVolumePrice(0.02001, 0.01, 1.5)!.price).toBe("up");
  expect(classifyVolumePrice(0.01, 0.01, 0.8)).toMatchObject({
    price: "flat",
    volume: "normal",
  });
  expect(classifyVolumePrice(-0.02001, 0.01, 0.799)!.volume).toBe("contracted");
  expect(classifyVolumePrice(0, 0.02, 1)!.price).toBe("grey");
  expect(classifyVolumePrice(0, 0, 2.2)).toMatchObject({
    mainBand: "huge",
    detailBand: "expanded",
  });
  expect(classifyVolumePrice(0, 0, 1.3)).toMatchObject({
    mainBand: "normal",
    detailBand: "mild",
  });
  const point = researchVolumeSeries("vp-breakout-1-5", examples[6]![1]).at(
    -1,
  )!;
  expect(point.values.ratio5).toBeCloseTo(150 / 110);
  expect(point.values.ratio20Prior).toBe(1.5);
  expect(
    researchVolumeSeries("vp-breakout-2", examples[6]![1]).at(-1)!.entry,
  ).toBe(false);
});

it("omits suspension rows from volume averages without omitting invalid observations", () => {
  const input = bars([], 0)
    .slice(0, 7)
    .map((bar, i) => ({ ...bar, volume: [10, 20, 0, 30, 40, 50, 60][i]! }));
  expect(volumeMa(input, 3)).toEqual([null, null, null, 20, 30, 40, 50]);
  expect(volumeMa(input, 3, true)).toEqual([
    null,
    null,
    null,
    null,
    20,
    30,
    40,
  ]);
  const invalid = input.map((bar, i) =>
    i === 3 ? { ...bar, volume: NaN } : bar,
  );
  expect(volumeMa(invalid, 3)[5]).toBeNull();
  expect(volumeMa(invalid, 3)[6]).toBe(50);
});

it("expires an unconfirmed plateau, rejects high-location entries, and blocks one-price/resumption interpretations", () => {
  const plateau = bars(
    [
      { close: 100, volume: 300 },
      ...Array.from({ length: 12 }, () => ({ close: 100, volume: 100 })),
    ],
    0,
  );
  const points = researchVolumeSeries("vp-flat-expanded-break", plateau);
  expect(points.some((point) => point.entry)).toBe(false);
  expect(points[71]!.decision).toContain("等待期结束");
  const high = bars(
    [
      { close: 180, volume: 300 },
      { close: 181, volume: 200 },
    ],
    1,
  );
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", high).at(-1)!.values
      .location,
  ).toBe("high");
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", high).some(
      (point) => point.entry,
    ),
  ).toBe(false);
  const resumed = bars(
    Array.from({ length: 7 }, (_, i) => ({
      close: 112 + i * 0.1,
      volume: i === 0 ? 0 : 100,
    })),
  );
  const rows = researchVolumeSeries("vp-volume-ma-cross", resumed);
  expect(rows.slice(61, 67).every((row) => row.reason !== null)).toBe(true);
  expect(rows[67]!.reason).toBeNull();
  const onePrice = examples[0]![1].map((bar, i) =>
    i === 61
      ? { ...bar, open: bar.close, high: bar.close, low: bar.close }
      : bar,
  );
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", onePrice)[61]!.reason,
  ).toContain("一字");
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", onePrice)[62]!.entry,
  ).toBe(false);
});

it("extends the volume history coverage boundary past a long suspension", () => {
  const input = bars(
    Array.from({ length: 100 }, (_, i) => ({
      close: 100,
      volume: i < 80 ? 0 : 100,
    })),
    0,
  );
  // Candidate waiting history starts during suspension; all 20 prior volume
  // observations therefore precede suspension (indices 41 through 60).
  expect(volumeWarmupStart(input, input[145]!.date)).toBe(input[41]!.date);
  expect(volumeStrategyIds).toHaveLength(
    9 + volumeGridIds.length + volumeCompletionIds.length,
  );
});

it("attributes a volume average exit without claiming a candidate stop", () => {
  const input = bars([
    { close: 112.2, volume: 150 },
    ...Array.from({ length: 6 }, (_, i) => ({
      close: 112.4 + i * 0.2,
      volume: 80,
    })),
  ]);
  const points = researchVolumeSeries("vp-volume-ma-cross", input);
  expect(points[61]!.entry).toBe(true);
  expect(points[61]!.ruleStop).toBeUndefined();
  const exit = points.find((point) => point.exit);
  expect(exit?.decision).toBe("有效成交记录VMA5下穿VMA10");
});

it("activates the confirmed volume protection for the first three completed holding bars", () => {
  const input = bars([
    { close: 115.36, volume: 300 },
    { close: 116, volume: 200 },
    { close: 114.7, volume: 100 },
    { close: 115.2, volume: 100 },
    { close: 115.1, volume: 100 },
    { close: 114.7, volume: 100 },
  ]);
  const common = createExtendedStudyRule("research-volume-price", input)!;
  const protectedRule = createExtendedStudyRule(
    "research-volume-price-protected",
    input,
  )!;
  const position = { entry: 116, entryIndex: 63, signalIndex: 62 };
  expect(protectedRule(62, { entry: 0, entryIndex: 62 }).enter).toBe(true);
  expect(common(63, position).exit).toBe(false);
  expect(protectedRule(63, position)).toMatchObject({
    exit: true,
    reason: "入场确认位前三根内收盘失守",
  });
  expect(
    protectedRule(63, { entry: 0, entryIndex: 63, signalIndex: 62 }).exit,
  ).toBe(false);
  expect(protectedRule(66, position).exit).toBe(common(66, position).exit);
  expect(common(66, position).exit).toBe(false);
});
