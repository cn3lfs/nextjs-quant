import {
  csi800ClassicFactors,
  csi800ClassicRecipes,
  classicRanks,
  type ClassicFamily,
} from "./csi800-factors.js";
import { csi800Weights, type Csi800Allocation } from "./csi800-study.js";

export type ClassicModel =
  (typeof csi800ClassicRecipes)[number]["id"] | "pool-equal" | "eligible-equal";
export type ClassicPanelRow = {
  symbol: string;
  values: (number | null)[];
  volatility: number;
  amihud: number | null;
  positiveEquity: boolean;
  reportDate: string | null;
  announcementDate: string | null;
  availableFrom: string | null;
  marketCap: number | null;
};
export type ClassicWeek = {
  date: string;
  nextDate: string;
  marketBudget: number;
  rows: ClassicPanelRow[];
};
export type ClassicScoredRow = ClassicPanelRow & {
  families: Partial<Record<ClassicFamily, number | null>>;
};
const technical = ["momentum", "trend", "reversal", "low-risk"] as const;
const financial = [
  "quality",
  "value",
  "growth",
  "investment",
  "balance-sheet",
] as const;
const average = (values: number[]) =>
  values.reduce((s, v) => s + v / values.length, 0);
const valid = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);
function groupMean(
  row: ClassicScoredRow,
  families: readonly ClassicFamily[],
  minimum: number,
  mandatory: readonly ClassicFamily[] = [],
) {
  if (mandatory.some((f) => !valid(row.families[f]))) return null;
  const values = families.map((f) => row.families[f]).filter(valid);
  return values.length >= minimum ? average(values) : null;
}

export function scoreClassicWeek(week: ClassicWeek): ClassicScoredRow[] {
  if (
    new Set(week.rows.map((r) => r.symbol)).size !== week.rows.length ||
    week.rows.some((r) => r.values.length !== csi800ClassicFactors.length)
  )
    throw new Error("因子面板证券重复或列数错误");
  const ranks = csi800ClassicFactors.map((factor, i) =>
    classicRanks(
      week.rows.map((row) =>
        row.values[i] === null ? null : row.values[i]! * factor.direction,
      ),
    ),
  );
  const families = [...new Set(csi800ClassicFactors.map((f) => f.family))];
  return week.rows.map((row, index) => {
    const result: ClassicScoredRow = { ...row, families: {} };
    for (const family of families) {
      const indices = csi800ClassicFactors.flatMap((f, i) =>
        f.family === family ? [i] : [],
      );
      const values = indices.map((i) => ranks[i]![index]).filter(valid);
      const minimum = family === "quality" ? 2 : Math.ceil(indices.length / 2);
      result.families[family] =
        values.length >= minimum ? average(values) : null;
    }
    return result;
  });
}

/** No label or future return is accepted by this scoring interface. */
export function classicModelScore(
  row: ClassicScoredRow,
  model: ClassicModel,
  omit?: ClassicFamily,
): number | null {
  const t = technical.filter((f) => f !== omit),
    f = financial.filter((family) => family !== omit);
  const tScore = groupMean(row, t, Math.min(3, t.length));
  const fScore = row.positiveEquity
    ? groupMean(
        row,
        f,
        Math.min(4, f.length),
        ["quality", "value"].filter((v) => v !== omit) as ClassicFamily[],
      )
    : null;
  if (model === "pool-equal") return 0;
  if (
    model === "eligible-equal" ||
    model === "combined" ||
    model === "combined-defensive"
  )
    return tScore === null || fScore === null ? null : (tScore + fScore) / 2;
  if (model === "technical") return tScore;
  if (model === "financial") return fScore;
  const recipe = csi800ClassicRecipes.find((r) => r.id === model)!;
  const members = recipe.families.filter((family) => family !== omit);
  if (
    members.some((family) =>
      (financial as readonly string[]).includes(family),
    ) &&
    !row.positiveEquity
  )
    return null;
  const mandatory = members.filter((family) =>
    ["quality", "value", "momentum"].includes(family),
  );
  return groupMean(
    row,
    members,
    members.length === 5 ? 4 : members.length,
    mandatory,
  );
}

export function classicCommonWindow(weeks: readonly ClassicWeek[]) {
  let consecutive = 0;
  const coverage = weeks.map((week) => {
    const scored = scoreClassicWeek(week);
    const count = scored.filter(
      (r) =>
        r.positiveEquity &&
        valid(r.families.quality) &&
        valid(r.families.value),
    ).length;
    const qualified =
      week.rows.length >= 200 && count / week.rows.length >= 0.6;
    consecutive = qualified ? consecutive + 1 : 0;
    return {
      date: week.date,
      technical: week.rows.length,
      financial: count,
      qualified,
      consecutive,
    };
  });
  const first = coverage.findIndex((row) => row.consecutive === 4);
  return {
    coverage,
    start: first < 0 ? null : weeks[first]!.nextDate,
    firstSignal: first < 0 ? null : weeks[first]!.date,
  };
}

/** Includes covariance through the observed portfolio return on each day. */
export function classicPortfolioVolatility(
  returns: readonly (readonly number[])[],
  weights: readonly number[],
) {
  if (
    returns.length !== weights.length ||
    !returns.length ||
    returns.some((r) => r.length !== 60 || r.some((v) => !Number.isFinite(v)))
  )
    return null;
  const daily = Array.from({ length: 60 }, (_, i) =>
    returns.reduce((s, r, j) => s + r[i]! * weights[j]!, 0),
  );
  const mean = average(daily);
  return (
    Math.sqrt(daily.reduce((s, r) => s + (r - mean) ** 2, 0) / 59) *
    Math.sqrt(252)
  );
}

export type ClassicScheduleOptions = {
  model: ClassicModel;
  count?: number;
  risk?: "none" | "market" | "volatility" | "both";
  omit?: ClassicFamily;
  startSignal?: string;
  budgetOverride?: ReadonlyMap<string, number>;
};
export function buildClassicSchedule(
  weeks: readonly ClassicWeek[],
  options: ClassicScheduleOptions,
  riskAt: (symbol: string, date: string) => readonly number[] | null,
) {
  const count = options.count ?? 20;
  if (!Number.isInteger(count) || count < 1) throw new Error("持股数量非法");
  const allocations: Csi800Allocation[] = [],
    audit: {
      date: string;
      eligible: number;
      selected: string[];
      exposure: number;
      estimatedVolatility: number | null;
      riskMissing: boolean;
    }[] = [];
  let previous = new Set<string>();
  for (const week of weeks) {
    if (options.startSignal && week.date < options.startSignal) continue;
    const scored = scoreClassicWeek(week);
    const eligible = scored
      .flatMap((row) => {
        const score = classicModelScore(row, options.model, options.omit);
        return score === null || !(row.volatility > 0)
          ? []
          : [{ ...row, score }];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.amihud ?? Infinity) - (b.amihud ?? Infinity) ||
          a.symbol.localeCompare(b.symbol),
      );
    const equal =
      options.model === "pool-equal" || options.model === "eligible-equal";
    const selected = equal
      ? eligible
      : eligible
          .filter(
            (r, i) => i < Math.ceil(count * 1.5) && previous.has(r.symbol),
          )
          .slice(0, count);
    if (!equal)
      for (const row of eligible)
        if (
          selected.length < count &&
          !selected.some((r) => r.symbol === row.symbol)
        )
          selected.push(row);
    previous = new Set(selected.map((r) => r.symbol));
    const base = csi800Weights(
      selected.map((r) => (equal ? 1 : 1 / r.volatility)),
      1,
    );
    const baseSum = base.reduce((a, b) => a + b, 0);
    const normalized = baseSum > 0 ? base.map((w) => w / baseSum) : base;
    const risk =
      options.risk ??
      (options.model === "combined-defensive" ? "both" : "none");
    let budget = 1,
      estimatedVolatility: number | null = null,
      riskMissing = false;
    if (risk === "market" || risk === "both") budget *= week.marketBudget;
    if ((risk === "volatility" || risk === "both") && selected.length) {
      const vectors = selected.map((r) => riskAt(r.symbol, week.date));
      estimatedVolatility = vectors.some((r) => r === null)
        ? null
        : classicPortfolioVolatility(
            vectors.flatMap((r) => (r === null ? [] : [r])),
            normalized,
          );
      riskMissing = estimatedVolatility === null;
      budget *=
        estimatedVolatility === null
          ? 0
          : estimatedVolatility === 0
            ? 1
            : Math.min(1, 0.15 / estimatedVolatility);
    }
    if (!equal) budget *= Math.min(1, selected.length / count);
    const override = options.budgetOverride?.get(week.date);
    if (override !== undefined) budget = override;
    const weights = csi800Weights(
      selected.map((r) => (equal ? 1 : 1 / r.volatility)),
      budget,
    );
    // A normalized sum can be 1 + machine epsilon. Metadata is a budget,
    // so keep it in [0,1] before using it in a same-exposure control.
    const exposure = Math.min(
      1,
      weights.reduce((a, b) => a + b, 0),
    );
    allocations.push({
      date: week.date,
      weights: Object.fromEntries(
        selected.map((r, i) => [r.symbol, weights[i]!]),
      ),
    });
    audit.push({
      date: week.date,
      eligible: eligible.length,
      selected: selected.map((r) => r.symbol),
      exposure,
      estimatedVolatility,
      riskMissing,
    });
  }
  return { options, allocations, audit };
}
