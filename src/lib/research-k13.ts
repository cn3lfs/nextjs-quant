import type { Bar } from "./domain";
import type { ResearchTrade } from "../server/backtest/research-portfolio";

export const k13MethodIds = [
  "SW-P-review",
  "RK-MAE-q80",
  "RK-MAE-q90",
  "RK-MAE-q50",
  "RK-MAE-q100",
  "RK-MAE-widen-resize",
  "RK-MAE-tighten-resize",
  "RK-MAE-overlap",
  "RK-MAE-mfe-tail",
  "RK-MAE-regime",
  "RK-MAE-cycle100",
  "RK-MAE-emotion20",
] as const;
export type K13MethodId = (typeof k13MethodIds)[number];

export const k13ResultLabels = [
  "当前样本表现较好",
  "当前样本表现较差",
  "不稳定",
  "样本不足",
  "数据不足",
  "无交易",
  "规则实现失败",
] as const;
export type K13ResultLabel = (typeof k13ResultLabels)[number];

export type K13ExitCategory = "stop" | "profit" | "time" | "emotion" | "other";

export type K13Contract = {
  version: "k13-contract-1";
  candidateId: string;
  strategy: string;
  strategyVersion: string;
  timeframe: "daily" | "five-minute" | "monthly";
  universeHash: string;
  knownOn: string | null;
  start: string;
  end: string;
  adjustment: "none" | "forward" | "backward" | "unknown";
  costs: {
    commissionBps: number;
    minimumCommission: number;
    sellTaxBps: number;
    slippageBps: number;
  };
  initialCapital: number;
  execution: {
    signal: "close";
    fill: "next-tradable-open";
    t1: true;
    cashRule: "cash-and-known-holdings";
    companyActions: "evidence-required";
  };
  baselines: readonly {
    id: "cash" | "buy-and-hold" | "dual-breakout" | "ma-cross";
    status: "available" | "not-run" | "data-insufficient";
    reason?: string;
  }[];
};

export type K13Regime = {
  atrBucket: "low" | "middle" | "high";
  indexTrend: "up" | "down";
  knownOn: string;
};

export type K13TradeRecord = {
  id: string;
  symbol: string;
  eventKey: string;
  strategyVersion: string;
  observedDate: string;
  entryDate: string;
  exitDate: string | null;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  entryTarget?: number | null;
  evidence?: string;
  initialStop: number | null;
  initialR: number | null;
  entryAtr: number | null;
  finalR: number | null;
  profit: number | null;
  netReturn: number | null;
  mae: number | null;
  mfe: number | null;
  exitReason: string | null;
  exitCategory: K13ExitCategory | null;
  regime?: K13Regime;
  complete: boolean;
  reason: string | null;
};

export const k13SensitivityGrid = {
  version: "k13-grid-1",
  maeQuantiles: [0.5, 0.8, 0.9, 1] as const,
  widen: {
    observationWindowTradingDays: [5, 10] as const,
    distanceMultiple: [1.5, 2] as const,
  },
  tighten: { nearZeroAtr: [0.25, 0.5] as const },
  overlap: { empiricalCdfVersion: "ecdf-min-area-v1" as const },
  mfeTail: {
    mfeToFinalMultiple: [2] as const,
    alternatives: ["chandelier-22-3", "retracement-2-7r"] as const,
  },
  regime: {
    atrBuckets: ["low", "middle", "high"] as const,
    indexTrend: ["up", "down"] as const,
  },
  cycle: { trainingTrades: 100, validationTrades: 100 } as const,
  emotion: { threshold: 0.2 } as const,
} as const;

export const k13Boundary =
  "K13统一回测工程v1：所有候选共享证券池、可知时点、区间、复权/公司行动、成本、现金及成交规则；现金、买入持有、双突破、均线基线不因候选失败删除。信号观察固定持有期收益/超额/MAE/MFE，交易观察净值、回撤、换手、费用、仓位、胜率、盈亏比、持有期和未平仓。分位只使用同策略同周期已闭合训练样本，线性n-minus-one算法、有效样本数和策略版本冻结，参数只作用于下一批；q100仍按风险预算缩仓。放宽/收紧诊断不改当前批次，受单股、总仓和容量约束。MAE重叠仅说明当前样本证据不足以区分，不证明普遍无效；MFE回吐分别登记吊灯和回撤止损，不自动归因。波动分组不跨状态补样本；策略版本改变后循环校准旧样本失效；少于50笔不出结论，50至99笔不满足100笔校准；情绪比例必须有真实退出原因分类，缺失不填非情绪。固定输入验证不等于真实历史业绩。";

type K13TradeWithCategory = ResearchTrade & {
  exitCategory?: K13ExitCategory | null;
};

const isFinitePositive = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) && value > 0;

function validBar(bar: Bar | undefined) {
  return (
    !!bar &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}

function categoryOf(trade: K13TradeWithCategory): K13ExitCategory | null {
  return trade.exitCategory ?? null;
}

function quantile(values: readonly number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

function identity(
  record: Pick<K13TradeRecord, "symbol" | "eventKey" | "entryDate">,
) {
  return JSON.stringify([record.symbol, record.eventKey, record.entryDate]);
}

function labelForProfit(profit: number | null, count: number): K13ResultLabel {
  if (!count) return "无交易";
  if (profit == null || !Number.isFinite(profit)) return "数据不足";
  return profit > 0
    ? "当前样本表现较好"
    : profit < 0
      ? "当前样本表现较差"
      : "不稳定";
}

function tradeReason(
  trade: ResearchTrade,
  bars: readonly Bar[],
  calendar: readonly string[],
) {
  const t = trade as K13TradeWithCategory;
  if (
    !isFinitePositive(t.entryPrice) ||
    !Number.isFinite(t.quantity) ||
    t.quantity <= 0 ||
    !t.exitDate ||
    !isFinitePositive(t.exitPrice) ||
    !Number.isFinite(t.profit) ||
    !Number.isFinite(t.netReturn)
  )
    return "未闭合或缺少完整成交/收益字段";
  if (t.exitDate <= t.entryDate) return "退出日期不晚于入场日期";
  const heldDates = calendar.filter(
    (date) => date >= t.entryDate && date < t.exitDate!,
  );
  const held = bars.filter(
    (bar) => bar.date >= t.entryDate && bar.date < t.exitDate!,
  );
  if (
    !heldDates.length ||
    held.length !== heldDates.length ||
    heldDates.some((date, i) => held[i]?.date !== date) ||
    held.some((bar) => !validBar(bar))
  )
    return "持仓窗口缺日或OHLCV无效";
  if (
    t.initialStop != null &&
    (!Number.isFinite(t.initialStop) ||
      t.initialStop <= 0 ||
      t.initialStop >= t.entryPrice)
  )
    return "初始止损无效";
  return null;
}

/** Derive the common K13 record without using any bar after the actual exit. */
export function researchK13Records(
  trades: readonly ResearchTrade[],
  series: ReadonlyMap<string, readonly Bar[]>,
  calendar: readonly string[],
): K13TradeRecord[] {
  return trades.map((trade, index) => {
    const t = trade as K13TradeWithCategory;
    const bars = series.get(t.event.symbol) ?? [];
    const reason = tradeReason(t, bars, calendar);
    const held =
      t.exitDate == null
        ? []
        : bars.filter(
            (bar) => bar.date >= t.entryDate && bar.date < t.exitDate!,
          );
    const distance =
      t.initialStop == null ? null : t.entryPrice - t.initialStop;
    const low = reason
      ? null
      : Math.min(t.entryPrice, t.exitPrice!, ...held.map((bar) => bar.low));
    const high = reason
      ? null
      : Math.max(t.entryPrice, t.exitPrice!, ...held.map((bar) => bar.high));
    const entryAtr =
      t.event.stopAtr != null && Number.isFinite(t.event.stopAtr)
        ? t.event.stopAtr
        : null;
    return {
      id: `${t.event.symbol}:${t.event.key}:${t.entryDate}:${index}`,
      symbol: t.event.symbol,
      eventKey: t.event.key,
      strategyVersion: t.event.strategyVersion,
      observedDate: t.event.observedDate,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      entryTarget: t.event.entryTarget ?? null,
      evidence: t.event.evidence,
      initialStop: t.initialStop ?? null,
      initialR: reason || distance == null ? null : distance * t.quantity,
      entryAtr,
      finalR:
        reason || distance == null || t.profit == null
          ? null
          : t.profit / (distance * t.quantity),
      profit: reason ? null : t.profit,
      netReturn: reason ? null : t.netReturn,
      mae: low == null ? null : (t.entryPrice - low) / t.entryPrice,
      mfe: high == null ? null : (high - t.entryPrice) / t.entryPrice,
      exitReason: t.exitReason ?? null,
      exitCategory: categoryOf(t),
      complete: !reason,
      reason,
    };
  });
}

export function compareK13Contracts(contracts: readonly K13Contract[]) {
  const comparable = (contract: K13Contract) => {
    const { candidateId: _candidateId, ...rest } = contract;
    return rest;
  };
  const first = contracts[0] ? JSON.stringify(comparable(contracts[0])) : null;
  const mismatches = contracts
    .map((contract, index) => ({
      candidateId: contract.candidateId,
      index,
      same: JSON.stringify(comparable(contract)) === first,
    }))
    .filter((item) => !item.same);
  return {
    version: "k13-contract-compare-1",
    comparable: mismatches.length === 0,
    candidateCount: contracts.length,
    mismatches,
    reason: mismatches.length ? "候选未共用统一回测合同" : null,
  };
}

export type K13MaeQuantileResult = {
  version: "k13-mae-quantile-1";
  methodId: "RK-MAE-q80" | "RK-MAE-q90" | "RK-MAE-q50" | "RK-MAE-q100";
  quantile: number;
  quantileMethod: "linear-n-minus-one";
  minimumTrades: 100;
  strategyVersions: string[];
  closedRecords: number;
  validRecords: number;
  profitableRecords: number;
  width: number | null;
  nextBatchOnly: true;
  riskBudgetPreserved: true;
  resultLabel: K13ResultLabel;
  reason: string | null;
};

const maeMethodQuantiles = {
  "RK-MAE-q80": 0.8,
  "RK-MAE-q90": 0.9,
  "RK-MAE-q50": 0.5,
  "RK-MAE-q100": 1,
} as const;

export function researchK13MaeQuantile(
  methodId: keyof typeof maeMethodQuantiles,
  records: readonly K13TradeRecord[],
): K13MaeQuantileResult {
  const quantileValue = maeMethodQuantiles[methodId];
  const closed = records.filter((record) => record.exitDate != null);
  const valid = closed.filter(
    (record) =>
      record.complete &&
      record.profit != null &&
      Number.isFinite(record.profit) &&
      record.mae != null &&
      Number.isFinite(record.mae) &&
      record.mae >= 0,
  );
  const wins = valid
    .filter((record) => record.profit! > 0)
    .map((record) => record.mae!);
  const versions = [...new Set(valid.map((record) => record.strategyVersion))];
  const duplicateIdentity =
    new Set(records.map((record) => identity(record))).size !== records.length;
  const width = quantile(wins, quantileValue);
  const reason = duplicateIdentity
    ? "重复交易身份"
    : versions.length !== 1
      ? versions.length
        ? "策略版本混合"
        : "没有同策略同周期盈利闭合训练样本"
      : closed.length !== records.length
        ? "存在未闭合或不可用记录，未选择性丢弃"
        : valid.length < 100
          ? "不足100笔同策略同周期已闭合训练样本"
          : !wins.length
            ? "无盈利训练样本"
            : width == null || width <= 0 || width >= 1
              ? "MAE分位宽度无效"
              : null;
  return {
    version: "k13-mae-quantile-1",
    methodId,
    quantile: quantileValue,
    quantileMethod: "linear-n-minus-one",
    minimumTrades: 100,
    strategyVersions: versions,
    closedRecords: closed.length,
    validRecords: valid.length,
    profitableRecords: wins.length,
    width: reason ? null : width,
    nextBatchOnly: true,
    riskBudgetPreserved: true,
    resultLabel: reason ? "样本不足" : "不稳定",
    reason,
  };
}

function closedWithR(records: readonly K13TradeRecord[]) {
  return records.filter(
    (record) =>
      record.complete &&
      record.exitDate != null &&
      record.initialR != null &&
      record.initialR > 0 &&
      record.finalR != null,
  );
}

export function researchK13WidenResize(records: readonly K13TradeRecord[]) {
  const candidates = closedWithR(records).filter(
    (record) => record.exitCategory === "stop" && record.finalR! <= -1 + 1e-12,
  );
  return {
    version: "k13-widen-resize-1" as const,
    observationWindowTradingDays: 10 as const,
    distanceMultiple: 2 as const,
    candidates: candidates.length,
    returnedToTwoR: null,
    nextBatchOnly: true as const,
    riskBudgetPreserved: true as const,
    action:
      candidates.length > 0
        ? "需要独立退出后10交易日观察窗口；若确认，下一批放宽并按距离同步减仓"
        : "当前记录未提供可核验的-1R止损后观察候选",
    resultLabel: candidates.length ? ("不稳定" as const) : ("无交易" as const),
    reason: candidates.length
      ? "研究Trade不包含退出后的价格窗口；不以持仓期MAE代替因果证据"
      : null,
  };
}

export function researchK13TightenResize(records: readonly K13TradeRecord[]) {
  const closed = closedWithR(records);
  const profitable = closed.filter((record) => record.finalR! > 0);
  const withAtr = profitable.filter(
    (record) =>
      record.mae != null && record.entryAtr != null && record.entryAtr > 0,
  );
  const nearZero = withAtr.filter(
    (record) => record.mae! / record.entryAtr! <= 0.25 + 1e-12,
  );
  const reason =
    profitable.length < 100
      ? "不足100笔盈利闭合记录，不能作近零诊断"
      : withAtr.length !== profitable.length
        ? "盈利记录缺入场ATR或MAE，不能填补"
        : null;
  return {
    version: "k13-tighten-resize-1" as const,
    nearZeroAtr: 0.25 as const,
    profitableRecords: profitable.length,
    recordsWithAtr: withAtr.length,
    nearZeroRecords: nearZero.length,
    nearZeroFraction: reason ? null : nearZero.length / withAtr.length,
    nextBatchOnly: true as const,
    riskBudgetPreserved: true as const,
    capacityLimitsRemain: true as const,
    action: "仅登记下一批收紧候选；当前批次不增仓、不改止损",
    resultLabel: reason ? ("样本不足" as const) : ("不稳定" as const),
    reason,
  };
}

function empiricalCdfAreaOverlap(
  left: readonly number[],
  right: readonly number[],
) {
  const points = [...new Set([...left, ...right].sort((a, b) => a - b))];
  if (points.length < 2) return null;
  const cdf = (values: readonly number[], x: number) =>
    values.filter((value) => value <= x).length / values.length;
  const min = points[0]!;
  const max = points.at(-1)!;
  const span = max - min;
  if (!(span > 0)) return 1;
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const width = points[i]! - points[i - 1]!;
    area +=
      width *
      Math.min(
        cdf(left, (points[i]! + points[i - 1]!) / 2),
        cdf(right, (points[i]! + points[i - 1]!) / 2),
      );
  }
  return 1 - area / span;
}

export function researchK13Overlap(records: readonly K13TradeRecord[]) {
  const valid = records.filter(
    (record) =>
      record.complete &&
      record.entryAtr != null &&
      record.entryAtr > 0 &&
      record.mae != null &&
      record.mae >= 0 &&
      record.finalR != null,
  );
  const wins = valid
    .filter((record) => record.finalR! > 0)
    .map((record) => record.mae! / record.entryAtr!);
  const losses = valid
    .filter((record) => record.finalR! <= 0)
    .map((record) => record.mae! / record.entryAtr!);
  const overlap =
    wins.length && losses.length ? empiricalCdfAreaOverlap(wins, losses) : null;
  const reason =
    valid.length < 100
      ? "不足100笔完整MAE/ATR记录"
      : !wins.length || !losses.length
        ? "缺少盈利或非盈利对照样本"
        : overlap == null
          ? "MAE分布无有效跨度"
          : null;
  return {
    version: "k13-overlap-1" as const,
    scale: "MAE/entryATR" as const,
    statistic: "empirical-cdf-min-area-v1" as const,
    validRecords: valid.length,
    profitableRecords: wins.length,
    nonProfitableRecords: losses.length,
    overlapCoefficient: overlap,
    conclusion:
      overlap == null
        ? null
        : overlap >= 0.8
          ? "样本证据不足以区分"
          : "当前样本有一定区分证据，但不外推为普遍有效",
    resultLabel: reason ? ("样本不足" as const) : ("不稳定" as const),
    reason,
  };
}

export type K13MfeAlternative = {
  id: "chandelier-22-3" | "retracement-2-7r";
  records: readonly K13TradeRecord[];
};

export function researchK13MfeTail(
  records: readonly K13TradeRecord[],
  alternatives: readonly K13MfeAlternative[] = [],
) {
  const valid = closedWithR(records).filter(
    (record) => record.mfe != null && record.mfe >= 0 && record.finalR! > 0,
  );
  const tails = valid.filter((record) => {
    const denominator =
      record.initialR! / (record.entryPrice * record.quantity);
    const mfeR = denominator > 0 ? record.mfe! / denominator : null;
    return mfeR != null && mfeR >= 2 * record.finalR!;
  });
  const baselineIdentities = new Set(records.map((record) => identity(record)));
  const comparisons = alternatives.map((alternative) => {
    const rows = closedWithR(alternative.records);
    const alternativeIdentities = new Set(
      alternative.records.map((record) => identity(record)),
    );
    const sameEntrySet =
      baselineIdentities.size === alternativeIdentities.size &&
      [...baselineIdentities].every((item) => alternativeIdentities.has(item));
    const profits = rows
      .map((record) => record.finalR!)
      .filter(Number.isFinite);
    return {
      id: alternative.id,
      closedRecords: rows.length,
      commonSampleCount: [...baselineIdentities].filter((item) =>
        alternativeIdentities.has(item),
      ).length,
      sameEntrySet,
      averageFinalR: profits.length
        ? profits.reduce((sum, value) => sum + value, 0) / profits.length
        : null,
      resultLabel: labelForProfit(
        profits.length ? profits.reduce((sum, value) => sum + value, 0) : null,
        profits.length,
      ),
    };
  });
  const reason =
    valid.length < 50
      ? "不足50笔可比较盈利记录"
      : alternatives.length !== 2 ||
          !alternatives.some((item) => item.id === "chandelier-22-3") ||
          !alternatives.some((item) => item.id === "retracement-2-7r")
        ? "未同时提供吊灯与回撤止损的独立回测"
        : comparisons.some((comparison) => !comparison.sameEntrySet)
          ? "两条退出对照未使用共同入场事件"
          : null;
  return {
    version: "k13-mfe-tail-1" as const,
    mfeToFinalMultiple: 2 as const,
    validProfitableRecords: valid.length,
    tailRecords: tails.length,
    alternatives: comparisons,
    conclusion:
      tails.length > 0
        ? "存在利润回吐观察，不自动归因为止盈或移动线过紧"
        : "未发现达到预登记阈值的利润回吐观察",
    resultLabel: reason ? ("样本不足" as const) : ("不稳定" as const),
    reason,
  };
}

export function researchK13Regime(records: readonly K13TradeRecord[]) {
  const groups = new Map<string, K13TradeRecord[]>();
  const missing = records.filter(
    (record) => !record.regime || record.regime.knownOn > record.observedDate,
  );
  for (const record of records) {
    if (!record.regime || record.regime.knownOn > record.observedDate) continue;
    const key = `${record.regime.atrBucket}/${record.regime.indexTrend}`;
    const rows = groups.get(key) ?? [];
    rows.push(record);
    groups.set(key, rows);
  }
  const groupRows = (["low", "middle", "high"] as const).flatMap((atrBucket) =>
    (["up", "down"] as const).map((indexTrend) => {
      const rows = groups.get(`${atrBucket}/${indexTrend}`) ?? [];
      const returns = rows
        .map((record) => record.netReturn)
        .filter(
          (value): value is number => value != null && Number.isFinite(value),
        );
      return {
        atrBucket,
        indexTrend,
        count: rows.length,
        meanReturn: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length
          : null,
      };
    }),
  );
  const valid = groupRows.reduce((sum, group) => sum + group.count, 0);
  return {
    version: "k13-regime-1" as const,
    groups: groupRows,
    missingRegimeRecords: missing.length,
    validRecords: valid,
    frozenGrouping:
      "ATR历史分位low/middle/high × 指数收盘相对MA20 up/down" as const,
    resultLabel: valid < 50 ? ("样本不足" as const) : ("不稳定" as const),
    reason:
      valid < 50
        ? "不足50笔含当时已知ATR分位和指数趋势的记录"
        : missing.length
          ? "部分记录缺状态，未跨状态补样本"
          : null,
  };
}

export function researchK13Cycle100(records: readonly K13TradeRecord[]) {
  const ordered = [...records].sort(
    (a, b) =>
      a.entryDate.localeCompare(b.entryDate) ||
      a.symbol.localeCompare(b.symbol) ||
      a.eventKey.localeCompare(b.eventKey),
  );
  const blocks: {
    strategyVersion: string;
    trainingCount: number;
    validationCount: number;
    trainingQ90: number | null;
    validationMeanReturn: number | null;
    status: "available" | "insufficient";
    reason: string | null;
  }[] = [];
  let cursor = 0;
  while (cursor < ordered.length) {
    const version = ordered[cursor]!.strategyVersion;
    const end = ordered.findIndex(
      (record, index) => index >= cursor && record.strategyVersion !== version,
    );
    const versionRows = ordered.slice(cursor, end < 0 ? ordered.length : end);
    const training = versionRows
      .filter((record) => record.complete)
      .slice(0, 100);
    const validation = versionRows
      .filter((record) => record.complete)
      .slice(100, 200);
    const winningMae = training
      .filter((record) => record.finalR! > 0 && record.mae != null)
      .map((record) => record.mae!);
    const validationReturns = validation
      .map((record) => record.netReturn)
      .filter(
        (value): value is number => value != null && Number.isFinite(value),
      );
    const status =
      training.length >= 100 && validation.length >= 100
        ? "available"
        : "insufficient";
    blocks.push({
      strategyVersion: version,
      trainingCount: training.length,
      validationCount: validation.length,
      trainingQ90: status === "available" ? quantile(winningMae, 0.9) : null,
      validationMeanReturn: validationReturns.length
        ? validationReturns.reduce((sum, value) => sum + value, 0) /
          validationReturns.length
        : null,
      status,
      reason:
        status === "available"
          ? null
          : training.length < 50
            ? "少于50笔，不出统计结论"
            : training.length < 100
              ? "50至99笔，未满足100笔校准门槛"
              : "训练达到100笔但下一批验证不足100笔",
    });
    cursor += versionRows.length;
  }
  const available = blocks.filter((block) => block.status === "available");
  return {
    version: "k13-cycle100-1" as const,
    trainingTrades: 100 as const,
    validationTrades: 100 as const,
    blocks,
    strategyChangeResetsTraining: true as const,
    resultLabel: available.length ? ("不稳定" as const) : ("样本不足" as const),
    reason: available.length
      ? null
      : "没有完成100笔训练+100笔验证的同版本顺序批次",
  };
}

export function researchK13Emotion20(records: readonly K13TradeRecord[]) {
  const closed = records.filter((record) => record.exitDate != null);
  const missing = closed.filter((record) => record.exitCategory == null);
  const emotions = closed.filter((record) => record.exitCategory === "emotion");
  const fraction =
    missing.length || !closed.length ? null : emotions.length / closed.length;
  const reason = !closed.length
    ? "没有已闭合交易"
    : missing.length
      ? "真实退出原因分类缺失，不能填为非情绪"
      : null;
  return {
    version: "k13-emotion20-1" as const,
    threshold: 0.2 as const,
    closedRecords: closed.length,
    missingCategoryRecords: missing.length,
    emotionRecords: emotions.length,
    emotionFraction: fraction,
    automaticStrategyPass: false as const,
    resultLabel: reason
      ? closed.length
        ? ("数据不足" as const)
        : ("无交易" as const)
      : fraction! > 0.2
        ? ("当前样本表现较差" as const)
        : ("当前样本表现较好" as const),
    reason,
  };
}

export function researchK13Review(
  records: readonly K13TradeRecord[],
  initialCapital: number,
) {
  const closed = records
    .filter(
      (record) =>
        record.complete &&
        record.exitDate != null &&
        record.profit != null &&
        Number.isFinite(record.profit),
    )
    .sort(
      (a, b) =>
        a.exitDate!.localeCompare(b.exitDate!) || a.id.localeCompare(b.id),
    );
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const record of closed) {
    equity += record.profit!;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
    lossStreak = record.profit! < 0 ? lossStreak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }
  const byMonth = new Map<string, K13TradeRecord[]>();
  for (const record of closed) {
    const month = record.exitDate!.slice(0, 7);
    const rows = byMonth.get(month) ?? [];
    rows.push(record);
    byMonth.set(month, rows);
  }
  const monthly = [...byMonth.entries()].map(([month, rows]) => {
    const profit = rows.reduce((sum, row) => sum + row.profit!, 0);
    const wins = rows.filter((row) => row.profit! > 0).length;
    const losses = rows.filter((row) => row.profit! < 0).length;
    return {
      month,
      trades: rows.length,
      wins,
      losses,
      zeros: rows.length - wins - losses,
      winRate: wins / rows.length,
      returnFraction: initialCapital > 0 ? profit / initialCapital : null,
      profit,
    };
  });
  const profit = closed.reduce((sum, row) => sum + row.profit!, 0);
  const wins = closed.filter((row) => row.profit! > 0);
  const losses = closed.filter((row) => row.profit! < 0);
  const averageWin = wins.length
    ? wins.reduce((sum, row) => sum + row.profit!, 0) / wins.length
    : null;
  const averageLoss = losses.length
    ? losses.reduce((sum, row) => sum + row.profit!, 0) / losses.length
    : null;
  return {
    version: "k13-review-1" as const,
    records: closed,
    statistics: {
      count: closed.length,
      winRate: closed.length ? wins.length / closed.length : null,
      averageWin,
      averageLoss,
      payoffRatio:
        averageWin != null && averageLoss != null
          ? averageWin / Math.abs(averageLoss)
          : null,
      realizedProfit: profit,
      maxDrawdown: closed.length ? maxDrawdown : null,
      maxLossStreak,
      openRecords: records.filter((record) => record.exitDate == null).length,
    },
    monthly,
    resultLabel: labelForProfit(profit, closed.length),
    reason:
      closed.length < 50 ? "少于50笔，仅作逐笔记录，不出稳定统计结论" : null,
  };
}

export type K13ReportInput = {
  contract: K13Contract;
  records?: readonly K13TradeRecord[];
  trades?: readonly ResearchTrade[];
  series?: ReadonlyMap<string, readonly Bar[]>;
  calendar?: readonly string[];
  dataStatus?: "available" | "fixed-input" | "data-insufficient";
  dataReason?: string;
  mfeAlternatives?: readonly K13MfeAlternative[];
};

export function researchK13Report(input: K13ReportInput) {
  const records =
    input.records ??
    (input.trades && input.series && input.calendar
      ? researchK13Records(input.trades, input.series, input.calendar)
      : []);
  const availabilityReason =
    input.dataStatus === "data-insufficient"
      ? (input.dataReason ?? "研究输入不足，未执行历史回测")
      : null;
  const result = {
    version: "k13-report-1" as const,
    boundary: k13Boundary,
    contract: input.contract,
    contractCheck: compareK13Contracts([input.contract]),
    dataStatus: input.dataStatus ?? "fixed-input",
    dataReason: availabilityReason,
    sensitivityGrid: k13SensitivityGrid,
    baselines: input.contract.baselines,
    methods: {
      "SW-P-review": researchK13Review(records, input.contract.initialCapital),
      "RK-MAE-q80": researchK13MaeQuantile("RK-MAE-q80", records),
      "RK-MAE-q90": researchK13MaeQuantile("RK-MAE-q90", records),
      "RK-MAE-q50": researchK13MaeQuantile("RK-MAE-q50", records),
      "RK-MAE-q100": researchK13MaeQuantile("RK-MAE-q100", records),
      "RK-MAE-widen-resize": researchK13WidenResize(records),
      "RK-MAE-tighten-resize": researchK13TightenResize(records),
      "RK-MAE-overlap": researchK13Overlap(records),
      "RK-MAE-mfe-tail": researchK13MfeTail(records, input.mfeAlternatives),
      "RK-MAE-regime": researchK13Regime(records),
      "RK-MAE-cycle100": researchK13Cycle100(records),
      "RK-MAE-emotion20": researchK13Emotion20(records),
    },
    recordCount: records.length,
  };
  return availabilityReason
    ? {
        ...result,
        methods: Object.fromEntries(
          k13MethodIds.map((id) => [
            id,
            {
              ...result.methods[id],
              resultLabel: "数据不足" as const,
              reason: availabilityReason,
            },
          ]),
        ) as unknown as typeof result.methods,
      }
    : result;
}
