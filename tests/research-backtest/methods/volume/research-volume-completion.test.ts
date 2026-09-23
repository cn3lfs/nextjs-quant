import { researchVolumeSeries } from "../../../../src/lib/research/methods/volume/research-volume";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import {
  washExternalVotes,
  washComposite,
  researchVolumeCompletionSeries,
  type WashEvidence,
} from "../../../../src/lib/research/methods/volume/research-volume-completion";
import { pivotDivergenceSeries } from "../../../../src/lib/research/technical/research-pivot-divergence";
const bar: Bar = {
  date: "2020-01-02",
  open: 100,
  high: 103,
  low: 95,
  close: 101,
  volume: 1000,
  amount: 100000,
};
const evidence: WashEvidence = {
  date: bar.date,
  availableDate: bar.date,
  source: "fixed",
  morningLow: 97,
  afternoonOpen: 100,
  previousChipPeak: 100,
  chipPeak: 99,
  highChipFraction: 0.2,
  turnover: 3,
  newsCoverage: true,
  adverseNews: false,
  earningsMiss: false,
};
it("七维外部证据真实三维、从严组合、不可用时点", () => {
  expect(washExternalVotes(bar, 100, evidence)).toEqual({
    intraday: "wash",
    chips: "wash",
    news: "wash",
  });
  expect(
    washExternalVotes({ ...bar, open: 102, close: 96 }, 100, {
      ...evidence,
      turnover: 15,
      highChipFraction: 0.5,
      adverseNews: true,
    }),
  ).toEqual({
    intraday: "distribution",
    chips: "distribution",
    news: "distribution",
  });
  for (const patch of [
    { availableDate: "2020-01-03" },
    { source: "" },
    { date: "2020-01-01" },
  ])
    expect(
      Object.values(washExternalVotes(bar, 100, { ...evidence, ...patch })),
    ).toEqual(["unknown", "unknown", "unknown"]);
  expect(washExternalVotes(bar, 100, { ...evidence, turnover: 7 }).chips).toBe(
    "unknown",
  );
  expect(
    washExternalVotes(bar, 100, { ...evidence, newsCoverage: false }).news,
  ).toBe("unknown");
  expect(washExternalVotes(bar, 100).intraday).toBe("unknown");
  expect(washComposite(Array(7).fill("wash"))).toBe("wash");
  for (let i = 0; i < 7; i++) {
    const v: Array<"wash" | "unknown"> = Array(7).fill("wash");
    v[i] = "unknown";
    expect(washComposite(v)).toBe("distribution");
  }
  expect(washComposite(Array(4).fill("wash"))).toBe("distribution");
});
const prices = [
  10, 11, 12, 15, 12, 11, 10, 11, 12, 16, 12, 11, 10, 11, 12, 17, 12, 11, 10,
];
const bars = prices.map((p, i) => ({
  ...bar,
  date: `2020-01-${String(i + 1).padStart(2, "0")}`,
  open: p,
  close: p,
  high: p + 0.2,
  low: p - 0.2,
}));
it("枢轴端点取值、确认日期、连续两次及平价反例", () => {
  const line = prices.map((_, i) => 100 - i);
  const result = pivotDivergenceSeries(bars, line);
  expect(result[9]!.top.single).toBe(false);
  expect(result[12]!.top.single).toBe(true);
  expect(result[18]!.top.double).toBe(true);
  expect(result[12]!.top.pivots.at(-1)?.date).toBe(bars[9]!.date);
  expect(pivotDivergenceSeries(bars, prices)[12]!.top.single).toBe(false);
  const invalid = bars.map((b, i) => (i === 8 ? { ...b, volume: 0 } : b));
  expect(pivotDivergenceSeries(invalid, line)[12]!.top.single).toBe(false);
  const equal = bars.map((b, i) =>
    i === 9 ? { ...b, high: bars[3]!.high } : b,
  );
  expect(pivotDivergenceSeries(equal, line)[12]!.top.single).toBe(false);
});
it("OBV预设与七维待数据适配可运行且不会补造输入", () => {
  expect(
    researchVolumeCompletionSeries("vp-pivot-obv", bars, researchVolumeSeries),
  ).toHaveLength(bars.length);
  expect(
    researchVolumeCompletionSeries(
      "vp-wash-seven",
      bars,
      researchVolumeSeries,
    ).some((p) => p.entry),
  ).toBe(false);
  expect(
    researchVolumeCompletionSeries(
      "vp-huge-half",
      bars,
      researchVolumeSeries,
    ).some((p) => p.reduction),
  ).toBe(false);
});

it("天量形态适配首次减半、持续不重卖、MA20失守清仓", () => {
  const base = researchVolumeSeries("vp-breakout-1-5", bars)
    .slice(0, 4)
    .map((p, i) => ({
      ...p,
      reason: null,
      exit: i > 0,
      decision: i > 0 ? "天量长上影/光头阴线/冲高回落，形态优先" : "等待",
      values: { ...p.values, close: i === 3 ? 99 : 101, ma20: 100 },
    }));
  const rows = researchVolumeCompletionSeries(
    "vp-huge-half",
    bars.slice(0, 4),
    () => base,
  );
  expect(rows.map((p) => p.reduction?.fraction ?? null)).toEqual([
    null,
    0.5,
    null,
    null,
  ]);
  expect(rows.map((p) => p.exit)).toEqual([false, false, false, true]);
  const other = researchVolumeCompletionSeries(
    "vp-huge-half",
    bars.slice(0, 4),
    () => base.map((p) => ({ ...p, decision: "未知位置从严退出" })),
  );
  expect(other.some((p) => p.reduction)).toBe(false);
});
it("七维完整日线候选及真实三维证据正例、缺失从严", () => {
  const data = Array.from({ length: 103 }, (_, i) => {
    const c = 100 + i * 0.5 + Math.sin(i / 3) * 3;
    return {
      ...bar,
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: c - 0.2,
      close: c,
      high: c + 1,
      low: c - 1,
      volume: i === 70 ? 500 : 100,
    };
  });
  Object.assign(data[100]!, { open: 159, high: 161, low: 158, close: 160 });
  Object.assign(data[101]!, {
    open: 160,
    high: 160,
    low: 154,
    close: 155,
    volume: 200,
  });
  Object.assign(data[102]!, {
    open: 158,
    high: 162,
    low: 154.5,
    close: 161,
    volume: 150,
  });
  const last = data[102]!;
  const proof = {
    ...evidence,
    date: last.date,
    availableDate: last.date,
    morningLow: 154.5,
    afternoonOpen: 158,
  };
  const result = researchVolumeCompletionSeries(
    "vp-wash-seven",
    data,
    researchVolumeSeries,
    {},
    { [last.date]: proof },
  );
  expect(result.at(-1)).toMatchObject({
    entry: true,
    exit: false,
    reason: null,
  });
  expect(
    researchVolumeCompletionSeries(
      "vp-wash-seven",
      data,
      researchVolumeSeries,
    ).at(-1),
  ).toMatchObject({
    entry: false,
    exit: true,
    reason: expect.stringContaining("待数据"),
  });
  expect(
    researchVolumeCompletionSeries(
      "vp-wash-seven",
      data,
      researchVolumeSeries,
      {},
      { [last.date]: { ...proof, adverseNews: true } },
    ).at(-1),
  ).toMatchObject({ entry: false, exit: true });
});

it("已知公司行动会隔离枢轴OBV，不带入可比较窗口", () => {
  const input = bars.map((b, i) => ({
    ...b,
    volume: i > 0 && b.close < bars[i - 1]!.close ? 200 : 100,
  }));
  const compute: typeof researchVolumeSeries = (_id, data) =>
    researchVolumeSeries("vp-breakout-1-5", data).map((p) => ({
      ...p,
      reason: null,
    }));
  expect(
    researchVolumeCompletionSeries("vp-pivot-obv", input, compute)[12]!.exit,
  ).toBe(true);
  const date = input[8]!.date;
  expect(
    researchVolumeCompletionSeries("vp-pivot-obv", input, compute, {
      [date]: {
        date,
        availableDate: date,
        source: "fixed",
        corporateAction: true,
      },
    })[12]!.exit,
  ).toBe(false);
});
