import {
  runPortfolio,
  runValidationSuite,
  type PortfolioRequest,
  type ValidationCandidate,
  type ValidationScore,
} from "quant-backtest";
import { evaluatePerformance } from "quant-performance";
import {
  prepareStrategy,
  lowZoneCycles,
  type ResearchCandidate,
  type StrategyObjectInput,
  type StrategyDecision,
} from "trading-strategies";
import { calculateFactor } from "trading-strategy-core/factors";
import {
  equityDailyReturns,
  multipleTesting,
  sharpeDaily,
} from "~/lib/backtest/multiple-testing";
import { combinatoriallySymmetricCv } from "~/lib/backtest/backtest-overfit";
import { indexFacts } from "./index-context";
import {
  validationHash,
  type FrozenValidationInput,
  type ValidationDataset,
} from "./validation-capture";
import type { ScoreboardRow } from "./validation-model";

/** Benchmark opens on the first observed evaluation bar, then holds. Missing
 * any daily benchmark value leaves all excess statistics unavailable. */
export function scoreValidationResult(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  dataset: ValidationDataset,
): ValidationScore {
  const benchmark = new Map<string, { open: number; close: number }>();
  for (const b of dataset.benchmark.filter(
    (b) =>
      b.date.slice(0, 10) >= request.start &&
      b.date.slice(0, 10) <= request.end,
  )) {
    const date = b.date.slice(0, 10),
      prior = benchmark.get(date);
    benchmark.set(date, { open: prior?.open ?? b.open, close: b.close });
  }
  let previous: number | undefined;
  const points = result.equity.map((p) => {
    const b = benchmark.get(p.date);
    const benchmarkReturn = b ? b.close / (previous ?? b.open) - 1 : undefined;
    previous = b?.close;
    return { date: p.date, value: p.equity, benchmarkReturn };
  });
  const evaluation = evaluatePerformance(request.initial, points);
  let benchmarkNav = request.initial;
  const benchmarkEvaluation = points.every(
    (p) => p.benchmarkReturn !== undefined,
  )
    ? evaluatePerformance(
        request.initial,
        points.map((p) => ({
          date: p.date,
          value: (benchmarkNav *= 1 + p.benchmarkReturn!),
        })),
      )
    : null;
  const difference = (a: number | null, b: number | null) =>
    a === null || b === null ? null : a - b;
  const benchmarkSharpe = benchmarkEvaluation?.sharpe.value ?? null;
  const benchmarkCalmar = benchmarkEvaluation?.calmar.value ?? null;
  return {
    riskAdjusted: {
      sharpe: evaluation.sharpe.value,
      benchmarkSharpe,
      sharpeDifference: difference(evaluation.sharpe.value, benchmarkSharpe),
      calmar: evaluation.calmar.value,
      benchmarkCalmar,
      calmarDifference: difference(evaluation.calmar.value, benchmarkCalmar),
      basis:
        "quant-performance: daily close, 252 observations/year, 2% risk-free; same-window benchmark; crypto comparison is a common convention, not 365-day annualization",
    },
    return: evaluation.totalReturn.value,
    excess: evaluation.excessReturn.value,
    drawdown: evaluation.maxDrawdown.value,
    trades: result.fills.filter(
      (f) => f.side === "sell" && f.holdingAfter === 0,
    ).length,
    events: {
      entries: result.observations.filter((o) => o.decision.entry === true)
        .length,
      exits: result.observations.filter((o) => o.decision.exit === true).length,
      orders: result.orders.length,
      fills: result.fills.length,
      rejectionAttempts: result.rejections.length,
    },
    daily: equityDailyReturns(points, request.initial),
  };
}

type DecisionCache = Map<string, StrategyDecision[]>;
/** Freeze causal decisions on their native timeframe once, then replay them
 * on the same bars through the engine's existing external rule contract.
 * The identity binds the original strategy, source bars and build hash.
 */
export function projectCandidate(
  candidate: ResearchCandidate,
  dataset: ValidationDataset,
  frozen: FrozenValidationInput,
  cache: DecisionCache,
): ValidationCandidate | null {
  const s = candidate.strategy;
  let instruments = dataset.instruments;
  const native = s.entry.kind === "chan-third-buy";
  if (native)
    instruments = instruments.filter((i) =>
      frozen.native.some((n) => n.symbol === i.symbol),
    );
  if (!instruments.length) return null;
  const universe = frozen.universe;
  const members = new Map(universe?.members.map((m) => [m.symbol, m]));
  const strategies: StrategyObjectInput[] = [];
  const projected = instruments.map((source) => {
    const member = members.get(source.symbol);
    const capture = frozen.native.find(
      (n) => n.symbol === source.symbol,
    )?.capture;
    const origin = native
      ? source.bars.findIndex((b) => b.date === capture!.originDate)
      : 0;
    const instrument = {
      ...source,
      bars: source.bars.slice(origin),
      signalBars: source.signalBars.slice(origin),
      external: {
        ...source.external,
        ...(native ? { chan: capture!.observations } : {}),
      },
    };
    const rule = {
      ...s,
      universe: {
        kind: "symbols" as const,
        symbols: instruments.map((i) => i.symbol),
      },
      exit: { rule: s.exit.rule },
    };
    const key = validationHash([
      rule.entry,
      rule.exit,
      source.symbol,
      dataset.period,
    ]);
    let decisions = cache.get(key);
    if (!decisions) {
      const prepared = prepareStrategy(
        rule,
        instrument.signalBars,
        instrument.external,
      );
      decisions = instrument.signalBars.map((b, i) =>
        b.date.slice(0, 10) < dataset.dates[0]!
          ? { entry: null, exit: null, stopLevel: null }
          : prepared.evaluate(i),
      );
      cache.set(key, decisions);
    }
    const stop = s.exit.stop;
    const atr =
      stop?.kind === "atr"
        ? calculateFactor(instrument.signalBars, {
            id: "atr",
            parameters: { period: stop.period },
          }).values
        : null;
    const signals = instrument.signalBars.map((b, i) => ({
      id: s.id,
      date: b.date,
      availableAt: b.date,
      entry:
        decisions![i]!.entry === true &&
        (!member?.listingDate || member.listingDate <= b.date) &&
        (!member?.delistingDate || member.delistingDate > b.date),
      exit: decisions![i]!.exit === true,
    }));
    const levels =
      atr && stop?.kind === "atr"
        ? instrument.signalBars.flatMap((b, i) => {
            const value =
              atr[i] == null ? null : b.close - atr[i]! * stop.multiple;
            return value !== null && value > 0
              ? [{ date: b.date, availableAt: b.date, field: s.id, value }]
              : [];
          })
        : [];
    if (!strategies.length)
      strategies.push({
        ...s,
        universe: rule.universe,
        entry: { kind: "external", id: s.id, side: "entry" },
        exit: {
          ...s.exit,
          rule: { kind: "external", id: s.id, side: "exit" },
          ...(stop?.kind === "atr"
            ? { stop: { kind: "structure", field: s.id } as const }
            : {}),
        },
      });
    return {
      ...instrument,
      external: { ...instrument.external, signals, levels },
    };
  });
  const request: PortfolioRequest = {
    market: s.market,
    initial: frozen.input.initial,
    start: dataset.dates[0]!,
    end: dataset.dates.at(-1)!,
    calendar: dataset.benchmark.map((b) => b.date),
    instruments: projected,
    strategies,
    sleeves: [
      {
        id: s.sleeve,
        share: 1,
        riskPerTrade: s.sleeve === "low-zone" ? 0.1 : 0.02,
        maxPositions: s.sleeve === "breakout" ? 3 : 10,
      },
    ],
  };
  return { id: s.id, family: candidate.family, request };
}

export function numericNeighbors(
  candidate: ResearchCandidate,
): ResearchCandidate[] {
  const stop = candidate.strategy.exit.stop;
  if (!stop) return [];
  return [0.9, 1.1].map((factor) => ({
    ...candidate,
    strategy: {
      ...candidate.strategy,
      id: `${candidate.strategy.id}-neighbor-${Math.round(factor * 100)}`,
      exit: {
        ...candidate.strategy.exit,
        ...(candidate.variant === "atr" && stop.kind === "atr"
          ? { stop: { ...stop, multiple: stop.multiple * factor } }
          : {}),
        ...(candidate.variant === "trailing"
          ? { trailing: candidate.strategy.exit.trailing! * factor }
          : {}),
        ...(candidate.variant === "time" && candidate.strategy.exit.maxBars
          ? {
              maxBars: Math.max(
                1,
                Math.round(candidate.strategy.exit.maxBars * factor),
              ),
            }
          : {}),
        ...(candidate.variant === "time" &&
        !candidate.strategy.exit.maxBars &&
        stop.kind === "fixed"
          ? { stop: { ...stop, fraction: stop.fraction * factor } }
          : {}),
      },
    },
    boundary: `${candidate.boundary}; predeclared numeric exit neighbor x${factor}`,
  }));
}
export function replayValidationInput(
  frozen: FrozenValidationInput,
  progress: (n: number, phase: string) => void = () => {},
) {
  const boards: ScoreboardRow[] = [];
  const suites: {
    period: string;
    suite: ReturnType<typeof runValidationSuite>;
    diagnostics: unknown;
    regimes: unknown;
  }[] = [];
  const combinedBooks: ReturnType<typeof combinedBook>[] = [];
  const cycleEvaluations: {
    id: string;
    cycles: {
      start: string;
      end: string;
      complete: boolean;
      evaluation: ValidationScore;
    }[];
  }[] = [];
  const cache: DecisionCache = new Map();
  const candidates = frozen.candidateMenu.flatMap((c) => [
    c,
    ...numericNeighbors(c),
  ]);
  const missing: { id: string; reason: string }[] = [];
  for (const [datasetIndex, dataset] of frozen.datasets.entries()) {
    const declared = candidates.filter(
      (c) => c.strategy.period === dataset.period,
    );
    const requests = declared.flatMap((candidate) => {
      const projected = projectCandidate(candidate, dataset, frozen, cache);
      if (projected) {
        const center = candidate.strategy.id.replace(/-neighbor-\d+$/, "");
        projected.neighborIds = declared
          .filter(
            (c) =>
              c.strategy.id.replace(/-neighbor-\d+$/, "") === center &&
              c.strategy.id !== candidate.strategy.id,
          )
          .map((c) => c.strategy.id);
      }
      if (!projected)
        missing.push({
          id: candidate.strategy.id,
          reason: "Required frozen serial native observations unavailable",
        });
      return projected ? [projected] : [];
    });
    if (!requests.length) continue;
    const n = dataset.dates.length;
    const suite = runValidationSuite(
      requests,
      dataset.dates,
      {
        ...frozen.input.policy,
        trainBars:
          frozen.input.policy.trainBars ?? Math.max(20, Math.floor(n * 0.4)),
        testBars:
          frozen.input.policy.testBars ?? Math.max(5, Math.floor(n * 0.1)),
      },
      (result, request) => scoreValidationResult(result, request, dataset),
      (done, total) =>
        progress(
          Math.round(
            40 + (45 * (datasetIndex + done / total)) / frozen.datasets.length,
          ),
          `验证 ${dataset.period} ${done}/${total}`,
        ),
    );
    const fullPeriod = requests.map((r) => ({
      id: r.id,
      score: scoreValidationResult(runPortfolio(r.request), r.request, dataset),
    }));
    const trials = fullPeriod.map((r) => sharpeDaily(r.score.daily));
    const diagnostics = {
      trialsLowerBound: requests.length,
      multipleTesting: suite.rows.map((r) => ({
        id: r.id,
        result: multipleTesting(
          r.windows.flatMap((w) => w.base.daily),
          trials,
          frozen.input.market === "crypto" ? 365 : 252,
        ),
      })),
      selectedFamilies: [...new Set(requests.map((r) => r.family))].map(
        (family) => ({
          family,
          result: multipleTesting(
            suite.selectedOos.flatMap(
              (w) =>
                w.families.find((f) => f.family === family)!.result.base.daily,
            ),
            trials,
            frozen.input.market === "crypto" ? 365 : 252,
          ),
        }),
      ),
      cscv: combinatoriallySymmetricCv({
        returns: fullPeriod.map((r) => r.score.daily),
        metric: "sharpe",
      }),
      boundary:
        "CSCV is a Sharpe diagnostic, not certification of the actual training excess-return selector; trial count is a lower bound. OOS folds have independent capital; final split overlaps folds and is not another independent sample.",
    };
    const benchmarkDaily = new Map<
      string,
      (typeof dataset.benchmark)[number]
    >();
    for (const bar of dataset.benchmark)
      benchmarkDaily.set(bar.date.slice(0, 10), {
        ...bar,
        date: bar.date.slice(0, 10),
      });
    const benchmarkBars = [...benchmarkDaily.values()];
    const regimeByDate = new Map(
      dataset.dates.map((date) => {
        const facts = indexFacts(benchmarkBars, date);
        const regime =
          facts.close === null || facts.ma20 === null || facts.ma60 === null
            ? "unknown"
            : facts.close > facts.ma60 && facts.ma20 > facts.ma60
              ? "rising"
              : facts.close < facts.ma60 && facts.ma20 < facts.ma60
                ? "falling"
                : "mixed";
        return [date, regime];
      }),
    );
    const regimes = suite.rows.map((r) => ({
      id: r.id,
      groups: ["rising", "falling", "mixed", "unknown"].map((regime) => {
        const values: number[] = [];
        r.windows.forEach((window) => {
          const dates = dataset.dates.filter(
            (d) => d >= window.start && d <= window.end,
          );
          window.base.daily.forEach((value, i) => {
            if (value === null || !dates[i]) return;
            const actual = regimeByDate.get(dates[i]!);
            if (actual === regime) values.push(value);
          });
        });
        return {
          regime,
          observations: values.length,
          conditionalReturn: values.length
            ? values.reduce((v, r) => v * (1 + r), 1) - 1
            : null,
          boundary:
            "Conditional daily attribution, not a continuous investible path or full market temperature",
        };
      }),
    }));
    suites.push({ period: dataset.period, suite, diagnostics, regimes });
    for (const row of suite.rows) {
      const candidate = declared.find((c) => c.strategy.id === row.id)!;
      const reasons = [...row.reasons];
      if (candidate.strategy.sleeve === "low-zone") {
        const index = frozen.lowZones.find((l) => l.symbol === "sh000300");
        const request = requests.find((r) => r.id === row.id)!.request;
        const cycles = lowZoneCycles(index?.observations ?? [])
          .filter((c) => c.start >= request.start && c.start <= request.end)
          .map((c) => {
            const cycleRequest = {
              ...request,
              start: c.start,
              end: c.end < request.end ? c.end : request.end,
            };
            return {
              start: c.start,
              end: cycleRequest.end,
              complete: c.complete && c.end <= request.end,
              evaluation: scoreValidationResult(
                runPortfolio(cycleRequest),
                cycleRequest,
                dataset,
              ),
            };
          });
        cycleEvaluations.push({ id: row.id, cycles });
        if (
          cycles.filter((c) => c.complete).length <
          frozen.input.policy.minimumMarketCycles
        )
          reasons.push("insufficient-complete-market-cycles");
      }
      const overfit = diagnostics.multipleTesting.find((d) => d.id === row.id)!
        .result.selected.dsr.value;
      if (overfit === null || overfit < frozen.input.policy.minimumDsr)
        reasons.push(`multiple-testing-dsr-${frozen.input.policy.minimumDsr}`);
      if (
        candidate.strategy.sleeve === "low-zone" &&
        frozen.lowZones.some((l) =>
          l.observations
            .filter((o) => o.depth && o.depth > 0)
            .some((o) => o.confidence !== "corroborated"),
        )
      )
        reasons.push("low-zone-input-confidence");
      boards.push({
        riskAdjusted: row.holdout.base.riskAdjusted,
        biasTags: validationBiasTags(frozen),
        id: row.id,
        level: "strategy",
        market: candidate.strategy.market,
        sleeve: candidate.strategy.sleeve,
        rule: `${candidate.family} / ${candidate.variant} / ${candidate.strategy.period}`,
        status: reasons.length ? "research" : "live-candidate",
        return: row.holdout.base.return,
        excess: row.holdout.base.excess,
        drawdown: row.holdout.base.drawdown,
        trades: row.closedTrades,
        oosWindows: row.windows.length,
        positiveWindows: row.positiveWindows,
        bias: biasLabels(frozen, candidate.strategy.sleeve),
        reasons,
      });
    }
    // Fixed ATR presets chosen before looking at OOS. No best-OOS selector.
    const first = requests.find(
      (r) =>
        r.id.includes(
          frozen.input.market === "cn-equity" ? "rps-multi-atr" : "dual-ma-",
        ) && r.id.endsWith("-atr"),
    );
    const second = requests.find((r) => r.id.endsWith("historical-low-atr"));
    if (first && frozen.input.market === "cn-equity") {
      const book = combinedBook(
        frozen,
        dataset,
        first.request,
        second?.request,
      );
      combinedBooks.push(book);
      boards.push(...book.rows);
    }
    cache.clear();
  }
  const base = frozen.datasets.find((d) => d.period === "15m"),
    swing = frozen.datasets.find((d) => d.period === "4h"),
    breakout = frozen.datasets.find((d) => d.period === "1h");
  if (frozen.input.market === "crypto" && base && swing && breakout) {
    const a = candidates.find(
      (c) => c.family === "dual-ma-4h" && c.variant === "atr",
    );
    const b = candidates.find(
      (c) => c.family === "range-1h" && c.variant === "atr",
    );
    if (a && b) {
      const primary = projectCandidate(a, swing, frozen, cache),
        secondary = projectCandidate(b, breakout, frozen, cache);
      if (primary && secondary) {
        const book = combinedBook(
          frozen,
          base,
          projectToExecutionClock(primary.request, base, 16),
          projectToExecutionClock(secondary.request, base, 4),
        );
        combinedBooks.push(book);
        boards.push(...book.rows);
      }
    }
  }
  for (const candidate of candidates.filter(
    (c) => !frozen.datasets.some((d) => d.period === c.strategy.period),
  ))
    missing.push({
      id: candidate.strategy.id,
      reason: "Required public OHLC timeframe unavailable",
    });
  return {
    version: "research-validation-scoreboard-1" as const,
    rows: boards,
    suites,
    combinedBooks,
    missing,
    cycleEvaluations,
    lowZone: frozen.lowZones.map((row) => ({
      symbol: row.symbol,
      cycles: lowZoneCycles(row.observations),
      triggers: row.observations.filter(
        (o, i) =>
          o.depth !== null &&
          o.depth > 0 &&
          o.depth > (row.observations[i - 1]?.depth ?? 0),
      ),
      recoveries: row.observations
        .filter((o, i) => o.recovery && !row.observations[i - 1]?.recovery)
        .map((o) => o.date),
      coverage: {
        start: row.observations[0]?.date,
        end: row.observations.at(-1)?.date,
        observations: row.observations.length,
      },
    })),
    promoted: boards
      .filter((r) => r.status === "live-candidate")
      .map((r) => r.id),
  };
}

export function validationBiasTags(
  frozen: FrozenValidationInput,
): NonNullable<ScoreboardRow["biasTags"]> {
  const tags: NonNullable<ScoreboardRow["biasTags"]> = [];
  if (!frozen.evidence.universeComplete)
    tags.push({
      code: "historical-universe-incomplete",
      severity: "high",
      detail:
        "可枚举历史证券池不完整，退市覆盖未知；免费数据研究偏差，不阻断统计晋级",
    });
  if (!frozen.evidence.executionVerified)
    tags.push(
      frozen.input.market === "cn-equity"
        ? {
            code: "historical-execution-unverified",
            severity: "high",
            detail: "历史ST/IPO/队列、成交及现金到账采用未认证情景",
          }
        : {
            code: "historical-venue-filters-and-liquidity-unverified",
            severity: "high",
            detail: "历史平台数量步长、最小金额和流动性容量未认证",
          },
    );
  return tags;
}

function biasLabels(
  frozen: FrozenValidationInput,
  sleeve: string,
): ScoreboardRow["bias"] {
  return {
    universe:
      frozen.universe?.grade ??
      "Current liquid spot selection, delisted history unknown",
    adjustment:
      frozen.input.market === "cn-equity"
        ? "Signals: frozen forward basis; RPS: backward; fills: raw; ex-date cash scenario"
        : "Raw public spot OHLC",
    financial:
      sleeve === "low-zone" ||
      (sleeve === "combined" && frozen.input.market === "cn-equity")
        ? "PIT announcement filter; current revision approximate; missing temperature/valuation explicit"
        : "Not used",
    execution:
      frozen.input.market === "cn-equity"
        ? "Board limit scenario, ST/IPO/queue and payment dates unverified; rule-check-only"
        : "Experimental spot grid/costs, no historical filters/capacity certification; rule-check-only",
  };
}

export function combinedBook(
  frozen: FrozenValidationInput,
  dataset: ValidationDataset,
  primary: PortfolioRequest,
  secondary?: PortfolioRequest,
) {
  const shares = frozen.input.market === "cn-equity" ? [1, 0.65] : [0.75, 0.8];
  const variants = shares.map((share, index) => {
    const strategies = [
      ...primary.strategies,
      ...(secondary?.strategies ?? []),
    ];
    const instruments = primary.instruments.map((p) => {
      const other = secondary?.instruments.find((s) => s.symbol === p.symbol);
      return {
        ...p,
        external: {
          ...p.external,
          signals: [
            ...(p.external?.signals ?? []),
            ...(other?.external?.signals ?? []),
          ],
          levels: [
            ...(p.external?.levels ?? []),
            ...(other?.external?.levels ?? []),
          ],
        },
      };
    });
    const low = combinedLowZoneTargets(frozen, primary);
    const sleeves = [
      { ...primary.sleeves[0]!, share: secondary ? share : 1 },
      ...(secondary ? [{ ...secondary.sleeves[0]!, share: 1 - share }] : []),
    ];
    const request: PortfolioRequest = {
      ...primary,
      strategies,
      instruments,
      sleeves,
      rebalance: { everyBars: 20, drift: 0.05 },
      ...(secondary && index === 0 && frozen.input.market === "cn-equity"
        ? { sleeveTargets: low }
        : {}),
    };
    const result = runPortfolio(request);
    const score = scoreValidationResult(result, request, dataset);
    const transfersBySleeve = new Map<string, Map<string, number>>();
    for (const transfer of result.transfers) {
      const dates =
        transfersBySleeve.get(transfer.sleeve) ?? new Map<string, number>();
      dates.set(
        transfer.date,
        (dates.get(transfer.date) ?? 0) + transfer.amount,
      );
      transfersBySleeve.set(transfer.sleeve, dates);
    }
    const sleeveScores = sleeves.map((s) => {
      // Remove cash transfers before computing sleeve time-weighted returns.
      let previous = frozen.input.initial * s.share;
      const byDay = new Map<string, number[]>();
      for (const point of result.curve) {
        const current = point.sleeves.find((r) => r.id === s.id)!.equity;
        const transfer = transfersBySleeve.get(s.id)?.get(point.date) ?? 0;
        const value = previous > 0 ? (current - transfer) / previous - 1 : null;
        previous = current;
        const day = point.date.slice(0, 10),
          values = byDay.get(day) ?? [];
        if (value !== null) values.push(value);
        byDay.set(day, values);
      }
      const daily = result.equity.map((p) => {
        const values = byDay.get(p.date)!;
        return values.length
          ? values.reduce((v, r) => v * (1 + r), 1) - 1
          : null;
      });
      let nav = 1;
      const active = daily.flatMap((value, i) =>
        value === null
          ? []
          : [{ date: result.equity[i]!.date, value: (nav *= 1 + value) }],
      );
      const evaluation = evaluatePerformance(1, active);
      return {
        sleeve: s.id,
        daily,
        observed: active.length,
        return: evaluation.totalReturn.value,
        drawdown: evaluation.maxDrawdown.value,
      };
    });
    const a = sleeveScores[0]?.daily ?? [],
      b = sleeveScores[1]?.daily ?? [];
    const pairs = a.flatMap((v, i) =>
      v !== null && b[i] != null ? [[v, b[i]!] as const] : [],
    );
    const meanA = pairs.reduce((n, p) => n + p[0], 0) / pairs.length,
      meanB = pairs.reduce((n, p) => n + p[1], 0) / pairs.length;
    const covariance = pairs.reduce(
      (n, p) => n + (p[0] - meanA) * (p[1] - meanB),
      0,
    );
    const denominator = Math.sqrt(
      pairs.reduce((n, p) => n + (p[0] - meanA) ** 2, 0) *
        pairs.reduce((n, p) => n + (p[1] - meanB) ** 2, 0),
    );
    return {
      name: index === 0 ? "default" : "comparison",
      shares: Object.fromEntries(sleeves.map((s) => [s.id, s.share])),
      score,
      sleeveScores,
      correlation:
        pairs.length >= 20 && denominator > 0 ? covariance / denominator : null,
      overlapDays: pairs.length,
      transfers: result.transfers,
      sleeveCurves: result.equity.map((p) => ({
        date: p.date,
        sleeves: p.sleeves,
      })),
    };
  });
  const rows: ScoreboardRow[] = variants.map((v) => ({
    riskAdjusted: v.score.riskAdjusted,
    biasTags: validationBiasTags(frozen),
    id: `book-${frozen.input.market}-${dataset.period}-${v.name}`,
    market: frozen.input.market,
    level: "market",
    sleeve: "combined",
    rule: `${dataset.period} fixed predeclared presets / ${v.name}`,
    status: "research",
    return: v.score.return,
    excess: v.score.excess,
    drawdown: v.score.drawdown,
    trades: v.score.trades,
    oosWindows: 0,
    positiveWindows: 0,
    bias: biasLabels(frozen, "combined"),
    reasons: ["descriptive-full-period-book-not-independent-oos"],
  }));
  for (const sleeve of variants[0]!.sleeveScores) {
    rows.push({
      ...rows[0]!,
      id: `sleeve-${frozen.input.market}-${dataset.period}-${sleeve.sleeve}`,
      level: "sleeve",
      sleeve: sleeve.sleeve,
      bias: biasLabels(frozen, sleeve.sleeve),
      return: sleeve.return,
      excess: null,
      drawdown: sleeve.drawdown,
      reasons: [
        "transfer-adjusted-conditional-sleeve-returns",
        "inactive-days-excluded-not-zero-filled",
      ],
    });
  }
  return {
    market: frozen.input.market,
    period: dataset.period,
    variants,
    rows,
    boundary:
      frozen.input.market === "crypto"
        ? "4h swing + 1h breakout on the shared 15m execution clock; 75/25 vs 80/20; completed native-timeframe decisions only, stops monitored every 15m. Time stops scaled by interval duration."
        : "Index or eligible stock low-zone 0/30/35/40 vs static 65/35. Only idle cash rebalances; holdings are never forced closed.",
  };
}

export function combinedLowZoneTargets(
  frozen: FrozenValidationInput,
  primary: PortfolioRequest,
) {
  const symbols = new Set([
    "sh000300",
    ...primary.instruments.map((i) => i.symbol),
  ]);
  const events = frozen.lowZones
    .filter((l) => symbols.has(l.symbol))
    .flatMap((l) => l.observations.map((o) => ({ ...o, symbol: l.symbol })))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
    );
  const state = new Map<string, number>();
  const targets: NonNullable<PortfolioRequest["sleeveTargets"]>[number][] = [];
  let cursor = 0;
  for (const date of primary.calendar) {
    while (events[cursor] && events[cursor]!.date <= date) {
      const e = events[cursor++]!;
      state.set(e.symbol, e.targetShare);
    }
    for (const member of frozen.universe?.members ?? [])
      if (member.delistingDate && member.delistingDate <= date)
        state.delete(member.symbol);
    const share = Math.max(0, ...state.values());
    targets.push({
      date,
      availableAt: date,
      shares: { swing: 1 - share, "low-zone": share },
    });
  }
  return targets;
}

export function projectToExecutionClock(
  request: PortfolioRequest,
  base: ValidationDataset,
  factor: number,
): PortfolioRequest {
  const strategies = request.strategies.map((s) => ({
    ...s,
    ...(s.exit.maxBars
      ? { exit: { ...s.exit, maxBars: s.exit.maxBars * factor } }
      : {}),
  }));
  const instruments = base.instruments.flatMap((instrument) => {
    const original = request.instruments.find(
      (i) => i.symbol === instrument.symbol,
    );
    if (!original) return [];
    const signals = new Map(
      original.external?.signals?.map((s) => [Date.parse(s.date), s]),
    );
    const levels = new Map(
      original.external?.levels?.map((s) => [Date.parse(s.date), s]),
    );
    const entry = strategies[0]!.entry;
    if (entry.kind !== "external")
      throw new Error(
        "Common-clock replay requires frozen native-timeframe decisions",
      );
    return [
      {
        ...instrument,
        external: {
          signals: instrument.bars.map((b) => ({
            id: entry.id,
            date: b.date,
            availableAt: b.date,
            entry: signals.get(Date.parse(b.date))?.entry ?? false,
            exit: signals.get(Date.parse(b.date))?.exit ?? false,
          })),
          levels: instrument.bars.flatMap((b) => {
            const level = levels.get(Date.parse(b.date));
            return level
              ? [{ ...level, date: b.date, availableAt: b.date }]
              : [];
          }),
        },
      },
    ];
  });
  return {
    ...request,
    strategies,
    instruments,
    calendar: base.benchmark.map((b) => b.date),
    start: [request.start, base.dates[0]!].sort().at(-1)!,
    end: [request.end, base.dates.at(-1)!].sort()[0]!,
  };
}
