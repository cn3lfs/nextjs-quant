import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readResearchCheckpoint,
  researchJsonHash,
} from "../src/server/research/research-run";
import { methodPoolInventory } from "./theory-study";
import {
  bindingForStrategy,
  isEntryStudyStrategy,
  isMethodPoolRegistrationVersion,
  methodPoolBindings,
  methodPoolMarkets,
} from "../src/lib/research/method-pool-bindings";
import { indexCoverageCases } from "./lib/research/method-pool-coverage";

type CaseKey = {
  market: string;
  strategyId: string;
  window: string;
  scenario: string;
};
type CaseRow = CaseKey & {
  status: "completed" | "blocked";
  buys?: number;
  sells?: number;
  peakPositions?: number;
  netReturn?: number;
  maxDrawdown?: number;
  reason?: string;
  fillsHash?: string;
  curveHash?: string;
};
type StoredCase = CaseRow & {
  path: string;
  identity: string;
  version: string;
};
const root = resolve(process.argv[2] ?? ".test-data/method-pool-ten");
const inventory = await methodPoolInventory();
const readCases: StoredCase[] = [];
for (const directory of await readdir(root, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const folder = join(root, directory.name);
  const files = await readdir(folder);
  for (const name of files.filter((file) =>
    /^registration-[a-f0-9]{64}\.json$/.test(file),
  )) {
    const identity = name.slice(13, -5);
    const registration = JSON.parse(await readFile(join(folder, name), "utf8"));
    if (!isMethodPoolRegistrationVersion(registration.version)) continue;
    if (researchJsonHash(registration) !== identity)
      throw new Error("Registration hash mismatch: " + name);
    const markets: string[] = registration.markets ?? ["cn-equity", "crypto"];
    const strategies: string[] =
      registration.includeBaseline === false
        ? registration.candidates
        : ["baseline-hold", ...registration.candidates];
    for (const market of markets)
      for (const strategyId of strategies)
        for (const { label: window } of registration.windows)
          for (const scenario of registration.scenarios) {
            const key = { market, strategyId, window, scenario };
            const path = join(
              folder,
              `${identity}-${market}-${strategyId}-${window}-${scenario}.json`,
            );
            const checkpoint = await readResearchCheckpoint<CaseRow>(path, {
              identity,
              key,
            });
            if (!checkpoint) continue;
            const row = checkpoint.row;
            if (
              row.market !== market ||
              row.strategyId !== strategyId ||
              row.window !== window ||
              row.scenario !== scenario ||
              !["completed", "blocked"].includes(row.status) ||
              (row.status === "completed" &&
                (!Number.isInteger(row.peakPositions) ||
                  row.peakPositions! < 0 ||
                  row.peakPositions! > 10 ||
                  !Number.isInteger(row.buys) ||
                  !Number.isInteger(row.sells) ||
                  row.buys! < 0 ||
                  row.sells! < 0))
            )
              throw new Error("Invalid case row: " + path);
            readCases.push({
              ...key,
              status: row.status,
              buys: row.buys,
              sells: row.sells,
              peakPositions: row.peakPositions,
              netReturn: row.netReturn,
              maxDrawdown: row.maxDrawdown,
              reason: row.reason,
              fillsHash: row.fillsHash,
              curveHash: row.curveHash,
              path,
              identity,
              version: registration.version,
            });
          }
  }
}
// Sort before deduplication so a copied checkpoint cannot depend on directory
// read order; grouping itself is deterministic too.
const cases = indexCoverageCases(
  [...readCases].sort((left, right) => left.path.localeCompare(right.path)),
);

/** Portfolio evidence comes from the single binding table. Legacy source
 * checkpoints that predate a binding are still readable, but never turn into
 * a proxy: the checkpoint keeps its own strategy identity. */
const replayProxies = new Map<string, string[]>();
for (const binding of methodPoolBindings) {
  if (binding.kind === "entry-experiment") continue;
  replayProxies.set(binding.preset, [
    ...(replayProxies.get(binding.preset) ?? []),
    binding.strategyId,
  ]);
}
for (const strategy of cases.keys()) {
  if (bindingForStrategy(strategy) || !strategy.startsWith("source-")) continue;
  const preset = strategy.slice("source-".length);
  replayProxies.set(preset, [...(replayProxies.get(preset) ?? []), strategy]);
}
function evidence(ids: readonly string[]) {
  return [...new Set(ids)].flatMap((strategyId) => cases.get(strategyId) ?? []);
}
const isEntryStudy = isEntryStudyStrategy;
const markets = methodPoolMarkets;
function runState(strategyId: string) {
  const rows = cases.get(strategyId) ?? [];
  if (rows.some((row) => row.status === "completed")) return "observed";
  return rows.length ? "blocked" : "not-run";
}
function marketEvidence(ids: readonly string[]) {
  const matches = evidence(ids);
  const bindings = ids.map((id) => bindingForStrategy(id));
  const allBound = ids.length > 0 && bindings.every(Boolean);
  const boundMarkets = new Set(
    bindings.flatMap((binding) => binding?.markets ?? []),
  );
  return Object.fromEntries(
    markets.map((market) => {
      if (allBound && !boundMarkets.has(market))
        return [
          market,
          {
            status: "unbound",
            runs: 0,
            completedRuns: 0,
            bothSidesRuns: 0,
            buysOnlyRuns: 0,
            zeroBuysRuns: 0,
            blocked: [],
          },
        ];
      const rows = matches.filter((row) => row.market === market);
      const completed = rows.filter((row) => row.status === "completed");
      return [
        market,
        {
          status: !ids.length
            ? "unbound"
            : completed.length
              ? "observed"
              : rows.length
                ? "blocked"
                : "not-run",
          runs: rows.length,
          completedRuns: completed.length,
          bothSidesRuns: completed.filter(
            (row) => row.buys! > 0 && row.sells! > 0,
          ).length,
          buysOnlyRuns: completed.filter(
            (row) => row.buys! > 0 && row.sells === 0,
          ).length,
          zeroBuysRuns: completed.filter((row) => row.buys === 0).length,
          blocked: rows
            .filter((row) => row.status === "blocked")
            .map(({ identity, strategyId, window, scenario, reason }) => ({
              identity,
              strategyId,
              window,
              scenario,
              reason,
            })),
        },
      ];
    }),
  );
}
const entryIds = inventory.candidates.filter(isEntryStudy);
const entryCompletion = Object.fromEntries(
  markets.map((market) => {
    const missing: string[] = [];
    const blocked: string[] = [];
    const conflicts: string[] = [];
    const verified = [];
    for (const id of entryIds) {
      const attempts = evidence([id]).filter(
        (row) =>
          row.market === market &&
          row.window === "development" &&
          row.scenario === "base",
      );
      const finished = attempts.filter((row) => row.status === "completed");
      if (!finished.length) {
        (attempts.length ? blocked : missing).push(id);
        continue;
      }
      const hashes = new Set(
        finished.map((row) =>
          JSON.stringify([row.fillsHash, row.curveHash, row.buys, row.sells]),
        ),
      );
      if (
        hashes.size !== 1 ||
        finished.some((row) => !row.fillsHash || !row.curveHash)
      ) {
        conflicts.push(id);
        continue;
      }
      verified.push({
        id,
        buys: finished[0]!.buys,
        sells: finished[0]!.sells,
        checkpoints: finished.map((row) => ({
          path: row.path,
          identity: row.identity,
        })),
      });
    }
    return [
      market,
      { expected: entryIds.length, verified, missing, blocked, conflicts },
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      account: inventory.account,
      portfolios: [
        ...new Set([
          ...inventory.candidates,
          ...methodPoolBindings
            .filter(
              (binding) =>
                binding.kind === "proxy" || binding.kind === "protected",
            )
            .map((binding) => binding.strategyId),
          ...cases.keys(),
        ]),
      ]
        .filter((id) => !isEntryStudy(id))
        .map((id) => {
          const bindings = methodPoolBindings.filter(
            (binding) => binding.strategyId === id,
          );
          return {
            id,
            bindingKinds: bindings.length
              ? [...new Set(bindings.map((b) => b.kind))]
              : [id.startsWith("source-") ? "source-exit" : "unbound"],
            sourcePresets: [...new Set(bindings.map((b) => b.preset))],
            registrationVersions: [
              ...new Set(evidence([id]).map((row) => row.version)),
            ],
            marketEvidence: marketEvidence([id]),
            cases: evidence([id]),
          };
        }),
      entryCompletion,
      signalStudies: entryIds.map((id) => ({
        id,
        bindingKind: bindingForStrategy(id)?.kind ?? "entry-experiment",
        registrationVersions: [
          ...new Set(evidence([id]).map((row) => row.version)),
        ],
        marketEvidence: marketEvidence([id]),
        cases: evidence([id]).map(
          ({ identity, market, window, scenario, status, buys, path }) => ({
            identity,
            market,
            window,
            scenario,
            status,
            signalsExecuted: buys,
            path,
          }),
        ),
      })),
      methods: inventory.methods.map((method) => {
        const portfolios = method.presets.flatMap(
          (preset) => replayProxies.get(preset) ?? [],
        );
        const portfolioBindings = [
          ...new Map(
            method.presets
              .flatMap((preset) =>
                (replayProxies.get(preset) ?? []).map((strategyId) => {
                  const bound = bindingForStrategy(strategyId);
                  const observedMarkets = [
                    ...new Set(
                      (cases.get(strategyId) ?? []).map((row) => row.market),
                    ),
                  ];
                  return {
                    preset,
                    strategyId,
                    // A legacy source checkpoint keeps its direct-run role;
                    // only a real proxy/protected binding can say otherwise.
                    kind:
                      bound?.kind ??
                      (strategyId.startsWith("source-")
                        ? "source-exit"
                        : "proxy"),
                    markets: bound?.markets ?? observedMarkets,
                    evidence: runState(strategyId),
                  };
                }),
              )
              .map((binding) => [binding.strategyId, binding] as const),
          ).values(),
        ];
        return {
          ...method,
          portfolios,
          portfolioBindings,
          portfolioEvidenceByMarket: marketEvidence(portfolios),
          signalEvidenceByMarket: marketEvidence(
            method.batchIds.filter(isEntryStudy),
          ),
          completedPortfolioRuns: evidence(portfolios).filter(
            (row) => row.status === "completed",
          ).length,
          unmatchedPortfolioPresets: method.presets.filter(
            (preset) => !replayProxies.has(preset),
          ),
        };
      }),
      theories: inventory.theories.map((card) => ({
        ...card,
        portfolioEvidenceByMarket: marketEvidence(
          card.batchIds.filter((id) => !isEntryStudy(id)),
        ),
        completedPortfolioRuns: evidence(
          card.batchIds.filter((id) => !isEntryStudy(id)),
        ).filter((row) => row.status === "completed").length,
      })),
    },
    null,
    2,
  ),
);
