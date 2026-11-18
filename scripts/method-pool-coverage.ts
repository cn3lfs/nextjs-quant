import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readResearchCheckpoint,
  researchJsonHash,
} from "../src/server/research/research-run";
import { methodPoolInventory } from "./theory-study";
import {
  volumeStudyBindings,
  wyckoffStudyBindings,
} from "../packages/trading-strategies/src/study-catalog";

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
const root = resolve(process.argv[2] ?? ".test-data/method-pool-ten");
const inventory = await methodPoolInventory();
const cases = new Map<
  string,
  (CaseRow & { path: string; identity: string })[]
>();
for (const directory of await readdir(root, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const folder = join(root, directory.name);
  const files = await readdir(folder);
  for (const name of files.filter((file) =>
    /^registration-[a-f0-9]{64}\.json$/.test(file),
  )) {
    const identity = name.slice(13, -5);
    const registration = JSON.parse(await readFile(join(folder, name), "utf8"));
    if (registration.version !== "theory-study-ten-2") continue;
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
            const recorded = cases.get(strategyId) ?? [];
            recorded.push({
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
            });
            cases.set(strategyId, recorded);
          }
  }
}

const replayProxies = new Map<string, string[]>([
  ["sw-double-prior20", ["research-breakout"]],
  ["vp-up-expanded-confirm", ["research-volume-price"]],
  ["wy-sos-daily", ["research-wyckoff"]],
]);
for (const [strategy, preset] of Object.entries({
  ...volumeStudyBindings,
  ...wyckoffStudyBindings,
})) {
  replayProxies.set(preset, [...(replayProxies.get(preset) ?? []), strategy]);
}
for (const strategy of cases.keys()) {
  if (!strategy.startsWith("source-sw-")) continue;
  const preset = strategy.slice("source-".length);
  replayProxies.set(preset, [...(replayProxies.get(preset) ?? []), strategy]);
}
function evidence(ids: readonly string[]) {
  return [...new Set(ids)].flatMap((strategyId) => cases.get(strategyId) ?? []);
}
const isEntryStudy = (id: string) =>
  id.startsWith("entry5-") || id === "research-growth";
const markets = ["cn-equity", "crypto"] as const;
function marketEvidence(ids: readonly string[]) {
  const matches = evidence(ids);
  return Object.fromEntries(
    markets.map((market) => {
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
          completed: completed.length,
          bothSides: completed.filter((row) => row.buys! > 0 && row.sells! > 0)
            .length,
          buysOnly: completed.filter((row) => row.buys! > 0 && row.sells === 0)
            .length,
          zeroBuys: completed.filter((row) => row.buys === 0).length,
          blocked: rows
            .filter((row) => row.status === "blocked")
            .map(({ strategyId, window, scenario, reason }) => ({
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
          ...Object.keys(volumeStudyBindings),
          ...Object.keys(wyckoffStudyBindings),
          ...cases.keys(),
        ]),
      ]
        .filter((id) => !isEntryStudy(id))
        .map((id) => ({
          id,
          marketEvidence: marketEvidence([id]),
          cases: evidence([id]),
        })),
      entryCompletion,
      signalStudies: entryIds.map((id) => ({
        id,
        marketEvidence: marketEvidence([id]),
        cases: evidence([id]).map(
          ({ market, window, scenario, status, buys, path }) => ({
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
        return {
          ...method,
          portfolios,
          portfolioEvidenceByMarket: marketEvidence(portfolios),
          signalEvidenceByMarket: marketEvidence(
            method.batchIds.filter(isEntryStudy),
          ),
          completedPortfolioCases: evidence(portfolios).filter(
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
        completedPortfolioCases: evidence(
          card.batchIds.filter((id) => !isEntryStudy(id)),
        ).filter((row) => row.status === "completed").length,
      })),
    },
    null,
    2,
  ),
);
