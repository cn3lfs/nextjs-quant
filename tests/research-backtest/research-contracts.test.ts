import { chanC4Ids } from "../../src/lib/research/methods/chan/research-chan-movements";
import {
  chanNativeIds,
  isChanZhongyin,
  isChanFiveMinute,
} from "../../src/lib/research/methods/chan/research-chan-native";
import { describe, expect, it } from "vitest";
import { maParamsSchema, type Bar } from "../../src/lib/domain";
import type { CzscResult } from "../../src/lib/research/methods/chan/czsc";
import {
  researchStrategyIds,
  researchStrategies,
} from "../../src/lib/research/specs/research-strategies";
import {
  researchSpecSchema,
  type ResearchEvent,
  type ResearchSpec,
} from "../../src/lib/research/strategy-research";
import { researchSignals as actualResearchSignals } from "../../src/server/strategies/shared/research-signals";
import {
  isResearchRule,
  researchRuleSeries,
} from "../../src/server/strategies/shared/research-rule-series";
import { researchMarketEvidenceSchema } from "../../src/lib/research/factors/research-market-evidence";
import { researchPortfolio } from "../../src/server/backtest/research-portfolio";
import {
  buildNamedResearchSpec,
  runStrategyResearch,
} from "../../src/server/backtest/research-run";
import {
  findResearchCompositePreset,
  researchCompositePresetIds,
} from "../../src/lib/research/specs/research-composite-presets";
import { isExternalVolatility } from "../../src/lib/research/factors/research-volatility-input";
import type { ResearchDataset } from "../../src/server/backtest/research-dataset";
import {
  researchSellQuantity,
  type ResearchExecutionRules,
} from "../../src/lib/research/technical/research-execution";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "../../src/lib/research/analysis/research-position-book";

export const structureExceptions = {
  ...Object.fromEntries(
    [...chanNativeIds, ...chanC4Ids].map((id) => [
      id,
      "原生具名变体沿用逐前缀协议；结构语义由原文及家族正反例核对，DLL golden仅为变更隔离信号",
    ]),
  ),
  "ma-cross":
    "均线事件没有可证实结构线，执行契约注入合成止损线，不冒充信号证据",
  czsc: "原生事件未提供可证实结构线；以确定性替身验证前缀协议，DLL golden 另测",
};
const native = async (
  bars: readonly Bar[],
  anchor?: 1 | 2 | 3,
): Promise<CzscResult> => ({
  status: "structure",
  hash: "contract",
  sourceCommit: "b67f3c6",
  families: [
    {
      config: 0,
      ...(anchor
        ? {
            native: {
              version: "native-projections-c2-1" as const,
              config: 0 as const,
              trends: [],
              highCandidates: [],
              completedSequence: "unavailable" as const,
              recursiveMovements: {
                version: "native-movements-c4-1" as const,
                anchor,
                config: 0 as const,
                centers: [],
                movements: [],
                connections: [],
                associations: [],
              },
              recursive: {
                anchor,
                config: 0 as const,
                nodes: [],
                completions: [],
                transitions: [],
              },
            },
          }
        : {}),
      points: [],
      centers: [
        {
          start: 0,
          end: 20,
          startDate: bars[0]!.date,
          endDate: bars[20]?.date ?? bars[0]!.date,
          direction: 1,
          ZD: 1,
          ZG: 2,
          DD: 1,
          GG: 2,
        },
      ],
      movements: [],
      qualities: [],
      divergences: [],
      signals:
        bars.length >= 63
          ? [
              {
                index: 30,
                date: bars[30]!.date,
                kind: 3,
                quality: 1,
                centerId: 1,
              },
            ]
          : [],
    },
  ],
});
function minuteFixture(bars: readonly Bar[]) {
  return bars.flatMap((b) =>
    Array.from({ length: 48 }, (_, i) => {
      const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
      return {
        ...b,
        date: `${b.date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
        volume: b.volume / 48,
        amount: b.amount / 48,
      };
    }),
  );
}
async function researchSignals(
  ...args: Parameters<typeof actualResearchSignals>
) {
  if (isChanFiveMinute(args[2].strategy)) args[9] = minuteFixture(args[1]);
  return actualResearchSignals(...args);
}
const prices = (count: number): Bar[] =>
  Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.03 + Math.sin(i / 3) * 4;
    return {
      date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + (i % 7) * 300,
      amount: close * 1000,
    };
  });
const rules: ResearchExecutionRules = {
  evidence: "synthetic-contract",
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
const days = prices(7).map((b) => b.date);
const executionBars = days.map((date, i) => ({
  date,
  open: i === 1 ? 10 : 11,
  close: i === 1 ? 8 : 11,
  high: 12,
  low: 7,
  volume: 1000,
  amount: 10000,
}));

it("requires an executable signal adapter for every registered preset", () => {
  expect(new Set(researchStrategyIds).size).toBe(researchStrategyIds.length);
  for (const id of researchStrategyIds)
    expect(
      isResearchRule(id) ||
        [
          "dual-breakout",
          "dual-breakout-structure",
          ...Object.keys(structureExceptions),
        ].includes(id),
      id,
    ).toBe(true);
});

describe.each(researchStrategyIds)("registered contracts: %s", (id) => {
  const bars = prices(
    isChanFiveMinute(id)
      ? 7
      : id.startsWith("canslim-high") ||
          id.startsWith("sepa-") ||
          id.endsWith("window120")
        ? 370
        : id === "czsc"
          ? 67
          : 85,
  );
  if (isChanZhongyin(id) || isChanFiveMinute(id))
    for (const bar of bars) bar.date = bar.date.replace("2023-", "2020-");
  const first = bars.length - 5;
  const spec = researchSpecSchema.parse({
    strategy: id,
    ...(id === "dual-breakout-structure"
      ? { risk: { fraction: 0.01, maxWeight: 0.2 } }
      : {}),
    ...(id === "ma-cross" ? { maParams: maParamsSchema.parse({}) } : {}),
    start: bars[first]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars.at(-2)!.date,
  });
  const execution = researchSpecSchema.parse({
    ...spec,
    start: days[0],
    end: days.at(-1),
    validationStart: days[5],
    initialCapital: 10000,
    maxPositions: 1,
    holdingDays: 60,
    risk: { fraction: 0.05, maxWeight: 1 },
    ...(id === "dual-breakout-structure"
      ? {}
      : { management: { stop: { kind: "percent", fraction: 0.1 } } }),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: days[0]!,
    endpointDate: days[0]!,
    key: `contract:${id}`,
    strategyVersion: researchStrategies[id].version,
    partition: "development",
    evidence: "synthetic confirmed execution input",
    initialStop: 9,
  };
  const portfolio = (
    events = [event],
    ruleForDate = (_symbol: string, _date: string) => rules,
    input = executionBars,
  ) =>
    researchPortfolio(
      execution,
      events,
      days,
      new Map(
        [...events]
          .sort((a, b) => a.symbol.localeCompare(b.symbol))
          .map((e) => [e.symbol, input]),
      ),
      ruleForDate,
    );
  it("full historical prefix agrees at every research observation", async () => {
    if (isResearchRule(id)) {
      const full = researchRuleSeries(id, bars);
      expect(full).toHaveLength(bars.length);
      for (let end = first + 1; end <= bars.length; end++)
        expect(researchRuleSeries(id, bars.slice(0, end))).toEqual(
          full.slice(0, end),
        );
    } else {
      const full = await researchSignals(event.symbol, bars, spec, native);
      for (let end = first + 1; end <= bars.length; end++)
        expect(
          await researchSignals(
            event.symbol,
            bars.slice(0, end),
            { ...spec, end: bars[end - 1]!.date },
            native,
          ),
        ).toEqual(full.filter((e) => e.observedDate <= bars[end - 1]!.date));
    }
  });
  it("appending extreme future observations never changes past outputs", async () => {
    const future = [
      ...bars,
      {
        ...bars.at(-1)!,
        date: "2026-01-01",
        open: 10000,
        close: 10000,
        high: 11000,
        low: 9000,
      },
    ];
    if (isResearchRule(id))
      expect(researchRuleSeries(id, future).slice(0, bars.length)).toEqual(
        researchRuleSeries(id, bars),
      );
    else
      expect(await researchSignals(event.symbol, future, spec, native)).toEqual(
        await researchSignals(event.symbol, bars, spec, native),
      );
  });
  it.each(["missing", "zero-volume", "invalid-ohlc"])(
    "does not fabricate entry on %s observation",
    async (kind) => {
      const changed = structuredClone(bars);
      const target = changed.at(-1)!.date;
      if (kind === "missing") changed.pop();
      else if (kind === "zero-volume") changed.at(-1)!.volume = 0;
      else changed.at(-1)!.high = changed.at(-1)!.low - 1;
      if (isResearchRule(id))
        expect(
          researchRuleSeries(id, changed).filter(
            (p) => p.date === target && p.entry,
          ),
        ).toEqual([]);
      else {
        const events = await researchSignals(
          event.symbol,
          changed,
          spec,
          native,
        );
        expect(events.filter((e) => e.observedDate === target)).toEqual([]);
      }
    },
  );
  it("executes only at the next available open", () => {
    const result = portfolio(
      [event],
      (_s, date) => ({
        ...rules,
        tradable: date !== days[1],
      }),
      executionBars.map((bar) => ({
        ...bar,
        open: 10,
        close: 10,
        high: 11,
        low: 9,
      })),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryDate).toBe(days[2]);
  });
  it("keeps old lots sellable while rejecting same-day added shares", () => {
    let book = researchBookBuy(researchPositionBook(), {
      date: days[0]!,
      quantity: 500,
      price: 10,
      commission: 5,
    });
    book = researchBookBuy(book, {
      date: days[1]!,
      quantity: 300,
      price: 11,
      commission: 5,
    });
    expect(researchBookSellable(book, days[1]!)).toBe(500);
    expect(() =>
      researchBookSell(book, {
        date: days[1]!,
        quantity: 501,
        price: 12,
        commission: 5,
        tax: 0,
      }),
    ).toThrow("可卖");
    const sold = researchBookSell(book, {
      date: days[1]!,
      quantity: 500,
      price: 12,
      commission: 5,
      tax: 0,
    }).book;
    expect(researchBookSellable(sold, days[1]!)).toBe(0);
    expect(researchBookSellable(sold, days[2]!)).toBe(300);
  });
  it("retains a confirmed stop through blockage and price recovery", () => {
    const result = portfolio([event], (_s, date) => ({
      ...rules,
      tradable: date !== days[2],
    }));
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryDate: days[1],
      exitDate: days[3],
      exitPrice: 11,
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({ date: days[2], side: "sell" }),
    ]);
  });
  it("refuses transaction simulation without corporate-action proof", async () => {
    const dataset: ResearchDataset = {
      version: "research-dataset-1",
      source: "tdx-local",
      root: "synthetic",
      adjustment: "none",
      membership: {
        mode: "current-snapshot",
        symbols: [event.symbol],
        source: null,
        warning: "synthetic",
      },
      benchmark: { symbol: "sh000001", bars },
      calendar: bars.map((b) => b.date),
      stocks: [
        {
          symbol: event.symbol,
          name: "synthetic",
          bars,
          hash: "fixture",
          ...(isChanFiveMinute(id) ? { minuteBars: minuteFixture(bars) } : {}),
          actions: [],
        },
      ],
      excluded: [],
      actionCoverage: "missing",
      actionSource: null,
      capturedAt: 0,
      hash: "fixture",
    };
    const result = await runStrategyResearch(spec, dataset, null, native);
    expect(result.partitions).toHaveLength(2);
    expect(result.partitions.map((p) => p.simulation)).toEqual([null, null]);
    const dailyEvidence = researchMarketEvidenceSchema.parse({
      version: "research-market-evidence-1",
      source: "synthetic-contract",
      exportedAt: 0,
      adjustment: "none",
      corporateActionFree: [],
      rows: bars
        .map((bar) => ({
          symbol: event.symbol,
          date: bar.date,
          ...rules,
          evidenceId: "synthetic-contract",
        }))
        .map(({ evidence: _evidence, ...row }) => row),
    });
    const withoutActionProof = await runStrategyResearch(
      spec,
      dataset,
      dailyEvidence,
      native,
    );
    expect(
      withoutActionProof.partitions.map((p) => p.simulation!.trades),
    ).toEqual([[], []]);
    if (id === "czsc") {
      expect(withoutActionProof.events).toHaveLength(1);
      const proven = await runStrategyResearch(
        spec,
        dataset,
        {
          ...dailyEvidence,
          corporateActionFree: [
            {
              symbol: event.symbol,
              start: bars[0]!.date,
              end: spec.end,
              evidenceId: "synthetic-no-action",
            },
          ],
        },
        native,
      );
      expect(
        proven.partitions.flatMap((p) => p.simulation!.trades),
      ).toHaveLength(1);
    }
  });
  it("enforces sell minima, steps, maximum and complete odd-lot remainder", () => {
    expect(researchSellQuantity(299, 1000, rules)).toBe(200);
    expect(researchSellQuantity(99, 1000, rules)).toBe(0);
    expect(
      researchSellQuantity(1000, 1000, { ...rules, maximumSell: 300 }),
    ).toBe(300);
    expect(researchSellQuantity(37, 37, rules)).toBe(37);
    expect(
      researchSellQuantity(37, 37, { ...rules, sellOddLotAll: false }),
    ).toBe(0);
    expect(
      researchSellQuantity(100, 100, { ...rules, sellStep: undefined }),
    ).toBeNull();
  });
  it("conserves cash and values actual holdings", () => {
    const result = portfolio();
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.profit).toBe(500);
    expect(result.nav.at(-1)).toMatchObject({ cash: 10500, value: 10500 });
    expect(result.nav[1]).toMatchObject({ cash: 5000, value: 9000 });
  });
  it("has stable selection under reversed candidate input", () => {
    const another = {
      ...event,
      symbol: "sh600001",
      key: `${event.key}:second`,
    };
    const first = portfolio([event, another]);
    expect(first.trades[0]!.event.symbol).toBe("sh600000");
    expect(portfolio([another, event])).toEqual(first);
  });
});

/**
 * S3: registers the 162 B2/B5 composite presets (research-composite-presets.ts)
 * into this same registration-driven suite, closing the gap noted in
 * trading-skills-next-round-plan.md §2: these presets previously had no
 * contract coverage at all.
 *
 * All 162 presets resolve to one of two shared baseline strategies
 * (`dual-breakout` for 161, `boll-band-recovery` for the one meanReversion
 * risk preset `RK-F-no-single-stop`) — both already exhaustively exercised
 * by the `describe.each(researchStrategyIds)` block above. Two consequences
 * follow, both verified rather than assumed:
 *
 * 1. Signal generation genuinely varies per preset (research-signals.ts
 *    reads spec.management for stop kind / crowd buffer / riskPreset
 *    admission / sw-preflight filtering — see e.g. line 344, 486, 515-518),
 *    so the full-prefix / future-invariance / no-fabrication contracts are
 *    re-run here per preset's own resolved spec.
 * 2. The portfolio-engine contracts that hold `execution.management` fixed
 *    to one identical synthetic value for every id in the block above (the
 *    T+1 lot-batching check via researchBookBuy/Sell, and the sell-quantity
 *    min/step/max/odd-lot check via researchSellQuantity) take no `spec`
 *    argument at all — they are pure-function/engine properties that cannot
 *    vary by preset and are therefore not re-run per preset below; running
 *    them 162 more times would add ~1,600 byte-identical assertions with no
 *    incremental defect-detection value. The remaining portfolio-engine
 *    contracts (next open / blocked retry+confirmed exit / cash conservation
 *    / stable sort) ARE re-run below using each preset's own resolved
 *    management, phrased as management-agnostic invariants (not the fixed
 *    10%-stop numeric fixtures above) so they hold for percent stops, ATR
 *    stops, trailing chandeliers, scale-outs, risk presets, context-risk
 *    gates and growth-intraday variants alike without hand-written
 *    per-method cases.
 */
const inRangePrices = (count: number): Bar[] =>
  Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.03 + Math.sin(i / 3) * 4;
    return {
      date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + (i % 7) * 300,
      amount: close * 1000,
    };
  });
/**
 * research-run.ts:238-280 unconditionally requires manual evidence rows
 * (contextRiskInputs, or volatilityInputs for the two external Kase/Beta
 * volatility profiles) before `runStrategyResearch` proceeds past setup —
 * this fires regardless of any dataset/marketEvidence content. Every other
 * management branch flows into the shared portfolio engine without any
 * additional input. Computed generically from the resolved spec, not a
 * hardcoded id list.
 */
function requiresManualEvidence(spec: ResearchSpec): boolean {
  return (
    !!spec.management?.contextRisk ||
    (!!spec.management?.volatilityStop &&
      isExternalVolatility(spec.management.volatilityStop))
  );
}

describe.each(researchCompositePresetIds)(
  "registered composite preset: %s",
  (presetId) => {
    const preset = findResearchCompositePreset(presetId)!;
    const bars = inRangePrices(85);
    const first = bars.length - 5;
    const signalBase = researchSpecSchema.parse({
      strategy: "dual-breakout",
      symbols: ["sh600000"],
      pool: null,
      start: bars[first]!.date,
      end: bars.at(-1)!.date,
      validationStart: bars.at(-2)!.date,
    });
    const spec = buildNamedResearchSpec(presetId, signalBase);
    const manualEvidence = requiresManualEvidence(spec);

    const days = inRangePrices(7).map((b) => b.date);
    const executionBars = days.map((date, i) => ({
      date,
      open: i === 1 ? 10 : 11,
      close: i === 1 ? 8 : 11,
      high: 12,
      low: 7,
      volume: 1000,
      amount: 10000,
    }));
    const executionBase = researchSpecSchema.parse({
      strategy: "dual-breakout",
      symbols: ["sh600000"],
      pool: null,
      start: days[0],
      end: days.at(-1),
      validationStart: days[5],
      initialCapital: 10000,
      maxPositions: 5,
      holdingDays: 60,
      entryMaxWait: 3,
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    });
    const execution = buildNamedResearchSpec(presetId, executionBase);
    const event: ResearchEvent = {
      symbol: "sh600000",
      observedDate: days[0]!,
      endpointDate: days[0]!,
      key: `composite:${presetId}`,
      strategyVersion: researchStrategies[execution.strategy].version,
      partition: "development",
      evidence: "synthetic confirmed execution input",
      initialStop: 9,
    };
    const portfolio = (
      events = [event],
      ruleForDate = (_symbol: string, _date: string) => rules,
      input = executionBars,
    ) =>
      researchPortfolio(
        execution,
        events,
        days,
        new Map(
          [...events]
            .sort((a, b) => a.symbol.localeCompare(b.symbol))
            .map((e) => [e.symbol, input]),
        ),
        ruleForDate,
      );

    it("declares itself in the composite preset registry", () => {
      expect(preset.id).toBe(presetId);
      expect(preset.component).toContain(preset.methodId);
    });

    it("full historical prefix agrees at every research observation", async () => {
      const full = await researchSignals(event.symbol, bars, spec, native);
      for (let end = first + 1; end <= bars.length; end++)
        expect(
          await researchSignals(
            event.symbol,
            bars.slice(0, end),
            { ...spec, end: bars[end - 1]!.date },
            native,
          ),
        ).toEqual(full.filter((e) => e.observedDate <= bars[end - 1]!.date));
    });

    it("appending extreme future observations never changes past outputs", async () => {
      const future = [
        ...bars,
        {
          ...bars.at(-1)!,
          date: "2022-11-30",
          open: 10000,
          close: 10000,
          high: 11000,
          low: 9000,
        },
      ];
      expect(await researchSignals(event.symbol, future, spec, native)).toEqual(
        await researchSignals(event.symbol, bars, spec, native),
      );
    });

    it.each(["missing", "zero-volume", "invalid-ohlc"])(
      "does not fabricate entry on %s observation",
      async (kind) => {
        const changed = structuredClone(bars);
        const target = changed.at(-1)!.date;
        if (kind === "missing") changed.pop();
        else if (kind === "zero-volume") changed.at(-1)!.volume = 0;
        else changed.at(-1)!.high = changed.at(-1)!.low - 1;
        const events = await researchSignals(
          event.symbol,
          changed,
          spec,
          native,
        );
        expect(events.filter((e) => e.observedDate === target)).toEqual([]);
      },
    );

    it("never fills a buy on a day marked non-tradable", () => {
      const result = portfolio(
        [event],
        (_s, date) => ({ ...rules, tradable: date !== days[1] }),
        executionBars.map((bar) => ({
          ...bar,
          open: 10,
          close: 10,
          high: 11,
          low: 9,
        })),
      );
      expect(result.trades.every((t) => t.entryDate !== days[1])).toBe(true);
    });

    it("never fills a sell on a day marked non-tradable, and a blocked confirmed exit still lands later rather than being reverted", () => {
      const result = portfolio([event], (_s, date) => ({
        ...rules,
        tradable: date !== days[2],
      }));
      expect(result.trades.every((t) => t.exitDate !== days[2])).toBe(true);
      const blockedSellAttempts = result.attempts.filter(
        (a) => a.date === days[2] && a.side === "sell",
      );
      if (blockedSellAttempts.length > 0)
        expect(
          result.trades.some(
            (t) => t.exitDate !== null && t.exitDate > days[2]!,
          ),
        ).toBe(true);
    });

    it("refuses transaction simulation without corporate-action proof", async () => {
      const dataset: ResearchDataset = {
        version: "research-dataset-1",
        source: "tdx-local",
        root: "synthetic",
        adjustment: "none",
        membership: {
          mode: "current-snapshot",
          symbols: [event.symbol],
          source: null,
          warning: "synthetic",
        },
        benchmark: { symbol: "sh000001", bars },
        calendar: bars.map((b) => b.date),
        stocks: [
          {
            symbol: event.symbol,
            name: "synthetic",
            bars,
            hash: "fixture",
            actions: [],
          },
        ],
        excluded: [],
        actionCoverage: "missing",
        actionSource: null,
        capturedAt: 0,
        hash: "fixture",
      };
      if (manualEvidence) {
        await expect(
          runStrategyResearch(spec, dataset, null, native),
        ).rejects.toThrow("missing:");
        return;
      }
      const result = await runStrategyResearch(spec, dataset, null, native);
      expect(result.partitions).toHaveLength(2);
      expect(result.partitions.map((p) => p.simulation)).toEqual([null, null]);
      const dailyEvidence = researchMarketEvidenceSchema.parse({
        version: "research-market-evidence-1",
        source: "synthetic-contract",
        exportedAt: 0,
        adjustment: "none",
        corporateActionFree: [],
        rows: bars
          .map((bar) => ({
            symbol: event.symbol,
            date: bar.date,
            ...rules,
            evidenceId: "synthetic-contract",
          }))
          .map(({ evidence: _evidence, ...row }) => row),
      });
      const withoutActionProof = await runStrategyResearch(
        spec,
        dataset,
        dailyEvidence,
        native,
      );
      expect(
        withoutActionProof.partitions.map((p) => p.simulation!.trades),
      ).toEqual([[], []]);
    });

    it("keeps cash and equity non-negative and conserves realized profit once flat", () => {
      // nav.value is total equity (cash + held market value), not held
      // value alone -- confirmed against the fixed-management block above,
      // where a fully-exited position leaves `{cash: 10500, value: 10500}`
      // (research-portfolio.ts:2482 pushes `{date, value, cash, stale}`
      // with `value` computed as the running equity, not a holdings-only
      // figure).
      const result = portfolio();
      expect(
        result.nav.every((row) => row.cash >= -1e-6 && row.value >= -1e-6),
      ).toBe(true);
      if (
        result.trades.length > 0 &&
        result.trades.every((t) => t.exitDate !== null)
      ) {
        const realized = result.trades.reduce(
          (sum, t) => sum + (t.profit ?? 0),
          0,
        );
        expect(result.nav.at(-1)!.cash).toBeCloseTo(10000 + realized, 6);
        expect(result.nav.at(-1)!.value).toBeCloseTo(10000 + realized, 6);
      }
    });

    it("has stable selection under reversed candidate input", () => {
      const another = {
        ...event,
        symbol: "sh600001",
        key: `${event.key}:second`,
      };
      const first = portfolio([event, another]);
      expect(portfolio([another, event])).toEqual(first);
    });
  },
);
