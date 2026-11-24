import { z } from "zod";
import {
  adjustmentFactors,
  applyAdjustment,
  applyAdjustmentByDate,
  isAStock,
  isLocalFund,
  readGbbq,
  readSnapshot,
} from "tstdx/local";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { prepareBreakout } from "trading-strategies/research/breakout/breakout";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { capabilityAllows } from "~/lib/common/capabilities";
import {
  barReplayAdjustmentSchema,
  barReplayIndicators,
  barReplaySessionSchema,
  barReplayStrategyKeys,
  barReplaySymbolSchema,
  evaluateBarReplaySession,
  settleBarReplaySession,
  type BarReplayFrame,
  type BarReplaySignal,
} from "~/lib/chart/bar-replay";
import type { Bar } from "~/lib/domain";
import { ma } from "~/lib/indicators";
import { settings } from "../infra/settings";
import { projectCzsc } from "../strategies/chan/czsc";
import type { CzscSnapshot } from "../strategies/chan/czsc-api";

const symbolInput = z.object({ symbol: barReplaySymbolSchema });
const strategyKey = z.enum(barReplayStrategyKeys);
export const barReplayFrameInput = symbolInput
  .extend({
    cutoffDate: researchDateSchema,
    adjustment: barReplayAdjustmentSchema.default("none"),
    includeCzsc: z.boolean().default(false),
    strategyKey: strategyKey.optional(),
    step: z.boolean().default(false),
    session: barReplaySessionSchema.optional(),
  })
  .strict();
export const barReplayRevealInput = symbolInput
  .extend({
    cutoffDate: researchDateSchema,
    strategyKey: strategyKey.default("ma-cross"),
    session: barReplaySessionSchema,
    toleranceSessions: z.number().int().min(0).max(10).default(2),
  })
  .strict();
export const barReplayCandidatesInput = symbolInput.strict();

async function readReplayBars(root: string, symbol: string) {
  if (!isAStock(symbol) && !isLocalFund(symbol))
    throw new Error("盲测训练支持 A 股及场内基金日线");
  return (await readSnapshot(root, symbol, "day", { chartFunds: true })).bars;
}

async function visibleActions(
  root: string,
  symbol: string,
  cutoffDate: string,
) {
  const source = await readGbbq(root).catch(() => null);
  return source
    ? (source.events.get(symbol) ?? []).filter(
        (event) => event.date <= cutoffDate,
      )
    : null;
}

function priceActionDates(
  actions: NonNullable<Awaited<ReturnType<typeof visibleActions>>>,
) {
  return actions
    .filter((action) => [1, 11, 12].includes(action.category))
    .map((action) => action.date);
}

const missingActions = "本地 GBBQ 不可读，原价训练的公司行动覆盖未知";
const unsupportedAdjustments = "可见区间含复权口径未支持的公司行动";

export async function getBarReplayFrame(
  raw: z.input<typeof barReplayFrameInput> & { root?: string },
): Promise<BarReplayFrame<CzscSnapshot>> {
  const { root: configuredRoot, ...request } = raw;
  const input = barReplayFrameInput.parse(request);
  const root = configuredRoot ?? settings().tdxRoot;
  const completed = completedBarFilter("day", Date.now());
  const source = await readReplayBars(root, input.symbol);
  const prefix = source
    .filter((bar) => bar.date <= input.cutoffDate)
    .filter((bar) => completed(bar.date));
  const next = source[prefix.length];
  const advance = input.step && next && completed(next.date) ? next : undefined;
  if (advance) prefix.push(advance);
  const cutoffDate = advance?.date ?? input.cutoffDate;
  if (!completed(cutoffDate) || !prefix.length)
    throw new Error("截断日尚未收盘或之前缺少完整日线");

  const actions = await visibleActions(root, input.symbol, cutoffDate);
  let bars = prefix;
  if (input.adjustment !== "none") {
    if (!actions) throw new Error("复权训练需要本地 GBBQ");
    if (
      actions.some(
        (action) => action.category === 12 && action.date > prefix[0]!.date,
      )
    )
      throw new Error(unsupportedAdjustments);
    const lastVisibleBar = prefix.at(-1)!;
    const hasTrailingAction = actions.some(
      (action) =>
        action.date > lastVisibleBar.date &&
        (action.category === 1 || action.category === 11),
    );
    // A suspended cutoff can carry effective actions without an observed bar.
    // Extend only the factor reference so the anchor never enters the frame.
    const reference =
      input.adjustment === "forward" && hasTrailingAction
        ? [...prefix, { ...lastVisibleBar, date: cutoffDate }]
        : prefix;
    bars = applyAdjustmentByDate(
      prefix,
      adjustmentFactors(reference, actions),
      input.adjustment,
    );
  }
  const hasMore = Boolean(
    source[prefix.length] && completed(source[prefix.length]!.date),
  );
  const indicators = barReplayIndicators(bars);
  const simulation = input.session
    ? settleBarReplaySession({
        symbol: input.symbol,
        bars: prefix,
        session: input.session,
        actionDates: actions ? priceActionDates(actions) : [],
      })
    : null;

  let czsc: CzscSnapshot | null = null;
  if (input.includeCzsc) {
    if (!capabilityAllows("nativeChart", "compute"))
      throw new Error("原生缠论计算暂不可用");
    czsc = await projectCzsc(
      {
        dates: bars.map((bar) => bar.date),
        high: bars.map((bar) => bar.high),
        low: bars.map((bar) => bar.low),
        close: bars.map((bar) => bar.close),
        volume: bars.map((bar) => bar.volume),
      },
      { bars: false },
    );
  }
  return {
    symbol: input.symbol,
    cutoffDate,
    adjustment: input.adjustment,
    strategyKey: input.strategyKey ?? null,
    bars,
    indicators,
    czsc,
    hasMore,
    simulation,
    warnings: actions ? [] : [missingActions],
  };
}

function comparisonSignals(
  bars: readonly Bar[],
  startDate: string,
  strategy: z.infer<typeof strategyKey>,
): BarReplaySignal[] {
  const fastAverage = ma(bars, 5),
    slowAverage = ma(bars, 20);
  // The comparison is frozen on the first raw bar's price basis.
  const breakout =
    strategy === "double-breakout" ? prepareBreakout(bars) : null;
  const signals: BarReplaySignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    if (bar.date < startDate) continue;
    const fast = fastAverage[i],
      slow = slowAverage[i];
    const priorFast = fastAverage[i - 1],
      priorSlow = slowAverage[i - 1];
    if (breakout) {
      const point = breakout.point(i);
      if (point.long.status === "是")
        signals.push({ date: bar.date, side: "buy" });
      else if (point.short.status === "是")
        signals.push({ date: bar.date, side: "sell" });
    } else if (
      fast != null &&
      slow != null &&
      priorFast != null &&
      priorSlow != null
    ) {
      if (fast > slow && priorFast <= priorSlow)
        signals.push({ date: bar.date, side: "buy" });
      if (fast < slow && priorFast >= priorSlow)
        signals.push({ date: bar.date, side: "sell" });
    }
  }
  return signals;
}

export async function revealBarReplaySession(
  raw: z.input<typeof barReplayRevealInput> & { root?: string },
) {
  const { root: configuredRoot, ...request } = raw;
  const { symbol, cutoffDate, session, toleranceSessions, strategyKey } =
    barReplayRevealInput.parse(request);
  const root = configuredRoot ?? settings().tdxRoot;
  const completed = completedBarFilter("day", Date.now());
  const source = await readReplayBars(root, symbol);
  const bars = source
    .filter((bar) => bar.date <= cutoffDate)
    .filter((bar) => completed(bar.date));
  if (!completed(cutoffDate) || !bars.length)
    throw new Error("揭晓区间缺少完整日线");
  const actions = await visibleActions(root, symbol, cutoffDate);
  const signalBars = actions
    ? applyAdjustment(bars, adjustmentFactors(bars, actions), "backward")
    : bars;
  return {
    symbol,
    cutoffDate,
    strategyKey,
    warnings: [
      "模拟按原价开盘或收盘撮合，采用历史费税基线与统一 T+1 整手规则。未模拟涨跌停排队及滑点。",
      ...(actions ? [] : [missingActions]),
      ...(actions?.some(
        (action) => action.category === 12 && action.date > bars[0]!.date,
      )
        ? [unsupportedAdjustments]
        : []),
    ],
    ...evaluateBarReplaySession({
      symbol,
      bars,
      signalBars,
      session,
      toleranceSessions,
      actionDates: actions ? priceActionDates(actions) : [],
      theorySignals: comparisonSignals(
        signalBars,
        session.startDate,
        strategyKey,
      ),
    }),
  };
}

export async function getBarReplayCandidates(
  symbol: string,
  root = settings().tdxRoot,
) {
  const completed = completedBarFilter("day", Date.now());
  const normalizedSymbol = barReplaySymbolSchema.parse(symbol);
  const first = (await readReplayBars(root, normalizedSymbol)).find((bar) =>
    completed(bar.date),
  );
  return {
    available: first !== undefined,
    firstDate: first?.date ?? null,
  };
}
