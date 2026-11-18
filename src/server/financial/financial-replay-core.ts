import {
  createPortfolioPreparation,
  runPortfolio,
  type PortfolioRequest,
} from "quant-backtest";
import { createPerformanceReport } from "quant-performance";
import { dailyEquity } from "~/lib/backtest/daily-equity";
import type {
  FinancialReplayInput,
  FinancialReplayYearStatus,
} from "~/lib/financial/financial-replay";
import { financialReplayBoundary } from "~/lib/financial/financial-replay";
import { evaluateResearchReadiness } from "~/lib/research/research-readiness";
import {
  assertResearchRunActive,
  researchJsonHash,
  type ResearchRunBudget,
} from "../research/research-run";
import {
  resolveFinancialReplayRun,
  financialReplayInstrumentFinancialFacts,
  financialReplayYearCache,
  type FinancialReplayConfig,
  type FinancialReplayYearCache,
} from "./financial-replay-source";
import {
  prepareFinancialReplay,
  type FinancialReplayMarketCoverage,
  type FinancialReplayPrepared,
  type FinancialReplayPreparedReady,
} from "./financial-replay-prepare";

export type FinancialReplaySummary = {
  performance: ReturnType<typeof createPerformanceReport>["overview"];
  buys: number;
  sells: number;
  fees: number;
  rejections: number;
  observations: number;
  openPositions: number;
  quality: unknown;
  fillsHash: string;
  curveHash: string;
};

export type FinancialReplayYearEvidence = FinancialReplayYearStatus & {
  selected: readonly { symbol: string; weight: number }[];
  issues: readonly { filename: string; reason: string }[];
};

export type FinancialReplayDiagnostics = {
  actualCalls: number;
  restoredCheckpoints: number;
  /** Actual wall-clock completion time; operational, not part of the result hash. */
  checkedAt: string;
};

export type FinancialReplayInstrumentReadiness = {
  symbol: string;
  readiness: ReturnType<typeof evaluateResearchReadiness>;
};

export type FinancialReplayResult = {
  version: "financial-replay-v1";
  id: string;
  /** Result identity covers annual financial files, raw bars and corporate actions. */
  identity: string;
  /** Annual checkpoint identity: financial files, calendar, pool and code. */
  annualIdentity: string;
  hash: string;
  createdAt: number;
  status: "completed" | "blocked";
  input: FinancialReplayInput;
  config: Omit<FinancialReplayConfig, "input">;
  years: FinancialReplayYearEvidence[];
  blockedReason: string | null;
  boundary: string;
  warnings: string[];
  /** Per actual instrument; no invented portfolio pseudo-symbol. */
  readinessByInstrument: readonly FinancialReplayInstrumentReadiness[];
  request?: PortfolioRequest;
  result?: ReturnType<typeof runPortfolio>;
  summary?: FinancialReplaySummary;
  marketCoverage?: readonly FinancialReplayMarketCoverage[];
  diagnostics: FinancialReplayDiagnostics;
};

function summarizeReplay(
  result: ReturnType<typeof runPortfolio>,
  initial: number,
): FinancialReplaySummary {
  return {
    performance: createPerformanceReport(initial, dailyEquity(result.curve))
      .overview,
    buys: result.fills.filter((fill) => fill.side === "buy").length,
    sells: result.fills.filter((fill) => fill.side === "sell").length,
    fees: result.fills.reduce((sum, fill) => sum + fill.fee, 0),
    rejections: result.rejections.length,
    observations: result.curve.length,
    openPositions: result.positions.length,
    quality: result.quality,
    fillsHash: researchJsonHash(result.fills),
    curveHash: researchJsonHash(result.curve),
  };
}

export type FinancialReplayCore = {
  result: ReturnType<typeof runPortfolio>;
  summary: FinancialReplaySummary;
};

export function runFinancialReplayCore(
  prepared: FinancialReplayPreparedReady,
  progress: (value: number, phase: string) => void,
  budget: ResearchRunBudget,
): FinancialReplayCore {
  assertResearchRunActive(budget);
  progress(70, "组合逐年回放");
  const result = runPortfolio(
    prepared.request,
    (done, total) => {
      assertResearchRunActive(budget);
      progress(
        70 + Math.floor((done / Math.max(1, total)) * 25),
        "组合逐年回放",
      );
    },
    createPortfolioPreparation(),
  );
  assertResearchRunActive(budget);
  progress(98, "汇总净值与成交证据");
  return {
    result,
    summary: summarizeReplay(result, prepared.plan.config.input.initial),
  };
}

const shanghaiClose = (day: string) => `${day}T15:00:00+08:00`;

function adjustmentIdentity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return researchJsonHash(value);
}

export function financialReplayInstrumentReadiness(
  prepared: FinancialReplayPreparedReady,
  index: number,
  evaluatedAt: string,
): FinancialReplayInstrumentReadiness {
  const instrument = prepared.request.instruments[index]!,
    coverage = prepared.marketCoverage[index]!,
    expected = prepared.expectedCalendar,
    bars = new Map(instrument.bars.map((bar) => [bar.date.slice(0, 10), bar])),
    slots = expected.map((day) => {
      const bar = bars.get(day);
      return bar
        ? { availableAt: shanghaiClose(day), bar }
        : {
            availableAt: shanghaiClose(day),
            bar: null,
            reason: "完整本地交易日历中该证券缺此交易日行情",
          };
    });
  const readiness = evaluateResearchReadiness({
    asOf: prepared.plan.config.input.endDate,
    evaluatedAt,
    instrument: instrument.symbol,
    market: "cn-equity",
    engineering: { runnable: true },
    ruleCheck: {
      evaluated: true,
      evidenceRef: `financial-replay:${prepared.resultIdentity}`,
      failed: false,
      checkedAt: evaluatedAt,
      reason: "年度财务组合回放已完成；仅规则自检，未经独立留出验证",
    },
    window: {
      start: expected[0]!,
      end: prepared.plan.config.input.endDate,
    },
    warmup: { decisionStart: prepared.plan.years[0]!.executeAt },
    series: [
      {
        instrument: instrument.symbol,
        period: "day",
        sourceHash: coverage.sourceHash,
        adjustmentId: adjustmentIdentity(coverage.adjustment),
        calendarHash: prepared.plan.config.calendarHash,
        expectedSlots: expected.length,
        expectedFirstAvailableAt: shanghaiClose(expected[0]!),
        expectedLastAvailableAt: shanghaiClose(expected[expected.length - 1]!),
        requiredBars: 0,
        slots,
      },
    ],
    financial: financialReplayInstrumentFinancialFacts(
      prepared.annual.signals,
      instrument.symbol,
      prepared.plan.config.input.preset,
    ),
    pointInTime: {
      status: "limited",
      reason:
        "当前冻结成分与当前下载修订版财报；未认证首次披露版本或历史时点成分",
    },
  });
  return { symbol: instrument.symbol, readiness };
}

/** Evaluation timestamps are actual run time and are removed from the semantic
 * hash; the historical research cutoff (`asOf`) remains part of the result. */
function canonicalReadiness(
  readiness: ReturnType<typeof evaluateResearchReadiness>,
) {
  const { evaluatedAt: _evaluatedAt, ...rest } = readiness;
  return {
    ...rest,
    ruleCheck: { ...readiness.ruleCheck, checkedAt: null },
  };
}

export function financialReplaySemanticContent(
  result: Omit<FinancialReplayResult, "hash" | "createdAt">,
) {
  const {
    diagnostics: _diagnostics,
    readinessByInstrument,
    hash: _hash,
    createdAt: _createdAt,
    ...rest
  } = result as FinancialReplayResult;
  return {
    ...rest,
    readinessByInstrument: readinessByInstrument.map((item) => ({
      symbol: item.symbol,
      readiness: canonicalReadiness(item.readiness),
    })),
  };
}

export function financialReplaySemanticHash(
  result: Omit<FinancialReplayResult, "hash" | "createdAt">,
) {
  return researchJsonHash(financialReplaySemanticContent(result));
}

export function assembleFinancialReplayResult(
  prepared: FinancialReplayPrepared,
  core?: FinancialReplayCore,
): FinancialReplayResult {
  const { plan, annual } = prepared;
  const completed = !!core;
  const evaluatedAt = new Date().toISOString();
  const blockedReason =
    prepared.kind === "blocked" ? annual.blockedReason : null;
  const identity =
    prepared.kind === "ready" ? prepared.resultIdentity : plan.identity;
  const years: FinancialReplayYearEvidence[] = annual.enriched.map(
    (signal, index) => {
      const status = annual.statuses[index]!;
      const selection =
        plan.config.input.preset === "f-score"
          ? signal.selections.fScore
          : signal.selections.magicFormula;
      return {
        ...status,
        selected: selection.positions.map((row) => ({
          symbol: row.symbol,
          weight: row.weight,
        })),
        issues: signal.issues ?? [],
      };
    },
  );
  const readinessByInstrument =
    prepared.kind === "ready" && core
      ? prepared.request.instruments.map((_, index) =>
          financialReplayInstrumentReadiness(prepared, index, evaluatedAt),
        )
      : [];
  const content = {
    version: "financial-replay-v1" as const,
    id: `financial-replay-${identity}`,
    identity,
    annualIdentity: plan.identity,
    status: (completed ? "completed" : "blocked") as "completed" | "blocked",
    input: plan.config.input,
    config: {
      version: plan.config.version,
      root: plan.config.root,
      calendarHash: plan.config.calendarHash,
      poolHash: plan.config.poolHash,
      researchCodeHash: plan.config.researchCodeHash,
      financialSourceHash: plan.config.financialSourceHash,
      strategyId: plan.config.strategyId,
    },
    years,
    blockedReason,
    boundary: financialReplayBoundary,
    warnings: annual.warnings,
    readinessByInstrument,
    ...(prepared.kind === "ready"
      ? {
          request: prepared.request,
          marketCoverage: prepared.marketCoverage,
        }
      : {}),
    ...(core ? { result: core.result, summary: core.summary } : {}),
    diagnostics: {
      actualCalls: annual.actualCalls,
      restoredCheckpoints: annual.restoredCheckpoints,
      checkedAt: evaluatedAt,
    },
  };
  return {
    ...content,
    hash: financialReplaySemanticHash(content),
    createdAt: Date.now(),
  };
}

/** Convenience for direct callers/tests. The worker uses the split phases so it
 * can check for an existing source-complete result before running the engine. */
export async function runFinancialReplay(
  input: FinancialReplayInput,
  root: string,
  progress: (value: number, phase: string) => void = () => {},
  budget: ResearchRunBudget = {},
  cache?: FinancialReplayYearCache,
  reuse?: (
    prepared: FinancialReplayPreparedReady,
  ) => Promise<FinancialReplayResult | null>,
): Promise<FinancialReplayResult> {
  const plan = await resolveFinancialReplayRun(input, root);
  const activeCache =
    cache ??
    financialReplayYearCache(root, plan.identity, budget, {
      poolHash: plan.config.poolHash,
      calendarHash: plan.config.calendarHash,
      researchCodeHash: plan.config.researchCodeHash,
      financialSourceHash: plan.config.financialSourceHash,
    });
  const prepared = await prepareFinancialReplay(
    plan,
    progress,
    budget,
    activeCache,
  );
  if (prepared.kind === "blocked")
    return assembleFinancialReplayResult(prepared);
  const existing = reuse ? await reuse(prepared) : null;
  if (existing) return existing;
  return assembleFinancialReplayResult(
    prepared,
    runFinancialReplayCore(prepared, progress, budget),
  );
}
