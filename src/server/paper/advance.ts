import { isDeepStrictEqual } from "node:util";
import {
  maBaselineBuildHash,
  type PortfolioRequest,
  type PortfolioExecution,
} from "quant-backtest";
import {
  strategyBuildHash,
  usesStrategyBook,
  type StrategyExternalInputs,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { checkBarBudget } from "../market/bar-store/resource-budget";
import { PaperRepository } from "../db/paper-repository";
import { runPaperPortfolio } from "../strategies/drivers/paper";
import { capturePaperDecisions } from "./decisions";
import type { PaperState } from "./model";
import { summarizePaper } from "./assessment";
import { beijingClock } from "~/lib/market/market-session";
import { paperCompletedAt } from "./advance-clock";
import { ForwardReferenceRepository } from "../db/forward-reference-repository";
import { AlertRepository } from "../db/alert-repository";
import { forwardExecutionBuildHash } from "../research/forward-identity";

export type PaperInput = {
  /** Provider has computed full-history rules and bounded only pre-start OHLC. */
  contextVersion?: "cn-book-1";
  sourceIdentity?: Readonly<Record<string, unknown>>;
  request: PortfolioRequest;
  benchmark: Bar[];
  source: string;
  readyDates: string[];
  decisions?: PaperState["decisions"];
};
const maxFrozenDecisions = 2_000_000;
const build = () => `${strategyBuildHash}:${maBaselineBuildHash}`;
type Checkpoint = PaperState & { build?: string };

/** Bound ONLY indicator warmup. Every real forward input remains replayable
 * and still counts against the existing ledger/serialization limits. */
export function boundedPaperRequest(
  q: PortfolioRequest,
  firstForward: string,
): PortfolioRequest {
  const dates = [firstForward, ...(q.bookSeeds ?? []).map((seed) => seed.date)];
  const floors = dates.map(
    (date) => q.calendar.filter((day) => day <= date).slice(-61)[0] ?? date,
  );
  const floor = floors.sort()[0]!;
  const dated = <T extends { date: string }>(rows: readonly T[] | undefined) =>
    rows?.filter((row) => row.date >= floor);
  const external = (
    value: StrategyExternalInputs | undefined,
  ): StrategyExternalInputs | undefined =>
    value
      ? {
          ...value,
          preparedRules: value.preparedRules?.map((rule) => ({
            ...rule,
            points: dated(rule.points)!,
          })),
          signals: dated(value.signals),
          levels: dated(value.levels),
          rps: dated(value.rps),
          lowZone: dated(value.lowZone),
          chan: dated(value.chan),
        }
      : undefined;
  return {
    ...q,
    calendar: q.calendar.filter((day) => day >= floor),
    instruments: q.instruments.map((instrument) => ({
      ...instrument,
      bars: dated(instrument.bars)!,
      signalBars: dated(instrument.signalBars)!,
      external: external(instrument.external),
      actions: instrument.actions?.filter(
        (action) => action.date >= firstForward,
      ),
      execution:
        typeof instrument.execution === "function" ||
        "evidence" in instrument.execution
          ? instrument.execution
          : Object.fromEntries(
              Object.entries(instrument.execution).filter(
                ([date]) => date >= firstForward,
              ),
            ),
    })),
    bookFacts: q.bookFacts
      ? Object.fromEntries(
          Object.entries(q.bookFacts).map(([id, facts]) => [
            id,
            {
              ...facts,
              benchmark: facts.benchmark
                ? { ...facts.benchmark, bars: dated(facts.benchmark.bars)! }
                : undefined,
              classicRiskSeries: facts.classicRiskSeries?.map((series) => ({
                ...series,
                bars: dated(series.bars)!,
              })),
              classicWeeks: dated(facts.classicWeeks),
              marketLowZone: dated(facts.marketLowZone),
            },
          ]),
        )
      : undefined,
    memberships: dated(q.memberships),
    positionWeights: dated(q.positionWeights),
  };
}

function freezeDatedRows<T extends { date: string }>(
  old: readonly T[] | undefined,
  incoming: readonly T[] | undefined,
  cutoff: string,
  priorCutoff: string | null,
  key: (row: T) => string = (row) => row.date,
): T[] {
  const rows = new Map((old ?? []).map((row) => [key(row), row]));
  if (rows.size !== (old?.length ?? 0))
    throw new Error("纸面冻结来源含重复身份");
  const seen = new Set<string>();
  for (const row of incoming ?? []) {
    if (row.date > cutoff) continue;
    const id = key(row),
      prior = rows.get(id);
    if (seen.has(id)) throw new Error("纸面输入来源含重复身份");
    seen.add(id);
    if (prior && !isDeepStrictEqual(prior, row))
      throw new Error("纸面已冻结预热或决策来源变化，拒绝重写历史输入");
    if (!prior && priorCutoff && row.date <= priorCutoff)
      throw new Error("纸面已冻结历史出现新增来源点，需显式复核");
    if (!prior) rows.set(id, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || key(a).localeCompare(key(b)),
  );
}

/** New book/chandelier requests retain causal indicator and covariance history.
 * Old requests keep their original external-decision replay byte shape. */
function freezeNativePaperContext(
  q: PortfolioRequest,
  previous: Checkpoint | null,
  cutoff: string,
  priorCutoff: string | null,
) {
  if (
    q.calendar.some(
      (date, i) =>
        !Number.isFinite(Date.parse(date)) ||
        (i > 0 && Date.parse(date) <= Date.parse(q.calendar[i - 1]!)),
    )
  )
    throw new Error("纸面原生日历重复或无序");
  if (
    previous &&
    (!isDeepStrictEqual(q.costs, previous.request.costs) ||
      !isDeepStrictEqual(q.sleeves, previous.request.sleeves) ||
      !isDeepStrictEqual(q.strategies, previous.request.strategies))
  )
    throw new Error("纸面冻结执行政策已变化，不能自动替换资金、费用或策略");
  const instruments = q.instruments.map((instrument) => {
    if (typeof instrument.execution === "function")
      throw new Error("纸面输入必须可序列化");
    const old = previous?.request.instruments.find(
      (row) => row.symbol === instrument.symbol,
    );
    const bars = freezeDatedRows(
      old?.bars,
      instrument.bars,
      cutoff,
      priorCutoff,
    );
    const signalBars = freezeDatedRows(
      old?.signalBars,
      instrument.signalBars,
      cutoff,
      priorCutoff,
    );
    if (
      bars.length !== signalBars.length ||
      bars.some((bar, i) => bar.date !== signalBars[i]!.date)
    )
      throw new Error("纸面原价与信号价预热轴不一致");
    const incoming = instrument.external ?? {},
      prior = old?.external ?? {};
    if (
      prior.preparedRules?.some(
        (rule) =>
          !incoming.preparedRules?.some(
            (row) => row.strategy.id === rule.strategy.id,
          ),
      )
    )
      throw new Error("纸面完整规则来源缺失，不能丢弃历史首见观察");
    const external: StrategyExternalInputs = {
      ...prior,
      ...incoming,
      ...(prior.preparedRules || incoming.preparedRules
        ? {
            preparedRules: (incoming.preparedRules ?? []).map((rule) => {
              const before = prior.preparedRules?.find(
                (row) => row.strategy.id === rule.strategy.id,
              );
              if (
                before &&
                !isDeepStrictEqual(
                  { ...before, points: [] },
                  { ...rule, points: [] },
                )
              )
                throw new Error("纸面完整规则来源、版本或价格基准变化");
              return {
                ...rule,
                points: freezeDatedRows(
                  before?.points,
                  rule.points,
                  cutoff,
                  priorCutoff,
                ),
              };
            }),
          }
        : {}),
      ...(prior.signals || incoming.signals
        ? {
            signals: freezeDatedRows(
              prior.signals,
              incoming.signals,
              cutoff,
              priorCutoff,
              (row) => `${row.id}:${row.date}`,
            ),
          }
        : {}),
      ...(prior.levels || incoming.levels
        ? {
            levels: freezeDatedRows(
              prior.levels,
              incoming.levels,
              cutoff,
              priorCutoff,
              (row) => `${row.field}:${row.date}`,
            ),
          }
        : {}),
      ...(prior.rps || incoming.rps
        ? { rps: freezeDatedRows(prior.rps, incoming.rps, cutoff, priorCutoff) }
        : {}),
      ...(prior.lowZone || incoming.lowZone
        ? {
            lowZone: freezeDatedRows(
              prior.lowZone,
              incoming.lowZone,
              cutoff,
              priorCutoff,
            ),
          }
        : {}),
      ...(prior.chan || incoming.chan
        ? {
            chan: freezeDatedRows(
              prior.chan,
              incoming.chan,
              cutoff,
              priorCutoff,
            ),
          }
        : {}),
    };
    // A common quote is immutable policy. Date-specific quotes are first-seen facts.
    let quotes: typeof instrument.execution;
    if ("evidence" in instrument.execution) {
      if (old && !isDeepStrictEqual(old.execution, instrument.execution))
        throw new Error("纸面冻结执行报价政策已变化");
      quotes = instrument.execution;
    } else {
      if (
        old &&
        (typeof old.execution === "function" || "evidence" in old.execution)
      )
        throw new Error("纸面执行依据从公共报价改为逐日记录，需显式复核");
      const execution: Record<string, PortfolioExecution> = {
        ...(old?.execution as
          Readonly<Record<string, PortfolioExecution>> | undefined),
      };
      for (const [date, value] of Object.entries(instrument.execution)) {
        if (date > cutoff) continue;
        const existing = (execution as Record<string, unknown>)[date];
        if (existing && !isDeepStrictEqual(existing, value))
          throw new Error("纸面已冻结执行依据变化");
        Object.assign(execution, { [date]: value });
      }
      quotes = execution;
    }
    return {
      ...instrument,
      bars,
      signalBars,
      external,
      execution: quotes,
      actions: freezeDatedRows(
        old?.actions,
        instrument.actions,
        cutoff,
        priorCutoff,
      ),
    };
  });
  const oldFacts = previous?.request.bookFacts ?? {},
    facts: Record<string, NonNullable<PortfolioRequest["bookFacts"]>[string]> =
      {};
  for (const strategy of q.strategies) {
    const incoming = q.bookFacts?.[strategy.id],
      prior = oldFacts[strategy.id];
    if (usesStrategyBook(strategy) && !incoming)
      throw new Error("纸面组合缺少完整冻结bookFacts上下文");
    if (!incoming) continue;
    if (
      prior &&
      (prior.roundTripCost !== incoming.roundTripCost ||
        prior.benchmark?.symbol !== incoming.benchmark?.symbol)
    )
      throw new Error("纸面组合成本或基准身份变化");
    const riskSeries = new Map(
      prior?.classicRiskSeries?.map((series) => [series.symbol, series]),
    );
    for (const series of incoming.classicRiskSeries ?? [])
      riskSeries.set(series.symbol, {
        symbol: series.symbol,
        bars: freezeDatedRows(
          riskSeries.get(series.symbol)?.bars,
          series.bars,
          cutoff,
          priorCutoff,
        ),
      });
    facts[strategy.id] = {
      ...prior,
      ...incoming,
      ...(incoming.benchmark
        ? {
            benchmark: {
              symbol: incoming.benchmark.symbol,
              bars: freezeDatedRows(
                prior?.benchmark?.bars,
                incoming.benchmark.bars,
                cutoff,
                priorCutoff,
              ),
            },
          }
        : {}),
      ...(prior?.classicWeeks || incoming.classicWeeks
        ? {
            classicWeeks: freezeDatedRows(
              prior?.classicWeeks,
              incoming.classicWeeks,
              cutoff,
              priorCutoff,
            ),
          }
        : {}),
      ...(prior?.classicRiskSeries || incoming.classicRiskSeries
        ? {
            classicRiskSeries: [...riskSeries.values()].sort((a, b) =>
              a.symbol.localeCompare(b.symbol),
            ),
          }
        : {}),
      ...(prior?.industries || incoming.industries
        ? {
            industries: freezeDatedRows(
              prior?.industries,
              incoming.industries,
              cutoff,
              priorCutoff,
              (row) => `${row.symbol}:${row.date}:${row.availableAt}`,
            ),
          }
        : {}),
      ...(prior?.marketLowZone || incoming.marketLowZone
        ? {
            marketLowZone: freezeDatedRows(
              prior?.marketLowZone,
              incoming.marketLowZone,
              cutoff,
              priorCutoff,
              (row) => `${row.index}:${row.role}:${row.date}`,
            ),
          }
        : {}),
    };
  }
  const oldCalendar = previous?.request.calendar ?? [];
  for (const date of q.calendar)
    if (priorCutoff && date <= priorCutoff && !oldCalendar.includes(date))
      throw new Error("纸面已冻结预热日历出现新增日期");
  const calendar = [...new Set([...oldCalendar, ...q.calendar])].sort();
  if (previous && !isDeepStrictEqual(previous.request.bookSeeds, q.bookSeeds))
    throw new Error("纸面预热周信号种子已变化");
  return {
    instruments,
    calendar,
    bookFacts: facts,
    memberships: freezeDatedRows(
      previous?.request.memberships,
      q.memberships,
      cutoff,
      priorCutoff,
      (row) => `${row.strategyId}:${row.date}`,
    ),
    positionWeights:
      q.positionWeights === undefined &&
      previous?.request.positionWeights === undefined
        ? undefined
        : freezeDatedRows(
            previous?.request.positionWeights,
            q.positionWeights,
            cutoff,
            priorCutoff,
            (row) => `${row.strategyId}:${row.symbol}:${row.date}`,
          ),
  };
}

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
  // Build changes are recorded in the checkpoint; the historical fill/equity
  // prefix check below is the real guard against rewriting past accounting.
  let q = input.request;
  const native = account.candidates.some(
    ({ strategy }) =>
      usesStrategyBook(strategy) ||
      !!strategy.exit.chandelier ||
      !!strategy.exit.timeReentry,
  );
  if (
    q.market !== account.market ||
    q.initial !== account.initial ||
    q.strategies.length !== account.candidates.length ||
    q.strategies.some(
      (s) => !account.candidates.some((c) => isDeepStrictEqual(c.strategy, s)),
    )
  )
    throw new Error("纸面账户参数与冻结候选不一致");
  if (native)
    for (const candidate of account.candidates) {
      const policy = candidate.executionPolicy;
      if (candidate.strategy.id.startsWith("l3-") && !policy)
        throw new Error("L3纸面候选缺少冻结执行政策");
      if (
        policy &&
        !isDeepStrictEqual(policy, {
          initial: q.initial,
          sleeves: q.sleeves,
          costs: q.costs,
        })
      )
        throw new Error("纸面请求与同版本冻结executionPolicy不一致");
    }
  const fresh = q.calendar.filter(
    (d) =>
      d > (account.lastBar ?? "") &&
      (native
        ? paperCompletedAt(account, d) > account.startedAt
        : paperCompletedAt(account, d) >= account.startedAt) &&
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
      (native
        ? paperCompletedAt(account, d) > account.startedAt
        : paperCompletedAt(account, d) >= account.startedAt) &&
      paperCompletedAt(account, d) <= now,
  );
  const blocked = pending.find((d) => !fresh.includes(d));
  const dates = blocked ? fresh.filter((d) => d < blocked) : fresh;
  if (!dates.length) return { advanced: 0, fills: 0 };
  const cutoff = dates.at(-1)!;
  if (input.contextVersion === "cn-book-1") {
    if (
      account.market !== "cn-equity" ||
      !native ||
      !input.sourceIdentity ||
      q.instruments.some((instrument) =>
        q.strategies.some(
          (strategy) =>
            !instrument.external?.preparedRules?.some(
              (rule) => rule.strategy.id === strategy.id,
            ),
        ),
      )
    )
      throw new Error("有界纸面预热缺少真实完整规则点或来源证明");
    if (previous && previous.contextVersion !== input.contextVersion)
      throw new Error("纸面预热保存协议变化，需显式评审");
    q = boundedPaperRequest(q, previous?.request.start ?? dates[0]!);
  } else if (previous?.contextVersion) {
    throw new Error("纸面有界预热来源缺失，拒绝回退另一协议");
  }
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
  const context = native
    ? freezeNativePaperContext(q, previous, cutoff, account.lastBar)
    : null;
  const strategies = native
    ? q.strategies
    : account.candidates.map(({ strategy: s }) => ({
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
  const instruments = context
    ? context.instruments
    : q.instruments.map((instrument) => {
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
  if (native)
    for (const instrument of instruments) {
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
      for (const date of dates.filter((day) =>
        instrument.bars.some((bar) => bar.date === day),
      ))
        for (const strategy of q.strategies)
          if (
            captured.filter(
              (decision) =>
                decision.date === date && decision.strategyId === strategy.id,
            ).length !== 1
          )
            throw new Error("纸面完成bar缺少唯一首见原始规则决定");
      decisions.push(...captured);
    }
  if (
    previous &&
    previous.request.instruments.some(
      (i) => !instruments.some((n) => n.symbol === i.symbol),
    )
  )
    throw new Error("纸面证券池缺失；拒绝丢弃历史持仓");
  const calendar = context?.calendar ?? [
    ...(previous?.request.calendar ?? []),
    ...dates,
  ];
  checkBarBudget(
    calendar.length * instruments.length,
    {
      symbol: "纸面冻结证券池",
      period: account.candidates[0]!.strategy.period,
    },
    "limit",
  );
  if (decisions.length > maxFrozenDecisions)
    throw new Error(
      `纸面冻结决策记录 ${decisions.length} 条，超过上限 ${maxFrozenDecisions} 条；原事实保留`,
    );
  const request: PortfolioRequest = {
    ...q,
    ...(context
      ? {
          bookFacts: context.bookFacts,
          memberships: context.memberships,
          positionWeights: context.positionWeights,
        }
      : {}),
    strategies,
    instruments,
    calendar,
    start: native
      ? (previous?.request.start ?? dates[0]!)
      : calendar[0]!.slice(0, 10),
    end: native ? cutoff : cutoff.slice(0, 10),
    observationDetail: input.contextVersion === "cn-book-1" ? "counts" : "full",
    ...(!native && q.positionWeights !== undefined
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
    ...(input.contextVersion
      ? {
          contextVersion: input.contextVersion,
          sourceIdentity: input.sourceIdentity,
        }
      : {}),
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
  if (!state) return;
  let buildHash: string | null = null;
  try {
    buildHash = forwardExecutionBuildHash();
  } catch {
    /* Missing runtime identity cannot certify forward observations. */
  }
  const candidate = account.candidates[0]!;
  const summary = summarizePaper(account, state, now, {
    reference: new ForwardReferenceRepository(repo.db).paper(
      account.id,
      candidate.strategy,
      account.startedAt,
    ),
    buildHash,
    calendar: new AlertRepository(repo.db).records.days(),
  });
  repo.atomic(() => {
    const current = repo.account(id)!;
    if (current.revision === account.revision)
      repo.save({ ...current, summary }, current.revision);
  });
}
