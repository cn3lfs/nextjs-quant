const defaultMaxBars = 2_000_000;
// Allow for a Bar object, its label and array references. This is a planning
// estimate; V8 heap, codec buffers and other consumers have their own costs.
const estimatedBytesPerBar = 256;

type BudgetLimits = { maxBars: number; maxEstimatedBytes: number };
type Series = { symbol: string; period: string };
type Stage = "limit" | "source" | "output";
type BudgetDiagnostic = BudgetLimits &
  Series & {
    stage: Stage;
    retainedBars: number;
    requestedBars: number;
    estimatedBytes: number;
  };

function positiveInteger(value: number | string, name: string) {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`BarStore 资源预算配置非法：${name} 必须为正整数`);
  return parsed;
}

export class BarResourceBudgetError extends Error {
  readonly code = "BAR_STORE_BUDGET_EXCEEDED";

  constructor(readonly diagnostic: BudgetDiagnostic) {
    const {
      symbol,
      period,
      stage,
      retainedBars,
      requestedBars,
      estimatedBytes,
      maxBars,
      maxEstimatedBytes,
    } = diagnostic;
    super(
      `BarStore 资源预算超限 [${symbol} ${period}, ${stage}]：` +
        `已保留 ${retainedBars} 根，本次 ${requestedBars} 根，上限 ${maxBars} 根；` +
        `预计 ${estimatedBytes} 字节，上限 ${maxEstimatedBytes} 字节。` +
        "可缩小区间或证券池，或调整 QUANT_BAR_STORE_MAX_BARS / QUANT_BAR_STORE_MAX_ESTIMATED_BYTES",
    );
    this.name = "BarResourceBudgetError";
  }
}

function budgetLimits(limits: Partial<BudgetLimits> = {}): BudgetLimits {
  const maxBars = positiveInteger(
    limits.maxBars ?? process.env.QUANT_BAR_STORE_MAX_BARS ?? defaultMaxBars,
    "QUANT_BAR_STORE_MAX_BARS",
  );
  const maxEstimatedBytes = positiveInteger(
    limits.maxEstimatedBytes ??
      process.env.QUANT_BAR_STORE_MAX_ESTIMATED_BYTES ??
      Math.min(Number.MAX_SAFE_INTEGER, maxBars * estimatedBytesPerBar),
    "QUANT_BAR_STORE_MAX_ESTIMATED_BYTES",
  );
  return { maxBars, maxEstimatedBytes };
}

export function checkBarBudget(
  requestedBars: number,
  series: Series,
  stage: Stage,
  retainedBars = 0,
  limits = budgetLimits(),
) {
  const total = retainedBars + requestedBars;
  const estimatedBytes = total * estimatedBytesPerBar;
  if (total > limits.maxBars || estimatedBytes > limits.maxEstimatedBytes)
    throw new BarResourceBudgetError({
      ...series,
      ...limits,
      stage,
      retainedBars,
      requestedBars,
      estimatedBytes,
    });
}

/** Share the retained output budget across all series in one research task. */
export class BarResourceBudget {
  private readonly limits: BudgetLimits;
  private retainedBars = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = budgetLimits(limits);
  }

  checkLimit(bars: number, series: Series) {
    checkBarBudget(bars, series, "limit", 0, this.limits);
  }

  checkSource(bars: number, series: Series) {
    checkBarBudget(bars, series, "source", this.retainedBars, this.limits);
  }

  retain(bars: number, series: Series) {
    checkBarBudget(bars, series, "output", this.retainedBars, this.limits);
    this.retainedBars += bars;
  }
}
