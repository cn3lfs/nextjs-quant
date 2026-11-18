import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  runPortfolio,
  createPortfolioPreparation,
  maBaselineBuildHash,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import {
  studyStrategies,
  studyCatalog,
  strategyBuildHash,
  createExtendedStudyRule,
  type StudyStrategy,
  type StrategyObjectInput,
} from "trading-strategies";
import {
  parseGbbqFile,
  adjustmentFactors,
  applyAdjustmentAtAnchor,
} from "tstdx/local";
import {
  researchCostScenarios,
  researchExecutionCosts,
  type ResearchCostScenario,
} from "trading-strategy-core/costs";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "../src/server/research/corporate-actions";
import { readPublicData } from "../src/server/data-sources/binance/public-data-store";
import type { LifecycleSignalBasis } from "../src/server/research/lifecycle-source";
import {
  assertResearchExecutionIdentity,
  assertResearchRunActive,
  createResearchRunBudget,
  createResearchRunGuard,
  ensureResearchRegistration,
  researchDigest,
  researchExecutionIdentity,
  researchJsonHash,
  runResearchMatrix,
  withResearchRunLock,
  writeResearchJsonAtomic,
  type ResearchMatrixCell,
  type ResearchMatrixRow,
  type ResearchRunBudget,
} from "../src/server/research/research-run";

import {
  technicalMethodProfiles,
  isTechnicalMethod,
  researchTechnicalMethodSeries,
} from "trading-strategies/research/technical/research-technical-methods";
import {
  researchWyckoffSeries,
  isWyckoff,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import { isCanslimHigh } from "trading-strategies/research/canslim/research-canslim-strategies";
import {
  entryStudyBindingsForPreset,
  entryStudyPresets,
  isEntryStudyStrategy,
  methodPoolBindingsForPreset,
  methodPoolMarkets,
  strategySupportsMarket,
} from "../src/lib/research/method-pool-bindings";
import { researchCanslimHighSeries } from "trading-strategies/research/canslim/research-canslim-high";
import {
  lowVolatilityId,
  lowVolatilityTargets,
} from "./lib/research/method-pool-low-volatility";

// Entry experiments compare the source entry event under one explicit
// five-bar exit. The preset/strategy/market table owns that distinction.
const entryPresets = entryStudyPresets();
type EntryStudy = `entry5-${string}`;
type PoolStudy =
  | StudyStrategy
  | EntryStudy
  | typeof relativeStrengthId
  | typeof lowVolatilityId;
type PoolStrategyId = PoolStudy | "baseline-hold";
type TheoryStudyKey = {
  market: "cn-equity" | "crypto";
  strategyId: PoolStrategyId;
  window: string;
  scenario: ResearchCostScenario;
};
type TheoryStudyRow = ResearchMatrixRow<
  TheoryStudyKey,
  Record<string, unknown>
>;
function isEntryStudy(id: string): id is EntryStudy {
  return isEntryStudyStrategy(id);
}
function withEntryEvents(
  id: EntryStudy,
  instruments: PortfolioInstrument[],
): PortfolioInstrument[] {
  const preset = id.slice("entry5-".length);
  return instruments.map((instrument) => {
    const bars = instrument.signalBars;
    const points = isTechnicalMethod(preset)
      ? researchTechnicalMethodSeries(preset, bars)
      : isWyckoff(preset)
        ? researchWyckoffSeries(preset, bars)
        : isCanslimHigh(preset)
          ? researchCanslimHighSeries(preset, bars)
          : null;
    if (!points || points.length !== bars.length)
      throw new Error("Entry series alignment failed: " + preset);
    const signals = points.flatMap((point, i) =>
      point.entry
        ? [
            {
              id,
              date: bars[i]!.date,
              availableAt: bars[i]!.date,
              entry: true,
              exit: false,
            },
          ]
        : [],
    );
    return { ...instrument, external: { ...instrument.external, signals } };
  });
}

import {
  relativeStrengthId,
  relativeStrengthInputs,
  relativeStrengthStrategy,
} from "./lib/research/method-pool-relative-strength";

const defaultBudget: ResearchRunBudget = { maxRssMiB: 4096 };
function assertResearchBudget(budget: ResearchRunBudget = defaultBudget) {
  assertResearchRunActive(budget);
}
const defaultSource =
  ".test-data/lifecycle-20261116/l3/sources/source-978a42271380e3609b78f644b74772a323203c917c78e805d3a3ed18ce247a1e.json";
export const theoryStudyWindows = [
  { label: "development", start: "2020-01-01", end: "2023-12-31" },
  {
    label: "reused-history-validation",
    start: "2024-01-01",
    end: "2026-11-13",
  },
] as const;

/** Existing historical inputs have already been inspected. No segment is a clean holdout. */
export function theoryStudyCandidates() {
  const daily = studyStrategies.filter(
    (id) =>
      createExtendedStudyRule(id, []) !== null &&
      id !== "research-indicator-confluence",
  );
  // Give each daily family a first turn before scheduling its other versions.
  const families = new Map<string, PoolStudy[]>();
  for (const id of [
    ...entryPresets.map((p) => `entry5-${p}` as EntryStudy),
    ...daily,
  ]) {
    const preset = id.slice("entry5-".length);
    const family = isEntryStudy(id)
      ? isTechnicalMethod(preset)
        ? technicalMethodProfiles[preset][2]
        : preset.split("-")[0]!
      : studyCatalog[id].family;
    const queue = families.get(family) ?? [];
    queue.push(id);
    families.set(family, queue);
  }
  const ordered: PoolStudy[] = [];
  for (
    let index = 0;
    ordered.length < daily.length + entryPresets.length;
    index++
  ) {
    for (const queue of families.values())
      if (queue[index]) ordered.push(queue[index]!);
  }
  return ordered;
}

export async function methodPoolInventory() {
  const candidates = theoryStudyCandidates();
  const runnable = new Set<string>([
    ...candidates,
    relativeStrengthId,
    lowVolatilityId,
  ]);
  const methods: {
    methods: {
      id: string;
      title: string;
      bindings?: { presets?: string[] };
      boundary?: string;
      execution?: { reason?: string };
    }[];
  } = JSON.parse(await readFile("docs/trading-skills-method-map.json", "utf8"));
  const theories: {
    cards: {
      theoryId: string;
      name: string;
      status: string;
      strategyIds: string[];
      reason: string;
    }[];
  } = JSON.parse(
    await readFile("docs/research/theory-implementation/coverage.json", "utf8"),
  );
  return {
    account: { maxPositions: 10, targetWeight: 0.1 },
    candidates,
    methods: methods.methods.map((method) => {
      const presets = method.bindings?.presets ?? [];
      const ids = [
        ...new Set(
          presets.flatMap((preset) =>
            entryStudyBindingsForPreset(preset).map(
              (binding) => binding.strategyId,
            ),
          ),
        ),
      ].filter((id) => runnable.has(id));
      const boundMarkets = [
        ...new Set(
          presets.flatMap((preset) =>
            methodPoolBindingsForPreset(preset).flatMap(
              (binding) => binding.markets,
            ),
          ),
        ),
      ].filter((market) =>
        methodPoolMarkets.includes(
          market as (typeof methodPoolMarkets)[number],
        ),
      );
      return {
        id: method.id,
        name: method.title,
        presets,
        batchIds: ids,
        boundMarkets,
        status: ids.length ? "entry-event-bound" : "requires-binding-review",
        reason: ids.length
          ? "Source entry, five completed holding bars"
          : (method.execution?.reason ?? method.boundary),
      };
    }),
    theories: theories.cards.map((card) => ({
      id: card.theoryId,
      name: card.name,
      bindings: card.strategyIds,
      batchIds: card.strategyIds.filter((id) => runnable.has(id)),
      status: card.status,
      reason: card.reason,
    })),
  };
}

export function theoryStudyStrategy(
  strategy: PoolStudy | "baseline-hold",
  market: "cn-equity" | "crypto",
  symbols: string[],
): StrategyObjectInput {
  if (strategy === relativeStrengthId) return relativeStrengthStrategy();
  return {
    id:
      strategy === lowVolatilityId
        ? lowVolatilityId
        : `theory-study-${market}-${strategy}`,
    version: 2,
    market,
    period: "day",
    universe: { kind: "symbols", symbols },
    entry:
      strategy === "baseline-hold" || strategy === lowVolatilityId
        ? { kind: "constant", value: strategy === "baseline-hold" }
        : isEntryStudy(strategy)
          ? { kind: "external", id: strategy, side: "entry" }
          : { kind: "study-rule", strategy, side: "entry" },
    exit:
      strategy === "baseline-hold" || strategy === lowVolatilityId
        ? {}
        : isEntryStudy(strategy)
          ? { maxBars: 5 }
          : { rule: { kind: "study-rule", strategy, side: "exit" } },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  };
}

export function summarizeTheoryResult(
  result: ReturnType<typeof runPortfolio>,
  initial: number,
) {
  let peak = initial,
    maxDrawdown = 0;
  for (const row of result.curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - row.equity / peak);
  }
  const held = new Set<string>();
  let peakPositions = 0;
  for (const fill of result.fills) {
    if (fill.holdingAfter > 0) held.add(fill.symbol);
    else held.delete(fill.symbol);
    peakPositions = Math.max(peakPositions, held.size);
  }
  if (peakPositions > 10) throw new Error("Ten-position limit exceeded");
  const netReturn = (result.curve.at(-1)?.equity ?? initial) / initial - 1;
  return {
    peakPositions,
    returnToDrawdown: maxDrawdown > 0 ? netReturn / maxDrawdown : null,
    meanExposure: result.curve.length
      ? result.curve.reduce(
          (sum, row) => sum + (row.equity > 0 ? 1 - row.cash / row.equity : 0),
          0,
        ) / result.curve.length
      : null,
    netReturn,
    maxDrawdown,
    buys: result.fills.filter((f) => f.side === "buy").length,
    sells: result.fills.filter((f) => f.side === "sell").length,
    turnoverNotional: result.fills.reduce(
      (sum, fill) => sum + fill.quantity * fill.price,
      0,
    ),
    rejectionReasons: result.rejections.reduce<Record<string, number>>(
      (counts, rejection) => {
        counts[rejection.reason] = (counts[rejection.reason] ?? 0) + 1;
        return counts;
      },
      {},
    ),
    fees: result.fills.reduce((sum, f) => sum + f.fee, 0),
    rejections: result.rejections.length,
    observations: result.curve.length,
    openPositions: result.positions.length,
    // Open inventory is marked by the engine, never silently discarded.
    quality: result.quality,
    fillsHash: researchJsonHash(result.fills),
    curveHash: researchJsonHash(result.curve),
  };
}

type Source = {
  identities: {
    classic: {
      signalBasis: LifecycleSignalBasis;
      normalized: {
        roster: { path: string; hash: string };
        executionSymbols: string[];
      };
    };
    crypto: { root: string };
  };
  biasTags: unknown[];
};

async function checked(path: string, hash: string) {
  const bytes = await readFile(path);
  if (researchDigest(bytes) !== hash)
    throw new Error(`Frozen source hash mismatch: ${path}`);
  return bytes;
}

export async function readInputs(
  sourcePath: string,
  limit: number,
  budget: ResearchRunBudget = defaultBudget,
) {
  const manifest = await readFile(sourcePath);
  const source = JSON.parse(manifest.toString()) as Source;
  const basis = source.identities.classic.signalBasis;
  const decoded = parseGbbqFile(
    await checked(basis.gbbq.path, basis.gbbq.hash),
  );
  const rosterSource = source.identities.classic.normalized.roster;
  const roster = JSON.parse(
    gunzipSync(await checked(rosterSource.path, rosterSource.hash)).toString(),
  ) as { symbols: string[] };
  const executionSymbols =
    source.identities.classic.normalized.executionSymbols;
  if (
    executionSymbols.length !== 799 ||
    new Set(executionSymbols).size !== 799 ||
    executionSymbols.some(
      (symbol) => !basis.origins.some((origin) => origin.symbol === symbol),
    )
  )
    throw new Error(
      "Frozen lifecycle execution universe must contain 799 unique symbols with raw origins",
    );
  const symbols = [...executionSymbols].sort().slice(0, limit);
  const cn: PortfolioInstrument[] = [];
  const evidence: unknown[] = [
    {
      path: resolve(sourcePath),
      hash: researchDigest(manifest),
      universe: "lifecycle-normalized-executionSymbols",
      executionUniverseHash: researchJsonHash(executionSymbols),
      rosterDifference: {
        captureOnly: roster.symbols.filter(
          (symbol) => !executionSymbols.includes(symbol),
        ),
        executionOnly: executionSymbols.filter(
          (symbol) => !roster.symbols.includes(symbol),
        ),
        first30Equal:
          JSON.stringify([...roster.symbols].sort().slice(0, 30)) ===
          JSON.stringify([...executionSymbols].sort().slice(0, 30)),
      },
    },
  ];
  for (const symbol of symbols) {
    assertResearchBudget(budget);
    const origin = basis.origins.find((o) => o.symbol === symbol);
    if (!origin) throw new Error(`Missing frozen origin ${symbol}`);
    const plain = gunzipSync(
      await checked(origin.rawSource.path, origin.rawSource.hash),
    );
    if (researchDigest(plain) !== origin.rawSource.decodedContentHash)
      throw new Error("Raw prefix identity mismatch");
    const tuples = JSON.parse(plain.toString()) as [
      string,
      number,
      number,
      number,
      number,
      number,
      number,
    ][];
    const bars = tuples.map(
      ([date, open, high, low, close, volume, amount]) => ({
        date,
        open,
        high,
        low,
        close,
        volume,
        amount,
      }),
    );
    const events = decoded.events.get(symbol) ?? [];
    const factors = adjustmentFactors(bars, events);
    const signalBars = applyAdjustmentAtAnchor(bars, factors, origin.anchor);
    const actions = researchCorporateActions(
      events,
      basis.gbbq.path,
      bars[0]!.date,
      bars.at(-1)!.date,
    );
    const executionIdentity = createHash("sha256");
    for (let index = 0; index < bars.length; index++)
      executionIdentity.update(
        JSON.stringify(
          researchExecutionAt(symbol, bars[index], bars[index - 1], actions),
        ),
      );
    cn.push({
      symbol,
      market: "cn-equity",
      bars,
      signalBars,
      actions,
      execution: (bar, previous) =>
        researchExecutionAt(symbol, bar, previous, actions),
    });
    evidence.push({
      symbol,
      rawHash: origin.rawSource.hash,
      anchor: origin.anchor,
      signalHash: researchJsonHash(signalBars),
      actionsHash: researchJsonHash(actions),
      executionHash: executionIdentity.digest("hex"),
    });
  }
  const crypto: PortfolioInstrument[] = [];
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const data = await readPublicData(symbol, "1d", {
      root: source.identities.crypto.root,
      now: Date.parse("2026-11-14T00:00:00Z"),
    });
    if (data.gaps.length) throw new Error(`Crypto archive gaps: ${symbol}`);
    const bars = data.rows
      .map((r) => r.bar)
      .filter((b) => b.date <= "2026-11-13");
    crypto.push({
      symbol,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        evidence:
          "Verified Binance spot archive; fixed lot scenario, no order-book liquidity certification",
        minimum: 0.00001,
        step: 0.00001,
        limitUp: null,
        limitDown: null,
        tradable: true,
      },
    });
    evidence.push({
      symbol,
      files: data.files.map((f) => ({ path: f.path, hash: f.sha256 })),
      bars: bars.length,
      hash: researchJsonHash(bars),
      executionHash: researchJsonHash(crypto.at(-1)!.execution),
      actionsHash: researchDigest("[]"),
    });
  }
  return { cn, crypto, evidence, biasTags: source.biasTags };
}

const pathProofStrategy = "research-volume-price";

export async function runTheoryStudy(args: string[]) {
  const value = (name: string, fallback: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  const output = resolve(
    value("--output", ".test-data/method-pool-ten/results"),
  );
  const rel = relative(resolve(".test-data"), output);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Output must be a task subdirectory under .test-data");
  const limit = Number(value("--limit", "799"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 799)
    throw new Error("limit must be 1..799");
  const stage = value("--stage", "all");
  if (
    ![
      "all",
      "first-pass",
      "path-proof",
      "follow-up",
      "relative-strength",
      "relative-strength-follow-up",
      "low-volatility",
    ].includes(stage)
  )
    throw new Error("Unknown theory study stage");
  const requestedCostScenario = value("--cost-scenario", "default");
  if (
    requestedCostScenario !== "default" &&
    !researchCostScenarios.includes(
      requestedCostScenario as ResearchCostScenario,
    )
  )
    throw new Error(
      "--cost-scenario must be default, fixed, base or double-cost",
    );
  const costScenario =
    requestedCostScenario === "default"
      ? null
      : (requestedCostScenario as ResearchCostScenario);
  const pathProof = stage === "path-proof";
  const followUp =
    stage === "follow-up" || stage === "relative-strength-follow-up";
  const relativeStrength =
    stage === "relative-strength" || stage === "relative-strength-follow-up";
  const lowVolatility = stage === "low-volatility";
  const rankedStage = relativeStrength || lowVolatility;
  const marketFilter = value("--market", "default");
  if (!["default", "cn-equity", "crypto"].includes(marketFilter))
    throw new Error("--market must be cn-equity or crypto");
  if ((pathProof || rankedStage) && marketFilter === "crypto")
    throw new Error("This research stage has only an A-share strategy");
  if (rankedStage && (limit !== 799 || args.includes("--strategies")))
    throw new Error("Ranked stages use the frozen 799-symbol pool");
  if (pathProof && (limit !== 799 || args.includes("--strategies")))
    throw new Error(
      "Path proof uses the frozen 799-stock pool and one volume-price strategy",
    );
  const timeBudgetMs = Number(value("--time-budget-ms", "0"));
  const maxRssMiB = Number(value("--max-rss-mib", "4096"));
  const controller = new AbortController();
  const cancel = () => controller.abort("cancelled by signal");
  // SIGINT is observed only at cooperative checkpoints; a synchronous engine
  // call is not preempted. Deadline and RSS checks use the same checkpoints.
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const budget = createResearchRunBudget({
    signal: controller.signal,
    timeBudgetMs,
    maxRssMiB,
  });
  process.env.QUANT_DATA_DIR = join(output, "data");
  await mkdir(output, { recursive: true });
  try {
    return await withResearchRunLock(join(output, ".run.lock"), async () => {
      const inputs = await readInputs(
        value("--source", defaultSource),
        limit,
        budget,
      );
      const selected = value("--strategies", "all");
      const candidates: PoolStudy[] = pathProof
        ? [pathProofStrategy]
        : relativeStrength
          ? [relativeStrengthId]
          : lowVolatility
            ? [lowVolatilityId]
            : theoryStudyCandidates().filter(
                (id) => selected === "all" || selected.split(",").includes(id),
              );
      if (!candidates.length)
        throw new Error("No executable strategies selected");
      if (
        selected !== "all" &&
        selected
          .split(",")
          .some((id) => !candidates.includes(id as StudyStrategy))
      )
        throw new Error("Unknown or unsupported selected strategy");
      const execution = await researchExecutionIdentity({
        runner: new URL(import.meta.url),
        // These local modules are imported by the runner and bind the
        // enumeration and ranked stages; none of them is under a package dist.
        definitions: [
          new URL(
            "../src/lib/research/method-pool-bindings.ts",
            import.meta.url,
          ),
          new URL(
            "./lib/research/method-pool-low-volatility.ts",
            import.meta.url,
          ),
          new URL(
            "./lib/research/method-pool-relative-strength.ts",
            import.meta.url,
          ),
        ],
      });
      const runnerSnapshotPath = join(
        output,
        `runner-${execution.runner.hash}.ts`,
      );
      const runnerBytes = await readFile(new URL(import.meta.url));
      await writeFile(runnerSnapshotPath, runnerBytes, { flag: "wx" }).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
          if (
            researchDigest(await readFile(runnerSnapshotPath)) !==
            execution.runner.hash
          )
            throw new Error("Runner snapshot conflicts with source identity");
        },
      );
      const registration = {
        version: "theory-study-ten-3",
        strategyBuildHash,
        engineBuildHash: maBaselineBuildHash,
        execution,
        runnerSnapshotPath,
        windows:
          pathProof || (rankedStage && !followUp)
            ? [theoryStudyWindows[0]]
            : followUp
              ? [theoryStudyWindows[1]]
              : theoryStudyWindows,
        candidates,
        scenarios: (costScenario
          ? [costScenario]
          : pathProof || (rankedStage && !followUp)
            ? ["base"]
            : ["base", "double-cost"]) as readonly ResearchCostScenario[],
        markets:
          marketFilter === "crypto"
            ? (["crypto"] as const)
            : marketFilter === "cn-equity" ||
                pathProof ||
                followUp ||
                rankedStage
              ? (["cn-equity"] as const)
              : (["cn-equity", "crypto"] as const),
        includeBaseline:
          !pathProof && !rankedStage && !args.includes("--without-baseline"),
        account: { maxPositions: 10, targetWeight: 0.1 },
        ordering:
          "Sell before buy; method score descending; ties by symbol ascending",
        inputEvidence: inputs.evidence,
        limit,
        selection:
          "Frozen lifecycle normalized.executionSymbols, ascending symbol prefix; legacy capture roster differences recorded; no selection by returns",
        status: "development-screen-only",
        biasTags: inputs.biasTags,
        gates:
          "No promotion; all existing history previously used. Final independent validation requires new untouched evidence.",
      };
      const identity = researchJsonHash(registration);
      const registrationPath = join(output, `registration-${identity}.json`);
      await ensureResearchRegistration(
        registrationPath,
        registration,
        identity,
      );
      const journal = join(output, `attempts-${identity}.jsonl`);
      const assertCommitIdentity = async () => {
        assertResearchRunActive(budget);
        await assertResearchExecutionIdentity(
          execution,
          "Research execution dependencies changed during research",
        );
        // Cancellation can arrive while the hashes above are being read.
        assertResearchRunActive(budget);
      };
      const marketData = new Map<
        "cn-equity" | "crypto",
        {
          instruments: PortfolioInstrument[];
          calendar: string[];
          symbols: string[];
        }
      >();
      for (const market of registration.markets) {
        const instruments = market === "cn-equity" ? inputs.cn : inputs.crypto;
        marketData.set(market, {
          instruments,
          calendar: [
            ...new Set(instruments.flatMap((i) => i.bars.map((b) => b.date))),
          ].sort(),
          symbols: instruments.map((i) => i.symbol),
        });
      }
      const strategyIds = registration.includeBaseline
        ? (["baseline-hold", ...candidates] as const)
        : candidates;
      const cells: ResearchMatrixCell<TheoryStudyKey>[] = [];
      for (const window of registration.windows)
        for (const scenario of registration.scenarios)
          for (const market of registration.markets) {
            if (
              stage === "first-pass" &&
              (window.label !== "development" || scenario !== "base")
            )
              continue;
            for (const strategyId of strategyIds) {
              if (!strategySupportsMarket(strategyId, market)) continue;
              const key = {
                market,
                strategyId,
                window: window.label,
                scenario,
              };
              cells.push({
                key,
                checkpointPath: join(
                  output,
                  `${identity}-${market}-${strategyId}-${window.label}-${scenario}.json`,
                ),
              });
            }
          }
      const results = await runResearchMatrix<TheoryStudyKey, TheoryStudyRow>({
        identity,
        journalPath: journal,
        cells,
        beforeResume: assertCommitIdentity,
        beforeCommit: assertCommitIdentity,
        blockedRow: ({ key }, error) => ({
          ...key,
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
        }),
        onRow: (row, _cell, origin) => {
          if (origin !== "computed") return;
          const { execution: _execution, ...summary } =
            row as unknown as Record<string, unknown>;
          process.stdout.write(JSON.stringify(summary) + "\n");
        },
        execute: async ({ key }) => {
          const { market, strategyId, scenario } = key;
          const window = registration.windows.find(
            (candidate) => candidate.label === key.window,
          );
          if (!window) throw new Error("Unknown research window");
          const data = marketData.get(market);
          if (!data) throw new Error("Unknown research market");
          const { instruments, calendar, symbols } = data;
          const request: PortfolioRequest = {
            market,
            initial: 1000000,
            start: window.start,
            end: window.end,
            calendar,
            instruments,
            strategies: [theoryStudyStrategy(strategyId, market, symbols)],
            sleeves: [
              {
                id: "swing",
                share: 1,
                maxPositions: 10,
                riskPerTrade: 0.01,
              },
            ],
            costs: researchExecutionCosts(market, scenario),
            observationDetail: "counts",
          };
          if (strategyId === lowVolatilityId)
            request.scheduledTargets = lowVolatilityTargets(
              instruments,
              calendar,
              window.start,
              window.end,
            );
          const started = performance.now();
          assertResearchBudget(budget);
          if (request.scheduledTargets?.length === 0)
            throw new Error("No month-end has eligible low-volatility inputs");
          const rankInput =
            strategyId === relativeStrengthId
              ? relativeStrengthInputs(
                  instruments,
                  calendar,
                  window.start,
                  window.end,
                )
              : null;
          const result = runPortfolio(
            rankInput
              ? { ...request, instruments: rankInput.instruments }
              : isEntryStudy(strategyId)
                ? {
                    ...request,
                    instruments: withEntryEvents(strategyId, instruments),
                  }
                : request,
            createResearchRunGuard(budget),
            createPortfolioPreparation(),
          );
          assertResearchBudget(budget);
          return {
            ...key,
            status: "completed",
            ...summarizeTheoryResult(result, request.initial),
            elapsedMs: Math.round(performance.now() - started),
            definition:
              strategyId === "baseline-hold"
                ? "Constant long, same universe and weight"
                : isEntryStudy(strategyId)
                  ? "Entry-event study, exit after five completed holding bars"
                  : strategyId === relativeStrengthId
                    ? "Frozen-pool composite RPS 20/50/120, weekly equal 10-slot book"
                    : strategyId === lowVolatilityId
                      ? "Lowest 60-return volatility at month end, ten positions at 10%"
                      : studyCatalog[strategyId],
            symbols: symbols.length,
            ...(request.scheduledTargets
              ? {
                  scheduledRebalances: request.scheduledTargets.length,
                  firstScheduledRebalance: request.scheduledTargets[0] ?? null,
                }
              : {}),
            ...(rankInput
              ? {
                  rpsCoverage: {
                    signalWeeks: rankInput.signalWeeks,
                    minimumCoverage: rankInput.minimumCoverage,
                    rebalanceWeeks: (result.bookDecisions ?? []).filter(
                      ({ decision }) => decision.targets !== null,
                    ).length,
                  },
                }
              : {}),
            ...(pathProof || rankInput || request.scheduledTargets
              ? {
                  execution: {
                    initial: request.initial,
                    costs: request.costs,
                    fills: result.fills,
                    slotRejections: result.rejections.filter((rejection) =>
                      rejection.reason.includes("持仓上限"),
                    ).length,
                  },
                }
              : {}),
          };
        },
      });
      await writeResearchJsonAtomic(
        join(output, `results-${identity}-${stage}.json`),
        {
          identity,
          registrationPath,
          stage,
          rows: results,
        },
        { beforeCommit: assertCommitIdentity },
      );
      return { identity, results };
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--inventory"))
    console.log(JSON.stringify(await methodPoolInventory(), null, 2));
  else await runTheoryStudy(process.argv.slice(2));
}
