import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  classicDefinitions,
  classicIds,
  classicIndicatorSeries,
  createClassicRule,
  type ClassicId,
} from "../src/classics/index.js";
import type { Bar } from "trading-strategy-core/bars";
function bars(closes: readonly number[], volumes?: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: close,
    close,
    high: close + 2,
    low: Math.max(close - 2, 0.01),
    volume: volumes?.[i] ?? 1000,
    amount: 100000,
  }));
}
const position = { entry: 10, entryIndex: 0 };
const sample = (id: ClassicId, input: Bar[], index = input.length - 1) =>
  classicIndicatorSeries(id, input)[index]!;
it("registers ten different indicator baselines with pinned source URLs and declared warmup", () => {
  expect(new Set(classicIds).size).toBe(10);
  expect(classicDefinitions.map((d) => d.id)).toEqual([...classicIds]);
  for (const d of classicDefinitions) {
    expect(d.sources[0]).toMatch(
      /github.com.*(?:054ec0596a66f0ad09ca5101df424cf6697060a7|a890410710a6e483c9ba08da7f3dd5089e4b9dff)/,
    );
    expect(d.warmupBars).toBeGreaterThanOrEqual(0);
    expect(d.rule.length).toBeGreaterThan(30);
  }
  expect(createClassicRule("unknown", [])).toBeNull();
});
it("IBS uses natural midpoint, with a zero-range bar neutral", () => {
  const input = bars([10]);
  input[0] = { ...input[0]!, open: 10, high: 16, low: 8, close: 10 };
  expect(sample("classic-ibs", input)).toEqual({ value: 0.25, signal: 0.5 });
  expect(createClassicRule("classic-ibs", input)!(0, position)).toEqual({
    enter: true,
    exit: false,
  });
  input[0] = { ...input[0]!, high: 10, low: 10 };
  expect(sample("classic-ibs", input)).toEqual({ value: 0.5, signal: 0.5 });
});
it("KAMA full10delta efficiency1 has smoothing4/9 and previous-close seed", () => {
  const input = bars(Array.from({ length: 12 }, (_, i) => 10 + i));
  const result = classicIndicatorSeries("classic-kama", input);
  expect(result[9]!.value).toBeNull();
  expect(result[10]!.value).toBeCloseTo(19 + 4 / 9, 12);
  expect(result[11]!.value).toBeCloseTo(
    19 + 4 / 9 + (4 / 9) * (21 - (19 + 4 / 9)),
    12,
  );
});
it("Aroon uses26observations, latest tied extremes, and the correct zero axis", () => {
  const input = bars(Array.from({ length: 26 }, (_, i) => 10 + i));
  expect(sample("classic-aroon", input).value).toBe(100);
  expect(sample("classic-aroon", bars(Array(26).fill(10))).value).toBe(0);
  expect(
    sample("classic-aroon", bars(Array.from({ length: 26 }, (_, i) => 40 - i)))
      .value,
  ).toBe(-100);
});
it("TRIX triple-EMA15 reuses shared first-value seed", () => {
  expect(sample("classic-trix", bars([10, 18])).value).toBeCloseTo(0.15625, 12);
  expect(
    createClassicRule("classic-trix", bars([10, 18]))!(1, position),
  ).toEqual({ enter: false, exit: false });
});
it("ForceIndex13 smooths raw price change times current volume", () => {
  const input = bars([10, 12, 11], [100, 5, 7]);
  expect(sample("classic-force-index", input, 1).value).toBe(10);
  expect(sample("classic-force-index", input, 2).value).toBeCloseTo(53 / 7, 12);
});
it("NVI changes only on strictly lower volume and has EMA255 reference", () => {
  const result = classicIndicatorSeries(
    "classic-nvi",
    bars([10, 11, 9, 9], [100, 90, 90, 80]),
  );
  expect(result.map((p) => p.value)).toEqual([1000, 1100, 1100, 1100]);
  expect(result[1]!.signal).toBeCloseTo(1000 + 100 / 128, 12);
});
it("Coppock ROC11+ROC14 WMA10 yields independent exact rational2244667/6006", () => {
  const input = bars(Array.from({ length: 24 }, (_, i) => 1 + i));
  expect(sample("classic-coppock", input).value).toBeCloseTo(
    2244667 / 6006,
    10,
  );
  expect(sample("classic-coppock", input, 22).value).toBeNull();
});
it("Vortex14 computes VMplus-minus over same-window TR sum", () => {
  const input = bars(Array.from({ length: 15 }, (_, i) => 10 + i));
  expect(sample("classic-vortex", input).value).toBeCloseTo(0.5, 12);
  const flat = bars(Array(20).fill(10)).map((b) => ({
    ...b,
    high: 10,
    low: 10,
  }));
  expect(sample("classic-vortex", flat).value).toBeNull();
});
it("Connors ranks only prior100real returns, strict ties score0, and source keeps streak on flat", () => {
  const input = bars(Array.from({ length: 102 }, (_, i) => 2 ** (i + 3)));
  expect(sample("classic-connors-rsi", input).value).toBeCloseTo(200 / 3, 12);
  const last = { ...input.at(-1)!, date: "2020-04-12" };
  input.push(last);
  expect(sample("classic-connors-rsi", input).value).toBeCloseTo(200 / 3, 12);
  expect(
    sample("classic-connors-rsi", bars(Array(120).fill(10))).value,
  ).toBeNull();
});
it("StochRSI requires completeRSI/window/K/D and keeps constantRSI100 at source-defined100", () => {
  const input = bars(Array.from({ length: 50 }, (_, i) => 10 + i));
  const result = classicIndicatorSeries("classic-stoch-rsi", input);
  expect(result[30]!.signal).toBeNull();
  expect(result[31]).toEqual({ value: 100, signal: 100 });
  expect(
    sample("classic-stoch-rsi", bars(Array(50).fill(10))).value,
  ).toBeNull();
});
describe.each(classicIds)("%s causal rules", (id) => {
  it("is prefix invariant, leaves input unchanged and enforces warmup", () => {
    const input = bars(
      Array.from(
        { length: 330 },
        (_, i) => 100 + Math.sin(i / 5) * 10 + i / 20,
      ),
      Array.from({ length: 330 }, (_, i) => 1000 + (i % 7) * 100),
    );
    const before = structuredClone(input),
      full = classicIndicatorSeries(id, input),
      rule = createClassicRule(id, input)!;
    for (const length of [1, 20, 60, 120, 260, 310]) {
      expect(classicIndicatorSeries(id, input.slice(0, length))).toEqual(
        full.slice(0, length),
      );
      const prefix = createClassicRule(id, input.slice(0, length))!;
      expect(prefix(length - 1, position)).toEqual(rule(length - 1, position));
    }
    const warmup = classicDefinitions.find((d) => d.id === id)!.warmupBars;
    for (let i = 0; i < warmup; i++)
      expect(rule(i, position)).toEqual({ enter: false, exit: false });
    expect(rule(-1, position)).toEqual({ enter: false, exit: false });
    expect(input).toEqual(before);
  });
  it("rejects malformed prices and volume instead of generating signals", () => {
    const input = bars([10, 11]);
    input[0]!.volume = NaN;
    expect(() => createClassicRule(id, input)).toThrow("非法");
  });
});
it("freezes the actual source content hashes and complete upstream licenses", () => {
  for (const name of ["lean", "ta"]) {
    const base = new URL(
      `../../../docs/data-sources/classic-strategies/${name}/`,
      import.meta.url,
    );
    const manifest = JSON.parse(
      readFileSync(new URL("manifest.json", base), "utf8"),
    ) as {
      license: string;
      ref: string;
      files: { path: string; sha256: string }[];
    };
    expect(manifest.ref).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.license).toBe(name === "lean" ? "Apache-2.0" : "MIT");
    for (const source of manifest.files) {
      const content = readFileSync(
        new URL(source.path.split("/").at(-1)!, base),
      );
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        source.sha256,
      );
    }
    const license = readFileSync(new URL("LICENSE", base), "utf8");
    expect(license).toContain(
      name === "lean" ? "Apache License" : "Permission is hereby granted",
    );
  }
});
