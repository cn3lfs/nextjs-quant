import type { StrategyObjectInput } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import { beijingClock, marketSession } from "~/lib/market/market-session";
import {
  alertKey,
  type AlertEvent,
  type AlertMode,
} from "~/lib/strategy-facts/alerts";
import { AlertRepository } from "../db/alert-repository";

export type AlertPhase = "close" | "intraday" | "crypto";
export type AlertProposal = {
  strategy: StrategyObjectInput;
  event: Pick<
    AlertEvent,
    | "strategyId"
    | "version"
    | "market"
    | "symbol"
    | "bar"
    | "type"
    | "price"
    | "sleeve"
    | "stop"
    | "target"
    | "reason"
    | "source"
    | "planId"
    | "tradingStatusEvidence"
  >;
  completedAt: number;
  windowMs: number;
  closePlan?: "triggered" | "expired";
  authorize?: (now: number) => boolean;
  shadowOnly?: boolean;
};
export type AlertEvaluation = {
  proposals: AlertProposal[];
  states: {
    id: string;
    value: unknown;
    atCommit?: (now: number) => unknown;
    authorize?: (now: number) => boolean;
  }[];
};
export type AlertEngineDependencies = {
  clock: { now(): number };
  repository: AlertRepository;
  mode(): AlertMode;
  leader(): boolean;
  calendar(now: number): Promise<string[]>;
  receipt(date: string, now: number): Promise<boolean>;
  evaluate(phase: AlertPhase, now: number): Promise<AlertEvaluation>;
  deliver(event: AlertEvent): void;
  outcomes(now: number): Promise<void>;
  error(error: unknown): void;
};
/** One clock, no historical replay. A claimed unfinished close scan is marked missed on restart. */
export class AlertEngine {
  private running = false;
  constructor(private readonly deps: AlertEngineDependencies) {}
  async tick() {
    const d = this.deps;
    if (this.running || !d.leader()) return;
    this.running = true;
    const now = d.clock.now();
    try {
      const mode = d.mode();
      if (mode === "off") {
        d.repository.saveState("runtime", { lastCheck: now, mode, phases: [] });
        return;
      }
      this.expirePlans(now);
      const days = await d.calendar(now);
      const wall = beijingClock(now);
      const open = days.includes(wall.date);
      const session = marketSession(now, open ? "open" : "closed");
      const phases: AlertPhase[] = ["crypto"];
      const sessions = marketRules["cn-equity"].sessions;
      // Include the just-completed 11:30 and 15:00 bar, never the lunch interior.
      if (
        open &&
        (["morning", "afternoon"].includes(session.kind) ||
          sessions?.some((s) => s[1] === wall.hhmm))
      )
        phases.push("intraday");
      const closeId = `close:${wall.date}`;
      const prior = d.repository.state<{ status: string }>(closeId);
      if (open && wall.minutes >= 905 && !prior) {
        if (wall.minutes >= 960)
          this.missedClose(wall.date, now, "已错过15:05–16:00窗口；不补跑");
        else if (await d.receipt(wall.date, now)) {
          d.repository.saveState(closeId, { status: "running", at: now });
          phases.push("close");
        }
      } else if (prior?.status === "running")
        this.missedClose(wall.date, now, "上次收盘扫描中断；不补跑");
      for (const phase of phases) {
        const evaluation = await d.evaluate(phase, now);
        const committedAt = d.clock.now();
        d.repository.atomic(() => {
          for (const proposal of evaluation.proposals) {
            if (proposal.authorize && !proposal.authorize(committedAt))
              continue;
            const missed =
              committedAt < proposal.completedAt ||
              committedAt - proposal.completedAt > proposal.windowMs;
            // Re-check mode after data I/O, before committing or enqueueing anything.
            const configured = d.mode();
            if (configured === "off") continue;
            const current = proposal.shadowOnly ? "shadow" : configured;
            const event: AlertEvent = {
              ...proposal.event,
              key: alertKey(proposal.event),
              observedAt: committedAt,
              postClose: phase === "close",
              mode: current,
              status: missed ? "missed" : current,
              wouldSend: !missed,
              outcomes: [],
              reason: missed
                ? `${proposal.event.reason}；错过窗口，仅记录，不补发`
                : proposal.event.reason,
            };
            d.repository.record(proposal.strategy, event, (committed) => {
              if (proposal.closePlan && event.planId)
                d.repository.closePlan(event.planId, proposal.closePlan);
              if (!proposal.shadowOnly) d.deliver(committed);
            });
          }
          for (const state of evaluation.states)
            if (!state.authorize || state.authorize(committedAt))
              d.repository.saveState(
                state.id,
                state.atCommit ? state.atCommit(committedAt) : state.value,
              );
          if (phase === "close")
            d.repository.saveState(closeId, { status: "complete", at: now });
          d.repository.saveState("runtime", {
            lastCheck: now,
            mode: d.mode(),
            phases,
            lastPhase: phase,
          });
        });
      }
      await d.outcomes(now);
    } catch (error) {
      d.repository.saveState("runtime", {
        lastCheck: now,
        mode: d.mode(),
        error: "提醒引擎运行失败，检查任务中心诊断",
      });
      d.error(error);
    } finally {
      this.running = false;
    }
  }
  private expirePlans(now: number) {
    const d = this.deps;
    for (const plan of d.repository.plans(true)) {
      if (!plan.expiresAt || Date.parse(plan.expiresAt) > now) continue;
      const original = d.repository.strategies.strategy(
        plan.strategyId,
        plan.strategyVersion,
      );
      if (!original) continue;
      const strategy: StrategyObjectInput = {
        ...original,
        id: `expiry-${plan.id}`,
        version: 1,
        entry: { kind: "constant", value: false },
        exit: {},
      };
      const missed = now - Date.parse(plan.expiresAt) > 5 * 60000;
      const event: AlertEvent = {
        key: "",
        strategyId: strategy.id,
        version: 1,
        market: original.market,
        symbol: plan.symbol,
        bar: plan.expiresAt,
        type: "plan-expired",
        price: null,
        sleeve: plan.sleeve,
        stop: plan.stop,
        target: plan.target,
        observedAt: now,
        mode: d.mode(),
        status: missed ? "missed" : d.mode() === "live" ? "live" : "shadow",
        reason: `计划${plan.id}已到期${missed ? "；错过窗口不补发" : ""}`,
        source: "用户交易计划",
        planId: plan.id,
        wouldSend: !missed,
        outcomes: [],
      };
      event.key = alertKey(event);
      d.repository.record(strategy, event, () => {
        d.repository.closePlan(plan.id, "expired");
        d.deliver(event);
      });
    }
  }
  private missedClose(date: string, now: number, reason: string) {
    const d = this.deps;
    const strategy: StrategyObjectInput = {
      id: "system-close-window",
      version: 1,
      market: "cn-equity",
      period: "day",
      universe: { kind: "symbols", symbols: ["sh000001"] },
      entry: { kind: "constant", value: false },
      exit: {},
      sizing: { kind: "weight", weight: 1 },
      sleeve: "swing",
    };
    const event: AlertEvent = {
      key: "",
      strategyId: strategy.id,
      version: 1,
      market: "cn-equity",
      symbol: "sh000001",
      bar: date,
      type: "missed",
      price: null,
      sleeve: "swing",
      stop: null,
      target: null,
      observedAt: now,
      mode: d.mode(),
      status: "missed",
      wouldSend: false,
      outcomes: [],
      reason,
      source: "调度窗口",
    };
    event.key = alertKey(event);
    d.repository.atomic(() => {
      d.repository.record(strategy, event);
      d.repository.saveState(`close:${date}`, { status: "missed", at: now });
    });
  }
}
