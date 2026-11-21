import {
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import {
  financialReplayBlockedReason,
  financialReplayCostMultiplier,
  financialReplayTargets,
  financialReplayYearStatus,
  type FinancialReplayYearStatus,
} from "~/lib/financial/financial-replay";
import {
  assertResearchRunActive,
  researchJsonHash,
  type ResearchRunBudget,
} from "../research/research-run";
import { corporateActions } from "../market/bar-store/corporate-actions";
import { BarResourceBudget } from "../market/bar-store/resource-budget";
import { readBars } from "../market/bar-store/read-bars";
import {
  researchCorporateActions,
  researchExecutionEvidence,
} from "../research/corporate-actions";
import { freezePortfolioExecution } from "../research/freeze-portfolio-execution";
import { loadFinancialTheoryYear } from "./financial-theory-history";
import {
  financialReplayCompleteness,
  financialReplayResultDirectory,
  rememberFinancialReplayIdentity,
  validateAnnualSignal,
  type FinancialReplayAnnualSignal,
  type FinancialReplayRunPlan,
  type FinancialReplayYearCache,
} from "./financial-replay-source";

export type FinancialReplayMarketCoverage = {
  symbol: string;
  expectedDays: number;
  presentDays: number;
  missingDays: number;
  missingExecutionDates: readonly string[];
  sourceHash: string;
  adjustment: unknown;
};

export type FinancialReplayAnnualPreparation = {
  signals: readonly FinancialReplayAnnualSignal[];
  enriched: readonly (FinancialReplayAnnualSignal & {
    complete: ReturnType<typeof financialReplayCompleteness>;
  })[];
  statuses: readonly FinancialReplayYearStatus[];
  blockedReason: string | null;
  actualCalls: number;
  restoredCheckpoints: number;
  warnings: string[];
};

export async function loadFinancialReplayAnnuals(
  plan: FinancialReplayRunPlan,
  progress: (value: number, phase: string) => void,
  budget: ResearchRunBudget,
  cache: FinancialReplayYearCache,
): Promise<FinancialReplayAnnualPreparation> {
  rememberFinancialReplayIdentity(plan.identity, {
    poolHash: plan.config.poolHash,
    calendarHash: plan.config.calendarHash,
    researchCodeHash: plan.config.researchCodeHash,
  });
  const signals: FinancialReplayAnnualSignal[] = [];
  const warnings: string[] = [];
  let actualCalls = 0,
    restoredCheckpoints = 0;
  for (let index = 0; index < plan.years.length; index++) {
    const year = plan.years[index]!;
    assertResearchRunActive(budget);
    progress(
      5 + Math.floor((index / plan.years.length) * 55),
      `读取 ${year.year} 年度财务事实`,
    );
    const restored = await cache.read(year.year, {
      asOf: year.asOf,
      executeAt: year.executeAt,
    });
    if (restored) {
      signals.push(restored);
      restoredCheckpoints++;
      continue;
    }
    const loaded = (await loadFinancialTheoryYear(
      {
        root: plan.config.root,
        symbols: plan.config.input.symbols,
        asOf: year.asOf,
        executeAt: year.executeAt,
        calendarHash: plan.config.calendarHash,
        poolHash: plan.config.poolHash,
        researchCodeHash: plan.config.researchCodeHash,
      },
      (done, total) =>
        progress(
          5 + Math.floor((done / Math.max(1, total)) * 5),
          `${year.year} 年度财报 ${done}/${total}`,
        ),
      budget.signal,
    )) as unknown as FinancialReplayAnnualSignal;
    assertResearchRunActive(budget);
    validateAnnualSignal(loaded, {
      year: year.year,
      asOf: year.asOf,
      executeAt: year.executeAt,
      poolHash: plan.config.poolHash,
      calendarHash: plan.config.calendarHash,
      researchCodeHash: plan.config.researchCodeHash,
    });
    await cache.write(
      year.year,
      { asOf: year.asOf, executeAt: year.executeAt },
      loaded,
    );
    signals.push(loaded);
    actualCalls++;
  }
  for (const signal of signals)
    for (const issue of signal.issues ?? [])
      warnings.push(`${signal.asOf} ${issue.filename}：${issue.reason}`);
  const enriched = signals.map((signal) => ({
    ...signal,
    complete: financialReplayCompleteness(signal),
  }));
  for (const signal of enriched)
    if (
      signal.complete.fScore < signal.counts.total ||
      signal.complete.magic < signal.counts.total
    )
      warnings.push(
        `${signal.asOf} 完整事实 F-score ${signal.complete.fScore}/${signal.counts.total}、魔法 ${signal.complete.magic}/${signal.counts.total}；其余为缺失或排除，不能称全池完整`,
      );
  const statuses = enriched.map((signal) =>
    financialReplayYearStatus(signal, plan.config.input.preset),
  );
  return {
    signals,
    enriched,
    statuses,
    blockedReason: financialReplayBlockedReason(statuses),
    actualCalls,
    restoredCheckpoints,
    warnings,
  };
}

/** Final result identity covers every source input: annual financial files,
 * the full local calendar, raw bar source hashes and corporate-action facts. */
export function financialReplayResultIdentity(input: {
  annualIdentity: string;
  calendarHash: string;
  market: readonly FinancialReplayMarketCoverage[];
  corporateActions: string;
  targets: readonly unknown[];
  costs: unknown;
  initial: number;
  start: string;
  end: string;
  strategyId: string;
}) {
  const { market, ...rest } = input;
  return researchJsonHash({
    ...rest,
    market: market.map((coverage) => ({
      symbol: coverage.symbol,
      sourceHash: coverage.sourceHash,
      adjustment: coverage.adjustment,
      expectedDays: coverage.expectedDays,
      presentDays: coverage.presentDays,
      missingExecutionDates: coverage.missingExecutionDates,
    })),
  });
}

export type FinancialReplayPreparedReady = {
  kind: "ready";
  plan: FinancialReplayRunPlan;
  annual: FinancialReplayAnnualPreparation;
  request: PortfolioRequest;
  marketCoverage: readonly FinancialReplayMarketCoverage[];
  expectedCalendar: readonly string[];
  resultIdentity: string;
  resultDirectory: string;
};

export type FinancialReplayPreparedBlocked = {
  kind: "blocked";
  plan: FinancialReplayRunPlan;
  annual: FinancialReplayAnnualPreparation;
};

export type FinancialReplayPrepared =
  FinancialReplayPreparedReady | FinancialReplayPreparedBlocked;

/** Prepares frozen bars, corporate actions and the complete replay request.
 * The result identity covers every source input used, not only the annual
 * financial files, so a cached final result is never reused across raw market
 * or corporate-action changes. */
export async function prepareFinancialReplay(
  plan: FinancialReplayRunPlan,
  progress: (value: number, phase: string) => void,
  budget: ResearchRunBudget,
  cache: FinancialReplayYearCache,
): Promise<FinancialReplayPrepared> {
  const annual = await loadFinancialReplayAnnuals(
    plan,
    progress,
    budget,
    cache,
  );
  if (annual.blockedReason) return { kind: "blocked", plan, annual };
  progress(62, "冻结行情、公司行动与执行证据");
  const actionSource = await corporateActions(plan.config.root);
  const instruments: PortfolioInstrument[] = [];
  const marketCoverage: FinancialReplayMarketCoverage[] = [];
  const start = plan.years[0]!.asOf;
  const expectedCalendar = plan.calendar.days.filter(
    (day) => day >= start && day <= plan.config.input.endDate,
  );
  const barBudget = new BarResourceBudget();
  barBudget.checkLimit(
    expectedCalendar.length * plan.config.input.symbols.length,
    {
      symbol: "财务回放证券池",
      period: "day",
    },
  );
  const executionDates = new Set(plan.years.map((year) => year.executeAt));
  for (let index = 0; index < plan.config.input.symbols.length; index++) {
    assertResearchRunActive(budget);
    const symbol = plan.config.input.symbols[index]!;
    const snapshot = await readBars({
      instrument: { market: "cn-equity", symbol },
      period: "day",
      adjustment: "forward",
      freezeRaw: true,
      root: plan.config.root,
      source: "local",
      to: plan.config.input.endDate,
      live: false,
    });
    if (
      snapshot.barStore.formingDates.length ||
      snapshot.barStore.priceRepaired
    )
      throw new Error(`${symbol}包含未完成或修复行情`);
    if (!snapshot.rawBars)
      throw new Error(`${symbol}缺少原价行情，不能以复权价代替成交价`);
    const raw = snapshot.rawBars;
    if (
      raw.length !== snapshot.bars.length ||
      raw.some((bar, i) => bar.date !== snapshot.bars[i]!.date)
    )
      throw new Error(`${symbol}原价与信号周期未对齐`);
    barBudget.retain(raw.length, { symbol, period: "day" });
    if (
      !raw.some(
        (bar) =>
          bar.date.slice(0, 10) >= start &&
          bar.date.slice(0, 10) <= plan.config.input.endDate,
      )
    )
      throw new Error(`${symbol}区间行情缺失`);
    const present = new Set(raw.map((bar) => bar.date.slice(0, 10)));
    const missing = expectedCalendar.filter((day) => !present.has(day));
    marketCoverage.push({
      symbol,
      expectedDays: expectedCalendar.length,
      presentDays: expectedCalendar.length - missing.length,
      missingDays: missing.length,
      missingExecutionDates: missing.filter((day) => executionDates.has(day)),
      sourceHash: snapshot.hash,
      adjustment: snapshot.barStore.adjustmentReference,
    });
    if (missing.length)
      annual.warnings.push(
        `${symbol} 相对完整本地日历缺 ${missing.length} 个交易日，未补造行情；缺口成交会被拒绝`,
      );
    const actions = researchCorporateActions(
      actionSource.events.get(symbol) ?? [],
      actionSource.fingerprint,
      raw[0]!.date,
      plan.config.input.endDate,
    );
    instruments.push({
      symbol,
      market: "cn-equity",
      bars: raw,
      signalBars: snapshot.bars,
      actions,
      execution: researchExecutionEvidence(symbol, raw, actions),
    });
    progress(
      62 + Math.floor(((index + 1) / plan.config.input.symbols.length) * 8),
      `冻结 ${symbol}`,
    );
  }
  const targets = financialReplayTargets(
    annual.enriched,
    plan.config.strategyId,
    plan.config.input.preset,
  );
  const multiplier = financialReplayCostMultiplier(
    plan.config.input.costScenario,
  );
  const costs = executionCostsSchema.parse({
    commissionBps: 3 * multiplier,
    minimumCommission: 5 * multiplier,
    sellTaxBps: 5 * multiplier,
    slippageBps: 5 * multiplier,
    ...(multiplier > 0
      ? { sellTaxSchedule: { kind: "cn-equity-historical", multiplier } }
      : {}),
  });
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: plan.config.input.initial,
    start,
    end: plan.config.input.endDate,
    calendar: plan.calendar.days,
    instruments: instruments.map(freezePortfolioExecution),
    strategies: [
      {
        id: plan.config.strategyId,
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols: plan.config.input.symbols },
        entry: { kind: "constant", value: false },
        exit: { rule: { kind: "constant", value: false } },
        sizing: { kind: "weight", weight: 0.05 },
        sleeve: "annual",
      },
    ],
    sleeves: [{ id: "annual", share: 1, maxPositions: 20, riskPerTrade: 0.01 }],
    scheduledTargets: targets,
    costs,
    observationDetail: "counts",
  };
  const resultIdentity = financialReplayResultIdentity({
    annualIdentity: plan.identity,
    calendarHash: plan.calendar.hash,
    market: marketCoverage,
    corporateActions: actionSource.fingerprint,
    targets,
    costs,
    initial: plan.config.input.initial,
    start,
    end: plan.config.input.endDate,
    strategyId: plan.config.strategyId,
  });
  return {
    kind: "ready",
    plan,
    annual,
    request,
    marketCoverage,
    expectedCalendar,
    resultIdentity,
    resultDirectory: financialReplayResultDirectory(resultIdentity),
  };
}
