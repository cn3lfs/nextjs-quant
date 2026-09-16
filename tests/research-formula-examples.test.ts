import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  formulaExampleIds,
  formulaExamples,
  formulaOriginalStatus,
  researchFormulaExampleSeries,
  type FormulaExampleId,
} from "../src/lib/research-formula-examples";

function bars(closes: number[], volumes: number[] = []): Bar[] {
  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: close,
    close,
    high: close + 1,
    low: close - 1,
    volume: volumes[i] ?? 1000,
    amount: close * (volumes[i] ?? 1000),
  }));
}
const flat = (n: number) => bars(Array<number>(n).fill(100));
type Pair = { yes: Bar[]; no: Bar[] };
function fixture(id: FormulaExampleId): Pair {
  let yes = flat(40),
    no = flat(40);
  switch (id) {
    case "tdx-macd-zero":
      yes = bars([...Array<number>(30).fill(100), 110]);
      no = bars([...Array<number>(30).fill(100), 90]);
      break;
    case "tdx-boll-reentry":
      yes = bars([...Array<number>(20).fill(100), 90, 100]);
      no = bars([...Array<number>(20).fill(100), 90, 89]);
      break;
    case "tdx-volume-double":
      yes.at(-1)!.volume = 2001;
      no.at(-1)!.volume = 2000;
      break;
    case "tdx-volume-five-four":
      for (let i = 35; i < 40; i++) {
        yes[i]!.volume = 4001;
        no[i]!.volume = 4000;
      }
      break;
    case "tdx-volume-half":
      yes.at(-1)!.volume = 499;
      no.at(-1)!.volume = 500;
      break;
    case "tdx-volume-five-half":
      for (let i = 35; i < 40; i++) {
        yes[i]!.volume = 499;
        no[i]!.volume = 500;
      }
      break;
    case "tdx-volume-capital-high":
      yes.at(-1)!.volume = 1001;
      no.at(-1)!.volume = 1000;
      break;
    case "tdx-volume-capital-low":
      yes.at(-1)!.volume = 49;
      no.at(-1)!.volume = 50;
      break;
    case "tdx-price-seven":
      yes = bars([100, 108]);
      no = bars([100, 107]);
      break;
    case "tdx-price-ma-rise":
      yes = bars([...Array<number>(10).fill(100), 101]);
      no = flat(11);
      break;
    case "tdx-price-bull":
      yes.at(-1)!.open = 99;
      break;
    case "tdx-price-bear":
      yes.at(-1)!.open = 101;
      break;
    case "tdx-price-volume-attack":
      yes = bars([100, 108], [1000, 2001]);
      no = bars([100, 108], [1000, 2000]);
      break;
    case "tdx-price-high":
      yes.at(-1)!.high = 102;
      no[20]!.high = 102;
      break;
    case "tdx-price-range":
      yes = flat(10);
      no = bars([106, ...Array<number>(9).fill(100)]);
      break;
    case "tdx-open-high":
      yes.at(-1)!.open = 101;
      break;
    case "tdx-open-low":
      yes.at(-1)!.open = 99;
      break;
    case "tdx-gap-up":
      yes = bars([100, 103]);
      no = bars([100, 101]);
      break;
    case "tdx-gap-down":
      yes = bars([100, 97]);
      no = bars([100, 99]);
      break;
    case "tdx-gap-unfilled":
      yes = bars([100, 104, 104]);
      no = bars([100, 104, 102]);
      break;
    case "tdx-gap-count-original":
      yes = bars([100, 100, 104, 104]);
      no = bars([100, 100, 104, 102]);
      break;
    case "tdx-ma-order":
    case "tdx-ma-order-four":
      yes = bars(Array.from({ length: 40 }, (_, i) => 100 + i));
      break;
    case "tdx-base-breakout":
      yes = flat(151);
      no = flat(151);
      yes[150]!.high = 102;
      yes[150]!.volume = 2001;
      no[150]!.high = 102;
      no[150]!.volume = 2000;
      break;
    case "tdx-skill-cross":
      yes = bars([...Array<number>(10).fill(100), 101]);
      no = bars([...Array<number>(10).fill(100), 99]);
      break;
    case "tdx-new-high":
      yes.at(-1)!.high = 101;
      yes.at(-1)!.close = 101;
      break;
    case "tdx-three-volume":
      yes = bars([100, 100, 100, 100], [1, 2, 3, 4]);
      no = bars([100, 100, 100, 100], [1, 2, 3, 3]);
      break;
    default: {
      const never: never = id;
      throw new Error(never);
    }
  }
  return { yes, no };
}
const capital = (input: Bar[]) =>
  input.map((b) => ({
    date: b.date,
    availableDate: b.date,
    source: "fixed-fixture",
    floatShares: 10000,
    volumeUnit: "share" as const,
  }));
it.each(formulaExampleIds)(
  "%s preserves an independently constructed positive and threshold/equality negative",
  (id) => {
    const { yes, no } = fixture(id);
    expect(
      researchFormulaExampleSeries(id, yes, capital(yes)).at(-1)!.values
        .formula,
    ).toBe(1);
    expect(
      researchFormulaExampleSeries(id, no, capital(no)).at(-1)!.values.formula,
    ).toBe(0);
  },
);
it("retains unsupported originals and exposes a separate runnable expression", () => {
  for (const id of [
    "tdx-macd-zero",
    "tdx-boll-reentry",
    "tdx-price-seven",
    "tdx-price-ma-rise",
    "tdx-price-high",
    "tdx-base-breakout",
    "tdx-volume-capital-high",
    "tdx-volume-capital-low",
  ] as const) {
    expect(formulaOriginalStatus(id).runnable).toBe(false);
    expect(formulaExamples[id].original).not.toBe(formulaExamples[id].formula);
    expect(formulaExamples[id].revision).toBeTruthy();
  }
  expect(formulaExamples["tdx-price-ma-rise"].original).toContain("REE");
  expect(formulaExamples["tdx-price-seven"].original).toContain(";;");
});
it("does not claim the two gap examples use the same anchor", () => {
  const input = bars([90, 100, 104, 104]);
  // Yesterday's low is above the high two days ago in the fixed-anchor rule;
  // change only the older high: the moving COUNT rule must now disagree.
  input[0]!.high = 110;
  expect(
    researchFormulaExampleSeries("tdx-gap-unfilled", input).at(-1)!.values
      .formula,
  ).toBe(1);
  expect(
    researchFormulaExampleSeries("tdx-gap-count-original", input).at(-1)!.values
      .formula,
  ).toBe(0);
});
it("uses the experts' two named outputs and the base breakout's final boolean output", () => {
  const macd = researchFormulaExampleSeries(
    "tdx-macd-zero",
    bars([...Array<number>(30).fill(100), 110, 90]),
  );
  expect(macd[30]).toMatchObject({ entry: true, exit: false });
  expect(macd[31]).toMatchObject({ entry: false, exit: true });
  const boll = researchFormulaExampleSeries(
    "tdx-boll-reentry",
    bars([...Array<number>(20).fill(100), 90, 100, 110]),
  );
  expect(boll[21]).toMatchObject({ entry: true, exit: false });
  expect(boll[22]).toMatchObject({ entry: false, exit: true });
  expect(
    researchFormulaExampleSeries(
      "tdx-base-breakout",
      fixture("tdx-base-breakout").no,
    ).at(-1)!.values.formula,
  ).toBe(0);
});
it("requires exact-day as-of capital, unique evidence and compatible volume units", () => {
  const input = fixture("tdx-volume-capital-high").yes,
    proof = capital(input),
    last = proof.at(-1)!;
  for (const changed of [
    [],
    [...proof, last],
    proof.map((e) => ({ ...e, availableDate: "2099-01-01" })),
    proof.map((e) => ({ ...e, source: "" })),
    proof.map((e) => ({ ...e, floatShares: NaN })),
  ]) {
    expect(
      researchFormulaExampleSeries(
        "tdx-volume-capital-high",
        input,
        changed,
      ).at(-1),
    ).toMatchObject({
      entry: false,
      reason: expect.stringContaining("待数据"),
    });
  }
  const lots = input.map((b) => ({ ...b, volume: b.volume / 100 }));
  expect(
    researchFormulaExampleSeries(
      "tdx-volume-capital-high",
      lots,
      proof.map((e) => ({ ...e, volumeUnit: "lot100" as const })),
    ).at(-1)!.values.formula,
  ).toBe(1);
});
