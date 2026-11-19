import { forwardDefinitionHash } from "../../db/forward-reference-repository";
import { createHash } from "node:crypto";
import { strategyObjectSchema } from "trading-strategies";
import { type Bar } from "~/lib/domain";
import {
  decayFlag,
  type AccountTrade,
} from "~/lib/portfolio/account-workspace";
import { type AccountBook } from "./load-book";
import { calendarDays, paperDailyBars } from "./daily-bars";

const strategyHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(strategyObjectSchema.parse(value)))
    .digest("hex");
/** Comparable entry cohort: entry price -> 20th market-day close, gross/raw.
 * This deliberately measures selection, not strategy/account realized P&L. */
export function entryCohortReturn(
  symbol: string,
  date: string,
  price: number,
  bars: Record<string, readonly Bar[]>,
  calendar: readonly string[],
  events: readonly { date: string; category: number }[],
  coverage: string | null,
  market: "cn-equity" | "crypto",
) {
  const day = date.slice(0, 10),
    index = calendar.indexOf(day),
    target = calendar[index + 19];
  if (index < 0 || !target || !(price > 0)) return null;
  if (
    market === "cn-equity" &&
    (!coverage ||
      coverage < target ||
      events.some(
        (e) =>
          e.date > day && e.date <= target && [1, 11, 12].includes(e.category),
      ))
  )
    return null;
  const candidates = (bars[symbol] ?? []).filter(
    (b) => b.date.slice(0, 10) === target,
  );
  return candidates.length === 1 && candidates[0]!.close > 0
    ? candidates[0]!.close / price - 1
    : null;
}

export function accountAttribution(
  book: AccountBook,
  strategyId?: string,
  version?: number,
) {
  const defs = book.facts.definitions.filter(
    (s) =>
      (!strategyId || s.id === strategyId) &&
      (version === undefined || s.version === version),
  );
  const cohorts = defs.map((s) => {
    const unavailable = book.facts.expectationStatuses.find(
      (e) =>
        e.definitionHash === forwardDefinitionHash(s) &&
        e.status === "unavailable",
    );
    const expected = unavailable
      ? undefined
      : book.facts.expectations.find(
          (e) =>
            e.strategyId === s.id &&
            e.version === s.version &&
            e.strategyHash === strategyHash(s),
        );
    const alerts = book.facts.events
      .filter(
        (e) =>
          e.strategyId === s.id &&
          e.version === s.version &&
          e.type === "entry",
      )
      .flatMap((e) =>
        e.outcomes
          .filter((o) => o.horizon === 20 && o.settled && o.returnPct !== null)
          .map((o) => o.returnPct! / 100),
      );
    const samples = (kind: AccountTrade["kind"]) =>
      book.trades
        .filter(
          (t) =>
            t.kind === kind &&
            t.side === "buy" &&
            t.strategyId === s.id &&
            t.strategyVersion === s.version,
        )
        .flatMap((t) => {
          if (
            t.id.startsWith("delivery:") &&
            book.facts.fills.find((f) => `delivery:${f.id}` === t.id)
              ?.instrument === "convertible"
          )
            return [];
          let bars = book.bars,
            calendar = book.calendar,
            coverage = book.context.evidence(t.symbol).coverageEnd,
            actions = book.context.evidence(t.symbol).events;
          if (kind === "paper") {
            const paper = book.facts.paper.find(
              (p) => p.account.id === t.account,
            );
            bars = paperDailyBars(book, t.account);
            calendar = [
              ...new Set(
                paper?.state?.request.calendar.map((d) => d.slice(0, 10)) ?? [],
              ),
            ];
            // Crypto has no equity corporate actions. A-share proof remains required.
          }
          if (t.market === "crypto")
            calendar = calendarDays((bars[t.symbol] ?? []).map((b) => b.date));
          const value = entryCohortReturn(
            t.symbol,
            t.date,
            t.price,
            bars,
            calendar,
            actions,
            coverage,
            t.market,
          );
          return value === null ? [] : [value];
        });
    const paper = samples("paper"),
      actual = samples("real"),
      simulation = samples("exchange-simulation"),
      values = expected?.samples ?? [];
    return {
      observations: { alerts, paper, actual, simulation },
      strategyId: s.id,
      version: s.version,
      sleeve: s.sleeve,
      market: s.market,
      expected: expected ?? null,
      expectationReason: expected
        ? null
        : (unavailable?.reason ?? "缺少已选择验证来源的同参数二十日冻结分布"),
      alerts: decayFlag(values, alerts, book.config.accountReview),
      paper: decayFlag(values, paper, book.config.accountReview),
      actual: decayFlag(values, actual, book.config.accountReview),
      simulation: decayFlag(values, simulation, book.config.accountReview),
      flagged: [alerts, paper, actual].some(
        (v) => decayFlag(values, v, book.config.accountReview).flagged,
      ),
      basis:
        "入场后第20个市场日收盘/入场价−1；原价无费用，选择归因，非策略净业绩。提醒T+1开盘；实际/纸面用实际入场价。",
    };
  });
  const rows = cohorts.map(({ observations: _observations, ...row }) => row);
  if (strategyId) return rows;
  for (const key of [
    ...new Set(cohorts.map((r) => `${r.market}:${r.sleeve}`)),
  ]) {
    const members = cohorts.filter((r) => `${r.market}:${r.sleeve}` === key),
      first = members[0]!;
    const complete = members.every((r) => r.expected !== null);
    const values = complete ? members.flatMap((r) => r.expected!.samples) : [];
    const observations = {
      alerts: members.flatMap((r) => r.observations.alerts),
      paper: members.flatMap((r) => r.observations.paper),
      actual: members.flatMap((r) => r.observations.actual),
      simulation: members.flatMap((r) => r.observations.simulation),
    };
    rows.push({
      ...first,
      strategyId: `分仓合计 ${first.sleeve}`,
      version: 0,
      expectationReason: complete ? null : "部分分仓成员缺少可核验冻结分布",
      expected: complete
        ? {
            ...first.expected!,
            samples: values,
            source: `同分仓${members.length}个策略版本的同期限入场样本`,
            excluded: members.reduce((n, r) => n + r.expected!.excluded, 0),
          }
        : null,
      alerts: decayFlag(values, observations.alerts, book.config.accountReview),
      paper: decayFlag(values, observations.paper, book.config.accountReview),
      actual: decayFlag(values, observations.actual, book.config.accountReview),
      simulation: decayFlag(
        values,
        observations.simulation,
        book.config.accountReview,
      ),
      flagged: [
        observations.alerts,
        observations.paper,
        observations.actual,
      ].some((v) => decayFlag(values, v, book.config.accountReview).flagged),
      basis:
        "同分仓同期限入场样本等权合并，非账户收益相加；相关/重叠样本不宣称独立。缺任一成员的同参数分布则整体不判衰减。",
    });
  }
  return rows;
}
