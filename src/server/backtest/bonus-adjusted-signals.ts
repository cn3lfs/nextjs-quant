import type { Bar } from "~/lib/domain";
import type {
  AdjustmentDiagnostics,
  ResearchAdjustment,
} from "~/lib/research/evidence/research-adjustment";
import { actionReview, type BacktestActions } from "./backtest-actions";

export type ResearchAdjustmentInput = {
  adjustment?: ResearchAdjustment;
  corporateActions?: BacktestActions;
};
export class AdjustmentUnavailableError extends Error {
  readonly status = "unavailable";
  constructor(
    reason: string,
    readonly diagnostics: AdjustmentDiagnostics,
  ) {
    super(
      `送转研究整段不可用：${reason}；diagnostics=${JSON.stringify(diagnostics)}`,
    );
    this.name = "AdjustmentUnavailableError";
  }
}

export function bonusAdjustedSignals(bars: Bar[], review?: BacktestActions) {
  const diagnostics: AdjustmentDiagnostics = {
    exDividendDays: 0,
    shareAdjustments: 0,
    fractionalShares: 0,
    rightsIssuesBlocked: 0,
    dividendsIgnored: 0,
    blockedEvents: { count: 0, events: [] },
  };
  const fail = (reason: string): never => {
    throw new AdjustmentUnavailableError(reason, diagnostics);
  };
  if (
    !bars.length ||
    bars.some(
      (b, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        !Number.isFinite(Date.parse(b.date)) ||
        new Date(b.date).toISOString().slice(0, 10) !== b.date ||
        (i > 0 && b.date <= bars[i - 1]!.date) ||
        [b.open, b.high, b.low, b.close].some(
          (p) => !Number.isFinite(p) || p <= 0,
        ),
    )
  )
    fail("需要有效且严格递增的原始日线价格");
  if (
    !review ||
    review.status === "missing" ||
    !review.source ||
    review.start > bars[0]!.date ||
    review.end < bars.at(-1)!.date
  )
    fail("公司行动来源缺失或未覆盖整个输入区间");
  const source = review!;
  let events: BacktestActions["events"];
  try {
    events = actionReview(
      { symbol: source.symbol, source: "tdx-local", bars },
      source.events,
      source.source!,
    ).events;
  } catch {
    return fail("公司行动数据未通过校验");
  }
  diagnostics.exDividendDays = new Set(
    events.filter((e) => e.category === 1).map((e) => e.date),
  ).size;
  diagnostics.dividendsIgnored = events.filter(
    (e) => e.category === 1 && e.dividend! > 0,
  ).length;
  for (const e of events) {
    const rights = e.category === 1 && e.rightsRatio! > 0;
    if (rights) diagnostics.rightsIssuesBlocked++;
    if (rights || [11, 12, 13, 14].includes(e.category))
      diagnostics.blockedEvents.events.push({
        date: e.date,
        category: e.category,
        reason: rights
          ? "配股需股东出资，未建模"
          : `${e.name}（类别 ${e.category}）未建模`,
      });
  }
  diagnostics.blockedEvents.count = diagnostics.blockedEvents.events.length;
  if (diagnostics.blockedEvents.count)
    fail(
      diagnostics.blockedEvents.events
        .map((e) => `${e.date} ${e.reason}`)
        .join("；"),
    );
  const bonuses = events.filter(
    (e) => e.category === 1 && e.bonusRatio! > 0 && e.date > bars[0]!.date,
  );
  let cursor = 0,
    factor = 1;
  const changes = bars.map((bar) => {
    const ratios: number[] = [];
    while (cursor < bonuses.length && bonuses[cursor]!.date <= bar.date) {
      const ratio = bonuses[cursor++]!.bonusRatio!;
      // W1 §8: (previousClose * 10) / (10 + bonusRatio * 10).
      factor *= 1 + ratio;
      ratios.push(ratio);
    }
    if (!Number.isFinite(factor) || factor <= 0) fail("送转因子溢出");
    return { date: bar.date, factor, ratios };
  });
  const adjusted = bars.map((bar, i) => {
    const factor = changes[i]!.factor;
    const result = {
      ...bar,
      open: bar.open * factor,
      high: bar.high * factor,
      low: bar.low * factor,
      close: bar.close * factor,
    };
    if (
      [result.open, result.high, result.low, result.close].some(
        (p) => !Number.isFinite(p),
      )
    )
      fail("送转信号价格溢出");
    return result;
  });
  return { bars: adjusted, changes, diagnostics };
}

export function bonusShares(shares: number, ratio: number, price: number) {
  const exact = shares * (1 + ratio);
  if (!Number.isFinite(exact) || exact > Number.MAX_SAFE_INTEGER)
    throw new Error("送转股数溢出");
  // Remove only machine roundoff near an integer; genuine fractions are cashed.
  const nearest = Math.round(exact);
  const normalized =
    Math.abs(exact - nearest) <= Number.EPSILON * Math.max(1, exact) * 2
      ? nearest
      : exact;
  const whole = Math.floor(normalized),
    fraction = normalized - whole;
  return { shares: whole, cash: fraction * price, fractional: fraction > 0 };
}
