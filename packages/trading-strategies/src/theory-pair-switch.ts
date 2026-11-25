import type { Bar } from "trading-strategy-core/bars";
import { dailyBarEpoch } from "./theory-input.js";

export const spotPairPresets = [
  {
    id: "hs300-zz500",
    legA: "sh510300",
    legB: "sh510500",
    name: "沪深300 / 中证500 风格配对切换",
  },
  {
    id: "dividend-chinext",
    legA: "sh510880",
    legB: "sz159915",
    name: "红利 / 创业板 价值成长配对切换",
  },
  {
    id: "gold-treasury",
    legA: "sh518880",
    legB: "sh511010",
    name: "黄金 / 国债 避险资产配对切换",
  },
] as const;

type PairLeg = { symbol: string; bars: readonly Bar[] };
type PairSwitchInput = {
  pairId?: string;
  legA: PairLeg;
  legB: PairLeg;
  asOf: string;
  calendar?: readonly string[];
  lookback?: number;
  entryZ?: number;
  exitZ?: number;
  minCorrelation?: number;
};
type ActiveLeg = "A" | "B" | "neutral";
const disclosure =
  "纯多头现货相对价值轮动，不含融券空头腿，不等同市场中性统计套利";

// Square root of the centered 2x2 scatter matrix:
// Sxx = xx², Sxy = xx*xy, Syy = xy² + error². Keeping the residual norm
// directly avoids subtracting nearly equal sums of squares for collinear ETFs.
type Fit = {
  n: number;
  x: number;
  y: number;
  xx: number;
  xy: number;
  error: number;
};
function point(x: number, y: number): Fit {
  return { n: 1, x, y, xx: 0, xy: 0, error: 0 };
}

function merge(a: Fit | undefined, b: Fit): Fit {
  if (!a) return b;
  const n = a.n + b.n;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const scale = Math.sqrt((a.n * b.n) / n);
  // Merge the within-group factors, then append the between-group deviation.
  const within = Math.hypot(a.xx, b.xx);
  const c = within ? a.xx / within : 1,
    s = within ? b.xx / within : 0;
  const projection = c * a.xy + s * b.xy;
  const betweenX = dx * scale,
    betweenY = dy * scale;
  const xx = Math.hypot(within, betweenX);
  const u = xx ? within / xx : 1,
    v = xx ? betweenX / xx : 0;
  return {
    n,
    x: a.x + dx * (b.n / n),
    y: a.y + dy * (b.n / n),
    xx,
    xy: u * projection + v * betweenY,
    error: Math.hypot(
      a.error,
      b.error,
      c * b.xy - s * a.xy,
      u * betweenY - v * projection,
    ),
  };
}

/** FIFO with two aggregate stacks. Each point is transferred at most once,
 * so all trailing regressions together cost O(N) time and O(lookback) space. */
class RollingFit {
  private incoming: Fit[] = [];
  private outgoing: Fit[] = [];
  private prefix?: Fit;
  constructor(private readonly capacity: number) {}

  push(observation: Fit): Fit {
    if (this.incoming.length + this.outgoing.length === this.capacity) {
      if (!this.outgoing.length) {
        while (this.incoming.length) {
          this.outgoing.push(merge(this.outgoing.at(-1), this.incoming.pop()!));
        }
        this.prefix = undefined;
      }
      this.outgoing.pop();
    }
    this.incoming.push(observation);
    this.prefix = merge(this.prefix, observation);
    return merge(this.outgoing.at(-1), this.prefix);
  }
}

type Evidence = {
  status: "unknown" | "ok";
  beta: number | null;
  alpha: number | null;
  correlation: number | null;
  sigma: number | null;
  zScore: number | null;
};
function unknown(correlation: number | null = null): Evidence {
  return {
    status: "unknown",
    beta: null,
    alpha: null,
    correlation,
    sigma: null,
    zScore: null,
  };
}
function regression(fit: Fit, latest: Fit, minCorrelation: number): Evidence {
  const yNorm = Math.hypot(fit.xy, fit.error);
  if (!fit.xx || !yNorm) return unknown();
  const beta = fit.xy / fit.xx,
    correlation = fit.xy / yNorm;
  const sigma = fit.error / Math.sqrt(fit.n - 1);
  if (beta <= 0 || correlation < minCorrelation || sigma <= 1e-12)
    return unknown(correlation);
  // With an intercept the residual mean is zero. Center before applying beta.
  const zScore = (latest.y - fit.y - beta * (latest.x - fit.x)) / sigma;
  return {
    status: "ok",
    beta,
    correlation,
    sigma,
    alpha: fit.y - beta * fit.x,
    zScore,
  };
}

function decision(
  input: PairSwitchInput,
  date: string | null,
  evidence: Evidence,
  activeLeg: ActiveLeg,
) {
  const weightA = activeLeg === "neutral" ? 0.5 : activeLeg === "A" ? 1 : 0;
  const targets: Record<string, number> =
    evidence.status === "ok"
      ? { [input.legA.symbol]: weightA, [input.legB.symbol]: 1 - weightA }
      : {};
  return {
    strategyId: "stat-pair-switch-zscore" as const,
    pairId: input.pairId ?? null,
    date,
    ...evidence,
    activeLeg,
    targets,
    disclosure,
  };
}

/** Bars are completed daily observations. Reject unordered/duplicate visible
 * dates rather than giving one of two closes implicit precedence. */
function* completed<T>(
  rows: readonly T[],
  asOf: string,
  dateOf: (row: T) => string,
) {
  let previous = "";
  for (const row of rows) {
    const date = dateOf(row);
    if (date > asOf) continue;
    if (dailyBarEpoch(date) === null || date <= previous)
      throw new RangeError(
        "Pair sessions require strictly increasing daily dates",
      );
    previous = date;
    yield row;
  }
}

function* pairSessions({ legA, legB, asOf, calendar }: PairSwitchInput) {
  const a = completed(legA.bars, asOf, (bar) => bar.date);
  const b = completed(legB.bars, asOf, (bar) => bar.date);
  const sessions = calendar && completed(calendar, asOf, (date) => date);
  let left = a.next().value;
  let right = b.next().value;
  while (true) {
    // The calendar defines expected sessions. Without it, either leg proves a session.
    const date = sessions
      ? sessions.next().value
      : left && (!right || left.date < right.date)
        ? left.date
        : right?.date;
    if (date === undefined) return;
    while (left && left.date < date) left = a.next().value;
    while (right && right.date < date) right = b.next().value;
    const barA = left?.date === date ? left : undefined;
    const barB = right?.date === date ? right : undefined;
    yield { date, barA, barB };
    if (barA) left = a.next().value;
    if (barB) right = b.next().value;
  }
}

function* decisions(input: PairSwitchInput) {
  const {
    legA,
    legB,
    asOf,
    lookback = 60,
    entryZ = 1.5,
    exitZ = 0.25,
    minCorrelation = 0.3,
  } = input;
  if (
    !legA.symbol ||
    !legB.symbol ||
    legA.symbol === legB.symbol ||
    dailyBarEpoch(asOf) === null ||
    !Number.isSafeInteger(lookback) ||
    lookback < 2 ||
    !Number.isFinite(entryZ) ||
    !Number.isFinite(exitZ) ||
    exitZ < 0 ||
    entryZ <= exitZ ||
    !Number.isFinite(minCorrelation) ||
    Math.abs(minCorrelation) > 1
  )
    throw new RangeError("Invalid pair or regression parameters");
  let window = new RollingFit(lookback);
  let active: ActiveLeg = "neutral";
  for (const { date, barA, barB } of pairSessions(input)) {
    let evidence = unknown();
    if (
      barA &&
      Number.isFinite(barA.close) &&
      barA.close > 0 &&
      barB &&
      Number.isFinite(barB.close) &&
      barB.close > 0
    ) {
      const latest = point(Math.log(barB.close), Math.log(barA.close));
      const fit = window.push(latest);
      if (fit.n === lookback)
        evidence = regression(fit, latest, minCorrelation);
    } else window = new RollingFit(lookback);
    const z = evidence.zScore;
    if (z === null || Math.abs(z) <= exitZ) active = "neutral";
    else if (z <= -entryZ) active = "A";
    else if (z >= entryZ) active = "B";
    yield decision(input, date, evidence, active);
  }
}

/** Replays the same state transitions as the schedule, including the hold band. */
export function evaluatePairSwitchZScore(input: PairSwitchInput) {
  let latest = decision(input, null, unknown(), "neutral");
  for (const row of decisions(input)) latest = row;
  return latest;
}

/** One row per visible calendar session or observed date across either leg.
 * Missing bars and unusable regressions target cash. sourceHash is the
 * caller's SHA-256 evidence digest for the frozen input. */
export function generatePairSwitchSchedule(
  input: PairSwitchInput & { sourceHash: string },
) {
  if (!/^[a-f0-9]{64}$/i.test(input.sourceHash))
    throw new RangeError("Expected a SHA-256 sourceHash");
  return Array.from(decisions(input), (row) => ({
    ...row,
    date: row.date!,
    availableAt: row.date!,
    sourceHash: input.sourceHash,
  }));
}
