import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  listTheoryScreenerSpecs,
  prepareStrategy,
  strategyObjectSchema,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import {
  SCREENER_STRATEGY_KEYS,
  buildLabDraftFromHandoff,
  buildScanToLabHandoffHref,
  isDiagnosticOnlyStrategyKey,
  isScreenerStrategyKey,
  labDiagnoseRunInputSchema,
  parseScanToLabHandoff,
  parseScreenerStrategyMethodId,
  scanHandoffStrategyRules,
} from "~/lib/research/diagnose-contract";
import { parseStudioEntry } from "~/lib/research/studio-entry";
import { requiresCausalPriceBasis } from "~/server/research/causal-price-basis";
import { archiveStrategySegment } from "~/server/research/diagnose/archive-fs";
import {
  discoverCliArchives,
  readCliReport,
} from "~/server/research/diagnose/cli-archive";
import { reconcileFills } from "~/server/research/diagnose/reconcile";
import { renderReport, writeReport } from "~/server/research/diagnose/report";
import {
  buildStrategy,
  isStrategyKey,
  planDiagnoseCells,
  warmupBarsFor,
} from "~/server/research/diagnose/strategy-specs";
import {
  emptyCounts,
  type DiagnoseCell,
} from "~/server/research/diagnose/types";

const specs = listTheoryScreenerSpecs().filter(
  (spec) => spec.direction !== "short",
);
const symbols = ["sh600000", "sz000001"] as const;
const baseInput = {
  symbols: [...symbols],
  start: "auto" as const,
  end: "2025-12-31",
  initial: 100_000,
  costScenario: "fixed" as const,
  scenarios: ["strict" as const],
  confirmed: true as const,
};
const plan = { symbols, controls: [], mode: "both" } as const;

it("exports the 56 distinct long-capable screener keys", () => {
  expect(new Set(SCREENER_STRATEGY_KEYS).size).toBe(56);
  expect(SCREENER_STRATEGY_KEYS).toEqual(
    specs.map(({ id }) => `screener:${id}`),
  );
});

it.each(specs)(
  "wires $id through planning, strategy building and Lab entry points",
  (spec) => {
    const key = `screener:${spec.id}` as const;
    expect(isStrategyKey(key)).toBe(true);
    expect(isScreenerStrategyKey(key)).toBe(true);
    expect(isDiagnosticOnlyStrategyKey(key)).toBe(true);
    expect(parseScreenerStrategyMethodId(key)).toBe(spec.id);
    expect(warmupBarsFor(key)).toBe(spec.warmupBars);
    expect(planDiagnoseCells({ ...plan, strategies: [key] })).toEqual([
      ...symbols.map((symbol) => ({
        mode: "per-symbol",
        strategy: key,
        symbols: [symbol],
      })),
      { mode: "portfolio", strategy: key, symbols },
    ]);

    const single = buildStrategy(key, [symbols[0]], "single");
    const portfolio = buildStrategy(key, symbols, "portfolio");
    const rule = {
      kind: "theory-screener",
      methodId: spec.id,
      direction: "long",
      holdBars: 25,
      useScreenerStops: true,
    };
    expect(single.entry).toEqual({ ...rule, side: "entry" });
    expect(single.exit).toEqual({ rule: { ...rule, side: "exit" } });
    expect(portfolio).toMatchObject({ entry: single.entry, exit: single.exit });

    const singleHandoff = buildScanToLabHandoffHref({
      handoffSource: "pattern",
      scope: "single-symbol-diagnose",
      symbol: symbols[0],
      strategyHint: key,
    });
    const parsed = parseScanToLabHandoff(
      new URLSearchParams(singleHandoff.split("?")[1]),
    );
    if (parsed.kind !== "valid")
      throw new Error(`Failed to parse ${singleHandoff}`);
    const draft = buildLabDraftFromHandoff(parsed.handoff);
    expect(draft.strategyKey).toBe(key);
    expect(strategyObjectSchema.parse(draft.strategy)).toEqual(single);
    const batchHandoff = buildScanToLabHandoffHref({
      handoffSource: "pattern",
      scope: "portfolio-diagnose",
      symbols: [...symbols],
      strategyHint: key,
    });
    expect(
      parseStudioEntry(batchHandoff.split("?")[1]!).batchPrefill,
    ).toMatchObject({ strategyKey: key, symbols, mode: "portfolio" });
    for (const mode of ["per-symbol", "portfolio"] as const)
      expect(
        labDiagnoseRunInputSchema.parse({
          ...baseInput,
          strategyKey: key,
          mode,
        }),
      ).toMatchObject({ strategyKey: key, mode });

    const sleeves = [
      { id: "a", strategyKey: key, share: 0.5 },
      { id: "b", strategyKey: "dual-ma", share: 0.5 },
    ];
    expect(
      labDiagnoseRunInputSchema.parse({ ...baseInput, book: { sleeves } }),
    ).toMatchObject({ book: { sleeves }, mode: "portfolio" });
  },
);

it.each(["screener:nonexistent", "screener:f08-wyckoff-utad-sow"])(
  "rejects %s in diagnostic planning and handoff",
  (key) => {
    expect(isStrategyKey(key)).toBe(false);
    expect(isScreenerStrategyKey(key)).toBe(false);
    expect(isDiagnosticOnlyStrategyKey(key)).toBe(false);
    expect(parseScreenerStrategyMethodId(key)).toBeNull();
    expect(scanHandoffStrategyRules(key)).toBeUndefined();
    expect(() => planDiagnoseCells({ ...plan, strategies: [key] })).toThrow(
      key,
    );
    expect(
      labDiagnoseRunInputSchema.safeParse({ ...baseInput, strategyKey: key })
        .success,
    ).toBe(false);
    expect(
      labDiagnoseRunInputSchema.safeParse({
        ...baseInput,
        book: {
          sleeves: [
            { id: "a", strategyKey: key, share: 0.5 },
            { id: "b", strategyKey: "dual-ma", share: 0.5 },
          ],
        },
      }).success,
    ).toBe(false);
    const params = new URLSearchParams({
      handoff: "1",
      handoffSource: "pattern",
      scope: "single-symbol-diagnose",
      symbol: symbols[0],
      strategyHint: key,
    });
    expect(parseScanToLabHandoff(params).kind).toBe("invalid");
  },
);

it("requires causal A-share signal prices for a theory-screener entry or exit", () => {
  const strategy = buildStrategy(
    "screener:f04-turtle-donchian",
    [symbols[0]],
    "single",
  );
  expect(requiresCausalPriceBasis({ ...strategy, exit: {} })).toBe(true);
  expect(
    requiresCausalPriceBasis({
      ...strategy,
      entry: { kind: "constant", value: true },
    }),
  ).toBe(true);
});

it("discovers Windows-safe CLI archive paths and retains the screener key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diagnose-screener-archive-"));
  try {
    const key = "screener:f04-turtle-donchian";
    const parts = ["per-symbol", archiveStrategySegment(key), symbols[0]];
    expect(parts.every((part) => !part.includes(":"))).toBe(true);
    const cell = join(dir, "report", ...parts);
    await mkdir(cell, { recursive: true });
    await writeFile(
      join(cell, "run.json"),
      JSON.stringify({
        strategyKey: `diag-${key}`,
        symbols: [symbols[0]],
      }),
    );
    const locations = await discoverCliArchives(dir);
    expect(locations).toEqual([["report"]]);
    const detail = await readCliReport(
      dir,
      locations[0]!,
      { page: 1, pageSize: 1, offset: 0 },
      async () => [],
    );
    expect(detail.summary.strategyKeys).toEqual([key]);
    expect(detail.cells[0]?.strategyKey).toBe(key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function candle(
  index: number,
  close: number,
  volume = 100_000,
  range: Partial<Pick<Bar, "open" | "high" | "low">> = {},
): Bar {
  return {
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume,
    amount: close * volume,
    ...range,
  };
}

const fixtures = [
  {
    family: "trend-breakout",
    key: "screener:f04-turtle-donchian",
    prefix: Array.from({ length: 81 }, (_, i) =>
      i === 80
        ? candle(i, 107, 160_000, { open: 103, high: 108, low: 102 })
        : candle(i, 100, 100_000, { high: 105, low: 95 }),
    ),
  },
  {
    family: "growth-oneil",
    key: "screener:f09-sepa-trend-template",
    prefix: Array.from({ length: 250 }, (_, i) =>
      i === 249 ? candle(i, 102, 230_000) : candle(i, 40 + (59 * i) / 248),
    ),
  },
  {
    family: "astock-dragon",
    key: "screener:f11-first-limit-up-break",
    prefix: Array.from({ length: 41 }, (_, i) =>
      i === 40 ? candle(i, 11, 200_000) : candle(i, 10),
    ),
  },
  {
    family: "wave-harmonic-smc",
    key: "screener:f05-key-candlestick-reversal",
    prefix: [
      ...Array.from({ length: 79 }, (_, i) =>
        candle(i, 100, 100_000, { high: 101, low: 99 }),
      ),
      candle(79, 100.8, 100_000, { open: 100, high: 101, low: 95 }),
      candle(80, 104, 150_000, { open: 101, high: 105, low: 100 }),
    ],
  },
] as const;

it.each(fixtures)(
  "reconciles a real $family round trip with causal signals and fills",
  ({ key, prefix }) => {
    const symbol = symbols[0];
    const strategy = buildStrategy(key, [symbol], "portfolio");
    const trigger = prefix.at(-1)!;
    const history = [
      ...prefix,
      ...Array.from({ length: 29 }, (_, i) =>
        candle(prefix.length + i, trigger.close),
      ),
    ];
    const full = [
      ...history,
      ...Array.from({ length: 8 }, (_, i) =>
        candle(
          history.length + i,
          trigger.close * (1.04 + i * 0.03),
          i % 2 ? 250_000 : 900_000,
        ),
      ),
    ];
    const signalIndex = prefix.length - 1;
    const signal = prepareStrategy(strategy, prefix).evaluate(signalIndex);
    expect(signal.entry).toBe(true);
    expect(prepareStrategy(strategy, full).evaluate(signalIndex)).toEqual(
      signal,
    );

    const request = (bars: Bar[]): PortfolioRequest => ({
      market: "cn-equity",
      initial: 100_000,
      start: trigger.date,
      end: bars.at(-1)!.date,
      calendar: bars.map(({ date }) => date),
      instruments: [
        {
          symbol,
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            evidence: "synthetic tradable session",
            minimum: 100,
            step: 100,
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        },
      ],
      strategies: [strategy],
      sleeves: [{ id: "diag", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    });
    const input = request(history);
    const fullInput = request(full);
    const result = runPortfolio(input);
    const extended = runPortfolio(fullInput);
    expect(result.fills[0]).toMatchObject({
      side: "buy",
      signalAt: trigger.date,
      date: history[prefix.length]!.date,
    });
    expect(result.fills.some(({ side }) => side === "sell")).toBe(true);
    for (const fill of extended.fills)
      expect(fill.date > fill.signalAt).toBe(true);
    expect(reconcileFills(input, result)).toEqual([]);
    expect(reconcileFills(fullInput, extended)).toEqual([]);
    expect(extended.fills.filter(({ date }) => date <= input.end)).toEqual(
      result.fills,
    );
    expect(extended.curve.filter(({ date }) => date <= input.end)).toEqual(
      result.curve,
    );
  },
);

it("discloses method metadata and evidence boundaries in Markdown and JSON", async () => {
  const cells: DiagnoseCell[] = fixtures.map(({ key }) => ({
    strategy: key,
    symbols: [symbols[0]],
    mode: "per-symbol",
    status: "ok",
    runPath: "fixture",
    counts: emptyCounts(),
    findings: [],
  }));
  const dir = mkdtempSync(join(tmpdir(), "diagnose-screener-report-"));
  try {
    const path = await writeReport(dir, [
      ...cells,
      { ...cells[0]!, mode: "portfolio" },
    ]);
    const markdown = await readFile(path, "utf8");
    const json = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    expect(json.screenerDisclosures).toHaveLength(fixtures.length);
    for (const { key, family } of fixtures) {
      const spec = specs.find(({ id }) => key === `screener:${id}`)!;
      expect(markdown).toContain(
        `| ${key} | ${spec.theoryId} | ${family} | ${spec.label} | 日线 OHLCV 结构代理`,
      );
      expect(json.screenerDisclosures).toContainEqual({
        strategyKey: key,
        theoryId: spec.theoryId,
        family,
        label: spec.label,
        boundary: expect.stringContaining("日线 OHLCV 结构代理"),
      });
    }
    expect(markdown).toContain("盘中涨停排队顺序及实际可成交性");
    expect(markdown).toContain("主观浪型计数与人工结构判读");
    expect(renderReport([{ ...cells[0]!, strategy: "hold" }])).not.toContain(
      "理论筛选策略披露",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
