import { isDeepStrictEqual } from "node:util";
import { maBaselineBuildHash, type PortfolioRequest } from "quant-backtest";
import { strategyBuildHash } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { PaperRepository } from "../db/paper-repository";
import { runPaperPortfolio } from "../strategies/drivers/paper";
import { capturePaperDecisions } from "./decisions";
import type { PaperState } from "./model";
import { summarizePaper } from "./assessment";
import { beijingClock } from "~/lib/market/market-session";
import { paperCompletedAt } from "./advance-clock";

export type PaperInput = {
  request: PortfolioRequest;
  benchmark: Bar[];
  source: string;
  readyDates: string[];
  decisions?: PaperState["decisions"];
};
const build = () => `${strategyBuildHash}:${maBaselineBuildHash}`;
type Checkpoint = PaperState & { build?: string };

/** Recompute from frozen first-observed decisions, then atomically publish only
 * if the earlier financial prefix is identical. Catch-up never calls delivery. */
export function advancePaper(
  repo: PaperRepository,
  id: string,
  input: PaperInput,
  now: number,
) {
  const account = repo.account(id);
  if (!account) throw new Error("纸面账户不存在");
  const previous = repo.state(id) as Checkpoint | null;
  if (previous?.build && previous.build !== build())
    throw new Error("纸面执行版本已变化；需显式评审，不重写历史成交");
  const q = input.request;
  if (
    q.market !== account.market ||
    q.initial !== account.initial ||
    q.strategies.length !== account.candidates.length ||
    q.strategies.some(
      (s) => !account.candidates.some((c) => isDeepStrictEqual(c.strategy, s)),
    )
  )
    throw new Error("纸面账户参数与冻结候选不一致");
  const fresh = q.calendar.filter(
    (d) =>
      d > (account.lastBar ?? "") &&
      paperCompletedAt(account, d) >= account.startedAt &&
      paperCompletedAt(account, d) <= now &&
      (account.market === "crypto" ||
        (input.benchmark.some((b) => b.date === d) &&
          (d < beijingClock(now).date || input.readyDates.includes(d)))),
  );
  if (!fresh.length) return { advanced: 0, fills: 0 };
  if (fresh.some((d, i) => i > 0 && d <= fresh[i - 1]!))
    throw new Error("纸面bar时间顺序无效");
  // Do not jump across a missing source bar or an unreceipted current market day.
  const pending = q.calendar.filter(
    (d) =>
      d > (account.lastBar ?? "") &&
      paperCompletedAt(account, d) >= account.startedAt &&
      paperCompletedAt(account, d) <= now,
  );
  const blocked = pending.find((d) => !fresh.includes(d));
  const dates = blocked ? fresh.filter((d) => d < blocked) : fresh;
  if (!dates.length) return { advanced: 0, fills: 0 };
  const cutoff = dates.at(-1)!;
  if (account.market === "crypto") {
    const minutes: Record<string, number> = {
      day: 1440,
      week: 10080,
      "4h": 240,
      "1h": 60,
      "60m": 60,
      "30m": 30,
      "15m": 15,
      "5m": 5,
    };
    const step = minutes[account.candidates[0]!.strategy.period]! * 60000;
    const expected = account.lastBar
      ? paperCompletedAt(account, account.lastBar) + step
      : (Math.floor(account.startedAt / step) + 1) * step;
    if (
      !step ||
      paperCompletedAt(account, dates[0]!) !== expected ||
      dates.some(
        (d, i) =>
          i > 0 &&
          paperCompletedAt(account, d) -
            paperCompletedAt(account, dates[i - 1]!) !==
            step,
      )
    )
      throw new Error("数字货币已完成bar存在缺口；等待原始行情补齐后顺序推进");
  }
  const dateSet = new Set(dates);
  const decisions: PaperState["decisions"] = [...(previous?.decisions ?? [])];
  const strategies = account.candidates.map(({ strategy: s }) => ({
    ...s,
    entry: { kind: "external" as const, id: s.id, side: "entry" as const },
    exit: {
      ...s.exit,
      rule: { kind: "external" as const, id: s.id, side: "exit" as const },
      ...(s.exit.stop?.kind === "atr" || s.exit.stop?.kind === "structure"
        ? { stop: { kind: "structure" as const, field: s.id } }
        : {}),
    },
  }));
  const instruments = q.instruments.map((instrument) => {
    if (typeof instrument.execution === "function")
      throw new Error("纸面输入必须可序列化");
    const old = previous?.request.instruments.find(
      (i) => i.symbol === instrument.symbol,
    );
    const bars = [
      ...(old?.bars ?? []),
      ...instrument.bars.filter((b) => dateSet.has(b.date)),
    ];
    const execution = { ...(old?.execution ?? {}) };
    const signals = [...(old?.external?.signals ?? [])];
    const levels = [...(old?.external?.levels ?? [])];
    const captured =
      input.decisions?.filter(
        (d) => d.symbol === instrument.symbol && dateSet.has(d.date),
      ) ??
      capturePaperDecisions(
        q.strategies,
        instrument,
        dates,
        now,
        input.source,
        q.memberships,
      );
    for (const date of dates) {
      const raw = instrument.bars.find((b) => b.date === date);
      const quote =
        "evidence" in instrument.execution
          ? instrument.execution
          : instrument.execution[date];
      if (quote) Object.assign(execution, { [date]: quote });
      if (!raw) continue;
      for (const { strategy } of account.candidates) {
        const decision = captured.find(
          (d) => d.strategyId === strategy.id && d.date === date,
        );
        if (!decision) throw new Error("纸面完成bar缺少冻结决策");
        signals.push({
          id: strategy.id,
          date,
          availableAt: date,
          entry: decision.entry === true,
          exit: decision.exit === true,
        });
        if (decision.stop !== null && decision.stop > 0)
          levels.push({
            field: strategy.id,
            date,
            availableAt: date,
            value: decision.stop,
          });
        decisions.push(decision);
      }
    }
    return {
      ...instrument,
      bars,
      signalBars: bars,
      external: { signals, levels },
      execution,
      actions: [
        ...(old?.actions ?? []),
        ...(instrument.actions ?? []).filter((a) => dateSet.has(a.date)),
      ],
    };
  });
  if (
    previous &&
    previous.request.instruments.some(
      (i) => !instruments.some((n) => n.symbol === i.symbol),
    )
  )
    throw new Error("纸面证券池缺失；拒绝丢弃历史持仓");
  const calendar = [...(previous?.request.calendar ?? []), ...dates];
  if (
    calendar.length * instruments.length > 2000000 ||
    decisions.length > 2000000
  )
    throw new Error("纸面冻结输入超过200万bar预算；原事实保留");
  const request: PortfolioRequest = {
    ...q,
    strategies,
    instruments,
    calendar,
    start: calendar[0]!.slice(0, 10),
    end: cutoff.slice(0, 10),
    observationDetail: "full",
    ...(q.positionWeights !== undefined
      ? {
          positionWeights: [
            ...(previous?.request.positionWeights ?? []),
            ...q.positionWeights.filter((w) => dateSet.has(w.date)),
          ],
        }
      : {}),
  };
  const result = runPaperPortfolio(request);
  if (
    previous &&
    (!isDeepStrictEqual(
      result.fills.slice(0, previous.result.fills.length),
      previous.result.fills,
    ) ||
      !isDeepStrictEqual(
        result.curve.slice(0, previous.result.curve.length),
        previous.result.curve,
      ))
  )
    throw new Error("纸面历史成交或权益前缀变化，拒绝覆盖");
  const benchmark = [
    ...(previous?.benchmark ?? []),
    ...input.benchmark.filter((b) => dateSet.has(b.date)),
  ];
  const next: Checkpoint = {
    request,
    result,
    benchmark,
    decisions,
    build: build(),
  };
  const newFills = result.fills.slice(previous?.result.fills.length ?? 0);
  repo.atomic(() => {
    repo.save(
      { ...account, lastBar: cutoff, lastRun: now, error: null, summary: null },
      account.revision,
    );
    repo.saveState(id, next);
    for (const order of result.orders)
      repo.fact(id, "order", {
        id: String(order.id),
        date: order.signalAt,
        value: order,
      });
    for (const [index, fill] of result.fills.entries())
      repo.fact(
        id,
        "fill",
        {
          id: String(index),
          date: fill.date,
          value: {
            ...fill,
            trigger: result.orders.find((o) => o.id === fill.orderId)!.trigger,
          },
        },
        true,
      );
    for (const [index, rejection] of result.rejections.entries())
      repo.fact(
        id,
        "rejection",
        { id: String(index), date: rejection.date, value: rejection },
        true,
      );
    repo.clearPositions(id);
    for (const position of result.positions)
      repo.fact(id, "position", {
        id: position.key,
        date: cutoff,
        value: position,
      });
    for (const row of result.equity)
      repo.fact(id, "equity", { id: row.date, date: row.date, value: row });
    for (const [index, action] of result.corporateActions.entries())
      repo.fact(
        id,
        "action",
        { id: String(index), date: action.date, value: action },
        true,
      );
    repo.fact(
      id,
      "advance",
      {
        id: cutoff,
        date: cutoff,
        value: {
          from: dates[0],
          to: cutoff,
          bars: dates.length,
          at: now,
          previousRun: account.lastRun,
          catchUp: dates.length > 1,
          source: input.source,
          notifications: 0,
        },
      },
      true,
    );
  });
  // Metrics are outside the accounting transaction; a reporting failure cannot
  // roll back or rewrite executions. A later tick can retry the projection.
  refreshPaperSummary(repo, id, now);
  return { advanced: dates.length, fills: newFills.length };
}
export function refreshPaperSummary(
  repo: PaperRepository,
  id: string,
  now: number,
) {
  const account = repo.account(id)!;
  const state = repo.state(id);
  if (!state || account.summary) return;
  const summary = summarizePaper(account, state, now);
  repo.atomic(() => {
    const current = repo.account(id)!;
    if (current.revision === account.revision)
      repo.save({ ...current, summary }, current.revision);
  });
}
