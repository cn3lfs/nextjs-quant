import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { maParamsSchema } from "../src/lib/domain";
import { researchMarketEnvironment } from "../src/lib/research-market-regime";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
const config = {
  kind: "ma20" as const,
  neutralBand: 0.01,
  weakWeight: 0 as const,
};
const calendar = Array.from({ length: 72 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
function bars(price: (i: number) => number): Bar[] {
  return calendar.map((date, i) => ({
    date,
    open: price(i),
    close: price(i),
    high: price(i) + 1,
    low: price(i) - 0.5,
    volume: 10000,
    amount: price(i) * 10000,
  }));
}
const benchmark = (kind: "strong" | "neutral" | "weak") => ({
  symbol: "sh000001",
  bars: bars((i) =>
    kind === "strong" ? 100 + i : kind === "weak" ? 500 - i : 100,
  ),
});
const stock = bars(() => 50);
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: calendar[61]!,
  endpointDate: calendar[61]!,
  key: "fixture",
  evidence: "{}",
  strategyVersion: "fixture",
  partition: "development",
};
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[61],
  end: calendar[70],
  validationStart: calendar[68],
  holdingDays: 60,
  initialCapital: 100000,
  maxPositions: 1,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: {
    stop: { kind: "percent", fraction: 0.03 },
    marketRegime: config,
  },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
function run(
  market: ReturnType<typeof benchmark> | undefined,
  spec = base,
  input = stock,
) {
  return researchPortfolio(
    spec,
    [event],
    calendar,
    new Map([[event.symbol, input]]),
    () => rules,
    market,
  );
}
it("uses hand-computable prior-day MA20 and keeps future prices out of earlier decisions", () => {
  const source = benchmark("strong"),
    full = researchMarketEnvironment(source, calendar, config);
  expect(full[62]).toMatchObject({
    date: calendar[62],
    observedDate: calendar[61],
    regime: "strong",
    close: 161,
    ma20: 151.5,
    previousMa20: 150.5,
    maxWeight: 0.6,
    reason: null,
  });
  expect(
    researchMarketEnvironment(
      { ...source, bars: source.bars.slice(0, 63) },
      calendar.slice(0, 63),
      config,
    ),
  ).toEqual(full.slice(0, 63));
  const changed = structuredClone(source);
  for (let i = 62; i < 72; i++) changed.bars[i]!.close = 100000;
  expect(researchMarketEnvironment(changed, calendar, config)[62]).toEqual(
    full[62],
  );
  expect(full[20]!.reason).toContain("21根");
});
it.each(["strong", "neutral", "weak"] as const)(
  "classifies %s and applies the cap to first purchases",
  (kind) => {
    const result = run(benchmark(kind));
    expect(result.marketEnvironment![1]!.regime).toBe(kind);
    if (kind === "weak") {
      expect(result.trades).toEqual([]);
      expect(result.attempts[0]!.reason).toContain("上限为0");
    } else
      expect(result.trades[0]!.quantity).toBe(kind === "strong" ? 1200 : 600);
  },
);
it("supports a weak 30% counterfactual, a neutral band and stricter independent caps", () => {
  const weak = researchSpecSchema.parse({
    ...base,
    management: {
      ...base.management,
      marketRegime: { ...config, weakWeight: 0.3 },
    },
  });
  expect(run(benchmark("weak"), weak).trades[0]!.quantity).toBe(600);
  const cap = researchSpecSchema.parse({
    ...base,
    management: { ...base.management, maxTotalWeight: 0.2 },
  });
  expect(run(benchmark("strong"), cap).trades[0]!.quantity).toBe(400);
  const near = { symbol: "sh000001", bars: bars((i) => 100 + 0.01 * i) };
  expect(researchMarketEnvironment(near, calendar, config)[62]!.regime).toBe(
    "neutral",
  );
  expect(
    researchMarketEnvironment(near, calendar, {
      ...config,
      neutralBand: 0,
    })[62]!.regime,
  ).toBe("strong");
  expect(
    researchManagementSchema.safeParse({
      ...base.management,
      marketRegime: { ...config, neutralBand: 0.06 },
    }).success,
  ).toBe(false);
});
it("reports missing, misaligned and invalid benchmark history without converting it to a weak or neutral signal", () => {
  for (const source of [
    undefined,
    {
      ...benchmark("strong"),
      bars: benchmark("strong").bars.filter((b) => b.date !== calendar[60]),
    },
    { symbol: "sh000001", bars: bars((i) => (i === 60 ? NaN : 100 + i)) },
  ]) {
    const result = run(source);
    expect(result.trades).toEqual([]);
    expect(result.marketEnvironment![1]).toMatchObject({
      regime: "unknown",
      maxWeight: null,
      reason: expect.any(String),
    });
    expect(result.attempts[0]!.reason).toContain("缺少");
  }
  const invalid = benchmark("strong");
  invalid.bars[60]!.volume = 0;
  expect(researchMarketEnvironment(invalid, calendar, config)[62]!.regime).toBe(
    "unknown",
  );
  expect(() =>
    researchMarketEnvironment(
      { ...invalid, bars: [invalid.bars[1]!, invalid.bars[0]!] },
      calendar,
      config,
    ),
  ).toThrow("严格递增");
  const { marketRegime: _regime, ...management } = base.management!;
  const old = run(undefined, researchSpecSchema.parse({ ...base, management }));
  expect(old.trades[0]!.quantity).toBe(2000);
  expect(old).not.toHaveProperty("marketEnvironment");
});
it("blocks queued additions after deterioration without blocking scheduled sales", () => {
  const market = benchmark("strong");
  for (let i = 62; i < 72; i++)
    Object.assign(market.bars[i]!, {
      open: 30 - (i - 62),
      close: 30 - (i - 62),
      high: 31 - (i - 62),
      low: 29 - (i - 62),
    });
  const input = bars((i) => (i < 63 ? 50 : 52));
  Object.assign(input[62]!, { close: 52, high: 53 });
  const spec = researchSpecSchema.parse({
    ...base,
    management: {
      ...base.management,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 1 },
    },
  });
  const result = run(market, spec, input);
  expect(result.trades[0]!.entries).toHaveLength(1);
  expect(
    result.attempts.some(
      (a) => a.date === calendar[63] && a.reason.includes("上限为0"),
    ),
  ).toBe(true);
  const sold = run(market, { ...base, holdingDays: 2 });
  expect(sold.trades[0]!.exitDate).toBe(calendar[64]);
  const missing = structuredClone(market);
  missing.bars[63]!.volume = 0;
  expect(run(missing, { ...base, holdingDays: 2 }).trades[0]!.exitDate).toBe(
    calendar[64],
  );
});
it("passes the frozen benchmark through both full-run partitions while retaining raw stock observations", async () => {
  const prices = bars((i) => 10 + i),
    spec = researchSpecSchema.parse({
      ...base,
      strategy: "ma-cross",
      maParams: maParamsSchema.parse({}),
      symbols: ["sh600000"],
      holdingDays: 1,
    });
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "合成",
    },
    benchmark: benchmark("strong"),
    calendar,
    stocks: [
      {
        symbol: "sh600000",
        name: "合成",
        bars: prices,
        hash: researchHash(prices),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: spec.start,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: calendar.map((date) => ({
      ...rules,
      evidence: undefined,
      date,
      symbol: "sh600000",
      evidenceId: "fixture",
    })),
  });
  const native = vi.fn(async (): Promise<never> => {
    throw Error("native must not run");
  });
  const strong = await runStrategyResearch(spec, dataset, evidence, native),
    weak = await runStrategyResearch(
      spec,
      { ...dataset, benchmark: benchmark("weak") },
      evidence,
      native,
    );
  expect(strong.events.length).toBeGreaterThan(0);
  expect(weak.events).toEqual(strong.events);
  for (let i = 0; i < 2; i++) {
    expect(strong.partitions[i]!.simulation!.trades.length).toBeGreaterThan(0);
    expect(weak.partitions[i]!.simulation!.trades).toEqual([]);
    expect(
      strong.partitions[i]!.simulation!.marketEnvironment![0]!.regime,
    ).toBe("strong");
  }
  expect(researchMethodSnapshot(spec).marketRegime!.version).toBe(
    "research-market-regime-1",
  );
  expect(native).not.toHaveBeenCalled();
});
