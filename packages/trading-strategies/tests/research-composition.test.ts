import { expect, it, vi } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import type { FormulaRuntime } from "../src/research/contracts/formula-runtime.js";
import { researchRuleSeries } from "../src/research/composition/research-rule-series.js";
import { researchTechnicalSeries } from "../src/research/technical/research-technical.js";
import { externalFormulaDecision } from "../src/research/technical/research-formula-external.js";

const bars: Bar[] = Array.from({ length: 160 }, (_, index) => ({
  date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
  open: 100,
  high: 102,
  low: 98,
  close: 100 + Math.sin(index),
  volume: 1000,
  amount: 100000,
}));

it("runs fixed technical and CANSLIM combinations without a formula interpreter", () => {
  const runtime: FormulaRuntime = {
    evaluate: vi.fn(() => {
      throw new Error("Unexpected DSL evaluation");
    }),
    inspectOriginal: vi.fn(() => {
      throw new Error("Unexpected DSL compilation");
    }),
  };
  for (const id of [
    "ma-golden-5-10",
    "sw-system-combined",
    "canslim-cup-u-window120",
  ] as const) {
    const full = researchRuleSeries(
      id,
      bars,
      undefined,
      undefined,
      {},
      runtime,
    );
    expect(full).toHaveLength(bars.length);
    expect(
      researchRuleSeries(
        id,
        bars.slice(0, 120),
        undefined,
        undefined,
        {},
        runtime,
      ),
    ).toEqual(full.slice(0, 120));
  }
  expect(runtime.evaluate).not.toHaveBeenCalled();
  expect(runtime.inspectOriginal).not.toHaveBeenCalled();
});

it("rejects missing DSL runtime explicitly instead of returning an empty signal series", () => {
  expect(() => researchTechnicalSeries("tdx-volume-double", bars)).toThrow(
    "显式提供公式解释器",
  );
  expect(() => researchRuleSeries("tdx-finance-asof", bars)).toThrow(
    "显式提供公式解释器",
  );
});

it("keeps strict financial thresholds and dated evidence in the pure external-rule engine", () => {
  const point = bars.at(-1)!;
  const row = {
    date: point.date,
    availableDate: point.date,
    source: "frozen-finance",
    finance: {
      revenue: 100,
      cost: 79,
      profit: 16,
      equity: 100,
      period: "2019-12-31",
      currency: "CNY",
    },
  };
  expect(
    externalFormulaDecision("tdx-finance-asof", bars, bars.length - 1, [row]),
  ).toEqual({ value: 1, reason: null });
  expect(
    externalFormulaDecision("tdx-finance-asof", bars, bars.length - 1, [
      { ...row, finance: { ...row.finance, cost: 80 } },
    ]).value,
  ).toBe(0);
  expect(
    externalFormulaDecision("tdx-finance-asof", bars, bars.length - 1, [
      { ...row, availableDate: "2099-01-01" },
    ]).value,
  ).toBeNull();
});
