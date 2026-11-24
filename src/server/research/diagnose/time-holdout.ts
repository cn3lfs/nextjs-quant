import {
  portfolioObservationDay,
  runValidationSuite,
  validationDefaults,
  validationRowReasons,
  type PortfolioRequest,
  type ValidationPolicy,
  type ValidationScore,
} from "quant-backtest";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import type { Bar } from "trading-strategy-core/bars";
import { scoreLifecycleResult } from "../lifecycle-score";
import { assessValidationCandidates } from "../validation-method";

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

function metrics(score: ValidationScore) {
  return {
    return: score.return,
    excess: score.excess,
    drawdown: score.drawdown,
    sharpe: score.riskAdjusted?.sharpe ?? null,
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

/** All replays share one frozen input. Optional benchmark bars must come from
 * the same snapshot. Missing benchmark observations leave excess unavailable. */
export function runDiagnoseTimeHoldout(
  request: PortfolioRequest,
  options: DiagnoseTimeHoldoutOptions = {},
) {
  options.signal?.throwIfAborted();
  const holdoutStart = options.holdoutStart ?? DEFAULT_HOLDOUT_START;
  const effectiveTrials = options.effectiveTrials ?? 1;
  const metadata = {
    classification: "historical-holdout-review" as const,
    disclosure:
      "历史留出复核（Historical Holdout Review）。因已查阅过核心池截至当前数据日的漏斗，本次仅复核历史留出段，不宣称新鲜样本外收益。",
    holdoutStart,
  };
  const day = (date: string) =>
    portfolioObservationDay(
      request.market,
      request.strategies[0]!.period,
      date,
    );
  const dates = [
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
  if (!holdoutRange) reasons.push("留出段没有交易日");
  else if (dates.length - split < Math.max(2, testBars))
    reasons.push("留出段不足一个完整测试窗或两个交易日");
  if (devBars < trainBars + testBars)
    reasons.push("开发段不足一个训练窗和一个完整滚动测试窗");
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
  const row = runValidationSuite(
    [
      {
        id,
        family: options.family ?? id,
        request: {
          ...request,
          costs: researchExecutionCosts(request.market, "base"),
          collectDailyDecisionCounts: true,
        },
      },
    ],
    dates,
    policy,
    (result, segment) => ({
      ...scoreLifecycleResult(
        result,
        segment,
        options.benchmark ?? [],
        dates,
        id,
      ),
      fees: result.fills.reduce((sum, fill) => sum + fill.fee, 0),
    }),
    undefined,
    options.signal,
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
