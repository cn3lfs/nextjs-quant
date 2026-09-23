import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchTechnicalSeries } from "../../src/lib/research/technical/research-technical";
import { researchSignals } from "../../src/server/strategies/shared/research-signals";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import {
  externalFormulaIds,
  externalFormulaProfiles,
  externalFormulaOriginals,
  externalFormulaDecision,
  formulaPsyRank,
  researchExternalFormulaSeries,
  type ExternalFormulaEvidence,
} from "../../src/lib/research/specs/research-formula-external";
const bars = (n = 30): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
const proof = (input: Bar[]): ExternalFormulaEvidence[] =>
  input.map((b) => ({
    date: b.date,
    availableDate: b.date,
    source: "fixed-fixture",
    limits: { hasDailyLimit: true, up: 110, down: 90 },
    benchmarkClose: 100,
  }));

it("reports requested interval and concrete missing fields at the real research entrypoint", async () => {
  const input = bars(80);
  const spec = researchSpecSchema.parse({
    strategy: "tdx-finance-asof",
    start: input[65]!.date,
    end: input[79]!.date,
    validationStart: input[75]!.date,
  });
  await expect(
    researchSignals("sh600000", input, spec, async () => {
      throw new Error("unexpected native");
    }),
  ).rejects.toThrow(
    `研究区间${spec.start}至${spec.end}没有可用策略输入：待数据：观察日唯一date/availableDate/source证据；披露时点、同期间同币种营收/成本/净利润/净资产`,
  );
});

it("executes the full old-duck formula with positive evidence and rejects a missing volume confirmation", () => {
  const closes = [
    ...Array.from({ length: 160 }, (_, i) => 100 + i * 0.5),
    ...Array.from({ length: 7 }, (_, i) => 179.5 - 0.5 * (i + 1)),
    177,
  ];
  const input = bars(closes.length).map((b, i) => ({
    ...b,
    open: closes[i]! - 0.1,
    close: closes[i]!,
    high: closes[i]! + 1,
    low: closes[i]! - 1,
    volume: i === closes.length - 1 ? 3000 : 1000,
  }));
  const rows = proof(input).map((e) => ({ ...e, listedDate: "2020-01-01" }));
  expect(
    researchExternalFormulaSeries("tdx-duck-asof", input, rows).at(-1),
  ).toMatchObject({ entry: true, values: { formula: 1 } });
  input.at(-1)!.volume = 1000;
  expect(
    researchExternalFormulaSeries("tdx-duck-asof", input, rows).at(-1)!.values
      .formula,
  ).toBe(0);
});
it("keeps every unsupported or board-inappropriate original, without substituting repaired expressions", () => {
  expect(externalFormulaOriginals["SW12-old-duck"]).toContain("FINANCE(42)");
  expect(externalFormulaOriginals["SW12-limit-state"]).toContain(
    "DYNAINFO(59)",
  );
  expect(externalFormulaOriginals["SW12-four-limit-down"]).toContain("<=-9");
  expect(externalFormulaOriginals["SW12-ten-limit"]).toContain("1.097");
  for (const id of externalFormulaIds)
    expect(
      externalFormulaOriginals[externalFormulaProfiles[id][0]],
    ).toBeTruthy();
});
it("financial thresholds are strict and reject denominator or disclosure ambiguity", () => {
  const input = bars(),
    rows = proof(input),
    i = input.length - 1;
  rows[i]!.finance = {
    revenue: 100,
    cost: 79,
    profit: 16,
    equity: 100,
    period: "2023-09-30",
    currency: "CNY",
  };
  expect(
    externalFormulaDecision("tdx-finance-asof", input, i, rows).value,
  ).toBe(1);
  for (const change of [{ cost: 80 }, { profit: 10 }, { equity: 16 / 0.15 }]) {
    const negative = structuredClone(rows);
    Object.assign(negative[i]!.finance!, change);
    expect(
      externalFormulaDecision("tdx-finance-asof", input, i, negative).value,
    ).toBe(0);
  }
  rows[i]!.finance.equity = 0;
  expect(
    externalFormulaDecision("tdx-finance-asof", input, i, rows).value,
  ).toBeNull();
});
it("old duck age uses completed calendar days and does not silently omit the source age filter", () => {
  const input = bars(),
    rows = proof(input),
    i = 29;
  rows[i]!.listedDate = new Date(Date.parse(input[i]!.date) - 101 * 86400000)
    .toISOString()
    .slice(0, 10);
  expect(
    externalFormulaDecision("tdx-duck-asof", input, i, rows, 1).value,
  ).toBe(1);
  expect(
    externalFormulaDecision("tdx-duck-asof", input, i, rows, 0).value,
  ).toBe(0);
  rows[i]!.listedDate = new Date(Date.parse(input[i]!.date) - 100 * 86400000)
    .toISOString()
    .slice(0, 10);
  expect(
    externalFormulaDecision("tdx-duck-asof", input, i, rows, 1).value,
  ).toBe(0);
});
it.each(["up", "down"] as const)(
  "%s limit types distinguish touched, currently sealed and intraday-only with board-independent limits",
  (direction) => {
    const input = bars(),
      rows = proof(input),
      i = 29,
      down = direction === "down";
    Object.assign(
      input[i]!,
      down
        ? { low: 90, close: 90, open: 95 }
        : { high: 110, close: 110, open: 105 },
    );
    rows[i]!.book = down
      ? { bid: 90, ask: 90, bidVolume: 0, askVolume: 1 }
      : { bid: 110, ask: 110, bidVolume: 1, askVolume: 0 };
    const id = (suffix: "any" | "current" | "intraday") =>
      `tdx-limit-${direction}-${suffix}` as const;
    expect(externalFormulaDecision(id("any"), input, i, rows).value).toBe(1);
    expect(externalFormulaDecision(id("current"), input, i, rows).value).toBe(
      1,
    );
    expect(externalFormulaDecision(id("intraday"), input, i, rows).value).toBe(
      0,
    );
    Object.assign(input[i]!, { close: 100 });
    Object.assign(rows[i]!.book!, {
      bid: 100,
      ask: 100,
      bidVolume: 1,
      askVolume: 1,
    });
    expect(externalFormulaDecision(id("current"), input, i, rows).value).toBe(
      0,
    );
    expect(externalFormulaDecision(id("intraday"), input, i, rows).value).toBe(
      1,
    );
    Object.assign(input[i]!, { high: 101, low: 99 });
    expect(externalFormulaDecision(id("any"), input, i, rows).value).toBe(0);
    delete rows[i]!.book;
    expect(
      externalFormulaDecision(id("current"), input, i, rows).value,
    ).toBeNull();
  },
);
it("preserves the include-one-price branch and requires exact legal limits for ten/four sessions", () => {
  const input = bars(),
    rows = proof(input),
    i = 29;
  Object.assign(input[i]!, { open: 110, close: 110, high: 110, low: 110 });
  expect(
    externalFormulaDecision("tdx-limit-up-any", input, i, rows).value,
  ).toBe(1);
  rows[i]!.limits!.includeOnePrice = false;
  expect(
    externalFormulaDecision("tdx-limit-up-any", input, i, rows).value,
  ).toBe(0);
  expect(externalFormulaDecision("tdx-ten-up-asof", input, i, rows).value).toBe(
    1,
  );
  input[i]!.close = 109.7;
  expect(externalFormulaDecision("tdx-ten-up-asof", input, i, rows).value).toBe(
    0,
  );
  for (let j = 26; j < 30; j++) input[j]!.close = 90;
  expect(
    externalFormulaDecision("tdx-four-down-asof", input, i, rows).value,
  ).toBe(1);
  input[26]!.close = 91;
  expect(
    externalFormulaDecision("tdx-four-down-asof", input, i, rows).value,
  ).toBe(0);
  delete rows[26]!.limits;
  expect(
    externalFormulaDecision("tdx-four-down-asof", input, i, rows).value,
  ).toBeNull();
});
it("relative strength requires exact aligned endpoint dates and strict outperformance", () => {
  const input = bars(),
    rows = proof(input),
    i = 29;
  input[i]!.close = 110;
  rows[i]!.benchmarkClose = 109;
  expect(
    externalFormulaDecision("tdx-relative-asof", input, i, rows).value,
  ).toBe(1);
  rows[i]!.benchmarkClose = 110;
  expect(
    externalFormulaDecision("tdx-relative-asof", input, i, rows).value,
  ).toBe(0);
  rows.splice(9, 1);
  expect(
    externalFormulaDecision("tdx-relative-asof", input, i, rows).value,
  ).toBeNull();
});
it("PSY second output uses the entire historical pool, tied competition ranks and original >=10 direction", () => {
  const input = bars(),
    dates = input.slice(-18).map((b) => b.date),
    rows = proof(input);
  const universe = {
    symbol: "target",
    complete: true,
    dates,
    members: [
      ...Array.from({ length: 9 }, (_, i) => ({
        symbol: `s${i}`,
        closes: Array.from({ length: 18 }, (_, j) => 100 + j),
      })),
      { symbol: "target", closes: Array<number>(18).fill(100) },
    ],
  };
  rows[29]!.universe = universe;
  expect(formulaPsyRank(universe, dates)).toBe(10);
  expect(
    externalFormulaDecision("tdx-psy-rank-asof", input, 29, rows).value,
  ).toBe(1);
  universe.members.pop();
  universe.symbol = "s0";
  expect(formulaPsyRank(universe, dates)).toBe(1);
  expect(
    externalFormulaDecision("tdx-psy-rank-asof", input, 29, rows).value,
  ).toBe(0);
  universe.complete = false;
  expect(formulaPsyRank(universe, dates)).toBeNull();
});
it.each(externalFormulaIds)(
  "%s keeps absent/future/duplicate data unavailable in its executable adapter",
  (id) => {
    const input = bars(),
      rows = proof(input);
    expect(researchTechnicalSeries(id, input)).toEqual(
      researchExternalFormulaSeries(id, input),
    );
    for (const evidence of [
      [],
      rows.map((e) => ({ ...e, availableDate: "2099-01-01" })),
      [...rows, ...rows],
    ]) {
      const point = researchExternalFormulaSeries(id, input, evidence).at(-1)!;
      expect(point.entry).toBe(false);
      expect(point.values.formula).toBeNull();
      expect(point.reason).toContain("待数据");
    }
  },
);
