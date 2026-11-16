import type { Bar, Period } from "trading-strategy-core/bars";
import {
  standingProtectionLevels,
  nextStrategyProtection,
  strategyProtection,
  strategyTimeExit,
} from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import { beijingClock } from "../market/market-session";
import { cryptoPeriodEnd } from "../market/crypto-aggregation";
import type { PlanProtection } from "../strategy-facts/plan-policy";
import {
  accountTradeFingerprint,
  type AccountKind,
  type AccountMarket,
  type AccountTrade,
} from "./account-workspace";
import { closeScanWindow } from "../market/close-scan-window";

export type HoldingProtectionBinding = {
  id: string;
  kind: AccountKind;
  account: string;
  market: AccountMarket;
  symbol: string;
  strategyId: string;
  version: number;
  planId: string;
  sleeve: string;
  trades: { id: string; fingerprint: string }[];
  entryDate: string;
  entryTime: number | null;
  entryPrice: number;
  boundAt: number;
  protection: PlanProtection;
  status: "active" | "needs-review";
  reason: string | null;
};
export type HoldingProtectionTask = {
  key: string;
  symbol: string;
  market: AccountMarket;
  account: string;
  kind: AccountKind;
  oldStop: number | null;
  newStop: number | null;
  reason: string;
  dueDate: string | null;
  dueAt: string | null;
  sourcePlanId: string;
  strategyId: string;
  version: number;
  status:
    | "set"
    | "adjust"
    | "time-exit"
    | "rule-exit"
    | "target-exit"
    | "stop-exit"
    | "needs-review";
  bar: string | null;
};
export type HoldingProtectionProjection = {
  task: HoldingProtectionTask;
  backupStop: number | null;
  bars: number;
  high: number;
  observedAt: number;
  bindingAt: number;
};
export const protectionPositionKey = (
  kind: AccountKind,
  account: string,
  market: AccountMarket,
  symbol: string,
) => JSON.stringify([kind, account, market, symbol]);

export const holdingTradeFingerprint = (trade: AccountTrade) =>
  JSON.stringify([
    accountTradeFingerprint(trade),
    trade.time,
    trade.strategyId,
    trade.strategyVersion,
    trade.planId,
    trade.sleeve,
    trade.timePrecision,
    trade.sourceOrder,
  ]);

/** Preserve every fill in the still-open round, including partial exits. */
export function activeHoldingRound(
  trades: readonly AccountTrade[],
  identity: Pick<
    HoldingProtectionBinding,
    "kind" | "account" | "market" | "symbol"
  >,
) {
  const ordered = trades
    .map((trade, index) => ({ trade, index }))
    .filter(
      ({ trade }) =>
        trade.kind === identity.kind &&
        trade.account === identity.account &&
        trade.market === identity.market &&
        trade.symbol === identity.symbol,
    )
    .sort((a, b) => a.trade.time - b.trade.time || a.index - b.index);
  let quantity = 0,
    ambiguous = false;
  let active: AccountTrade[] = [];
  for (let i = 0; i < ordered.length;) {
    let end = i + 1;
    while (
      end < ordered.length &&
      ordered[end]!.trade.time === ordered[i]!.trade.time
    )
      end++;
    const group = ordered.slice(i, end).map((r) => r.trade);
    const evidence = group[0]!.sourceOrder;
    const proven =
      group.length === 1 ||
      (!!evidence &&
        group.every((t) => t.sourceOrder?.source === evidence.source) &&
        new Set(group.map((t) => t.sourceOrder!.index)).size === group.length);
    const buys = group
      .filter((t) => t.side === "buy")
      .reduce((n, t) => n + t.quantity, 0);
    const sells = group
      .filter((t) => t.side === "sell")
      .reduce((n, t) => n + t.quantity, 0);
    if (!proven && buys > 0 && sells >= quantity && sells > 0) {
      ambiguous = true;
      active.push(...group);
      quantity = Math.max(0, quantity + buys - sells);
      if (quantity <= 1e-8) {
        quantity = 0;
        active = [];
        ambiguous = false;
      }
    } else {
      if (proven && evidence)
        group.sort((a, b) => a.sourceOrder!.index - b.sourceOrder!.index);
      for (const trade of group) {
        active.push(trade);
        quantity += trade.side === "buy" ? trade.quantity : -trade.quantity;
        if (quantity <= 1e-8) {
          quantity = 0;
          active = [];
          ambiguous = false;
        }
      }
    }
    i = end;
  }
  return { trades: active, ambiguous };
}
export function holdingProtectionCurrent(
  binding: HoldingProtectionBinding,
  trades: readonly AccountTrade[],
) {
  const round = activeHoldingRound(trades, binding);
  const active = round.trades;
  return (
    !round.ambiguous &&
    binding.status === "active" &&
    active.length === binding.trades.length &&
    binding.trades.every((r) =>
      active.some(
        (t) => t.id === r.id && holdingTradeFingerprint(t) === r.fingerprint,
      ),
    )
  );
}
export function protectionReviewTask(
  binding: HoldingProtectionBinding,
  reason: string,
): HoldingProtectionTask {
  return {
    key: binding.id,
    symbol: binding.symbol,
    market: binding.market,
    account: binding.account,
    kind: binding.kind,
    oldStop: null,
    newStop: null,
    reason,
    dueDate: null,
    dueAt: null,
    sourcePlanId: binding.planId,
    strategyId: binding.strategyId,
    version: binding.version,
    status: "needs-review",
    bar: null,
  };
}
/** A completed high updates the NEXT session's order, never this bar's stop.
 * This is an order-setting suggestion, not evidence that a broker accepted it. */
export function observeHoldingProtection(
  binding: HoldingProtectionBinding,
  bars: readonly Bar[],
  calendar: readonly string[],
  now: number,
  previous?: HoldingProtectionProjection,
  options: {
    period?: Period;
    ruleExit?: boolean | null;
    evidenceIssue?: string;
    chandelierStop?: number | null;
  } = {},
): HoldingProtectionProjection {
  if (previous?.bindingAt !== binding.boundAt) previous = undefined;
  if (binding.protection.version !== "plan-protection-1")
    return {
      task: protectionReviewTask(
        binding,
        "旧计划未提供完整退出规格，请重新核验保护",
      ),
      backupStop: null,
      bars: 0,
      high: binding.entryPrice,
      observedAt: now,
      bindingAt: binding.boundAt,
    };
  const period = options.period ?? "day";
  const completedAt = (bar: Bar) =>
    binding.market === "crypto"
      ? cryptoPeriodEnd(bar.date, period)
      : period === "day" || period === "week"
        ? Date.parse(`${bar.date.slice(0, 10)}T15:00:00+08:00`)
        : Date.parse(bar.date);
  const needsEntryTime =
    binding.market === "crypto" || (period !== "day" && period !== "week");
  const observed = bars.filter(
    (bar) =>
      completedAt(bar) <= now &&
      (needsEntryTime
        ? binding.entryTime !== null && completedAt(bar) >= binding.entryTime
        : bar.date.slice(0, 10) >= binding.entryDate.slice(0, 10)),
  );

  const bar = observed.at(-1);
  const spec = binding.protection;
  const oldStop =
    previous?.task.newStop ?? previous?.backupStop ?? spec.initialStop;
  const missing =
    binding.market === "cn-equity" &&
    period === "day" &&
    bar &&
    calendar.some(
      (d) =>
        d >= binding.entryDate.slice(0, 10) &&
        d <= bar.date &&
        !observed.some((b) => b.date === d),
    );
  const invalid = observed.some(
    (b, i) =>
      ![b.open, b.high, b.low, b.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close) ||
      (i > 0 && b.date <= observed[i - 1]!.date),
  );
  let evidenceIssue = options.evidenceIssue;
  if (!evidenceIssue && needsEntryTime && binding.entryTime === null)
    evidenceIssue = "入场时刻未知，不能猜测盘内持有根数或保护高点";
  if (!evidenceIssue && !bar) evidenceIssue = "没有入场后的完成bar";
  if (!evidenceIssue && missing)
    evidenceIssue = "持仓周期存在缺失bar，不能认证持有根数或新保护价";
  if (!evidenceIssue && invalid) evidenceIssue = "保护行情价格或日期无效";
  if (
    !evidenceIssue &&
    spec.exitSpec.stop?.kind === "atr" &&
    !spec.initialStopEvidence
  )
    evidenceIssue = "ATR初始止损缺少冻结来源证据";
  if (!evidenceIssue && spec.exitSpec.rule && options.ruleExit == null)
    evidenceIssue = "退出规则证据或预热不足，不能视为未触发";
  if (
    !evidenceIssue &&
    spec.exitSpec.chandelier &&
    options.chandelierStop == null
  )
    evidenceIssue =
      "Chandelier ATR或滚动高点预热/完成bar证据不足，保留原保护价";
  if (evidenceIssue)
    return {
      task: protectionReviewTask(binding, evidenceIssue),
      backupStop: oldStop,
      bars: previous?.bars ?? 0,
      high: previous?.high ?? binding.entryPrice,
      observedAt: now,
      bindingAt: binding.boundAt,
    };
  if (previous && previous.task.bar === bar?.date) return previous;
  const high = Math.max(binding.entryPrice, ...observed.map((b) => b.high));
  const initialLevels = standingProtectionLevels(spec.exitSpec, {
    stop: Math.max(spec.initialStop, oldStop ?? 0),
    target: spec.target,
    high,
  });
  const nextStop = nextStrategyProtection(
    spec.exitSpec,
    { stop: initialLevels.stop, high },
    bar!,
    options.chandelierStop,
  ).stop;
  const priorHigh = Math.max(
    binding.entryPrice,
    ...observed.slice(0, -1).map((b) => b.high),
  );
  const crossing = bar
    ? strategyProtection({ exit: spec.exitSpec }, bar, {
        stop: oldStop,
        target: spec.target,
        high: priorHigh,
      })
    : null;
  const timed = strategyTimeExit(spec.exitSpec, observed.length);
  let dueTime: number | null = null;
  if (bar) {
    if (binding.market === "crypto")
      dueTime = cryptoPeriodEnd(bar.date, period);
    else if (period === "day" || period === "week")
      dueTime = closeScanWindow(bar.date.slice(0, 10), calendar).deadline;
    else {
      const completed = Date.parse(bar.date),
        wall = beijingClock(completed),
        sessions = marketRules["cn-equity"].sessions!;
      if (
        sessions.some(([open, close]) => wall.hhmm >= open && wall.hhmm < close)
      )
        dueTime = completed;
      else {
        const next = sessions.find(([open]) => open > wall.hhmm);
        const nextDate = next
          ? wall.date
          : beijingClock(closeScanWindow(wall.date, calendar).deadline).date;
        dueTime = Date.parse(
          `${nextDate}T${next?.[0] ?? sessions[0]![0]}:00+08:00`,
        );
      }
    }
  }
  const dueAt = dueTime === null ? null : new Date(dueTime).toISOString();
  const dueDate =
    dueTime === null
      ? null
      : new Date(dueTime + (binding.market === "cn-equity" ? 8 * 3600000 : 0))
          .toISOString()
          .slice(0, 10);
  let status: HoldingProtectionTask["status"] = previous ? "adjust" : "set";
  let reason = `${spec.exitSpec.trailing === undefined ? "计划初始止损" : `完成bar最高价${high} × (1-${spec.exitSpec.trailing})，不降低初始止损`}；下一周期设置/调整券商止损单，未认证已挂单`;
  if (spec.exitSpec.chandelier)
    reason = `同版本完成bar Chandelier(${spec.exitSpec.chandelier.period},${spec.exitSpec.chandelier.multiple})=${options.chandelierStop}；取原保护价与新候选较高者${nextStop}，下一周期人工设置/调整券商止损单，未认证已挂单`;
  if (timed) {
    status = "time-exit";
    reason = `已持有${observed.length}根完成bar，下一周期执行${spec.exitSpec.maxBars}根时间退出；须人工操作`;
  }
  if (options.ruleExit === true) {
    status = "rule-exit";
    reason = "策略退出规则已在完成bar触发，下一周期人工退出";
  }
  if (crossing) {
    status = crossing.trigger === "target" ? "target-exit" : "stop-exit";
    reason = `完成bar触及${crossing.trigger}保护，须核对券商成交或处理剩余持仓；不认证已成交`;
  }
  if (spec.matchesStrategy === false)
    reason = `保护已人工覆盖：${spec.overrideReason ?? "见计划覆盖记录"}；${reason}`;
  return {
    task: {
      key: binding.id,
      symbol: binding.symbol,
      market: binding.market,
      account: binding.account,
      kind: binding.kind,
      oldStop,
      newStop: nextStop,
      reason,
      dueDate,
      dueAt,
      sourcePlanId: binding.planId,
      strategyId: binding.strategyId,
      version: binding.version,
      status,
      bar: bar?.date ?? null,
    },
    backupStop: oldStop,
    bars: observed.length,
    high,
    observedAt: now,
    bindingAt: binding.boundAt,
  };
}
