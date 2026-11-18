import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
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
import { executionCostsSchema } from "trading-strategy-core/costs";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "../src/server/research/corporate-actions";
import { readPublicData } from "../src/server/data-sources/binance/public-data-store";
import type { LifecycleSignalBasis } from "../src/server/research/lifecycle-source";
import {
  ResearchIdentityError,
  ResearchRunAbortedError,
  appendResearchAttempt,
  assertResearchIdentity,
  assertResearchRunActive,
  createResearchRunBudget,
  createResearchRunGuard,
  ensureResearchRegistration,
  readResearchCheckpoint,
  reportResearchJournalFailure,
  researchDigest,
  researchJsonHash,
  withResearchRunLock,
  writeResearchCheckpoint,
  writeResearchJsonAtomic,
  type ResearchRunBudget,
} from "../src/server/research/research-run";

const defaultBudget: ResearchRunBudget = { maxRssMiB: 4096 };
function assertResearchBudget(budget: ResearchRunBudget = defaultBudget) {
  assertResearchRunActive(budget);
}
async function artifactIdentity() {
  const hash = createHash("sha256");
  for (const folder of [
    "packages/quant-backtest/dist",
    "packages/trading-strategies/dist",
    "packages/trading-strategy-core/dist",
    "packages/tstdx/dist",
    // App readers import shared crypto/date, database-path and outbound helpers.
    // Hash the complete app source closure conservatively rather than missing
    // a transitive runtime dependency when an import is added later.
    "src",
  ]) {
    for (const name of (await readdir(folder, { recursive: true }))
      .filter((name) => /\.(js|ts|tsx|json)$/.test(name))
      .sort()) {
      hash.update(join(folder, name));
      hash.update(await readFile(join(folder, name)));
    }
  }
  return hash.digest("hex");
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
  return studyStrategies.filter(
    (id) =>
      createExtendedStudyRule(id, []) !== null && !id.startsWith("research-"),
  );
}

export function theoryStudyStrategy(
  strategy: StudyStrategy | "baseline-hold",
  market: "cn-equity" | "crypto",
  symbols: string[],
): StrategyObjectInput {
  return {
    id: `theory-study-${market}-${strategy}`,
    version: 1,
    market,
    period: "day",
    universe: { kind: "symbols", symbols },
    entry:
      strategy === "baseline-hold"
        ? { kind: "constant", value: true }
        : { kind: "study-rule", strategy, side: "entry" },
    exit:
      strategy === "baseline-hold"
        ? {}
        : { rule: { kind: "study-rule", strategy, side: "exit" } },
    sizing: { kind: "weight", weight: 1 / symbols.length },
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
  return {
    netReturn: (result.curve.at(-1)?.equity ?? initial) / initial - 1,
    maxDrawdown,
    buys: result.fills.filter((f) => f.side === "buy").length,
    sells: result.fills.filter((f) => f.side === "sell").length,
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

export async function runTheoryStudy(args: string[]) {
  const value = (name: string, fallback: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  const output = resolve(value("--output", ".test-data/theory-20261117"));
  const rel = relative(resolve(".test-data"), output);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Output must be a task subdirectory under .test-data");
  const limit = Number(value("--limit", "30"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 799)
    throw new Error("limit must be 1..799");
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
      const candidates = theoryStudyCandidates().filter(
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
      const runnerBytes = await readFile(new URL(import.meta.url));
      const runnerHash = researchDigest(runnerBytes);
      const runnerSnapshotPath = join(output, `runner-${runnerHash}.ts`);
      await writeFile(runnerSnapshotPath, runnerBytes, { flag: "wx" }).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
          if (researchDigest(await readFile(runnerSnapshotPath)) !== runnerHash)
            throw new Error("Runner snapshot conflicts with source identity");
        },
      );
      const registration = {
        version: "theory-study-1",
        strategyBuildHash,
        engineBuildHash: maBaselineBuildHash,
        executableArtifactsHash: await artifactIdentity(),
        lockfileHash: researchDigest(await readFile("pnpm-lock.yaml")),
        runnerHash,
        runnerSnapshotPath,
        windows: theoryStudyWindows,
        candidates,
        scenarios: ["base", "double-cost"],
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
        assertResearchIdentity(
          registration.executableArtifactsHash,
          await artifactIdentity(),
          "Executable artifacts changed during research",
        );
        assertResearchIdentity(
          registration.runnerHash,
          researchDigest(await readFile(new URL(import.meta.url))),
          "Research runner changed during research",
        );
        // Cancellation can arrive while the hashes above are being read.
        assertResearchRunActive(budget);
      };
      const results: unknown[] = [];
      for (const [market, instruments] of [
        ["cn-equity", inputs.cn],
        ["crypto", inputs.crypto],
      ] as const) {
        const calendar = [
          ...new Set(instruments.flatMap((i) => i.bars.map((b) => b.date))),
        ].sort();
        const symbols = instruments.map((i) => i.symbol);
        for (const strategyId of ["baseline-hold", ...candidates] as const) {
          const preparation = createPortfolioPreparation();
          for (const window of theoryStudyWindows)
            for (const scenario of ["base", "double-cost"] as const) {
              const key = {
                market,
                strategyId,
                window: window.label,
                scenario,
              };
              const checkpoint = join(
                output,
                `${identity}-${market}-${strategyId}-${window.label}-${scenario}.json`,
              );
              const saved = await readResearchCheckpoint(checkpoint, {
                identity,
                key,
                beforeResume: assertCommitIdentity,
              });
              if (saved) {
                results.push(saved.row);
                await appendResearchAttempt(journal, {
                  identity,
                  key,
                  event: "restored",
                  contentHash: saved.contentHash,
                });
                continue;
              }
              const attemptId = `${Date.now()}-${process.pid}`;
              await appendResearchAttempt(journal, {
                identity,
                key,
                attemptId,
                event: "started",
              });
              const multiplier = scenario === "base" ? 1 : 2;
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
                    maxPositions: symbols.length,
                    riskPerTrade: 0.01,
                  },
                ],
                costs: executionCostsSchema.parse({
                  commissionBps: (market === "crypto" ? 10 : 3) * multiplier,
                  minimumCommission: market === "crypto" ? 0 : 5 * multiplier,
                  sellTaxBps: market === "crypto" ? 0 : 5 * multiplier,
                  ...(market === "cn-equity"
                    ? {
                        sellTaxSchedule: {
                          kind: "cn-equity-historical",
                          multiplier,
                        },
                      }
                    : {}),
                  slippageBps: 5 * multiplier,
                }),
                observationDetail: "counts",
              };
              const started = performance.now();
              assertResearchBudget(budget);
              let row: unknown;
              let outcome: "completed" | "blocked" = "completed";
              try {
                const result = runPortfolio(
                  request,
                  createResearchRunGuard(budget),
                  preparation,
                );
                assertResearchBudget(budget);
                row = {
                  ...key,
                  status: "completed",
                  ...summarizeTheoryResult(result, request.initial),
                  elapsedMs: Math.round(performance.now() - started),
                  definition:
                    strategyId === "baseline-hold"
                      ? "Constant long, same universe and weight"
                      : studyCatalog[strategyId],
                  symbols: symbols.length,
                };
              } catch (error) {
                if (
                  error instanceof ResearchRunAbortedError ||
                  error instanceof ResearchIdentityError
                ) {
                  // Journaling is secondary here; preserve the original stop.
                  await appendResearchAttempt(journal, {
                    identity,
                    key,
                    attemptId,
                    event: "aborted",
                    reason:
                      error instanceof Error ? error.message : String(error),
                  }).catch((error) =>
                    reportResearchJournalFailure(journal, error),
                  );
                  throw error;
                }
                outcome = "blocked";
                row = {
                  ...key,
                  status: "blocked",
                  reason:
                    error instanceof Error ? error.message : String(error),
                };
              }
              let contentHash: string;
              try {
                contentHash = await writeResearchCheckpoint(
                  checkpoint,
                  { identity, key, row },
                  { beforeCommit: assertCommitIdentity },
                );
              } catch (error) {
                await appendResearchAttempt(journal, {
                  identity,
                  key,
                  attemptId,
                  event:
                    error instanceof ResearchRunAbortedError ||
                    error instanceof ResearchIdentityError
                      ? "aborted"
                      : "failed",
                  reason:
                    error instanceof Error ? error.message : String(error),
                }).catch((error) =>
                  reportResearchJournalFailure(journal, error),
                );
                throw error;
              }
              await appendResearchAttempt(journal, {
                identity,
                key,
                attemptId,
                event: outcome,
                contentHash,
              });
              results.push(row);
              process.stdout.write(JSON.stringify(row) + "\n");
            }
        }
      }
      await assertCommitIdentity();
      await writeResearchJsonAtomic(join(output, `results-${identity}.json`), {
        identity,
        registrationPath,
        rows: results,
      });
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
  await runTheoryStudy(process.argv.slice(2));
}
