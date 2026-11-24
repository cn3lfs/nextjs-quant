import {
  portfolioObservationDay,
  createPortfolioPreparation,
  runPortfolio,
  validationScorePasses,
  type ValidationRow,
  runValidationSuite,
  validationDefaults,
  validationRowReasons,
  type PortfolioRequest,
  type ValidationPolicy,
  type ValidationScore,
} from "quant-backtest";
import {
  researchExecutionCosts,
  scaleResearchCosts,
} from "trading-strategy-core/costs";
import { isDeepStrictEqual } from "node:util";
import type { Bar } from "trading-strategy-core/bars";
import { scoreLifecycleResult } from "../lifecycle-score";
import { assessValidationCandidates } from "../validation-method";

import { assertSharedEntryFamily } from "./strategy-specs";
import type { HoldoutLegMetrics } from "./types";

export const DEFAULT_HOLDOUT_START = "2023-01-01";
export type DiagnoseTimeHoldoutOptions = {
  holdoutStart?: string;
  trainBars?: number;
  testBars?: number;
  candidateId?: string;
  family?: string;
  effectiveTrials?: number;
  benchmark?: readonly Bar[];
  signal?: AbortSignal;
};

function metrics(score: ValidationScore): HoldoutLegMetrics {
  return {
    return: score.return,
    excess: score.excess,
    drawdown: score.drawdown,
    sharpe: score.riskAdjusted?.sharpe ?? null,
    calmar: score.riskAdjusted?.calmar ?? null,
    benchmarkCalmar: score.riskAdjusted?.benchmarkCalmar ?? null,
    calmarDifference: score.riskAdjusted?.calmarDifference ?? null,
    trades: score.trades,
    fees: score.fees!,
  };
}

function summarize(scores: ValidationScore[]) {
  const mean = (values: (number | null)[]) => {
    if (!values.length || values.some((v) => v === null)) return null;
    return (values as number[]).reduce((sum, v) => sum + v, 0) / values.length;
  };
  return {
    meanReturn: mean(scores.map((s) => s.return)),
    meanSharpe: mean(scores.map((s) => s.riskAdjusted?.sharpe ?? null)),
    worstDrawdown:
      scores.length && scores.every((s) => s.drawdown !== null)
        ? Math.max(...scores.map((s) => s.drawdown!))
        : null,
    trades: scores.reduce((sum, s) => sum + s.trades, 0),
  };
}

function requestDates(request: PortfolioRequest) {
  const day = (date: string) =>
    portfolioObservationDay(
      request.market,
      request.strategies[0]!.period,
      date,
    );
  return [
    ...new Set(
      request.calendar
        .filter(
          (date) =>
            (request.start.length === 10
              ? day(date) >= request.start
              : Date.parse(date) >= Date.parse(request.start)) &&
            (request.end.length === 10
              ? day(date) <= request.end
              : Date.parse(date) <= Date.parse(request.end)),
        )
        .map(day),
    ),
  ];
}

function holdoutPlan(
  dates: readonly string[],
  options: DiagnoseTimeHoldoutOptions,
) {
  const holdoutStart = options.holdoutStart ?? DEFAULT_HOLDOUT_START;
  const effectiveTrials = options.effectiveTrials ?? 1;
  const metadata = {
    classification: "historical-holdout-review" as const,
    disclosure:
      "历史留出复核（Historical Holdout Review）。因已查阅过核心池截至当前数据日的漏斗，本次仅复核历史留出段，不宣称新鲜样本外收益。",
    holdoutStart,
  };
  const split = dates.findIndex((date) => date >= holdoutStart);
  const devBars = split < 0 ? dates.length : split;
  const trainBars =
    options.trainBars ?? Math.max(20, Math.floor(devBars * 0.4));
  const testBars = options.testBars ?? Math.max(5, Math.floor(devBars * 0.1));
  const holdoutRange =
    split < 0 ? null : { start: dates[split]!, end: dates.at(-1)! };
  const dsrThreshold = 0.95 as const;
  const reasons: string[] = [];
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(holdoutStart) ||
    !Number.isFinite(Date.parse(holdoutStart)) ||
    new Date(holdoutStart).toISOString().slice(0, 10) !== holdoutStart
  )
    reasons.push("留出切点日期无效");
  if (
    ![trainBars, testBars, effectiveTrials].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    reasons.push("训练窗、测试窗及有效试验数必须为正整数");
  if (dates.length < 10) reasons.push("验证日历不足 10 天");
  const holdoutReason = !holdoutRange
    ? "留出段没有交易日"
    : dates.length - split < Math.max(2, testBars)
      ? "留出段不足一个完整测试窗或两个交易日"
      : null;
  if (devBars < trainBars + testBars)
    reasons.push("开发段不足一个训练窗和一个完整滚动测试窗");
  const policy = {
    ...validationDefaults,
    trainBars,
    testBars,
    holdoutStart,
    method: "lifecycle-2",
    purpose: "post-hoc",
    clusterCorrelation: 0.95,
    maximumPbo: 0.5,
    minimumDsr: dsrThreshold,
  } as const satisfies ValidationPolicy & { minimumDsr: number };
  return {
    metadata,
    holdoutRange,
    dsrThreshold,
    effectiveTrials,
    reasons,
    holdoutReason,
    policy,
  };
}

function replayCandidates(
  candidates: readonly {
    id: string;
    family: string;
    request: PortfolioRequest;
  }[],
  dates: readonly string[],
  policy: ValidationPolicy,
  options: DiagnoseTimeHoldoutOptions,
) {
  return runValidationSuite(
    candidates.map((c) => ({
      ...c,
      request: {
        ...c.request,
        costs: researchExecutionCosts(c.request.market, "base"),
        collectDailyDecisionCounts: true,
      },
    })),
    dates,
    policy,
    (result, segment, candidateId) => ({
      ...scoreLifecycleResult(
        result,
        segment,
        options.benchmark?.filter(
          (bar) =>
            portfolioObservationDay(
              segment.market,
              segment.strategies[0]!.period,
              bar.date,
            ) <= segment.end,
        ) ?? [],
        dates,
        candidateId,
      ),
      fees: result.fills.reduce((sum, fill) => sum + fill.fee, 0),
    }),
    undefined,
    options.signal,
  );
}

/** All replays share one frozen input. Optional benchmark bars must come from
 * the same snapshot. Missing benchmark observations leave excess unavailable. */
export function runDiagnoseTimeHoldout(
  request: PortfolioRequest,
  options: DiagnoseTimeHoldoutOptions = {},
) {
  options.signal?.throwIfAborted();
  const dates = requestDates(request);
  const {
    metadata,
    holdoutRange,
    dsrThreshold,
    effectiveTrials,
    reasons,
    holdoutReason,
    policy,
  } = holdoutPlan(dates, options);
  if (holdoutReason) reasons.push(holdoutReason);
  if (reasons.length)
    return {
      ...metadata,
      status: "insufficient" as const,
      devWindowRange: null,
      devSummary: null,
      holdoutRange,
      holdout: null,
      reasons,
      statistics: {
        dsr: null,
        dsrThreshold,
        pbo: null,
        effectiveTrials,
        note: reasons.join("；"),
      },
      passed: false,
    };
  const id = options.candidateId ?? request.strategies[0]!.id;
  const row = replayCandidates(
    [{ id, family: options.family ?? id, request }],
    dates,
    policy,
    options,
  ).rows[0]!;
  const assessed = assessValidationCandidates(
    [{ row, market: request.market, sleeve: row.family }],
    policy,
  )[0]!;
  const dsr =
    effectiveTrials === 1 ? assessed.testing.selected.dsr.value : null;
  const pbo = assessed.family.cscv.pbo;
  const notes = [
    effectiveTrials === 1
      ? "单一有效试验按既有方法对零夏普门槛计算 DSR。"
      : "仅提供一个候选，缺少估计多试验夏普方差的独立序列。",
    pbo.reason,
    effectiveTrials === 1 ? assessed.testing.selected.dsr.reason : null,
  ];
  const allReasons = new Set([
    ...validationRowReasons(row, policy),
    ...assessed.row.reasons,
  ]);
  if (!options.benchmark?.length) allReasons.add("missing-frozen-benchmark");
  if (dsr === null || dsr < dsrThreshold)
    allReasons.add("multiple-testing-dsr-0.95");
  if (effectiveTrials > 1) allReasons.add("missing-trial-sharpe-distribution");
  const { windows, holdout } = row;
  return {
    ...metadata,
    status: "reviewed" as const,
    devWindowRange: {
      start: windows[0]!.start,
      end: windows.at(-1)!.end,
      windowCount: windows.length,
    },
    holdoutRange: { start: holdout.start, end: holdout.end },
    devSummary: {
      windowCount: windows.length,
      positiveWindows: row.positiveWindows,
      base: summarize(windows.map((w) => w.base)),
      doubledCost: summarize(windows.map((w) => w.doubledCost)),
      delayed: summarize(windows.map((w) => w.delayed)),
    },
    holdout: {
      base: metrics(holdout.base),
      doubledCost: metrics(holdout.doubledCost),
      delayed: metrics(holdout.delayed),
    },
    reasons: [...allReasons],
    statistics: {
      dsr,
      dsrThreshold,
      pbo: pbo.value,
      effectiveTrials,
      note: notes.filter(Boolean).join(" "),
    },
    passed: allReasons.size === 0,
  };
}

export type DiagnoseTimeHoldoutResult = ReturnType<
  typeof runDiagnoseTimeHoldout
>;

export type DiagnoseFamilyCandidate = {
  id: string;
  request: PortfolioRequest;
  /** Only a verified pre-cut request is available for this candidate. */
  holdoutFailure?: string;
  /** Declare the economic role independently of the display ID. */
  role: "base" | "doubledCost" | "delayed" | "hold" | "terminal-accounting";
};

export type DiagnoseFamilyTimeHoldoutOptions = Omit<
  DiagnoseTimeHoldoutOptions,
  "effectiveTrials"
> & {
  family: string;
  /** Predeclared candidate for the headline DSR. Each included member also has its own DSR. */
  candidateId: string;
  /** Common frozen market observation days covering development AND historical holdout. */
  dates: readonly string[];
};

function excludedRole({ id, request, role }: DiagnoseFamilyCandidate) {
  if (role !== "base") return role ?? "undeclared-role";
  if (
    ["hold", "diag-hold"].includes(id) ||
    request.strategies.some((s) => s.id === "diag-hold" || s.id === "hold")
  )
    return "hold";
  if (request.instruments.some((i) => i.terminal)) return "terminal-accounting";
  if (request.signalDelayBars === 1 || id === "delayed") return "delayed";
  if (
    id === "doubledCost" ||
    isDeepStrictEqual(
      request.costs,
      researchExecutionCosts(request.market, "double-cost"),
    )
  )
    return "doubledCost";
  return null;
}

/** Freeze exactly the observable prefix before preparing any rule or native feed.
 * Reuse its preparation across cost/delay scenarios; each run has a fresh account. */
function familySegment(
  candidate: DiagnoseFamilyCandidate,
  start: string,
  end: string,
  options: DiagnoseFamilyTimeHoldoutOptions,
) {
  const original = candidate.request;
  const day = (date: string) =>
    portfolioObservationDay(
      original.market,
      original.strategies[0]!.period,
      date,
    );
  const throughEnd = (r: { date: string }) => day(r.date) <= end;
  const costs = researchExecutionCosts(original.market, "base");
  const prefix: PortfolioRequest = {
    ...original,
    start,
    end,
    costs,
    collectDailyDecisionCounts: true,
    calendar: original.calendar.filter((date) => day(date) <= end),
    instruments: original.instruments.map((i) => ({
      ...i,
      bars: i.bars.filter(throughEnd),
      signalBars: i.signalBars.filter(throughEnd),
      actions: i.actions?.filter(throughEnd),
      certifiedSuspensions: i.certifiedSuspensions?.filter(
        (s) => s.resumptionDate <= end,
      ),
      external: i.external && {
        ...i.external,
        chan: i.external.chan?.filter(throughEnd),
        signals: i.external.signals?.filter(throughEnd),
        levels: i.external.levels?.filter(throughEnd),
        rps: i.external.rps?.filter(throughEnd),
        lowZone: i.external.lowZone?.filter(throughEnd),
      },
    })),
    memberships: original.memberships?.filter(throughEnd),
    sleeveTargets: original.sleeveTargets?.filter(throughEnd),
    scheduledTargets: original.scheduledTargets?.filter(throughEnd),
    positionWeights: original.positionWeights?.filter(throughEnd),
  };
  const preparation = createPortfolioPreparation();
  const benchmark = options.benchmark?.filter(throughEnd) ?? [];
  return (multiplier: number, signalDelayBars: 0 | 1) => {
    const request = {
      ...prefix,
      costs: scaleResearchCosts(costs, multiplier),
      signalDelayBars,
    };
    const result = runPortfolio(
      request,
      undefined,
      preparation,
      options.signal,
    );
    return {
      ...scoreLifecycleResult(
        result,
        request,
        benchmark,
        options.dates,
        candidate.id,
      ),
      fees: result.fills.reduce((sum, f) => sum + f.fee, 0),
    };
  };
}

function familyStress(
  candidate: DiagnoseFamilyCandidate,
  start: string,
  end: string,
  options: DiagnoseFamilyTimeHoldoutOptions,
) {
  const run = familySegment(candidate, start, end, options);
  return {
    start,
    end,
    base: run(1, 0),
    doubledCost: run(2, 0),
    delayed: run(1, 1),
  };
}

export function runDiagnoseFamilyTimeHoldout(
  candidates: readonly DiagnoseFamilyCandidate[],
  options: DiagnoseFamilyTimeHoldoutOptions,
) {
  options.signal?.throwIfAborted();
  const { dates, family, candidateId } = options;
  if (
    !family.trim() ||
    !candidates.some((c) => c.id === candidateId) ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length
  )
    throw new Error(
      "Expected one declared family, unique IDs and a named DSR candidate",
    );
  if (
    dates.some(
      (date, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        (i > 0 && date <= dates[i - 1]!),
    )
  )
    throw new Error("Invalid frozen family calendar");

  assertSharedEntryFamily(
    candidates
      .filter((c) => !excludedRole(c))
      .map((c) => ({
        id: c.id,
        entries: c.request.strategies.map((s) => s.entry),
      })),
  );
  const {
    metadata,
    holdoutRange,
    dsrThreshold,
    reasons,
    holdoutReason,
    policy,
  } = holdoutPlan(dates, options);
  const devDates = dates.filter((date) => date < metadata.holdoutStart);
  const excluded: { id: string; reason: string }[] = [];
  const eligible = candidates
    .filter((c) => {
      let reason: string | null = excludedRole(c);
      if (!reason) {
        const own = requestDates(c.request).filter(
          (date) => date < metadata.holdoutStart,
        );
        if (
          own.length !== devDates.length ||
          own.some((date, i) => date !== devDates[i])
        )
          reason = "incomplete-or-misaligned-development-calendar";
      }
      if (reason) excluded.push({ id: c.id, reason });
      return !reason;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    eligible.some(
      (c) =>
        c.request.market !== eligible[0]!.request.market ||
        c.request.strategies[0]!.period !==
          eligible[0]!.request.strategies[0]!.period,
    )
  )
    throw new Error("Mixed family markets / observation clocks");

  const windows: {
    trainStart: string;
    trainEnd: string;
    start: string;
    end: string;
  }[] = [];
  if (!reasons.length) {
    for (
      let i = policy.trainBars;
      i + policy.testBars <= devDates.length;
      i += policy.testBars
    )
      windows.push({
        trainStart: devDates[i - policy.trainBars]!,
        trainEnd: devDates[i - 1]!,
        start: devDates[i]!,
        end: devDates[i + policy.testBars - 1]!,
      });
  }
  const devOosDates = windows.flatMap((w) =>
    devDates.filter((d) => d >= w.start && d <= w.end),
  );
  const holdoutFailures = new Map<string, string>();
  const training = new Map<string, ValidationScore[]>();
  const rows: ValidationRow[] = [];
  for (const candidate of eligible) {
    if (!windows.length) {
      excluded.push({ id: candidate.id, reason: reasons.join("；") });
      continue;
    }
    let scores, evaluated;
    try {
      scores = windows.map((w) =>
        familySegment(candidate, w.trainStart, w.trainEnd, options)(1, 0),
      );
      evaluated = windows.map((w) =>
        familyStress(candidate, w.start, w.end, options),
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      excluded.push({
        id: candidate.id,
        reason: `开发段回放失败：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    training.set(candidate.id, scores);
    const failure = candidate.holdoutFailure ?? holdoutReason;
    let observed;
    if (failure !== null && failure !== undefined)
      holdoutFailures.set(candidate.id, failure);
    else if (holdoutRange) {
      try {
        observed = familyStress(
          candidate,
          holdoutRange.start,
          holdoutRange.end,
          options,
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        holdoutFailures.set(
          candidate.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // The shared validation row requires a holdout. An unavailable score has
    // no observations and cannot pass any return or drawdown criterion.
    const unavailable: ValidationScore = {
      return: null,
      excess: null,
      drawdown: null,
      daily: [],
      trades: 0,
      events: {
        entries: 0,
        exits: 0,
        orders: 0,
        fills: 0,
        rejectionAttempts: 0,
      },
    };
    rows.push({
      id: candidate.id,
      family,
      windows: evaluated,
      inSample: scores[0]!,
      holdout: observed ?? {
        start: metadata.holdoutStart,
        end: options.dates.at(-1)!,
        base: unavailable,
        doubledCost: unavailable,
        delayed: unavailable,
      },
      neighbors: [],
      positiveWindows: evaluated.filter((w) => validationScorePasses(w.base))
        .length,
      stressPositiveWindows: evaluated.filter(
        (w) =>
          validationScorePasses(w.doubledCost) &&
          validationScorePasses(w.delayed),
      ).length,
      closedTrades: evaluated.reduce((n, w) => n + w.base.trades, 0),
      reasons: [],
      passed: false,
    });
  }
  const rollingSelection = training.size
    ? windows.map(({ start, end }, i) => {
        const ranked = [...training].sort(
          ([a, left], [b, right]) =>
            (right[i]!.excess ?? -Infinity) - (left[i]!.excess ?? -Infinity) ||
            (left[i]!.drawdown ?? Infinity) -
              (right[i]!.drawdown ?? Infinity) ||
            a.localeCompare(b),
        );
        return { start, end, selectedId: ranked[0]![0] };
      })
    : [];
  const assessed = rows.length
    ? assessValidationCandidates(
        rows.map((row) => ({
          row,
          market: eligible[0]!.request.market,
          sleeve: family,
          neighborhoodCenter: row.id,
        })),
        policy,
        devOosDates,
      )
    : [];
  const result = assessed[0]?.family;
  excluded.push(...(result?.excluded ?? []));
  const includedCandidateIds = result?.trials.map((t) => t.id) ?? [];
  const selected = includedCandidateIds.includes(candidateId)
    ? assessed.find((c) => c.id === candidateId)?.testing.selected.dsr
    : undefined;
  const pbo = result?.cscv.pbo;
  return {
    ...metadata,
    family,
    holdoutRange,
    status: (pbo?.value != null ? "reviewed" : "insufficient") as
      "reviewed" | "insufficient",
    statistics: {
      rawCandidateCount: candidates.length,
      includedCandidateIds,
      excluded,
      clusters: result?.cluster.clusters ?? [],
      effectiveTrials: result?.cluster.effectiveTrials ?? 0,
      devOosDays: devOosDates.length,
      pbo: pbo?.value ?? null,
      pboReason:
        pbo?.reason ??
        (result ? null : reasons.join("；") || "no-eligible-candidates"),
      combinations: result?.cscv.combinations ?? 0,
      discardedCscvDays: result?.cscv.discardedPeriods ?? 0,
      pboBasis:
        "PBO(Sharpe)：仅在开发段同期完整的 base 滚动 OOS 日收益上按夏普进行 CSCV 排名。滚动选优按训练段超额收益降序、回撤升序、ID 排序。",
      dsrCandidateId: candidateId,
      dsr: selected?.value ?? null,
      dsrThreshold,
      dsrReason: selected ? selected.reason : "dsr-candidate-excluded",
    },
    candidates: assessed.map(({ id, row, testing }) => {
      const failure = holdoutFailures.get(id);
      const leg = (score: ValidationScore) =>
        failure !== undefined || score.daily.some((r) => r === null)
          ? {
              return: null,
              excess: null,
              drawdown: null,
              sharpe: null,
              calmar: null,
              benchmarkCalmar: null,
              calmarDifference: null,
              trades: null,
              fees: null,
            }
          : metrics(score);
      const missing = [
        row.holdout.base,
        row.holdout.doubledCost,
        row.holdout.delayed,
      ].some((score) => score.daily.some((r) => r === null));
      return {
        ...(failure !== undefined || missing
          ? { holdoutFailure: failure ?? "留出段存在未经认证的缺失观察" }
          : {}),
        id,
        dsr: includedCandidateIds.includes(id)
          ? testing.selected.dsr.value
          : null,
        holdout: {
          base: leg(row.holdout.base),
          doubledCost: leg(row.holdout.doubledCost),
          delayed: leg(row.holdout.delayed),
        },
      };
    }),
    rollingSelection,
  };
}

export type DiagnoseFamilyTimeHoldoutResult = ReturnType<
  typeof runDiagnoseFamilyTimeHoldout
>;
