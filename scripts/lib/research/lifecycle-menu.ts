import type { StrategyObjectInput } from "trading-strategies";

type Detector = {
  years: number;
  minimumBars: number;
  recoveryPercentile: number;
  minimumBreadth: number;
  minimumCoverage: number;
  maximumValuationPercentile: number;
  benchmark: "sh000300";
  diagnosticBenchmark: "sh000001";
};
export type LifecycleMain = {
  id: string;
  family: string;
  strategy: StrategyObjectInput;
  sizing: "equal" | "volatility" | "legacy";
  detector?: Detector;
  inputRef: string;
  sleevePolicy: { riskPerTrade: number; maxPositions: number };
};
export type LifecycleNeighbor = {
  id: string;
  parent: string;
  family: string;
  block: string;
  factor: number;
  patch: Record<string, number | number[]>;
};
const scaled = (value: number, factor: number) =>
  Number((value * factor).toPrecision(12));
const integer = (value: number, factor: number) =>
  Math.max(1, Math.round(value * factor));
const gate = (market: string) => ({
  kind: "trend-breadth" as const,
  benchmark: market === "crypto" ? "BTCUSDT" : "sh000906",
  period: 20,
  minimumBreadth: market === "crypto" ? 0 : 0.5,
  minimumCoverage: 0.6,
});
const overlay = (market: string, volatility: boolean) => ({
  ...(volatility ? { volatilityTarget: market === "crypto" ? 0.3 : 0.15 } : {}),
  lookback: 60 as const,
  drawdownBrake: {
    reduceAt: 0.1,
    pauseAt: 0.15,
    recoverAt: 0.05,
    pauseBars: 5,
  },
  symbolWeight: 0.15,
  heat: 0.06,
  ...(market === "cn-equity"
    ? { industryWeight: 0.3, industryBasis: "current-labelled" as const }
    : {}),
  correlationGroupRisk: 0.03,
  correlationThreshold: 0.8,
});
const protection = (multiple: number) => ({
  stop: { kind: "atr" as const, period: 14, multiple },
  chandelier: { period: 14, multiple },
});
const range = (period: number) => ({
  kind: "formula" as const,
  source: "选股:C>REF(HHV(H,N1),1) AND V>MA(V,20);",
  parameters: { N1: period },
});
const rps = { kind: "rps-composite" as const, periods: [20, 50, 120] };

export function lifecycleMainMenu(): LifecycleMain[] {
  const main: LifecycleMain[] = [];
  const add = (
    name: string,
    market: "cn-equity" | "crypto",
    sleeve: string,
    strategy: Omit<
      StrategyObjectInput,
      "id" | "version" | "market" | "sleeve" | "universe"
    >,
    sizing: LifecycleMain["sizing"],
    detector?: Detector,
  ) => {
    const id = `l3-${name}`;
    main.push({
      id,
      family: `${market}:${sleeve}`,
      strategy: {
        ...strategy,
        ...(market === "crypto"
          ? { sizing: { kind: "equal", positions: 2, tranches: 1 } as const }
          : {}),
        id,
        version: 1,
        market,
        sleeve,
        universe:
          market === "crypto"
            ? { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] }
            : { kind: "pool", id: "l3-frozen-csi800-20261108" },
      },
      sizing,
      ...(detector ? { detector } : {}),
      inputRef: market === "crypto" ? "crypto-inputs" : "classic-inputs",
      sleevePolicy: {
        riskPerTrade: sleeve === "low-zone" ? 0.1 : 0.02,
        maxPositions:
          sleeve === "low-zone"
            ? 5
            : market === "crypto"
              ? 2
              : (strategy.rebalance?.top ?? 10),
      },
    });
  };
  for (const kind of ["double-breakout", "formula-range"] as const)
    for (const regime of [false, true])
      add(
        `cn-swing-${kind}-${regime ? "regime" : "open"}`,
        "cn-equity",
        "swing",
        {
          period: "day",
          entry:
            kind === "double-breakout" ? { kind, side: "entry" } : range(20),
          rank: rps,
          ...(regime ? { regime: gate("cn-equity") } : {}),
          overlay: overlay("cn-equity", true),
          exit: protection(3),
          sizing: { kind: "equal", positions: 10, tranches: 1 },
        },
        "volatility",
      );
  for (const [kind, regime] of [
    ["classic", false],
    ["classic", true],
    ["rps", false],
  ] as const)
    add(
      `cn-swing-weekly-${kind}-${regime ? "regime" : "open"}`,
      "cn-equity",
      "swing",
      {
        period: "day",
        entry: { kind: "constant", value: true },
        rank:
          kind === "classic" ? { kind: "classic", model: "classic-five" } : rps,
        ...(regime ? { regime: gate("cn-equity") } : {}),
        overlay: overlay("cn-equity", true),
        rebalance: {
          kind: "ranked-weekly",
          top: 20,
          retentionMultiple: 1.5,
          weighting: "inverse-volatility",
        },
        exit: protection(3),
        sizing: { kind: "weight", weight: 1, tranches: 1 },
      },
      "volatility",
    );
  add(
    "cn-low-zone-market",
    "cn-equity",
    "low-zone",
    {
      period: "day",
      entry: { kind: "external", id: "l3-market-low-zone", side: "entry" },
      exit: {
        rule: { kind: "external", id: "l3-market-low-zone", side: "exit" },
        stop: { kind: "fixed", fraction: 0.25 },
        trailing: 0.33,
      },
      overlay: overlay("cn-equity", false),
      sizing: { kind: "equal", positions: 5, tranches: 3 },
    },
    "legacy",
    {
      years: 10,
      minimumBars: 1000,
      recoveryPercentile: 0.6,
      minimumBreadth: 0.3,
      minimumCoverage: 0.6,
      maximumValuationPercentile: 0.3,
      benchmark: "sh000300",
      diagnosticBenchmark: "sh000001",
    },
  );
  for (const regime of [false, true])
    for (const sizing of ["equal", "volatility"] as const)
      add(
        `crypto-swing-ma-${regime ? "regime" : "open"}-${sizing}`,
        "crypto",
        "swing",
        {
          period: "day",
          entry: { kind: "dual-ma", fast: 10, slow: 40, side: "entry" },
          ...(regime ? { regime: gate("crypto") } : {}),
          exit: {
            ...protection(3),
            rule: { kind: "dual-ma", fast: 10, slow: 40, side: "exit" },
          },
          overlay: overlay("crypto", sizing === "volatility"),
          sizing: { kind: "equal", positions: 20, tranches: 1 },
        },
        sizing,
      );
  for (const period of ["4h", "day"] as const)
    for (const sizing of ["equal", "volatility"] as const)
      add(
        `crypto-breakout-${period}-${sizing}`,
        "crypto",
        "breakout",
        {
          period,
          entry: range(period === "4h" ? 40 : 20),
          regime: gate("crypto"),
          costFilter: { atrPeriod: 14, minimumMoveToCost: 3 },
          exit: {
            ...protection(2),
            maxBars: period === "4h" ? 12 : 20,
            timeReentry: { cooldownBars: 1, requireNewSignal: true },
          },
          overlay: overlay("crypto", sizing === "volatility"),
          sizing: { kind: "equal", positions: 20, tranches: 1 },
        },
        sizing,
      );
  return main;
}

/** Independent parameter blocks, not a Cartesian search or result-selected grid. */
export function lifecycleNeighborhood(main: readonly LifecycleMain[]) {
  const neighbors: LifecycleNeighbor[] = [],
    noops: LifecycleNeighbor[] = [];
  for (const row of main)
    for (const factor of [0.9, 1.1]) {
      const s = row.strategy;
      const add = (
        block: string,
        patch: LifecycleNeighbor["patch"],
        noop = false,
      ) => {
        const candidate = {
          id: `${row.id}-n-${block}-${Math.round(factor * 100)}`,
          parent: row.id,
          family: row.family,
          block,
          factor,
          patch,
        };
        (noop ? noops : neighbors).push(candidate);
      };
      if (s.entry.kind === "dual-ma")
        add("entry-rule", {
          "strategy.entry.fast": integer(s.entry.fast, factor),
          "strategy.entry.slow": integer(s.entry.slow, factor),
          "strategy.exit.rule.fast": integer(s.entry.fast, factor),
          "strategy.exit.rule.slow": integer(s.entry.slow, factor),
        });
      else if (s.entry.kind === "formula")
        add("entry-rule", {
          "strategy.entry.parameters.N1": integer(
            s.entry.parameters?.N1 ?? 20,
            factor,
          ),
        });
      else if (row.detector)
        add("entry-rule", {
          "detector.years": Math.min(
            10,
            Math.max(5, integer(row.detector.years, factor)),
          ),
          "detector.minimumBars": Math.max(
            1000,
            integer(row.detector.minimumBars, factor),
          ),
          "detector.minimumBreadth": scaled(
            row.detector.minimumBreadth,
            factor,
          ),
          "detector.maximumValuationPercentile": scaled(
            row.detector.maximumValuationPercentile,
            factor,
          ),
        });
      if (s.rank?.kind === "rps-composite")
        add("entry-rank", {
          "strategy.rank.periods": s.rank.periods!.map((v) =>
            integer(v, factor),
          ),
        });
      if (s.regime?.kind === "trend-breadth")
        add("entry-regime", {
          "strategy.regime.period": integer(s.regime.period!, factor),
          "strategy.regime.minimumBreadth": scaled(
            s.regime.minimumBreadth!,
            factor,
          ),
        });
      if (s.rebalance)
        add("entry-selection", {
          "strategy.rebalance.top": integer(s.rebalance.top, factor),
          "strategy.rebalance.retentionMultiple": scaled(
            s.rebalance.retentionMultiple!,
            factor,
          ),
        });
      add(
        "exit-protection",
        s.exit.chandelier
          ? {
              "strategy.exit.stop.multiple": scaled(
                s.exit.chandelier.multiple,
                factor,
              ),
              "strategy.exit.chandelier.multiple": scaled(
                s.exit.chandelier.multiple,
                factor,
              ),
            }
          : {
              "strategy.exit.stop.fraction": scaled(0.25, factor),
              "strategy.exit.trailing": scaled(0.33, factor),
              "detector.recoveryPercentile": scaled(
                row.detector!.recoveryPercentile,
                factor,
              ),
            },
      );
      if (s.exit.maxBars)
        add("exit-time", {
          "strategy.exit.maxBars": integer(s.exit.maxBars, factor),
        });
      if (s.costFilter)
        add("entry-cost", {
          "strategy.costFilter.minimumMoveToCost": scaled(
            s.costFilter.minimumMoveToCost,
            factor,
          ),
        });
      if (s.exit.timeReentry)
        add(
          "exit-cooldown",
          {
            "strategy.exit.timeReentry.cooldownBars": integer(
              s.exit.timeReentry.cooldownBars,
              factor,
            ),
          },
          true,
        );
    }
  return { neighbors, noops };
}

export function applyLifecyclePatch(
  main: LifecycleMain,
  neighbor: LifecycleNeighbor,
): LifecycleMain {
  if (neighbor.parent !== main.id) throw new Error("Neighbor parent mismatch");
  const output = structuredClone(main);
  for (const [path, value] of Object.entries(neighbor.patch)) {
    const keys = path.split(".");
    let node = output as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== "object")
        throw new Error(`Missing numeric neighborhood path: ${path}`);
      node = node[key] as Record<string, unknown>;
    }
    if (!(keys.at(-1)! in node))
      throw new Error(`Unknown numeric neighborhood field: ${path}`);
    node[keys.at(-1)!] = value;
  }
  output.id = neighbor.id;
  output.strategy.id = neighbor.id;
  return output;
}

export function lifecyclePreregistration() {
  const main = lifecycleMainMenu(),
    { neighbors, noops } = lifecycleNeighborhood(main);
  const families = [...new Set(main.map((r) => r.family))].map((family) => ({
    family,
    main: main.filter((r) => r.family === family).length,
    neighbors: neighbors.filter((r) => r.family === family).length,
    economicConfigurations: [...main, ...neighbors].filter(
      (r) => r.family === family,
    ).length,
  }));
  return {
    version: "lifecycle-preregistration-1",
    batch: "L3",
    method: "lifecycle-2",
    purpose: "preregistered",
    status: "engineering-review-before-return-research",
    task: ".test-data/lifecycle-20261116",
    freezeRule:
      "Freeze this exact file and all input/build/axis hashes before calculating any return; changed parameters require a new declared round, never overwrite this registration.",
    methodConfig: "research/configs/l2-method.json",
    limits: {
      mainPerMarketSleeve: 12,
      main: main.length,
      neighbors: neighbors.length,
      economicConfigurations: main.length + neighbors.length,
      schemaNoops: noops.length,
      schemaNoopsActuallyRun: 0,
      primaryDsrCandidatesBeforeExecutionNoopAudit:
        main.length + neighbors.length,
      executionScenarios: (main.length + neighbors.length) * 3,
    },
    families,
    rankSource: {
      universe:
        "All baseline and rank-neighbor RPS values are recomputed on the SAME frozen CSI800 price-input cross section; NEVER mix historical 5564-market baseline RPS with 799-pool neighbors.",
      periods: [18, 20, 22, 45, 50, 55, 108, 120, 132],
      computation:
        "Reuse quant-rps rankReturns (1-based mean ties) on actual calendar-aligned endpoint returns for every registered period. Every endpoint must exist with positive turnover; no price/constant fill. Freeze eligible symbols and missing inputs per date/period before evaluation. Current constituent/local price coverage bias is explicit.",
      oldRpsSnapshots:
        "Do not read the old 20/50/120-only external.rps as new rank evidence. Missing registered periods is a data gap, never an economic no-trade or stable neighbor.",
      resource:
        "One shared read-only source parse, stream one date x period cross section; persist compact per-symbol rank arrays under the registered cache budget and bind source/pool/period/calendar hashes.",
    },
    counting: {
      primary:
        "All 120 main and valid neighbors enter their market x sleeve DSR/CSCV pool on one common OOS daily axis. Effective N is computed after complete OOS series exist.",
      schemaNoop:
        "The 8 rounded cooldown neighbors equal the parent before execution, are NOT in 120, and are not run. Listed separately below.",
      executionNoop:
        "Identical full trade lists are only detectable after execution. Preserve their result/audit rows, mark stability untestable, deduplicate exact trials for effective N per lifecycle-2; never presume no-op from similar rule labels.",
      stress:
        "Each of 120 configurations runs base, double all commission/minimum commission/tax/slippage costs, and discretionary one-bar delay. 360 planned runs; stress scenarios are gates, not independently selectable candidates. If a stress scenario is ever selected as a candidate it must enter DSR as another trial.",
      terminalAccounting:
        "Not a candidate search; missing terminal evidence blocks trusted returns. Any required last-close/total-loss sensitivity is explicitly labelled accounting and not used to choose winners; source-only applicability is frozen before execution.",
      noSearch:
        "No Cartesian combinations, no new mains, no result-driven parameter tuning. Fixed user capital/industry/heat/brake thresholds are governance constraints, not optimization dimensions.",
    },
    axes: {
      freezeBeforeReturns: true,
      cnSwing: {
        start: "2018-09-03",
        end: "2026-11-06",
        source:
          "Frozen classic input commonStart / final completed source week; all 47 configurations use exactly this tradable daily axis before split.",
        longerSignalHistory: "diagnostic only, no additional selectable trial",
      },
      cnLowZone: {
        primary:
          "sh000300 from 2005, only after declared causal warmup and constituent/valuation coverage; no fake early-cycle completeness",
        diagnostic:
          "longer sh000001, separate diagnostic, not another candidate",
      },
      crypto: {
        unit: "UTC complete natural day",
        intradayLabels:
          "END label: group by completion-1ms; 4h complete day requires 04/08/12/16/20/next00, no missing component or zero fill",
        start:
          "Per market x sleeve family, maximum earliest source-complete date after every declared main/neighbor warmup (including 61 complete daily closes for 60 returns); computed from source coverage ONLY, before any equity/return run.",
        end: "Minimum last full UTC day across every required symbol/period/benchmark, capped at 2026-11-13; source-only intersection is frozen with exact dates and input hash before returns.",
        missing:
          "Do not shorten OOS axes after viewing results or impute zero. Any missing required day makes evidence incomplete, preserving the declared axis.",
      },
      split: {
        trainFraction: 0.4,
        testFraction: 0.1,
        holdoutFraction: 0.2,
        holdoutStartRule:
          "last 20 percent of frozen family daily axis; rolling OOS on preceding 80 percent, identical windows for all family trials",
      },
    },
    sourcePolicy: {
      cnUniverse:
        "The original frozen CSI800 current-constituent price pool, explicitly survivorship biased; any later delisting audit/industry source must be hashed and labelled, not treated as PIT.",
      cryptoUniverse:
        "BTCUSDT and ETHUSDT ONLY, matching current authorized scope. Freeze both original native-period Binance source hashes before family coverage intersection. Old 20-pair runs remain historical comparisons, not new candidates or trials.",
      industry:
        "CN current labels allowed only with current-industry-lookahead source/hash; crypto has no default industry cap. Correlation uses same-industry OR rho>=0.8 connected groups and 3% planned-stop equity risk, explicit strategy config.",
      lowValuation:
        "Aggregate positive market-cap coverage >=60% separately for PE/PB, trailing <=30th percentile, actual PIT announcement availability; missing history is unknown, never zero or today's values backfilled.",
    },
    resources: {
      processes: 1,
      nodeHeapMiB: 4096,
      mutableOutputRoot: ".test-data/lifecycle-20261116/l3",
      oracleOutputRoot: ".test-data/lifecycle-20261116/oracle",
      sourceReads:
        "Read-only shared frozen source, parse once per heavy process; no per-trial copies or parallel heavy processes.",
      projectedDiskMiB: {
        oracle: 2,
        sourceDerivedCache: 512,
        checkpointsAndCompactDistributions: 512,
        totalHardStop: 1026,
      },
      checkpoint:
        "Atomic content-addressed per configuration/scenario manifest only after exact input/config/build/axis hash binding. Resume only matching identities; at most one active run. Keep compact daily arrays/trade returns plus actual fill evidence for selected final candidate; never fabricate distributions from summaries.",
      budgetStop:
        "Stop cleanly before projected disk budget, heap exhaustion or source mismatch. Preserve raw inputs/manifests. Do not prune raw/active evidence to continue.",
      actualReturnRun:
        "NOT AUTHORIZED until engineering/oracle/distribution and this frozen registration pass manager review.",
    },
    main,
    neighbors,
    schemaNoops: noops,
  };
}
