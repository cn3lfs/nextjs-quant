import {
  runPortfolio,
  runValidationSuite,
  type ValidationScore,
} from "quant-backtest";
import { lowZoneCycles } from "trading-strategies";
import { multipleTesting, sharpeDaily } from "~/lib/backtest/multiple-testing";
import { combinatoriallySymmetricCv } from "~/lib/backtest/backtest-overfit";
import { indexFacts } from "../index-context";
import {
  assessValidationCandidates,
  validationMethodEvidence,
} from "../validation-method";
import { type FrozenValidationInput } from "../validation-capture";
import { type ScoreboardRow } from "../validation-model";
import { scoreValidationResult } from "./scoring";
import { type DecisionCache, projectCandidate } from "./candidate-input";
import { numericNeighbors } from "./parameter-neighbors";
import { validationBiasTags, biasLabels } from "./bias";
import { combinedBook } from "./combined-book";
import { projectToExecutionClock } from "./execution-clock";

export function replayValidationInput(
  frozen: FrozenValidationInput,
  progress: (n: number, phase: string) => void = () => {},
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
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
    ...numericNeighbors(c, frozen.input.policy.method),
  ]);
  const missing: { id: string; reason: string }[] = [];
  for (const [datasetIndex, dataset] of frozen.datasets.entries()) {
    const declared = candidates.filter(
      (c) => c.strategy.period === dataset.period,
    );
    const requests = declared.flatMap((candidate) => {
      const projected = projectCandidate(candidate, dataset, frozen, cache);
      if (projected) {
        const center = candidate.strategy.id.replace(
          /-neighbor-(?:entry-)?\d+$/,
          "",
        );
        projected.neighborIds = declared
          .filter(
            (c) =>
              c.strategy.id.replace(/-neighbor-(?:entry-)?\d+$/, "") ===
                center && c.strategy.id !== candidate.strategy.id,
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
      (result, request) =>
        scoreValidationResult(
          result,
          request,
          dataset,
          frozen.input.policy.method,
        ),
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
      score: scoreValidationResult(
        runPortfolio(r.request, undefined, undefined, signal),
        r.request,
        dataset,
      ),
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
                runPortfolio(cycleRequest, undefined, undefined, signal),
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
      if (
        frozen.input.policy.method !== "lifecycle-2" &&
        (overfit === null || overfit < frozen.input.policy.minimumDsr)
      )
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
  if (frozen.input.policy.method === "lifecycle-2") {
    const policy = {
      ...frozen.input.policy,
      trainBars: frozen.input.policy.trainBars ?? 20,
      testBars: frozen.input.policy.testBars ?? 5,
    };
    const evaluated = assessValidationCandidates(
      suites.flatMap(({ suite }) =>
        suite.rows.map((row) => {
          const strategy = candidates.find(
            (c) => c.strategy.id === row.id,
          )!.strategy;
          return { row, market: strategy.market, sleeve: strategy.sleeve };
        }),
      ),
      policy,
    );
    for (const board of boards) {
      const method = evaluated.find((row) => row.id === board.id);
      board.method = "lifecycle-2";
      board.purpose = policy.purpose;
      board.methodLabel =
        policy.purpose === "post-hoc"
          ? "post-hoc re-evaluation"
          : "preregistered method evaluation";
      if (method) {
        const domainReasons = board.reasons.filter(
          (reason) =>
            reason === "insufficient-complete-market-cycles" ||
            reason === "low-zone-input-confidence",
        );
        board.reasons = [...method.row.reasons, ...domainReasons];
        board.status = board.reasons.length ? "research" : "live-candidate";
      } else if (policy.purpose === "post-hoc") {
        board.reasons.push("post-hoc-re-evaluation-not-promotable");
        board.status = "research";
      }
    }
    for (const suite of suites)
      suite.diagnostics = {
        method: "lifecycle-2",
        purpose: policy.purpose,
        families: evaluated
          .filter((row) =>
            suite.suite.rows.some((candidate) => candidate.id === row.id),
          )
          .map(validationMethodEvidence),
      };
  }
  return {
    ...(frozen.input.policy.method === "lifecycle-2"
      ? { method: "lifecycle-2" as const, purpose: frozen.input.policy.purpose }
      : {}),
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
