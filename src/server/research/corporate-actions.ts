import type { TdxXdxr } from "tstdx/wire";
import {
  actionPrice,
  type PortfolioInstrument,
  type PortfolioExecution,
} from "quant-backtest";
import { equityResearchRules } from "trading-strategy-core/market-rules";
import type { Bar } from "trading-strategy-core/bars";

/** Explicit research entitlement assumptions, never personal ledger evidence. */
export function researchCorporateActions(
  events: readonly TdxXdxr[],
  source: string,
  start: string,
  end: string,
): NonNullable<PortfolioInstrument["actions"]> {
  const changes = new Map(
    events
      .filter((e) => e.category >= 2 && e.category <= 10)
      .map((e) => [e.date, e]),
  );
  const actions: NonNullable<PortfolioInstrument["actions"]>[number][] = [];
  for (const e of events.filter((e) => e.date >= start && e.date <= end)) {
    if (e.category === 13 || e.category === 14)
      throw new Error(`Unsupported warrant entitlement ${e.date}`);
    // Category 12 affects non-tradable shares, outside this public float account.
    if (e.category !== 1 && e.category !== 11) continue;
    const change = changes.get(e.date);
    const unchanged =
      change?.totalSharesBefore != null &&
      change.totalSharesAfter === change.totalSharesBefore;
    const bonus = unchanged ? 0 : (e.bonusRatio ?? 0);
    const rightsRatio = unchanged ? 0 : (e.rightsRatio ?? 0);
    const dividend = e.dividend ?? 0;
    const shareFactor = e.category === 11 ? e.shrinkRatio : 1;
    if (
      shareFactor === undefined ||
      !Number.isFinite(shareFactor) ||
      shareFactor <= 0 ||
      [bonus, rightsRatio, dividend].some((v) => !Number.isFinite(v) || v < 0)
    )
      throw new Error(`Invalid GBBQ ratio ${e.date}`);
    if (!dividend && !bonus && !rightsRatio && shareFactor === 1) continue;
    const action = {
      date: e.date,
      availableAt: e.date,
      dividend,
      bonus,
      shareFactor,
      rightsRatio,
      rightsPrice: e.rightsPrice ?? 0,
      ...(bonus ? { sharesSellableAt: e.date } : {}),
      evidence: `${source}; GBBQ ${e.name}; ex-date cash/bonus availability research assumption; no rights subscription; whole-share floor, residual disclosed`,
    };
    if (actions.some((a) => a.date === e.date))
      throw new Error(`Ambiguous same-day GBBQ entitlements ${e.date}`);
    actions.push(action);
  }
  return actions;
}
export function researchExecutionEvidence(
  symbol: string,
  bars: readonly Bar[],
  actions: PortfolioInstrument["actions"],
): PortfolioInstrument["execution"] {
  return Object.fromEntries(
    bars.map((bar, i) => [
      bar.date,
      researchExecutionAt(symbol, bar, bars[i - 1], actions)!,
    ]),
  );
}
export function researchExecutionAt(
  symbol: string,
  bar: Readonly<Bar> | undefined,
  previousBar: Readonly<Bar> | undefined,
  actions: PortfolioInstrument["actions"],
): PortfolioExecution | undefined {
  if (!bar) return undefined;
  const rules = equityResearchRules(symbol, bar.date);
  let previous = previousBar?.close;
  for (const action of actions?.filter(
    (a) => a.date <= bar.date && a.date > (previousBar?.date ?? bar.date),
  ) ?? [])
    if (previous !== undefined) previous = actionPrice(previous, action);
  return {
    evidence: "Board-rule scenario; historical ST/IPO/queue unverified",
    minimum: rules.minimum,
    step: rules.step,
    tradable: bar.volume > 0,
    limitUp: previous
      ? Math.round(previous * (1 + rules.limit) * 100) / 100
      : null,
    limitDown: previous
      ? Math.round(previous * (1 - rules.limit) * 100) / 100
      : null,
  };
}
