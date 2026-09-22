import { researchStructureTargets } from "~/lib/research-structure-targets";
import { confirmedExtrema } from "~/lib/indicators";
import {
  researchWyckoffSeries,
  structureBarBytes,
  wyckoffScore,
  type WyckoffId,
  type WyckoffStructureInput,
} from "~/lib/research-wyckoff";
import {
  researchWyckoffHourlySeries,
  type WyckoffHourlyInput,
} from "~/lib/research-wyckoff-hourly";
import { researchStructureRs } from "./research-structure-rs";
import type { Bar } from "~/lib/domain";
import type { Snapshot } from "~/lib/domain";
import type { CalendarReference } from "../../market/data-health";
import { weeklyBars } from "../../market/weekly-bars";

const shift = (day: string, days: number) =>
  new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
const monday = (day: string) =>
  shift(day, 1 - (new Date(day).getUTCDay() || 7));

/** A window of trading weeks, not the last N surviving aggregates. Fully
 * closed weeks may be skipped only with explicit evidence for all five days. */
export function researchStructureWeekly(
  snapshot: Snapshot,
  calendar: CalendarReference,
  asOf: string,
  count: number,
) {
  if (!Number.isInteger(count) || count < 2 || count > 104)
    throw new Error("周线窗口须为2至104周");
  const cutoff = Date.parse(`${asOf}T15:05:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(cutoff) ||
    new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("周线观察日期无效");
  if (snapshot.historicalAsOf && snapshot.historicalAsOf < asOf)
    throw new Error("周线源快照截止日期早于观察日");
  // Slice before aggregation: a later corrupt/revised bar cannot change this prefix.
  const source = {
    ...snapshot,
    historicalAsOf: asOf,
    bars: snapshot.bars.filter((bar) => bar.date <= asOf),
  };
  const reference = {
    ...calendar,
    days: calendar.days.filter((day) => day <= asOf),
    closedDays: calendar.closedDays?.filter((day) => day <= asOf),
  };
  const aggregate = weeklyBars(source, reference, cutoff);
  const open = new Set(reference.days),
    closed = new Set(reference.closedDays);
  const byWeek = new Map(aggregate.bars.map((bar) => [monday(bar.date), bar]));
  const gaps: { week: string; reason: string; dates: string[] }[] = [];
  const selected: {
    week: string;
    completedAt: string;
    bar: Snapshot["bars"][number];
  }[] = [];
  let week = monday(asOf);
  if (shift(week, 4) > asOf) week = shift(week, -7);
  let slots = 0;
  // Bound scanning even for an entirely closed or unknown calendar.
  for (
    let scanned = 0;
    slots < count && scanned < count + 104;
    scanned++, week = shift(week, -7)
  ) {
    const dates = Array.from({ length: 5 }, (_, i) => shift(week, i));
    if (dates.every((day) => closed.has(day))) continue;
    slots++;
    const unknown = dates.filter((day) => !open.has(day) && !closed.has(day));
    const bar = byWeek.get(week);
    if (unknown.length || !reference.hash || !reference.source.trim())
      gaps.push({ week, reason: "周日历或来源缺失", dates: unknown });
    else if (
      !bar ||
      bar.volume <= 0 ||
      source.bars.some((b) => monday(b.date) === week && b.volume <= 0)
    )
      gaps.push({
        week,
        reason: "交易周缺失、缺日或无有效成交量",
        dates: dates.filter((d) => open.has(d)),
      });
    else
      selected.push({
        week,
        completedAt: `${shift(week, 4)}T15:05:00+08:00`,
        bar,
      });
  }
  if (slots < count)
    gaps.push({ week, reason: "连续交易周窗口不足", dates: [] });
  selected.reverse();
  return {
    version: "research-completed-trading-weeks-1" as const,
    status: gaps.length ? ("missing" as const) : ("ready" as const),
    asOf,
    count,
    source: snapshot.source,
    sourceId: snapshot.id,
    adjustment: snapshot.adjustment,
    calendar: reference,
    aggregateHash: aggregate.hash,
    gaps,
    // Never hand a compressed window to the structural consumer.
    weeks: gaps.length ? [] : selected,
    reason: gaps.length ? "缺少连续有效已完成交易周；不得跨缺周拼接" : null,
    availabilityModel: "周五15:05完成K线回放模型，不证明供应商历史发布延迟",
  };
}

/** Method rows consume the existing weekly/RS adapters, preserving raw evidence. */
export function researchWyckoffStructureSeries(
  id: WyckoffId,
  bars: readonly Bar[],
  calendar: readonly string[],
  symbol: string,
  inputs?: readonly WyckoffStructureInput[],
  hours?: readonly WyckoffHourlyInput[],
) {
  const base =
    id === "wy-week-day-hour"
      ? researchWyckoffHourlySeries(bars, calendar, hours, symbol)
      : researchWyckoffSeries(
          id === "wy-dual-rs" || id === "wy-score-half-kelly"
            ? "wy-sos-jac-daily"
            : id,
          bars,
          calendar,
        );
  const rows = new Map(
    (inputs ?? []).filter((r) => r.symbol === symbol).map((r) => [r.date, r]),
  );
  const priorBytes = new Map<string, string>();
  return base.map((point, i) => {
    if (["wy-target-pf", "wy-target-time", "wy-target-width"].includes(id))
      return { ...point, inputEvidence: null };
    const row = rows.get(point.date),
      cutoff = Date.parse(`${point.date}T15:05:00+08:00`);
    let reason = point.reason;
    const known = (stamp: string) =>
      Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) <= cutoff;
    if (
      !row ||
      !known(row.availableAt) ||
      !known(row.calendar.availableAt) ||
      row.stock.symbol !== symbol ||
      row.stock.period !== "day" ||
      row.stock.adjustment !== "none"
    )
      reason = "缺少当日可知的原始结构输入/身份/日历";
    if (row) {
      const prefix = bars.slice(0, i + 1),
        supplied = row.stock.bars.filter((b) => b.date <= point.date);
      if (structureBarBytes(prefix) !== structureBarBytes(supplied))
        reason = "原始结构日线与研究日线不一致";
      if (
        Date.parse(row.availableAt) < Date.parse(`${point.date}T15:00:00+08:00`)
      )
        reason = "原始收盘行情availableAt早于收盘";
      if (
        JSON.stringify(
          row.calendar.days.filter(
            (d) => d >= bars[0]!.date && d <= point.date,
          ),
        ) !==
        JSON.stringify(
          calendar.filter((d) => d >= bars[0]!.date && d <= point.date),
        )
      )
        reason = "结构日历与研究交易日历不一致";
      // Earlier evidence cannot be revised by a later per-date observation.
      if (!reason)
        for (const snap of [
          row.stock,
          ...(row.benchmarks ?? []).map((b) => b.snapshot),
        ])
          for (const bar of snap.bars.filter((b) => b.date <= point.date)) {
            const key = `${snap.symbol}:${bar.date}`,
              bytes = structureBarBytes([bar]),
              previous = priorBytes.get(key);
            if (previous && previous !== bytes)
              reason = "结构输入重叠行情被修订";
            else priorBytes.set(key, bytes);
          }
    }
    let pass = false;
    let evidence: unknown = null;
    let scoreStop: number | undefined;
    let scoreTarget: ReturnType<typeof researchStructureTargets> | undefined;
    if (row && !reason) {
      if (id === "wy-week-day-hour") {
        // Friday's close cannot qualify an earlier Friday intraday Spring.
        const candidate = point.events.find(
          (e) => e.state === "confirmed" && e.kind === "spring",
        )?.candidateAt;
        const asOf = candidate
          ? (calendar.filter((d) => d < candidate.slice(0, 10)).at(-1) ??
            point.date)
          : point.date;
        const weekly = researchStructureWeekly(
          row.stock,
          row.calendar,
          asOf,
          52,
        );
        const extrema = confirmedExtrema(weekly.weeks.map((w) => w.bar));
        const barrier = extrema.ambiguousIndices.at(-1) ?? -1;
        const points = extrema.extrema.filter((p) => p.index - 3 > barrier);
        const highs = points.filter((p) => p.kind === "high").slice(-2),
          lows = points.filter((p) => p.kind === "low").slice(-2);
        pass =
          highs.length === 2 &&
          lows.length === 2 &&
          highs[1]!.price > highs[0]!.price &&
          lows[1]!.price > lows[0]!.price;
        reason = weekly.reason;
        const weeklyKnown = Date.parse(row.weeklyAvailableAt ?? ""),
          completed = Date.parse(weekly.weeks.at(-1)?.completedAt ?? "");
        if (
          !Number.isFinite(weeklyKnown) ||
          weeklyKnown < completed ||
          weeklyKnown > (candidate ? Date.parse(candidate) : cutoff) ||
          (candidate != null &&
            Date.parse(row.calendar.availableAt) > Date.parse(candidate))
        )
          reason = "缺少候选前已知且不早于周完成的weeklyAvailableAt";
        evidence = { weekly, highs, lows, aligned: pass };
      } else if (id === "wy-dual-rs") {
        const start = calendar[calendar.indexOf(point.date) - 20];
        if (!start) reason = "双RS需要此前20个研究交易日";
        else {
          const rs = researchStructureRs(
            row.stock,
            row.benchmarks ?? [],
            row.calendar,
            start,
            point.date,
            row.availableAt,
          );
          pass = rs.bothStronger === true;
          reason = rs.reason;
          evidence = rs;
        }
      } else {
        const score = wyckoffScore(row.assessment);
        if (!score || !row.assessment || !known(row.assessment.availableAt))
          reason = "缺少当时已知的阶段/五项评分证据";
        else {
          const match = point.events.find(
            (e) => e.kind === "jac" && e.state === "confirmed",
          );
          if (match && "index" in match.facts) {
            const f = match.facts;
            scoreTarget = researchStructureTargets({
              model: "source-width-123",
              bars: bars.slice(f.rangeStart, f.index),
              low: f.support,
              high: f.resistance,
              boxSize: (f.resistance - f.support) * 0.1,
              direction: 1,
              breakoutPrice: f.close,
              confirmedAt: point.date,
            });
            const stop = f.support * 0.999;
            scoreStop = stop;
            const payoff =
              scoreTarget.status === "computed"
                ? (scoreTarget.targets.at(-1)! - bars[i]!.close) /
                  (bars[i]!.close - stop)
                : null;
            pass =
              score.value >= 70 &&
              ["accumulation", "markup"].includes(score.phase) &&
              payoff !== null &&
              payoff >= 2;
            evidence = { ...score, payoff, target: scoreTarget, stop };
            if (scoreTarget.status === "missing") reason = scoreTarget.reason;
          } else evidence = score;
        }
      }
    }
    return {
      ...point,
      ...(id === "wy-score-half-kelly" && scoreStop
        ? {
            ruleStop: {
              price: scoreStop,
              days: 60,
              reason: "冻结TR下沿下方0.1%",
            },
          }
        : {}),
      ...(scoreTarget ? { targetPlan: scoreTarget } : {}),
      entry: point.entry && !reason && pass,
      reason,
      inputEvidence: evidence,
      values: {
        ...point.values,
        structureInput: row ?? null,
        criterion: evidence,
      },
      decision: reason ?? (pass ? "共享输入判据通过" : "共享输入判据过滤"),
    };
  });
}
