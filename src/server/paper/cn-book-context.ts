import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  applyAdjustmentAtAnchor,
  adjustmentFactors,
  parseGbbqFile,
  readStableLocalFile,
  resolveTdxRoot,
} from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import {
  csi800SignalBars,
  evaluateStrategyBook,
  prepareStrategy,
  prepareStrategyRulePoints,
  strategyObjectSchema,
  type ClassicWeek,
  type Csi800Stock,
  type MarketLowZoneInput,
  type PreparedStrategyRule,
  type StrategyBookFacts,
  type StrategyBookState,
} from "trading-strategies";
import {
  buildClassicObservation,
  captureClassicFinancial,
  type ClassicFinancialInput,
  type ClassicPriceInput,
} from "../../../scripts/lib/csi800-factor-data";
import { readBars } from "../market/bar-store/read-bars";
import {
  readIndustryBlocks,
  parseIndustryMembers,
} from "../market/industry-blocks";
import {
  buildLifecycleRps,
  lifecycleFinancialValuations,
  lifecycleRpsPeriods,
  lifecycleContentHash,
  lifecycleRawPrefixHash,
  readLifecycleSourceManifest,
  readLifecycleSignalOriginBars,
} from "../research/lifecycle-source";
import { projectLifecycleLowZone } from "../research/lifecycle-low-zone";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "../research/corporate-actions";
import { forwardDefinitionHash } from "../db/forward-reference-repository";
import { forwardExecutionBuildHash } from "../research/forward-identity";
import { PaperRepository } from "../db/paper-repository";
import { settings } from "../infra/settings";
import type { PaperAccount, PaperState } from "./model";
import type { PaperInput } from "./advance";

const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Identical object-key normalization is also used by the frozen source proof. */
export const cnPaperContentHash = lifecycleContentHash;
const weekOf = (date: string) => {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
};
export function cnPaperWeeklyDates(
  calendar: readonly string[],
  through: string,
) {
  return calendar.flatMap((date, index) =>
    date <= through &&
    calendar[index + 1] &&
    weekOf(date) !== weekOf(calendar[index + 1]!)
      ? [{ date, nextDate: calendar[index + 1]! }]
      : [],
  );
}

export type CnPaperCapture = {
  /** The fixed original pool, not the execution mask. All prices start at the
   * published per-symbol origin; a longer current TDX series cannot reseed DB. */
  stocks: readonly Csi800Stock[];
  actionsBySymbol?: ReadonlyMap<
    string,
    NonNullable<PortfolioInstrument["actions"]>
  >;
  baselineStocks: readonly Csi800Stock[];
  benchmark: readonly Bar[];
  calendar: readonly string[];
  classicWeeks: readonly ClassicWeek[];
  firstSignal: string;
  financial?: ClassicFinancialInput;
  industries: NonNullable<StrategyBookFacts["industries"]>;
  lowZoneInput?: MarketLowZoneInput;
  sourceHashes: Readonly<Record<string, string>>;
  observationSourceHashes: Readonly<Record<string, string>>;
  sourceIdentity: Readonly<Record<string, unknown>>;
  buildHash: string;
};

/** Pure assembly. Full history is used by the original compiler and then
 * projected to genuine points. No warmup orders, money or DD are inherited. */
export function compileCnPaperContext(
  account: PaperAccount,
  capture: CnPaperCapture,
  readyDates: readonly string[],
  previous: PaperState | null = null,
): PaperInput {
  if (account.market !== "cn-equity" || !readyDates.length)
    throw new Error("CN paper context requires completed forward dates");
  const first = previous?.request.start ?? readyDates[0]!;
  const through = readyDates.at(-1)!;
  const candidates = account.candidates;
  if (
    candidates.some(
      (row) =>
        row.strategy.market !== "cn-equity" ||
        row.strategy.period !== "day" ||
        row.sourceContext?.sourceKey !== "cn-day",
    )
  )
    throw new Error(
      "CN book provider requires the frozen native daily CN source",
    );
  const policy = candidates[0]!.executionPolicy;
  if (
    !policy ||
    !policy.costs ||
    candidates.some((row) => !isDeepStrictEqual(row.executionPolicy, policy))
  )
    throw new Error("CN paper context requires one immutable execution policy");
  const rawUniverse = candidates[0]!.sourceContext?.rawUniverse;
  if (
    !rawUniverse ||
    !rawUniverse.symbols.length ||
    !isDeepStrictEqual(
      [...rawUniverse.symbols].sort(),
      capture.stocks.map((stock) => stock.symbol).sort(),
    )
  )
    throw new Error(
      "CN paper context lacks the exact frozen raw ranking universe",
    );
  const baselineBySymbol = new Map(
    capture.baselineStocks.map((stock) => [stock.symbol, stock]),
  );
  if (rawUniverse.symbols.some((symbol) => !baselineBySymbol.has(symbol)))
    throw new Error("Missing original800 BASE risk source");
  const calendar = capture.calendar.filter(
    (date) =>
      date <= through || date === capture.calendar.find((d) => d > through),
  );
  const weeks = cnPaperWeeklyDates(capture.calendar, through);
  const seed = weeks.filter((row) => row.date < first).at(-1);
  const minimumDate = candidates.some((row) => row.strategy.rebalance)
    ? (seed?.date ?? first)
    : first;
  const minimumIndex = calendar.indexOf(minimumDate);
  if (minimumIndex < 60)
    throw new Error(
      "CN paper context lacks61 completed risk closes before its first observation",
    );
  const retainFrom = calendar[minimumIndex - 60]!;
  const forwardDates = calendar.filter(
    (date) => date >= first && date <= through,
  );
  const rps = buildLifecycleRps(
    capture.stocks,
    capture.calendar.filter((date) => date <= through),
    lifecycleRpsPeriods,
  );
  const sourceStocks = new Map(
    capture.stocks.map((stock) => [stock.symbol, stock]),
  );
  const calendarIndices = new Map(
    capture.calendar.map((date, index) => [date, index]),
  );
  const sourceCoverage = new Map(
    capture.stocks.map((stock) => {
      const dates = new Set(stock.bars.map((bar) => bar.date));
      const prefix = new Int32Array(capture.calendar.length + 1);
      for (let index = 0; index < capture.calendar.length; index++)
        prefix[index + 1] =
          prefix[index]! + Number(!dates.has(capture.calendar[index]!));
      return [
        stock.symbol,
        { prefix, first: calendarIndices.get(stock.bars[0]?.date ?? "") ?? -1 },
      ] as const;
    }),
  );
  const baselineRisk = candidates.some(
    (row) => row.strategy.rank?.kind === "classic",
  )
    ? capture.baselineStocks.map((stock) => ({
        symbol: stock.symbol,
        bars: csi800SignalBars(stock),
      }))
    : [];
  const baseInstruments: PortfolioInstrument[] =
    candidates[0]!.sourceContext!.universeSymbols.map((symbol) => {
      const stock = sourceStocks.get(symbol);
      if (!stock) throw new Error(`Missing frozen execution member ${symbol}`);
      return {
        symbol,
        market: "cn-equity",
        bars: stock.bars,
        signalBars: stock.signalBars ?? csi800SignalBars(stock),
        actions: [],
        execution: {},
        external: { rps: rps.rpsBySymbol.get(symbol) ?? [] },
      };
    });
  const facts: Record<string, StrategyBookFacts> = {};
  const groups = new Map<string, PreparedStrategyRule[]>();
  const bookSeeds: NonNullable<PortfolioRequest["bookSeeds"]>[number][] = [];
  const panels = new Map(capture.classicWeeks.map((row) => [row.date, row]));
  const memberships: NonNullable<PortfolioRequest["memberships"]>[number][] =
    [];
  for (const value of Object.values(previous?.request.bookFacts ?? {}))
    for (const panel of value.classicWeeks ?? []) panels.set(panel.date, panel);
  for (const candidate of candidates) {
    const strategy = strategyObjectSchema.parse(candidate.strategy);
    if (strategy.regime && strategy.regime.benchmark !== "sh000906")
      throw new Error(
        "CN book provider has no actual source for the declared regime benchmark",
      );
    if (
      !candidate.sourceContext ||
      !isDeepStrictEqual(candidate.sourceContext.rawUniverse, rawUniverse)
    )
      throw new Error(
        "CN paper candidates do not share the same immutable raw pool",
      );
    if (strategy.rank?.kind === "classic") {
      if (!capture.financial)
        throw new Error("Missing current classic financial capture");
      const earliest =
        previous?.request.bookSeeds?.find(
          (row) => row.strategyId === strategy.id,
        )?.date ?? capture.firstSignal;
      for (const observation of weeks.filter(
        (row) => row.date >= earliest && !panels.has(row.date),
      )) {
        const price: ClassicPriceInput = {
          version: "csi800-frozen-1",
          start: capture.calendar[0]!,
          end: observation.date,
          initial: policy.initial,
          benchmark: capture.benchmark.filter(
            (bar) => bar.date <= observation.date,
          ),
          stocks: capture.baselineStocks.map((stock) => ({
            symbol: stock.symbol,
            actions: stock.actions,
            bars: stock.bars.filter((bar) => bar.date <= observation.date),
          })),
        };
        panels.set(
          observation.date,
          buildClassicObservation(price, capture.financial, observation).week,
        );
      }
    }
    let instruments = baseInstruments;
    let market: StrategyBookFacts["marketLowZone"];
    if (
      strategy.entry.kind === "external" &&
      strategy.entry.id === "l3-market-low-zone"
    ) {
      if (!capture.lowZoneInput || !candidate.sourceContext.detector)
        throw new Error(
          "Missing same-index market low-zone price/membership/PIT financial capture",
        );
      const projected = projectLifecycleLowZone(
        instruments,
        capture.lowZoneInput,
        candidate.sourceContext.detector,
      );
      instruments = projected.instruments;
      market = projected.market;
    }
    const currentFacts: StrategyBookFacts = {
      ...(strategy.regime
        ? {
            benchmark: {
              symbol: strategy.regime.benchmark,
              bars: capture.benchmark,
            },
          }
        : {}),
      industries: capture.industries,
      ...(strategy.rank?.kind === "classic"
        ? {
            classicWeeks: [...panels.values()].sort((a, b) =>
              a.date.localeCompare(b.date),
            ),
            classicRiskSeries: baselineRisk,
          }
        : {}),
      ...(market ? { marketLowZone: market } : {}),
    };
    if (strategy.costFilter) {
      if (policy.costs.minimumCommission > 0)
        throw new Error(
          "Missing frozen notional cost basis for minimum commission",
        );
      currentFacts.roundTripCost =
        (2 * policy.costs.commissionBps +
          2 * policy.costs.slippageBps +
          policy.costs.sellTaxBps) /
        10000;
    }
    const previousSeed = previous?.request.bookSeeds?.find(
      (row) => row.strategyId === strategy.id,
    );
    if (strategy.rebalance && !previousSeed && !seed)
      throw new Error("Missing causal pre-start weekly signal");
    const selectionDates =
      strategy.rebalance && !previousSeed
        ? weeks
            .filter(
              (row) => row.date >= capture.firstSignal && row.date < seed!.date,
            )
            .map((row) => row.date)
        : [];
    const evaluators = new Map(
      instruments.map((instrument) => [
        instrument.symbol,
        prepareStrategy(strategy, instrument.signalBars, instrument.external),
      ]),
    );
    let selectionState: StrategyBookState | undefined;
    const eligible = (symbol: string, date: string) => {
      const source = sourceCoverage.get(symbol)!;
      const index = calendarIndices.get(date) ?? -1;
      const longest = Math.max(...lifecycleRpsPeriods);
      if (source.first < 0 || index < source.first + longest) return false;
      if (source.prefix[index + 1]! !== source.prefix[index - longest]!)
        throw new Error(
          `${symbol}: missing completed CN source; no quote or merger conversion is inferred`,
        );
      return rps.isEligible(symbol, date);
    };
    for (const date of selectionDates) {
      const decision = evaluateStrategyBook(strategy, {
        date,
        calendar: capture.calendar,
        candidates: instruments.map((instrument) => {
          const index = instrument.signalBars.findIndex(
            (bar) => bar.date === date,
          );
          return {
            symbol: instrument.symbol,
            bars: instrument.signalBars,
            external: instrument.external,
            eligible: eligible(instrument.symbol, date),
            decision:
              index < 0
                ? { entry: null, exit: null, stopLevel: null }
                : evaluators.get(instrument.symbol)!.evaluate(index),
          };
        }),
        initial: policy.initial,
        equity: policy.initial,
        maxPositions: policy.sleeves.find((row) => row.id === strategy.sleeve)!
          .maxPositions,
        holdings: [],
        state: selectionState,
        facts: currentFacts,
      });
      if (!decision.available)
        throw new Error(
          `Pre-start weekly selection unavailable: ${decision.reason}`,
        );
      selectionState = decision.state;
    }
    if (strategy.rebalance)
      bookSeeds.push(
        previousSeed ?? {
          strategyId: strategy.id,
          date: seed!.date,
          availableAt: seed!.date,
          ...(Date.parse(`${first}T09:30:00+08:00`) < account.startedAt
            ? { emitOrders: false }
            : {}),
          ...(selectionDates.length
            ? {
                previousSelected: {
                  date: selectionDates.at(-1)!,
                  availableAt: selectionDates.at(-1)!,
                  symbols: selectionState!.selected,
                  sourceHash: cnPaperContentHash({
                    source: capture.sourceHashes,
                    observation: capture.observationSourceHashes,
                    through: selectionDates.at(-1),
                    selected: selectionState!.selected,
                  }),
                },
              }
            : {}),
        },
      );
    const retainedDates = [
      ...new Set([
        ...(strategy.rebalance ? [seed!.date] : []),
        ...forwardDates,
      ]),
    ].sort();
    for (const date of retainedDates)
      memberships.push({
        strategyId: strategy.id,
        date,
        availableAt: date,
        symbols: instruments
          .filter((instrument) => eligible(instrument.symbol, date))
          .map((instrument) => instrument.symbol),
      });
    for (const instrument of instruments) {
      const oldGroup = previous?.request.instruments
        .find((row) => row.symbol === instrument.symbol)
        ?.external?.preparedRules?.find(
          (row) => row.strategy.id === strategy.id,
        );
      const oldDates = new Set(oldGroup?.points.map((row) => row.date));
      const newDates = retainedDates.filter(
        (date) =>
          !oldDates.has(date) &&
          instrument.signalBars.some((bar) => bar.date === date),
      );
      const group = prepareStrategyRulePoints(
        strategy,
        instrument.signalBars,
        instrument.external ?? {},
        newDates,
        {
          definitionHash: forwardDefinitionHash(strategy),
          buildHash: capture.buildHash,
          sourceHashes: capture.sourceHashes,
          observationSourceHashes: {
            ...capture.observationSourceHashes,
            raw: lifecycleRawPrefixHash(instrument.bars),
          },
        },
      );
      groups.set(instrument.symbol, [
        ...(groups.get(instrument.symbol) ?? []),
        {
          ...group,
          points: [...(oldGroup?.points ?? []), ...group.points].sort((a, b) =>
            a.date.localeCompare(b.date),
          ),
        },
      ]);
    }
    facts[strategy.id] = {
      ...currentFacts,
      ...(currentFacts.benchmark
        ? {
            benchmark: {
              ...currentFacts.benchmark,
              bars: currentFacts.benchmark.bars.filter(
                (bar) => bar.date >= retainFrom && bar.date <= through,
              ),
            },
          }
        : {}),
      ...(currentFacts.classicWeeks
        ? {
            classicWeeks: currentFacts.classicWeeks.filter(
              (row) => row.date >= (seed?.date ?? first),
            ),
          }
        : {}),
      ...(currentFacts.classicRiskSeries
        ? {
            classicRiskSeries: currentFacts.classicRiskSeries.map((row) => ({
              ...row,
              bars: row.bars.filter(
                (bar) => bar.date >= retainFrom && bar.date <= through,
              ),
            })),
          }
        : {}),
      ...(market
        ? {
            marketLowZone: market.filter(
              (row) => row.date >= retainFrom && row.date <= through,
            ),
          }
        : {}),
    };
  }
  const instruments = baseInstruments.map((instrument) => {
    const stock = sourceStocks.get(instrument.symbol)!;
    const actions = capture.actionsBySymbol?.get(stock.symbol) ?? [];
    const oldActions =
      previous?.request.instruments.find((row) => row.symbol === stock.symbol)
        ?.actions ?? [];
    const frozenActions = actions.map((action) => {
      const old = oldActions.find((row) => row.date === action.date);
      if (!old) return action;
      const economic = (row: typeof action) => {
        const { evidence: _evidence, ...fields } = row;
        return fields;
      };
      if (!isDeepStrictEqual(economic(old), economic(action)))
        throw new Error(
          `${stock.symbol}: frozen corporate-action economics changed`,
        );
      return old;
    });
    const requestedPeriods = [
      ...new Set(
        candidates.flatMap(({ strategy }) =>
          strategy.rank?.kind === "rps-composite"
            ? (strategy.rank.periods ?? [20, 50, 120])
            : [],
        ),
      ),
    ];
    return {
      ...instrument,
      bars: instrument.bars.filter(
        (bar) => bar.date >= retainFrom && bar.date <= through,
      ),
      signalBars: instrument.signalBars.filter(
        (bar) => bar.date >= retainFrom && bar.date <= through,
      ),
      external: {
        rps: instrument
          .external!.rps!.filter(
            (point) =>
              point.date >= (seed?.date ?? first) && point.date <= through,
          )
          .map((point) => ({
            date: point.date,
            periods: requestedPeriods,
            values: requestedPeriods.map(
              (period) => point.values[point.periods.indexOf(period)]!,
            ),
          })),
        preparedRules: groups.get(instrument.symbol)!,
      },
      actions: frozenActions.filter(
        (action) => action.date >= first && action.date <= through,
      ),
      execution: Object.fromEntries(
        stock.bars.flatMap((bar, index) =>
          bar.date >= first && bar.date <= through
            ? [
                [
                  bar.date,
                  researchExecutionAt(
                    instrument.symbol,
                    bar,
                    stock.bars[index - 1],
                    actions,
                  )!,
                ],
              ]
            : [],
        ),
      ),
    };
  });
  return {
    contextVersion: "cn-book-1",
    sourceIdentity: capture.sourceIdentity,
    request: {
      market: "cn-equity",
      initial: policy.initial,
      sleeves: policy.sleeves,
      costs: policy.costs,
      strategies: candidates.map((row) => row.strategy),
      start: first,
      end: through,
      calendar: calendar.filter((date) => date >= retainFrom),
      instruments,
      bookFacts: facts,
      memberships,
      bookSeeds,
      observationDetail: "counts",
    },
    benchmark: capture.benchmark.filter(
      (bar) => bar.date >= first && bar.date <= through,
    ),
    readyDates: [...readyDates],
    source: `CN book causal local capture ${cnPaperContentHash(capture.observationSourceHashes)}`,
  };
}

export type CnPaperSignalOrigin = {
  symbol: string;
  startDate: string;
  through: string;
  anchor: { date: string; factor: number };
  rawSource: {
    format: "bar-tuples-1";
    path: string;
    hash: string;
    decodedContentHash: string;
  };
  rawPrefixHash: string;
  eventsPrefixHash: string;
  factorsPrefixHash: string;
  signalPrefixHash: string;
};
export type CnPaperSignalPrefix = Omit<CnPaperSignalOrigin, "rawSource">;
type SignalOrigin = CnPaperSignalOrigin;
type SourceManifest = {
  version: string;
  inputHash: string;
  configHash: string;
  identities: {
    classic: {
      files: { path: string; hash: string }[];
      industry: Awaited<ReturnType<typeof readIndustryBlocks>>;
      signalBasis: {
        version: string;
        arithmetic: string;
        gbbq: { path: string; hash: string; parserHash: string };
        origins: SignalOrigin[];
      };
    };
    lowZone: {
      membership: {
        path: string;
        hash: string;
        symbols: string[];
        basis: "current-labelled";
      } | null;
    };
    families: Record<string, { firstSignal?: string }>;
  };
};
const immutableFiles = new Map<string, Promise<unknown>>();
async function frozenJson<T>(
  path: string,
  hash: string,
  compressed = false,
): Promise<T> {
  // Content, not mtime, authenticates immutable source files. Recheck bytes on
  // every capture; cache only decoded objects and never a mutable local source.
  const bytes = await readFile(path);
  if (digest(bytes) !== hash)
    throw new Error(`Frozen paper source hash mismatch: ${path}`);
  const key = `${path}:${hash}`;
  let pending = immutableFiles.get(key);
  if (!pending) {
    if (immutableFiles.size >= 3)
      immutableFiles.delete(immutableFiles.keys().next().value!);
    pending = Promise.resolve(
      JSON.parse(
        (compressed
          ? gunzipSync(bytes, { maxOutputLength: 768 * 1024 ** 2 })
          : bytes
        ).toString(),
      ),
    );
    immutableFiles.set(key, pending);
  }
  return pending as Promise<T>;
}
function prefixProof(
  bars: readonly Bar[],
  events: readonly TdxXdxr[],
  through: string,
) {
  const raw = bars.filter((bar) => bar.date <= through);
  const visibleEvents = events.filter(
    (event) => event.date >= (raw[0]?.date ?? "") && event.date <= through,
  );
  const factors = adjustmentFactors([...raw], [...visibleEvents]);
  const first = factors[0];
  if (!first) throw new Error("Missing fixed research raw origin");
  const signals = applyAdjustmentAtAnchor([...raw], factors, {
    date: first.date,
    factor: first.factor,
  });
  return {
    rawPrefixHash: lifecycleRawPrefixHash(raw),
    eventsPrefixHash: cnPaperContentHash(visibleEvents),
    factorsPrefixHash: cnPaperContentHash(factors),
    signalPrefixHash: lifecycleRawPrefixHash(signals),
  };
}
function validateProof(
  actual: ReturnType<typeof prefixProof>,
  expected: ReturnType<typeof prefixProof>,
  label: string,
) {
  for (const field of Object.keys(actual) as (keyof typeof actual)[])
    if (actual[field] !== expected[field])
      throw new Error(
        `${label}: frozen ${field} changed; explicit review required`,
      );
}

/** Both frozen source and previous account prefixes are checked before new
 * corporate actions can contribute a tail. No latest-forward denominator. */
export function captureCnPaperSignal(
  bars: Bar[],
  events: TdxXdxr[],
  origin: CnPaperSignalOrigin,
  previous?: CnPaperSignalPrefix,
) {
  if (
    bars[0]?.date !== origin.startDate ||
    origin.anchor.date !== origin.startDate
  )
    throw new Error(
      `${origin.symbol}: local raw history misses the fixed research origin`,
    );
  validateProof(
    prefixProof(bars, events, origin.through),
    origin,
    origin.symbol,
  );
  if (
    previous &&
    (previous.symbol !== origin.symbol ||
      previous.startDate !== origin.startDate ||
      !isDeepStrictEqual(previous.anchor, origin.anchor))
  )
    throw new Error(`${origin.symbol}: previous paper signal identity changed`);
  if (previous)
    validateProof(
      prefixProof(bars, events, previous.through),
      previous,
      `${origin.symbol} paper prefix`,
    );
  const factors = adjustmentFactors(bars, events);
  return {
    signalBars: applyAdjustmentAtAnchor(bars, factors, origin.anchor),
    proof: {
      symbol: origin.symbol,
      startDate: origin.startDate,
      anchor: origin.anchor,
      ...prefixProof(bars, events, bars.at(-1)!.date),
      through: bars.at(-1)!.date,
    },
  };
}

/** Production reader uses only local completed sources. It never invokes the
 * research runner, requests a remote quote, changes the pool or repairs a gap. */
export async function loadCnPaperContext(
  account: PaperAccount,
  now: number,
  calendar: readonly string[],
  readyDates: readonly string[],
  previous = new PaperRepository().state(account.id),
): Promise<PaperInput> {
  const config = settings();
  const candidate = account.candidates[0]!;
  const context = candidate.sourceContext;
  const rawUniverse = context?.rawUniverse;
  if (!context || !rawUniverse || !config.tdxRoot || !readyDates.length)
    throw new Error("Missing immutable CN paper raw universe/source context");
  if (
    account.candidates.some(
      (row) => !isDeepStrictEqual(row.sourceContext, context),
    )
  )
    throw new Error(
      "CN paper source contexts differ; separate source review required",
    );
  const manifest = (await readLifecycleSourceManifest(
    context.manifestPath,
    context.inputHash,
  )) as unknown as SourceManifest;
  if (
    manifest.version !== "lifecycle-source-1" ||
    manifest.inputHash !== context.inputHash ||
    manifest.configHash !== context.configHash ||
    cnPaperContentHash(manifest.identities) !== context.inputHash
  )
    throw new Error("Frozen CN paper manifest identity mismatch");
  const classic = manifest.identities.classic;
  if (
    classic.signalBasis?.version !== "tdx-first-raw-anchor-1" ||
    classic.signalBasis.arithmetic !== "rawOHLC*(F(t)/F(firstFrozenRawDate))" ||
    !classic.signalBasis.origins.length ||
    !classic.signalBasis.gbbq?.hash
  )
    throw new Error(
      "CN paper requires the preregistered causal fixed-origin GBBQ source; old normalized source cannot be guessed",
    );
  const priceFile = classic.files.find(
    (file) => file.hash === rawUniverse.hash,
  );
  if (
    !priceFile ||
    priceFile.path.replaceAll("\\", "/") !==
      rawUniverse.source.replaceAll("\\", "/")
  )
    throw new Error(
      "Original raw800 path/hash differs from the frozen candidate",
    );
  const price = await frozenJson<ClassicPriceInput>(
    rawUniverse.source,
    rawUniverse.hash,
  );
  if (
    !isDeepStrictEqual(
      price.stocks.map((stock) => stock.symbol).sort(),
      [...rawUniverse.symbols].sort(),
    )
  )
    throw new Error("Original raw800 roster differs from the frozen candidate");
  const panelFile = classic.files.find((file) =>
    /factor-panel\.json\.gz$/i.test(file.path),
  );
  const financialFile = classic.files.find((file) =>
    /financial-input\.json\.gz$/i.test(file.path),
  );
  if (!panelFile || !financialFile)
    throw new Error("Missing original classic panel/financial identity");
  const classicWeeks = await frozenJson<ClassicWeek[]>(
    panelFile.path,
    panelFile.hash,
    true,
  );
  const originalFinancial = await frozenJson<ClassicFinancialInput>(
    financialFile.path,
    financialFile.hash,
    true,
  );
  if (originalFinancial.priceHash !== rawUniverse.hash)
    throw new Error("Original financial/price identity mismatch");
  const through = readyDates.at(-1)!;
  const actionSource = await readStableLocalFile(
    join(resolveTdxRoot(config.tdxRoot), "T0002/hq_cache/gbbq"),
  );
  const frozenActions = await readFile(classic.signalBasis.gbbq.path);
  if (digest(frozenActions) !== classic.signalBasis.gbbq.hash)
    throw new Error("Frozen original GBBQ bytes changed");
  const decodedActions = parseGbbqFile(actionSource.body);
  if (
    cnPaperContentHash(decodedActions.issues) !==
    cnPaperContentHash(parseGbbqFile(frozenActions).issues)
  )
    throw new Error(
      "Current GBBQ has new unexplained records; no action is guessed",
    );
  const events = decodedActions.events;
  const eventHash = digest(actionSource.body);
  const origins = new Map(
    classic.signalBasis.origins.map((origin) => [origin.symbol, origin]),
  );
  if (origins.size !== rawUniverse.symbols.length)
    throw new Error("Missing/duplicate frozen CN signal origins");
  const oldIdentity = previous?.sourceIdentity as
    { origins?: CnPaperSignalPrefix[] } | undefined;
  if (
    previous &&
    (previous.contextVersion !== "cn-book-1" ||
      oldIdentity?.origins?.length !== rawUniverse.symbols.length ||
      !isDeepStrictEqual(
        oldIdentity.origins.map((row) => row.symbol).sort(),
        [...rawUniverse.symbols].sort(),
      ))
  )
    throw new Error(
      "Existing paper checkpoint lacks complete fixed-origin source proofs; explicit review required",
    );
  const proofs: CnPaperSignalPrefix[] = [];
  const observationSources: Record<string, string> = { gbbq: eventHash };
  const stocks: Csi800Stock[] = [],
    baselineStocks: Csi800Stock[] = [];
  const actionsBySymbol = new Map<
    string,
    NonNullable<PortfolioInstrument["actions"]>
  >();
  const read = async (symbol: string) => {
    const source = await readBars({
      instrument: { market: "cn-equity", symbol },
      period: "day",
      adjustment: "none",
      root: config.tdxRoot,
      source: "local",
      live: false,
      to: through,
      now,
    });
    if (source.barStore.priceRepaired || source.sourceNote)
      throw new Error(
        `${symbol}: repaired/unverified local raw source; no synthetic price accepted`,
      );
    const bars = source.bars.filter(
      (bar) =>
        !source.barStore.formingDates.includes(bar.date) &&
        bar.date <= through &&
        Date.parse(`${bar.date}T15:00:00+08:00`) <= now,
    );
    observationSources[symbol] = source.hash;
    return bars;
  };
  for (const original of price.stocks) {
    const origin = origins.get(original.symbol);
    if (
      !origin ||
      origin.startDate !== original.bars[0]?.date ||
      origin.anchor.date !== origin.startDate
    )
      throw new Error(
        `${original.symbol}: fixed origin differs from the original research source`,
      );
    const local = (await read(original.symbol)).filter(
      (bar) => bar.date >= origin.startDate,
    );
    const archived = await readLifecycleSignalOriginBars(origin);
    const localByDate = new Map(local.map((bar) => [bar.date, bar]));
    for (const bar of archived)
      if (
        localByDate.has(bar.date) &&
        !isDeepStrictEqual(localByDate.get(bar.date), bar)
      )
        throw new Error(
          `${original.symbol}: frozen raw origin archive and current local source differ`,
        );
    const bars = [
      ...archived.filter((bar) => bar.date <= through),
      ...local.filter((bar) => bar.date > origin.through),
    ];
    const ownEvents = events.get(original.symbol) ?? [];
    const prior = oldIdentity?.origins?.find(
      (row) => row.symbol === original.symbol,
    );
    const normalized = captureCnPaperSignal(bars, ownEvents, origin, prior);
    const signalBars = normalized.signalBars;
    const actions = researchCorporateActions(
      ownEvents,
      eventHash,
      origin.startDate,
      through,
    );
    if (
      actions.some(
        (action) => action.date > price.end && (action.shareFactor ?? 1) !== 1,
      )
    )
      throw new Error(
        `${original.symbol}: unsupported BASE wealth share conversion; no merger cash or exchange ratio is invented`,
      );
    stocks.push({ symbol: original.symbol, bars, signalBars, actions: [] });
    actionsBySymbol.set(original.symbol, actions);
    // BASE's original observed rows and economics are immutable. Only later
    // raw observations and later entitled actions extend its old compiler.
    const rawByDate = new Map(bars.map((bar) => [bar.date, bar]));
    for (const bar of original.bars)
      if (
        bar.date <= through &&
        !isDeepStrictEqual(rawByDate.get(bar.date), bar)
      )
        throw new Error(`${original.symbol}: original BASE raw source changed`);
    baselineStocks.push({
      ...original,
      bars: [
        ...original.bars.filter((bar) => bar.date <= through),
        ...bars.filter((bar) => bar.date > price.end),
      ],
      actions: [
        ...original.actions,
        ...actions
          .filter((action) => action.date > price.end)
          .map((action) => ({
            date: action.date,
            dividend: action.dividend,
            bonus: action.bonus,
            rights: action.rightsRatio ?? 0,
            rightsPrice: action.rightsPrice ?? 0,
            unsupported: (action.shareFactor ?? 1) !== 1,
          })),
      ],
    });
    proofs.push(normalized.proof);
  }
  const localBenchmark = await read("sh000906");
  const benchmarkByDate = new Map(localBenchmark.map((bar) => [bar.date, bar]));
  for (const bar of price.benchmark)
    if (
      benchmarkByDate.has(bar.date) &&
      !isDeepStrictEqual(benchmarkByDate.get(bar.date), bar)
    )
      throw new Error("Original classic benchmark prefix changed");
  const benchmark = [
    ...price.benchmark.filter((bar) => bar.date <= through),
    ...localBenchmark.filter((bar) => bar.date > price.end),
  ];
  const sourceCalendar = [
    ...new Set([
      ...price.benchmark.map((bar) => bar.date),
      ...calendar.filter((date) => date >= price.benchmark[0]!.date),
    ]),
  ].sort();
  const needsFinancial = account.candidates.some(
    (row) =>
      row.strategy.rank?.kind === "classic" || row.sourceContext?.detector,
  );
  const currentPrice = {
    ...price,
    end: through,
    stocks: baselineStocks,
    benchmark,
  };
  const currentPriceHash = needsFinancial
    ? cnPaperContentHash(currentPrice)
    : undefined;
  const currentFinancial = needsFinancial
    ? await captureClassicFinancial(
        config.tdxRoot,
        currentPrice,
        currentPriceHash!,
      )
    : undefined;
  const firstSignal =
    manifest.identities.families[`${account.market}:${account.sleeve}`]
      ?.firstSignal;
  if (account.candidates.some((row) => row.strategy.rebalance) && !firstSignal)
    throw new Error("Missing immutable first weekly selection date");
  // Keep all old panel rows exactly; the current capture is used only by new
  // observations. Current downloaded revisions are labelled, not first-vintage.
  const financial = currentFinancial;
  if (financial) {
    observationSources.financial = cnPaperContentHash(financial);
    observationSources.baselinePrice = currentPriceHash!;
  }
  const industry = await readIndustryBlocks(classic.industry.root);
  if (industry.hash !== classic.industry.hash)
    throw new Error("Frozen132-group industry source changed");
  const memberships = new Map<string, string[]>();
  for (const file of industry.files)
    for (const symbol of file.members)
      memberships.set(symbol, [...(memberships.get(symbol) ?? []), file.name]);
  const industryDate = new Date(
    Math.max(...industry.files.map((file) => file.mtimeMs)),
  )
    .toISOString()
    .slice(0, 10);
  const industries = [...memberships].map(([symbol, groups]) => ({
    symbol,
    date: industryDate,
    availableAt: industryDate,
    groups: [...new Set(groups)].sort(),
    basis: "current" as const,
    source: `current Blocks full membership ${industry.hash}`,
  }));
  observationSources.industry = industry.hash;
  let lowZoneInput: MarketLowZoneInput | undefined;
  if (account.candidates.some((row) => row.sourceContext?.detector)) {
    const membership = manifest.identities.lowZone.membership;
    if (!membership || !financial)
      throw new Error(
        "Missing frozen CSI300 membership/current PIT financial source",
      );
    const bytes = await readFile(membership.path);
    if (
      digest(bytes) !== membership.hash ||
      !isDeepStrictEqual(
        parseIndustryMembers(bytes, membership.path),
        membership.symbols,
      )
    )
      throw new Error("Frozen primary CSI300 membership changed");
    const indexBars = await read("sh000300");
    const lowCalendar = indexBars.map((bar) => bar.date);
    const oldValuations = lifecycleFinancialValuations(
      originalFinancial,
      rawUniverse.symbols,
      lowCalendar,
      financialFile.hash,
    );
    const oldDates = new Set(
      oldValuations.map((row) => `${row.symbol}:${row.date}`),
    );
    const newValuations = lifecycleFinancialValuations(
      financial,
      rawUniverse.symbols,
      lowCalendar,
      observationSources.financial!,
    ).filter((row) => !oldDates.has(`${row.symbol}:${row.date}`));
    lowZoneInput = {
      calendar: lowCalendar,
      index: {
        symbol: "sh000300",
        bars: indexBars,
        source: "Local primary sh000300 raw daily",
        hash: observationSources.sh000300!,
      },
      stocks: stocks.map((stock) => ({
        symbol: stock.symbol,
        bars: stock.signalBars!,
        source: "Frozen-origin causal GBBQ",
        hash: cnPaperContentHash(
          proofs.find((row) => row.symbol === stock.symbol),
        ),
      })),
      constituents: lowCalendar.map((date) => ({
        index: "sh000300" as const,
        date,
        availableAt: new Date(now).toISOString(),
        symbols: membership.symbols,
        basis: "current-labelled" as const,
        source: membership.path,
        hash: membership.hash,
      })),
      valuations: [...oldValuations, ...newValuations],
    };
  }
  const immutableHashes = {
    research: context.inputHash,
    rawUniverse: rawUniverse.hash,
    originalPanel: panelFile.hash,
    originalFinancial: financialFile.hash,
    signalBasis: cnPaperContentHash(classic.signalBasis),
  };
  if (
    digest(
      (
        await readStableLocalFile(
          join(resolveTdxRoot(config.tdxRoot), "T0002/hq_cache/gbbq"),
        )
      ).body,
    ) !== eventHash
  )
    throw new Error(
      "GBBQ changed during the multi-symbol paper capture; retry one coherent capture",
    );
  return compileCnPaperContext(
    account,
    {
      stocks,
      baselineStocks,
      actionsBySymbol,
      benchmark,
      calendar: sourceCalendar,
      classicWeeks,
      firstSignal: firstSignal ?? sourceCalendar[0]!,
      financial,
      industries,
      lowZoneInput,
      sourceHashes: immutableHashes,
      observationSourceHashes: {
        capture: cnPaperContentHash(observationSources),
        gbbq: eventHash,
        ...(observationSources.financial
          ? { financial: observationSources.financial }
          : {}),
        industry: industry.hash,
      },
      sourceIdentity: {
        version: "cn-book-source-1",
        source: immutableHashes,
        through,
        origins: proofs,
        currentRawRoot: config.tdxRoot,
        currentCaptureHash: cnPaperContentHash(observationSources),
      },
      buildHash: forwardExecutionBuildHash(),
    },
    readyDates,
    previous,
  );
}
