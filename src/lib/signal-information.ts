import { horizons, type LedgerRow } from "./signal-ledger";

type Sample = { score: number; value: number };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function ranks(xs: number[]) {
  const sorted = xs
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = Array<number>(xs.length);
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end]!.value === sorted[i]!.value)
      end++;
    for (let j = i; j < end; j++) result[sorted[j]!.index] = (i + 1 + end) / 2;
    i = end;
  }
  return result;
}
function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const x = ranks(xs),
    y = ranks(ys),
    mx = mean(x),
    my = mean(y);
  const xx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const yy = y.reduce((s, v) => s + (v - my) ** 2, 0);
  return xx && yy
    ? x.reduce((s, v, i) => s + (v - mx) * (y[i]! - my), 0) / Math.sqrt(xx * yy)
    : null;
}
function stratify(samples: Sample[], requestedQ: number) {
  const q = samples.length / requestedQ < 10 ? 3 : requestedQ;
  const base = {
    requestedQ,
    q,
    tiedBoundary: false,
    reason: null as string | null,
  };
  if (samples.length / q < 10)
    return {
      ...base,
      reason: "分层样本不足（每组期望少于10条）",
      groups: [],
      monotonicity: null,
      topMinusBottom: null,
    };
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  // Empirical full-sample quantiles; a tie block belongs to its first (lower) bin.
  const bins: Sample[][] = Array.from({ length: q }, () => []);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.score === sorted[start]!.score)
      end++;
    const bin = Math.floor((start * q) / sorted.length);
    if (Math.floor(((end - 1) * q) / sorted.length) !== bin)
      base.tiedBoundary = true;
    for (let i = start; i < end; i++) bins[bin]!.push(sorted[i]!);
    start = end;
  }
  const groups = bins.map((bin, i) => {
    const values = bin.map((s) => s.value).sort((a, b) => a - b),
      n = values.length;
    return {
      quantile: i + 1,
      count: n,
      meanReturn: n ? mean(values) : null,
      medianReturn: n
        ? (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2
        : null,
      winRate: n ? (values.filter((v) => v > 0).length / n) * 100 : null,
      scoreRange: n ? [bin[0]!.score, bin.at(-1)!.score] : null,
      reason: n ? null : "并列边界导致空组",
    };
  });
  const complete = groups.every((g) => g.meanReturn !== null);
  const monotonicity = complete
    ? spearman(
        groups.map((g) => g.quantile),
        groups.map((g) => g.meanReturn!),
      )
    : null;
  const bottom = groups[0]!.meanReturn,
    top = groups.at(-1)!.meanReturn;
  return {
    ...base,
    groups,
    monotonicity,
    topMinusBottom: bottom !== null && top !== null ? top - bottom : null,
    reason: !complete
      ? "并列边界导致空组，单调性留空"
      : monotonicity === null
        ? "分层均值无差异，单调性留空"
        : null,
  };
}

/** V3 / invariants §5: price returns retain their sign for both directions. */
export function signalInformation(rows: readonly LedgerRow[], q = 5) {
  if (!Number.isInteger(q) || q < 3)
    throw new RangeError("Q 必须为不小于3的整数");
  const winners = new Map<string, LedgerRow>();
  const key = (r: LedgerRow) =>
    JSON.stringify([r.symbol, r.observedDate, r.strategy]);
  for (const row of rows) {
    const previous = winners.get(key(row));
    if (!previous || row.id < previous.id) winners.set(key(row), row);
  }
  const directions = new Map<
    string,
    {
      strategy: LedgerRow["strategy"];
      direction: LedgerRow["direction"];
      rows: LedgerRow[];
    }
  >();
  for (const row of rows) {
    const k = `${row.strategy}:${row.direction}`;
    const group = directions.get(k) ?? {
      strategy: row.strategy,
      direction: row.direction,
      rows: [],
    };
    group.rows.push(row);
    directions.set(k, group);
  }
  const groups = [...directions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, group]) =>
      horizons.map((horizon) => {
        const exclusions = {
          duplicate: 0,
          unsettled: 0,
          nullReturn: 0,
          corporateAction: 0,
          missingOutcome: 0,
          nonFinite: 0,
          reasons: {} as Record<string, number>,
        };
        const addReason = (reason: string) => {
          exclusions.reasons[reason] = (exclusions.reasons[reason] ?? 0) + 1;
        };
        const sections = new Map<string, Sample[]>();
        const samples: Sample[] = [];
        // Duplicate exclusion takes precedence; other exclusion flags may overlap.
        const seen = new Set<string>();
        for (const row of group.rows) {
          if (winners.get(key(row)) !== row || seen.has(key(row))) {
            exclusions.duplicate++;
            continue;
          }
          seen.add(key(row));
          const section = sections.get(row.observedDate) ?? [];
          sections.set(row.observedDate, section);
          const out = row.outcomes.find((o) => o.horizon === horizon);
          if (!out) {
            exclusions.missingOutcome++;
            addReason("等待回填");
            continue;
          }
          if (!out.settled) exclusions.unsettled++;
          if (out.returnPct === null) {
            exclusions.nullReturn++;
            for (const reason of new Set(
              out.reasons.length ? out.reasons : ["收益缺失（未提供原因）"],
            ))
              addReason(reason);
          }
          if (out.action === "含除权，收益不可比") exclusions.corporateAction++;
          if (
            !out.settled ||
            out.returnPct === null ||
            out.action === "含除权，收益不可比"
          )
            continue;
          if (!Number.isFinite(row.score) || !Number.isFinite(out.returnPct)) {
            exclusions.nonFinite++;
            addReason("评分或收益非有限数");
            continue;
          }
          const sample = { score: row.score, value: out.returnPct };
          section.push(sample);
          samples.push(sample);
        }
        const daily = [...sections.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([observedDate, values]) => {
            const rankIC =
              values.length < 5
                ? null
                : spearman(
                    values.map((v) => v.score),
                    values.map((v) => v.value),
                  );
            return {
              observedDate,
              count: values.length,
              rankIC,
              reason:
                values.length < 5
                  ? "截面样本不足"
                  : rankIC === null
                    ? "截面内取值无差异"
                    : null,
            };
          });
        const ics = daily.flatMap((d) => (d.rankIC === null ? [] : [d.rankIC])),
          k = ics.length;
        const icMean = k ? mean(ics) : null;
        const icStd =
          k > 1
            ? Math.sqrt(
                ics.reduce((s, v) => s + (v - icMean!) ** 2, 0) / (k - 1),
              )
            : null;
        const reasons: string[] = [];
        if (k < 10) reasons.push("截面数不足，t 值不可靠");
        if (!k) reasons.push("无有效截面");
        if (k < 2) reasons.push("不足两个有效截面，标准差、ICIR与t值留空");
        else if (icStd === 0) reasons.push("IC标准差为零，ICIR与t值留空");
        return {
          strategy: group.strategy,
          direction: group.direction,
          horizon,
          samples: group.rows.length,
          valid: samples.length,
          excluded: group.rows.length - samples.length,
          exclusions,
          daily,
          icMean,
          icStd,
          icir: icStd ? icMean! / icStd : null,
          icTStat: icStd ? icMean! / (icStd / Math.sqrt(k)) : null,
          positiveRatio: k ? ics.filter((v) => v > 0).length / k : null,
          sections: { valid: k, total: daily.length },
          reasons,
          stratification: stratify(samples, q),
        };
      }),
    );
  const decay = [...directions.values()]
    .sort((a, b) =>
      `${a.strategy}:${a.direction}`.localeCompare(
        `${b.strategy}:${b.direction}`,
      ),
    )
    .map(({ strategy, direction }) => ({
      strategy,
      direction,
      decay: groups
        .filter((g) => g.strategy === strategy && g.direction === direction)
        .map((g) => ({
          horizon: g.horizon,
          icMean: g.icMean,
          topMinusBottom: g.stratification.topMinusBottom,
        })),
    }));
  return { groups, decay };
}
export type SignalInformation = ReturnType<typeof signalInformation>;
