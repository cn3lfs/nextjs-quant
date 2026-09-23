import { expect, it, vi } from "vitest";
import * as breakout from "../src/server/strategies/breakout/breakout";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { researchGroupRisk } from "../src/lib/research-group-risk";
import {
  contextRiskTemplate,
  contextRiskPoint,
  type ContextRiskInput,
} from "../src/lib/research-context-risk";
import { riskPresetTemplate } from "../src/lib/research-risk-presets";
import { researchKellyTraining } from "../src/lib/research-kelly-training";
import { applyResearchManagement } from "../src/components/research/research-strategy-fields";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
const bars = Array.from({ length: 100 }, (_, i) => ({
  date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 100000,
  amount: 10000000,
}));
const calendar = bars.map((b) => b.date),
  symbols = ["sh600000", "sh600001", "sz000001", "sz000002"];
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const inputs: ContextRiskInput[] = symbols.flatMap((symbol) =>
  calendar.map((date) => ({
    symbol,
    date,
    source: "fixed",
    version: "1",
    effectiveAt: `${date}T14:00:00+08:00`,
    availableAt: `${date}T14:00:00+08:00`,
    capturedAt: `${date}T14:00:00+08:00`,
    sector: "shared",
    marketStage: {
      stage: "bull",
      predicateVersion: "fixed",
      evidence: "fixture",
    },
    scheduledEvent: {
      coverageComplete: true,
      id: "E1",
      eventDate: calendar[72]!,
      announcedAt: "2021-01-01T13:00:00+08:00",
      evidence: "announced",
    },
  })),
);
const events: ResearchEvent[] = symbols.map((symbol) => ({
  symbol,
  observedDate: calendar[65]!,
  endpointDate: calendar[65]!,
  key: "same",
  strategyVersion: "fixed",
  partition: "development",
  evidence: "fixture",
}));
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[60],
  end: calendar[95],
  validationStart: calendar[90],
  costs,
  initialCapital: 1000000,
});
const series = new Map(symbols.map((s) => [s, bars]));
it("sector sums nonnegative risk, caps equality at 3%, includes fees and does not net protected profits", () => {
  const held = symbols
    .slice(1)
    .map((symbol) => ({ symbol, quantity: 2000, entry: 100, stop: 95 }));
  const check = researchGroupRisk(
    symbols[0]!,
    calendar[65]!,
    calendar,
    series,
    inputs,
    held,
    1000000,
    costs,
  );
  expect(check).toMatchObject({
    used: 30000,
    fraction: 0,
    members: [...symbols].sort(),
    reason: null,
  });
  held[0]!.stop = 110;
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      inputs,
      held,
      1000000,
      costs,
    ).used,
  ).toBe(20000);
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      [],
      held,
      1000000,
      costs,
    ).fraction,
  ).toBeNull();
});
it("different sectors still connect on 60-return correlation; future data cannot change grouping", () => {
  const varying = bars.map((b, i) => {
    const close = 100 + Math.sin(i);
    return { ...b, open: close, close, low: close - 1, high: close + 1 };
  });
  const map = new Map(symbols.map((s) => [s, varying]));
  const rows = inputs.map((r) => ({ ...r, sector: r.symbol }));
  const held = [{ symbol: symbols[1]!, quantity: 2000, entry: 100, stop: 95 }];
  const run = (m: typeof map) =>
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      m,
      rows,
      held,
      1000000,
      costs,
    );
  expect(run(map).members).toEqual(symbols.slice(0, 2));
  const future = new Map(
    [...map].map(([s, bs]) => [
      s,
      bs.map((b, i) => (i > 65 ? { ...b, close: 900 } : b)),
    ]),
  );
  expect(run(future)).toEqual(run(map));
  expect(
    researchGroupRisk(
      symbols[0]!,
      calendar[65]!,
      calendar,
      series,
      rows,
      held,
      1000000,
      costs,
    ).reason,
  ).toContain("零方差");
});
it("actual fills aggregate same-sector risk while diversification admits one", () => {
  const run = (id: "rk-sector-risk" | "rk-diversify") =>
    researchPortfolio(
      applyResearchManagement(base, {
        ...contextRiskTemplate(id),
        contextRiskInputs: inputs,
      }),
      events,
      calendar,
      series,
      () => rules,
    );
  const risk = run("rk-sector-risk");
  expect(risk.trades.map((t) => t.quantity)).toEqual([2000, 2000, 2000]);
  expect(risk.groupRiskChecks!.some((r) => r.check.fraction === 0)).toBe(true);
  expect(run("rk-diversify").trades.map((t) => t.event.symbol)).toEqual([
    symbols[0],
  ]);
});
it("event pre-announcement triggers one half reduction, preserves blocked sell and uses no future publication", () => {
  const spec = applyResearchManagement(base, {
    ...contextRiskTemplate("rk-event-reduce"),
    contextRiskInputs: inputs,
  });
  const result = researchPortfolio(
    spec,
    [events[0]!],
    calendar,
    series,
    (_s, d) => ({ ...rules, tradable: d !== calendar[70] }),
  );
  expect(result.trades[0]!.sales).toHaveLength(1);
  expect(result.trades[0]!.sales![0]).toMatchObject({
    triggerDate: calendar[69],
    date: calendar[71],
    quantity: 1000,
  });
  expect(result.trades[0]!.remainingQuantity).toBe(1000);
  const late = inputs.map((r) => ({
    ...r,
    scheduledEvent: {
      ...r.scheduledEvent!,
      announcedAt: "2022-01-01T00:00:00Z",
    },
  }));
  expect(
    contextRiskPoint(
      "rk-event-reduce",
      late,
      symbols[0]!,
      calendar[69]!,
      calendar,
    ).status,
  ).toBe("missing");
});
it("positive trained Kelly cannot override bear/distribution; unknown is missing", () => {
  const training = researchKellyTraining(
    Array.from({ length: 30 }, (_, i) => ({
      event: {
        symbol: symbols[0]!,
        key: String(i),
        observedDate: "2020-01-01",
        partition: "development",
      },
      entryDate: "2020-01-02",
      exitDate: "2020-01-03",
      profit: i < 20 ? 200 : -100,
    })),
    "2020-01-01",
    "2020-02-01",
  );
  const run = (rows: typeof inputs) =>
    researchPortfolio(
      applyResearchManagement(base, {
        ...contextRiskTemplate("rk-kelly-market"),
        contextRiskInputs: rows,
      }),
      [events[0]!],
      calendar,
      series,
      () => rules,
      undefined,
      training,
    );
  expect(run(inputs).trades).toHaveLength(1);
  for (const stage of ["bear", "distribution"] as const)
    expect(
      run(
        inputs.map((r) => ({
          ...r,
          marketStage: { ...r.marketStage!, stage },
        })),
      ).trades,
    ).toHaveLength(0);
  expect(
    run(inputs.map((r) => ({ ...r, marketStage: undefined }))).excluded[0]!
      .reason,
  ).toContain("missing");
});
it("month boundary rebalance sells only frozen overweight quantity and does not recur daily", () => {
  const input = bars.map((b, i) =>
    i >= 90 ? { ...b, open: 150, close: 150, high: 151, low: 149 } : b,
  );
  const result = researchPortfolio(
    applyResearchManagement(base, riskPresetTemplate("rk-rebalance")),
    [events[0]!],
    calendar,
    new Map([[symbols[0]!, input]]),
    () => rules,
  );
  // March holding 2000; April 1 equity=1.1m and target=220000/150, so sell floor(533/100)*100.
  expect(result.trades[0]!.sales).toHaveLength(1);
  expect(result.trades[0]!.sales![0]).toMatchObject({
    triggerDate: calendar[90],
    date: calendar[91],
    quantity: 500,
  });
  expect(result.trades[0]!.remainingQuantity).toBe(1500);
});

it.each(["rk-sector-risk", "rk-diversify"] as const)(
  "%s refuses research-period-only action proof for its historical correlation inputs",
  async (id) => {
    const original = breakout.analyzeBreakout(bars);
    // S4 breakout rewrite: the signal loop calls `analyzeBreakout(bars, 0)` once
    // and reads `points[index]`, so the stub must cover every index instead of
    // only the called prefix. The overrides (and therefore the behaviour this
    // test asserts) are unchanged.
    const spy = vi
      .spyOn(breakout, "analyzeBreakout")
      .mockImplementation((calledBars) => {
        const points: typeof original.points = calledBars.map((bar) => ({
          ...original.latest!,
          date: bar.date,
          long: { ...original.latest!.long, status: "是" },
        }));
        return { ...original, points, latest: points.at(-1) ?? null };
      });
    const spec = researchSpecSchema.parse({
      ...applyResearchManagement(base, {
        ...contextRiskTemplate(id),
        contextRiskInputs: inputs,
      }),
      start: calendar[61],
    });
    const symbol = symbols[0]!;
    const dataset: ResearchDataset = {
      version: "research-dataset-1",
      source: "tdx-local",
      root: "synthetic",
      adjustment: "none",
      membership: {
        mode: "current-snapshot",
        symbols: [symbol],
        source: null,
        warning: "fixture",
      },
      benchmark: { symbol: "sh000001", bars },
      calendar,
      stocks: [{ symbol, name: "fixture", bars, hash: "fixture", actions: [] }],
      excluded: [],
      actionCoverage: "missing",
      actionSource: null,
      capturedAt: 0,
      hash: "fixture",
    };
    const evidence = researchMarketEvidenceSchema.parse({
      version: "research-market-evidence-1",
      source: "fixture",
      exportedAt: 0,
      adjustment: "none",
      corporateActionFree: [
        {
          symbol,
          start: spec.start,
          end: spec.end,
          evidenceId: "only-research-period",
        },
      ],
      rows: calendar.map((date) => ({
        symbol,
        date,
        ...rules,
        evidenceId: "fixture",
      })),
    });
    const native = async () => {
      throw new Error("no DLL required for this fixture");
    };
    try {
      const insufficient = await runStrategyResearch(
        spec,
        dataset,
        evidence,
        native,
      );
      expect(
        insufficient.partitions.flatMap((p) => p.simulation!.trades),
      ).toHaveLength(0);
      const proven = await runStrategyResearch(
        spec,
        dataset,
        {
          ...evidence,
          corporateActionFree: [
            {
              symbol,
              start: calendar[0]!,
              end: spec.end,
              evidenceId: "full-input-prefix",
            },
          ],
        },
        native,
      );
      expect(
        proven.partitions.flatMap((p) => p.simulation!.trades),
      ).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  },
);
