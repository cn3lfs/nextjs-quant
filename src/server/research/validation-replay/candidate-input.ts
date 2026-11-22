import {
  type PortfolioRequest,
  type ValidationCandidate,
  validationEntryParameterSensitivity,
} from "quant-backtest";
import {
  prepareStrategy,
  usesStrategyBook,
  type ResearchCandidate,
  type StrategyObjectInput,
  type StrategyDecision,
} from "trading-strategies";
import { calculateFactor } from "trading-strategy-core/factors";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  validationHash,
  type FrozenValidationInput,
  type ValidationDataset,
} from "../validation-capture";
import {
  validationMemberActive,
  validationMembersAt,
} from "../validation-universe";
import { firstVintageValuations } from "../validation-financials";
import {
  CausalPriceBasisError,
  hasCausalPriceProof,
  missingCausalPriceBasis,
  requiresCausalPriceBasis,
} from "../causal-price-basis";

export type DecisionCache = Map<string, StrategyDecision[]>;
/** Freeze causal decisions on their native timeframe once, then replay them
 * on the same bars through the engine's existing external rule contract.
 * The identity binds the original strategy, source bars and build hash.
 */
export function projectCandidate(
  candidate: ResearchCandidate,
  dataset: ValidationDataset,
  frozen: FrozenValidationInput,
  cache: DecisionCache,
  progress?: (done: number, total: number) => void,
): ValidationCandidate | null {
  const s = candidate.strategy;
  let instruments = dataset.instruments;
  const native = s.entry.kind === "chan-third-buy";
  if (native)
    instruments = instruments.filter((i) =>
      frozen.native.some((n) => n.symbol === i.symbol),
    );
  if (!instruments.length) return null;
  if (requiresCausalPriceBasis(s)) {
    const sources = new Map(
      dataset.sources.map((source) => [source.symbol, source]),
    );
    for (const instrument of instruments) {
      const source = sources.get(instrument.symbol);
      if (
        !hasCausalPriceProof(
          source?.causalPrice,
          instrument.bars,
          instrument.signalBars,
        )
      )
        throw new CausalPriceBasisError(
          `${instrument.symbol}：${missingCausalPriceBasis}${source?.causalPriceGap ? `（${source.causalPriceGap}）` : ""}`,
        );
    }
  }
  const universe = frozen.universe;
  const timedMembership = frozen.timingContract === "p5" && universe !== null;
  const instrumentSymbols = new Set(
    instruments.map((instrument) => instrument.symbol),
  );
  const projectedRoster = universe?.members.filter((member) =>
    instrumentSymbols.has(member.symbol),
  );
  const members = new Map(
    projectedRoster?.map((member) => [member.symbol, member]),
  );
  const strategies: StrategyObjectInput[] = [];
  const projected = instruments.map((source, instrumentIndex) => {
    if (instrumentIndex % 32 === 0)
      progress?.(instrumentIndex, instruments.length);
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
        ...(source.external?.lowZone
          ? { lowZone: firstVintageValuations(source.external.lowZone) }
          : {}),
        ...(native ? { chan: capture!.observations } : {}),
      },
    };
    const rule = {
      ...s,
      universe: {
        kind: "symbols" as const,
        symbols: [...instrumentSymbols],
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
        (!member || validationMemberActive(member, b.date)),
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
        universe: timedMembership
          ? { kind: "pool", id: "validation-local-roster" }
          : rule.universe,
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
      // The original rule has already consumed/validated its input. Execution
      // uses these frozen decisions and levels only, without rebuilding unused
      // full-market RPS or valuation indices in every independent window.
      external: { signals, levels },
    };
  });
  progress?.(instruments.length, instruments.length);
  const request: PortfolioRequest = {
    market: s.market,
    observationDetail: usesStrategyBook(s) ? "full" : "counts",
    ...(frozen.input.policy.method === "lifecycle-2" && s.market === "cn-equity"
      ? {
          costs: {
            ...marketRules["cn-equity"].costs!,
            sellTaxSchedule: {
              kind: "cn-equity-historical" as const,
              multiplier: 1,
            },
          },
        }
      : {}),
    initial: frozen.input.initial,
    start: dataset.dates[0]!,
    end: dataset.dates.at(-1)!,
    calendar: dataset.benchmark.map((b) => b.date),
    ...(projectedRoster
      ? {
          memberships: dataset.benchmark.map((b) => ({
            strategyId: s.id,
            date: b.date,
            availableAt: b.date,
            symbols: validationMembersAt({ members: projectedRoster }, b.date),
          })),
        }
      : {}),
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
  return {
    id: s.id,
    family: candidate.family,
    request,
    ...(frozen.input.policy.method === "lifecycle-2"
      ? { entryParameterSensitivity: validationEntryParameterSensitivity([s]) }
      : {}),
  };
}
