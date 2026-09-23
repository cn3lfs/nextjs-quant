import type { Bar } from "~/lib/domain";
import { ledgerOutcome, type LedgerRow } from "~/lib/strategy-facts/signal-ledger";
import { signalInformation } from "~/lib/strategy-facts/signal-information";

/** Keep V3 absolute-return membership and bins; missing benchmarks cannot re-bin scores. */
export function benchmarkStratification(
  rows: LedgerRow[],
  benchmark: Bar[],
  days: string[],
  calendarSource: string,
  completedThrough: string,
) {
  const information = signalInformation(rows);
  const cache = new Map<string, ReturnType<typeof ledgerOutcome>>();
  const observations = rows.flatMap((row) =>
    row.outcomes.map((outcome) => {
      const key = `${row.observedDate}:${outcome.horizon}`;
      let reference = cache.get(key);
      if (!reference) {
        reference = ledgerOutcome(
          row,
          outcome.horizon,
          benchmark,
          days,
          calendarSource,
          {
            dates: [],
            source: "中证800 sh000906 指数点位，无个股公司行动",
            coverageEnd: completedThrough,
          },
          completedThrough,
        );
        cache.set(key, reference);
      }
      const reasons = [...outcome.reasons];
      if (row.observedDate < (benchmark[0]?.date ?? "9999"))
        reasons.push("中证800基准历史未覆盖信号日（2007-01-15之前不替代）");
      reasons.push(...reference.reasons.map((r) => `中证800：${r}`));
      const excess =
        outcome.settled &&
        outcome.returnPct !== null &&
        reference.returnPct !== null &&
        !reasons.length
          ? outcome.returnPct - reference.returnPct
          : null;
      return {
        id: row.id,
        observedDate: row.observedDate,
        strategy: row.strategy,
        direction: row.direction,
        score: row.score,
        horizon: outcome.horizon,
        absolute: outcome.returnPct,
        absoluteValid:
          outcome.settled &&
          outcome.returnPct !== null &&
          Number.isFinite(outcome.returnPct) &&
          Number.isFinite(row.score) &&
          outcome.action !== "含除权，收益不可比",
        benchmarkReturn: reference.returnPct,
        excess,
        reasons: [...new Set(reasons)],
      };
    }),
  );
  if (
    new Set(
      rows.map((r) => JSON.stringify([r.symbol, r.observedDate, r.strategy])),
    ).size !== rows.length
  )
    throw new Error("W7b 输入含重复观察，停止分层而非改变 V3 去重口径");
  const groups = information.groups.map((group) => ({
    strategy: group.strategy,
    direction: group.direction,
    horizon: group.horizon,
    bins: group.stratification.groups.map((bin) => {
      const samples = observations.filter(
        (o) =>
          o.strategy === group.strategy &&
          o.direction === group.direction &&
          o.horizon === group.horizon &&
          o.absoluteValid &&
          bin.scoreRange !== null &&
          o.score >= bin.scoreRange[0]! &&
          o.score <= bin.scoreRange[1]!,
      );
      if (samples.length !== bin.count)
        throw new Error("超额分层与绝对收益成员不一致");
      const values = samples
        .flatMap((o) => (o.excess === null ? [] : [o.excess]))
        .sort((a, b) => a - b);
      const reasons: Record<string, number> = {};
      for (const sample of samples.filter((s) => s.excess === null))
        for (const reason of sample.reasons)
          reasons[reason] = (reasons[reason] ?? 0) + 1;
      const n = values.length;
      return {
        ...bin,
        excessCount: n,
        excessMissing: samples.length - n,
        meanExcess: n ? values.reduce((a, b) => a + b, 0) / n : null,
        medianExcess: n
          ? (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2
          : null,
        excessWinRate: n
          ? (values.filter((v) => v > 0).length / n) * 100
          : null,
        excessReasons: reasons,
      };
    }),
  }));
  return { information, groups, observations };
}
