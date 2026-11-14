import { runPortfolio, type PortfolioRequest } from "./portfolio-engine.js";
import { marketRules } from "trading-strategy-core/market-rules";

export type ValidationScore = {
  return: number | null;
  excess: number | null;
  drawdown: number | null;
  trades: number;
  events: {
    entries: number;
    exits: number;
    orders: number;
    fills: number;
    rejectionAttempts: number;
  };
  daily: (number | null)[];
};
export type ValidationPolicy = {
  trainBars: number;
  testBars: number;
  minimumWindows: number;
  minimumTrades: number;
  maximumDrawdown: number;
  minimumPositiveWindows: number;
  minimumStableNeighbors: number;
};
export const validationDefaults = {
  minimumWindows: 3,
  minimumTrades: 30,
  maximumDrawdown: 0.25,
  minimumPositiveWindows: 0.6,
  minimumStableNeighbors: 0.5,
} as const;
export type ValidationCandidate = {
  id: string;
  family: string;
  request: PortfolioRequest;
  neighborIds?: readonly string[];
};
export type ValidationRun = {
  start: string;
  end: string;
  base: ValidationScore;
  doubledCost: ValidationScore;
  delayed: ValidationScore;
};
export type ValidationRow = {
  id: string;
  family: string;
  inSample: ValidationScore;
  holdout: ValidationRun;
  windows: ValidationRun[];
  neighbors: { id: string; excess: number | null }[];
  positiveWindows: number;
  stressPositiveWindows: number;
  closedTrades: number;
  reasons: string[];
  passed: boolean;
};

/** Only the training prefix is supplied to the engine and ranking callback.
 * Each segment starts with independent capital, preserving earlier features but
 * no inherited positions. The separate last-20% split overlaps rolling OOS;
 * it is a diagnostic, never an extra independent statistical trial.
 */
export function runValidationSuite(
  candidates: readonly ValidationCandidate[],
  dates: readonly string[],
  policy: ValidationPolicy,
  score: (
    result: ReturnType<typeof runPortfolio>,
    request: PortfolioRequest,
  ) => ValidationScore,
  progress: (done: number, total: number) => void = () => {},
) {
  if (
    !candidates.length ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length ||
    dates.length < 10 ||
    policy.trainBars >= dates.length ||
    dates.some(
      (d, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) ||
        (i > 0 && d <= dates[i - 1]!),
    ) ||
    ![
      policy.trainBars,
      policy.testBars,
      policy.minimumWindows,
      policy.minimumTrades,
    ].every((n) => Number.isInteger(n) && n > 0) ||
    ![
      policy.maximumDrawdown,
      policy.minimumPositiveWindows,
      policy.minimumStableNeighbors,
    ].every((n) => Number.isFinite(n) && n > 0 && n <= 1)
  )
    throw new Error("Invalid validation candidates / dates / policy");
  const windows: {
    trainStart: string;
    trainEnd: string;
    start: string;
    end: string;
  }[] = [];
  for (
    let i = policy.trainBars;
    i + policy.testBars <= dates.length;
    i += policy.testBars
  )
    windows.push({
      trainStart: dates[i - policy.trainBars]!,
      trainEnd: dates[i - 1]!,
      start: dates[i]!,
      end: dates[i + policy.testBars - 1]!,
    });
  const split = Math.floor(dates.length * 0.8);
  const run = (
    candidate: ValidationCandidate,
    start: string,
    end: string,
    costMultiplier = 1,
    delay: 0 | 1 = 0,
  ) => {
    const original = candidate.request;
    const costs = original.costs ?? marketRules[original.market].costs;
    if (!costs) throw new Error("Missing market cost assumptions");
    const request: PortfolioRequest = {
      ...original,
      start,
      end,
      signalDelayBars: delay,
      costs: Object.fromEntries(
        Object.entries(costs).map(([key, value]) => [
          key,
          typeof value === "number" ? value * costMultiplier : value,
        ]),
      ) as typeof costs,
      calendar: original.calendar.filter((d) => d.slice(0, 10) <= end),
      instruments: original.instruments.map((instrument) => ({
        ...instrument,
        bars: instrument.bars.filter((b) => b.date.slice(0, 10) <= end),
        signalBars: instrument.signalBars.filter(
          (b) => b.date.slice(0, 10) <= end,
        ),
        actions: instrument.actions?.filter((a) => a.date <= end),
        external: instrument.external && {
          ...instrument.external,
          rps: instrument.external.rps?.filter(
            (r) => r.date.slice(0, 10) <= end,
          ),
          chan: instrument.external.chan?.filter(
            (r) => r.date.slice(0, 10) <= end,
          ),
          signals: instrument.external.signals?.filter(
            (r) => r.date.slice(0, 10) <= end,
          ),
          levels: instrument.external.levels?.filter(
            (r) => r.date.slice(0, 10) <= end,
          ),
          lowZone: instrument.external.lowZone?.filter(
            (r) => r.date.slice(0, 10) <= end,
          ),
        },
      })),
      memberships: original.memberships?.filter(
        (m) => m.date.slice(0, 10) <= end,
      ),
      sleeveTargets: original.sleeveTargets?.filter(
        (t) => t.date.slice(0, 10) <= end,
      ),
    };
    return score(runPortfolio(request), request);
  };
  const stress = (
    c: ValidationCandidate,
    start: string,
    end: string,
  ): ValidationRun => ({
    start,
    end,
    base: run(c, start, end),
    doubledCost: run(c, start, end, 2),
    delayed: run(c, start, end, 1, 1),
  });
  const training = windows.map((window) =>
    candidates.map((c) => run(c, window.trainStart, window.trainEnd)),
  );
  const selection = windows.map((window, index) => ({
    ...window,
    families: [...new Set(candidates.map((c) => c.family))].map((family) => {
      const eligible = candidates
        .map((c, i) => ({ c, i, score: training[index]![i]! }))
        .filter((x) => x.c.family === family);
      eligible.sort(
        (a, b) =>
          (b.score.excess ?? -Infinity) - (a.score.excess ?? -Infinity) ||
          (a.score.drawdown ?? Infinity) - (b.score.drawdown ?? Infinity) ||
          a.c.id.localeCompare(b.c.id),
      );
      return {
        family,
        selectedId: eligible[0]!.c.id,
        training: eligible[0]!.score,
      };
    }),
  }));
  const rows: ValidationRow[] = candidates.map((candidate, index) => {
    const evaluated = windows.map((w) => stress(candidate, w.start, w.end));
    const positiveWindows = evaluated.filter(
      (w) => w.base.excess !== null && w.base.excess > 0,
    ).length;
    const stressPositiveWindows = evaluated.filter((w) =>
      [w.doubledCost, w.delayed].every(
        (s) => s.excess !== null && s.excess > 0,
      ),
    ).length;
    const closedTrades = evaluated.reduce((n, w) => n + w.base.trades, 0);
    progress(index + 1, candidates.length);
    return {
      id: candidate.id,
      family: candidate.family,
      inSample: run(candidate, dates[0]!, dates[policy.trainBars - 1]!),
      holdout: stress(candidate, dates[split]!, dates.at(-1)!),
      windows: evaluated,
      neighbors: [],
      positiveWindows,
      stressPositiveWindows,
      closedTrades,
      reasons: [],
      passed: false,
    };
  });
  for (const row of rows) {
    const neighbors = candidates.find((c) => c.id === row.id)!.neighborIds;
    row.neighbors = rows
      .filter((r) =>
        neighbors
          ? neighbors.includes(r.id)
          : r.family === row.family && r.id !== row.id,
      )
      .map((r) => ({ id: r.id, excess: r.inSample.excess }));
    const reasons: string[] = [];
    if (windows.length < policy.minimumWindows)
      reasons.push("insufficient-oos-windows");
    if (
      !windows.length ||
      row.positiveWindows / windows.length < policy.minimumPositiveWindows
    )
      reasons.push("oos-positive-excess-majority");
    if (
      !windows.length ||
      row.stressPositiveWindows / windows.length <
        policy.minimumPositiveWindows ||
      [row.holdout.doubledCost, row.holdout.delayed].some(
        (s) => s.excess === null || s.excess <= 0,
      )
    )
      reasons.push("cost-or-delay-stress");
    if (row.closedTrades < policy.minimumTrades)
      reasons.push("insufficient-closed-trades");
    if (
      [
        ...row.windows.flatMap((w) => [w.base, w.doubledCost, w.delayed]),
        row.holdout.base,
        row.holdout.doubledCost,
        row.holdout.delayed,
      ].some((s) => s.drawdown === null || s.drawdown > policy.maximumDrawdown)
    )
      reasons.push("drawdown-bound");
    if (row.holdout.base.excess === null || row.holdout.base.excess <= 0)
      reasons.push("holdout-positive-excess");
    if (
      !row.neighbors.length ||
      row.neighbors.filter((n) => n.excess !== null && n.excess > 0).length /
        row.neighbors.length <
        policy.minimumStableNeighbors
    )
      reasons.push("parameter-neighborhood");
    row.reasons = reasons;
    row.passed = reasons.length === 0;
  }
  return {
    version: "validation-suite-1" as const,
    policy,
    windows,
    selection,
    rows,
    selectedOos: selection.map((s, index) => ({
      start: s.start,
      end: s.end,
      families: s.families.map((f) => ({
        ...f,
        result: rows.find((r) => r.id === f.selectedId)!.windows[index]!,
      })),
    })),
  };
}
