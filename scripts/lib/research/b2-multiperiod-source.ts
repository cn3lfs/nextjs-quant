import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type {
  StrategyObjectInput,
  TripleScreenVariant,
} from "trading-strategies";
import {
  runPortfolio,
  maBaselineBuildHash,
  type PortfolioRequest,
} from "quant-backtest";
import { strategyBuildHash } from "trading-strategies";
import { gzipSync, gunzipSync } from "node:zlib";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { gfCalendarReference } from "../../../src/server/data-sources/gf/gf-calendar";
import type { CalendarReference } from "../../../src/server/market/data-health";
import { loadTheoryMultiperiodSource } from "../../../src/server/research/theory-multiperiod-source";
import {
  loadTheoryPriceTicks,
  type TheoryPriceTick,
} from "../../../src/server/research/theory-price-ticks";
import {
  ResearchCheckpointError,
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
  researchJsonHash,
  validateResearchRunBudget,
  withResearchRunLock,
  writeResearchCheckpoint,
  writeResearchJsonAtomic,
  type ResearchRunBudget,
} from "../../../src/server/research/research-run";

export const b2MultiperiodRegistration = {
  version: 2,
  quality: "rule-check-only",
  selection:
    "First three sorted symbols of existing frozen 799 execution pool; no result-driven substitution",
  cnSymbols: ["sh600000", "sh600004", "sh600008"],
  cryptoSymbols: ["cxBTCUSDT", "cxETHUSDT"],
  indexCoverageOnly: "sh000300",
  start: "2026-10-12",
  end: "2026-11-13",
  initial: 1000000,
  variants: ["week-day", "day-hour-five"],
  costScenarios: ["base", "double-cost"],
  tdxRoot: "E:/new_tdx64",
  binancePublicDataRoot: resolve(
    ".test-data/r2a4/data/market-data/binance-public-data",
  ),
  sourceManifest: resolve(
    ".test-data/lifecycle-20261116/l3/sources/source-978a42271380e3609b78f644b74772a323203c917c78e805d3a3ed18ce247a1e.json",
  ),
} as const;
async function runtimeIdentity() {
  const files: Record<string, string> = {};
  for (const directory of [
    "src",
    "packages/trading-strategies/src",
    "packages/trading-strategies/dist",
    "packages/quant-backtest/src",
    "packages/quant-backtest/dist",
    "packages/trading-strategy-core/src",
    "packages/trading-strategy-core/dist",
    "packages/tstdx/src",
    "packages/tstdx/dist",
    "packages/quant-rps/src",
    "packages/quant-rps/dist",
  ]) {
    for (const relative of (await readdir(directory, { recursive: true }))
      .filter((f) => /\.(ts|tsx|js|json)$/.test(f))
      .sort()) {
      const path = join(directory, relative);
      files[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  for (const path of [
    "scripts/lib/research/b2-multiperiod-source.ts",
    "pnpm-lock.yaml",
  ])
    files[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return { strategyBuildHash, engineBuildHash: maBaselineBuildHash, files };
}
type RunStatus = {
  status: "running" | "completed" | "failed";
  attempts: number;
  resultHash?: string;
  reason?: string;
  inputHash: string;
};
export function b2MultiperiodStrategy(
  market: "cn-equity" | "crypto",
  variant: TripleScreenVariant,
): StrategyObjectInput {
  const symbols = [
    ...(market === "cn-equity"
      ? b2MultiperiodRegistration.cnSymbols
      : b2MultiperiodRegistration.cryptoSymbols),
  ];
  return {
    id: `b2-${market}-${variant}`,
    version: 2,
    market,
    period: variant === "week-day" ? "day" : "5m",
    universe: { kind: "symbols", symbols },
    entry: { kind: "triple-screen", variant, side: "entry" },
    exit: { rule: { kind: "triple-screen", variant, side: "exit" } },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  };
}
export async function freezeB2Calendars(
  directory: string,
  months: string[],
  budget?: ResearchRunBudget,
) {
  const refs: CalendarReference[] = [],
    failures: { month: string; reason: string }[] = [];
  for (const month of months) {
    if (budget) assertResearchRunActive(budget);
    const path = join(directory, `calendar-${month}.json`);
    try {
      let reference: CalendarReference;
      try {
        reference = JSON.parse(
          await readFile(path, "utf8"),
        ) as CalendarReference;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        reference = await gfCalendarReference(
          Date.parse(`${month}-15T12:00:00+08:00`),
        );
        await writeResearchJsonAtomic(path, reference);
      }
      refs.push(reference);
      console.log(`calendar ${month} ready`);
    } catch (error) {
      if (error instanceof ResearchRunAbortedError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ month, reason });
      console.log(`calendar ${month} blocked: ${reason}`);
    }
  }
  const combined = {
    days: [...new Set(refs.flatMap((r) => r.days))].sort(),
    closedDays: [...new Set(refs.flatMap((r) => r.closedDays ?? []))].sort(),
    source: "Frozen GF monthly trading-day flags",
    hash: researchJsonHash(refs.map((r) => r.hash)),
  };
  await writeResearchJsonAtomic(join(directory, "calendar-summary.json"), {
    combined,
    failures,
  });
  return { combined, failures };
}
export type B2MultiperiodRunOptions = {
  /** New research must pass the current task root; the historical default is
   * kept only for reproducing the recorded B2 run. */
  output?: string;
  budget?: ResearchRunBudget;
};

/** A shared-envelope checkpoint must still belong to the current frozen
 * input; its envelope identity alone does not bind the input hash. */
export function assertCheckpointInputHash(
  row: unknown,
  inputHash: string,
  path: string,
): void {
  if (
    typeof row !== "object" ||
    row === null ||
    !("inputHash" in row) ||
    (row as { inputHash?: unknown }).inputHash !== inputHash
  )
    throw new ResearchCheckpointError(
      `Research checkpoint input hash mismatch: ${path}`,
    );
}

/** Old result files are read-only evidence. When they recorded the source
 * identity, it must match the current registration. */
export function assertLegacyCheckpointEvidence(
  evidence: unknown,
  registrationHash: string,
  identityHash: string,
): void {
  if (typeof evidence !== "object" || evidence === null) return;
  const recorded = evidence as {
    registrationHash?: unknown;
    identityHash?: unknown;
  };
  if (
    (recorded.registrationHash !== undefined &&
      recorded.registrationHash !== registrationHash) ||
    (recorded.identityHash !== undefined &&
      recorded.identityHash !== identityHash)
  )
    throw new ResearchCheckpointError(
      "Legacy checkpoint evidence identity mismatch",
    );
}

export async function runB2MultiperiodPreparation(
  run = false,
  options: B2MultiperiodRunOptions = {},
) {
  const directory = resolve(
    options.output ?? ".test-data/method-pool-ten/multiperiod",
  );
  const outputRelative = relative(resolve(".test-data"), directory);
  if (
    !outputRelative ||
    outputRelative.startsWith("..") ||
    isAbsolute(outputRelative)
  )
    throw new Error("Output must be a task subdirectory under .test-data");
  const isolation = process.env.QUANT_DATA_DIR;
  const isolationRelative = isolation
    ? relative(resolve(".test-data"), resolve(isolation))
    : "..";
  if (
    !isolation ||
    !isAbsolute(isolation) ||
    !isolationRelative ||
    isolationRelative.startsWith("..") ||
    isAbsolute(isolationRelative)
  )
    throw new Error(
      "Set absolute isolated QUANT_DATA_DIR under .test-data before running",
    );
  const budget: ResearchRunBudget = options.budget
    ? validateResearchRunBudget(options.budget)
    : createResearchRunBudget({ maxRssMiB: 4096 });
  const guard = createResearchRunGuard(budget);
  await mkdir(directory, { recursive: true });
  return await withResearchRunLock(join(directory, ".run.lock"), async () => {
    const registrationPath = join(directory, "registration.json");
    await ensureResearchRegistration(
      registrationPath,
      b2MultiperiodRegistration,
    );
    const source = JSON.parse(
      await readFile(b2MultiperiodRegistration.sourceManifest, "utf8"),
    ) as {
      identities: { classic: { normalized: { executionSymbols: string[] } } };
    };
    if (
      JSON.stringify(
        [...source.identities.classic.normalized.executionSymbols]
          .sort()
          .slice(0, 3),
      ) !== JSON.stringify(b2MultiperiodRegistration.cnSymbols)
    )
      throw new Error("Frozen pool selection changed");
    const months = Array.from({ length: 26 }, (_, i) =>
      new Date(Date.UTC(2024, 9 + i, 1)).toISOString().slice(0, 7),
    );
    // Fetch the four intraday months first, then complete the weekly warmup calendar.
    const ordered = [
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      ...months.filter((m) => m < "2026-08"),
    ];
    const calendar = await freezeB2Calendars(directory, ordered, budget);
    let ticks: Record<string, TheoryPriceTick> | undefined;
    try {
      ticks = JSON.parse(
        await readFile(join(directory, "price-ticks.json"), "utf8"),
      ) as Record<string, TheoryPriceTick>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        ticks = await loadTheoryPriceTicks();
        await writeResearchJsonAtomic(
          join(directory, "price-ticks.json"),
          ticks,
        );
      } catch (failure) {
        if (failure instanceof ResearchRunAbortedError) throw failure;
        console.log(
          `price ticks blocked: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    const identity = await runtimeIdentity(),
      identityHash = researchJsonHash(identity);
    const registrationHash = researchJsonHash({
      registration: b2MultiperiodRegistration,
      identityHash,
      calendar: calendar.combined,
      ticks,
    });
    await writeResearchJsonAtomic(
      join(directory, `${registrationHash}-identity.json`),
      { registrationHash, identityHash, identity },
    );
    const summaryPath = join(directory, `${registrationHash}-summary.json`);
    let summary: {
      registrationHash: string;
      identityHash: string;
      cases: Record<string, RunStatus>;
      actualCalls: number;
    } = { registrationHash, identityHash, cases: {}, actualCalls: 0 };
    try {
      summary = JSON.parse(
        await readFile(summaryPath, "utf8"),
      ) as typeof summary;
      if (
        summary.registrationHash !== registrationHash ||
        summary.identityHash !== identityHash
      )
        throw new Error("Resume identity mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const saveSummary = async () => {
      await writeResearchJsonAtomic(summaryPath, summary);
      await writeResearchJsonAtomic(join(directory, "latest-summary.json"), {
        registrationHash,
        summary: summaryPath,
        quality: "rule-check-only",
      });
    };
    const assertIdentity = async () => {
      assertResearchRunActive(budget);
      assertResearchIdentity(
        identityHash,
        researchJsonHash(await runtimeIdentity()),
        "Runtime/source changed during registered execution",
      );
      // Cancellation can arrive while the runtime hash is being read.
      assertResearchRunActive(budget);
    };
    const resultOf = (row: unknown) =>
      typeof row === "object" &&
      row !== null &&
      "inputHash" in row &&
      "result" in row
        ? (row as { result: unknown }).result
        : row;
    const journal = join(directory, `attempts-${registrationHash}.jsonl`);
    for (const market of ["cn-equity", "crypto"] as const)
      for (const variant of b2MultiperiodRegistration.variants) {
        const key = `${market}-${variant}`;
        try {
          const strategy = b2MultiperiodStrategy(market, variant);
          const loaded = await loadTheoryMultiperiodSource({
            strategy,
            start: b2MultiperiodRegistration.start,
            end: b2MultiperiodRegistration.end,
            config: b2MultiperiodRegistration,
            calendar: calendar.combined,
            priceTicks: ticks ?? {},
            progress: (_n, phase) => {
              assertResearchRunActive(budget);
              console.log(phase);
            },
          });
          const evidence = {
            registrationHash,
            identityHash,
            sources: loaded.sources,
            start: loaded.start,
            end: loaded.end,
            counts: loaded.instruments.map((i) => ({
              symbol: i.symbol,
              raw: i.bars.length,
              signal: i.signalBars.length,
            })),
            boundary: loaded.boundary,
          };
          await writeResearchJsonAtomic(
            join(directory, `${key}-sources.json`),
            evidence,
          );
          console.log(`${key} source ready`);
          await writeResearchJsonAtomic(join(directory, `${key}-status.json`), {
            status: "ready",
            registrationHash,
            evidence,
          });
          if (!run) continue;
          delete summary.cases[key];
          const instruments = loaded.instruments.map((instrument) => {
            const execution = instrument.execution;
            if (typeof execution !== "function") return instrument;
            const facts: Record<
              string,
              NonNullable<ReturnType<typeof execution>>
            > = {};
            instrument.bars.forEach((bar, i) => {
              const fact = execution(bar, instrument.bars[i - 1]);
              if (fact) facts[bar.date] = fact;
            });
            return {
              ...instrument,
              execution: facts,
            };
          });
          const frozen = {
            strategy,
            instruments,
            calendar: loaded.calendar,
            start: loaded.start,
            end: loaded.end,
            sources: loaded.sources,
          };
          const inputHash = researchJsonHash(frozen),
            inputPath = join(
              directory,
              `${registrationHash}-${key}-input.json.gz`,
            );
          try {
            const previous = JSON.parse(
              gunzipSync(await readFile(inputPath)).toString(),
            ) as unknown;
            if (researchJsonHash(previous) !== inputHash)
              throw new ResearchCheckpointError(
                `Frozen input changed within registration: ${inputPath}`,
              );
          } catch (error) {
            if (error instanceof ResearchCheckpointError) throw error;
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              throw new ResearchCheckpointError(
                `Frozen input is corrupted: ${inputPath}`,
              );
            await writeFile(inputPath, gzipSync(JSON.stringify(frozen)));
          }
          for (const multiplier of [1, 2]) {
            const caseKey = `${key}-cost-${multiplier}`,
              checkpointPath = join(
                directory,
                `${registrationHash}-${caseKey}.checkpoint.json`,
              ),
              legacyPath = join(
                directory,
                `${registrationHash}-${caseKey}.json`,
              ),
              prior = summary.cases[caseKey],
              priorResultHash = prior?.resultHash;
            await assertResearchRunActive(budget);
            let savedSource: "checkpoint" | "legacy" | undefined;
            let saved = await readResearchCheckpoint(checkpointPath, {
              identity: registrationHash,
              key: caseKey,
              beforeResume: assertIdentity,
            });
            if (saved) savedSource = "checkpoint";
            if (!saved && prior?.status === "completed") {
              saved = await readResearchCheckpoint(legacyPath, {
                identity: registrationHash,
                key: caseKey,
                beforeResume: assertIdentity,
                readLegacy: (value) => {
                  if (value.inputHash !== inputHash) return null;
                  assertLegacyCheckpointEvidence(
                    value.evidence,
                    registrationHash,
                    identityHash,
                  );
                  const result = value.result;
                  if (researchJsonHash(result) !== priorResultHash)
                    throw new ResearchCheckpointError(
                      "Completed checkpoint identity/content mismatch",
                    );
                  return {
                    identity: registrationHash,
                    key: caseKey,
                    row: result,
                    contentHash: researchJsonHash(result),
                  };
                },
              });
              if (saved) savedSource = "legacy";
            }
            if (!saved && prior?.status === "completed")
              throw new ResearchCheckpointError(
                `Completed case has no checkpoint evidence: ${caseKey}`,
              );
            if (saved) {
              if (savedSource === "checkpoint")
                assertCheckpointInputHash(saved.row, inputHash, checkpointPath);
              const savedResult = resultOf(saved.row);
              if (
                prior?.resultHash &&
                researchJsonHash(savedResult) !== prior.resultHash
              )
                throw new ResearchCheckpointError(
                  "Completed checkpoint identity/content mismatch",
                );
              summary.cases[caseKey] = {
                status: "completed",
                attempts: prior?.attempts ?? 0,
                inputHash,
                resultHash: researchJsonHash(savedResult),
              };
              await saveSummary();
              await appendResearchAttempt(journal, {
                registrationHash,
                caseKey,
                event: "restored",
                contentHash: saved.contentHash,
              });
              console.log(`${caseKey} resumed without engine call`);
              continue;
            }
            const attemptId = `${Date.now()}-${process.pid}`;
            summary.cases[caseKey] = {
              status: "running",
              attempts: (prior?.attempts ?? 0) + 1,
              inputHash,
            };
            summary.actualCalls++;
            await saveSummary();
            await appendResearchAttempt(journal, {
              registrationHash,
              caseKey,
              attemptId,
              event: "started",
            });
            let completed: {
              result: ReturnType<typeof runPortfolio>;
              contentHash: string;
            };
            try {
              assertResearchRunActive(budget);
              const request: PortfolioRequest = {
                market,
                initial: b2MultiperiodRegistration.initial,
                start: loaded.start,
                end: loaded.end,
                calendar: loaded.calendar,
                instruments,
                strategies: [strategy],
                sleeves: [
                  {
                    id: "swing",
                    share: 1,
                    maxPositions: 10,
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
              const result = runPortfolio(request, guard);
              await assertIdentity();
              const row = {
                evidence,
                inputHash,
                inputPath,
                costs: request.costs,
                result,
              };
              const contentHash = await writeResearchCheckpoint(
                checkpointPath,
                { identity: registrationHash, key: caseKey, row },
                { beforeCommit: assertIdentity },
              );
              completed = { result, contentHash };
            } catch (error) {
              summary.cases[caseKey] = {
                ...summary.cases[caseKey]!,
                status: "failed",
                reason: error instanceof Error ? error.message : String(error),
              };
              await saveSummary();
              // Journaling is secondary here; preserve the original stop.
              await appendResearchAttempt(journal, {
                registrationHash,
                caseKey,
                attemptId,
                event:
                  error instanceof ResearchRunAbortedError ||
                  error instanceof ResearchIdentityError
                    ? "aborted"
                    : "failed",
                reason: error instanceof Error ? error.message : String(error),
              }).catch((error) => reportResearchJournalFailure(journal, error));
              throw error;
            }
            summary.cases[caseKey] = {
              ...summary.cases[caseKey]!,
              status: "completed",
              resultHash: researchJsonHash(completed.result),
            };
            await saveSummary();
            await appendResearchAttempt(journal, {
              registrationHash,
              caseKey,
              attemptId,
              event: "completed",
              contentHash: completed.contentHash,
            });
            console.log(
              `${key} cost ${multiplier} done: ${completed.result.fills.length} fills`,
            );
          }
        } catch (error) {
          if (
            error instanceof ResearchRunAbortedError ||
            error instanceof ResearchIdentityError ||
            error instanceof ResearchCheckpointError
          )
            throw error;
          const failure = {
            key,
            reason: error instanceof Error ? error.message : String(error),
          };
          await writeResearchJsonAtomic(
            join(directory, `${key}-failure.json`),
            failure,
          );
          summary.cases[key] = {
            status: "failed",
            attempts: summary.cases[key]?.attempts ?? 0,
            inputHash: "source-not-ready",
            reason: failure.reason,
          };
          await saveSummary();
          await writeResearchJsonAtomic(join(directory, `${key}-status.json`), {
            status: "failed",
            registrationHash,
            ...failure,
          });
          console.log(`${key} blocked: ${failure.reason}`);
        }
      }
    await assertIdentity();
    await saveSummary();
    return summary;
  });
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const timeBudgetMs = Number(argument("--time-budget-ms") ?? "0");
  const controller = new AbortController();
  const cancel = () => controller.abort("cancelled by signal");
  // SIGINT is observed only at cooperative checkpoints; a synchronous engine
  // call is not preempted. Deadline and RSS checks use the same checkpoints.
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const summary = await runB2MultiperiodPreparation(
      process.argv.includes("--run"),
      {
        output: argument("--output"),
        budget: createResearchRunBudget({
          signal: controller.signal,
          timeBudgetMs,
          maxRssMiB: Number(argument("--max-rss-mib") ?? "4096"),
        }),
      },
    );
    if (Object.values(summary.cases).some((row) => row.status !== "completed"))
      process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
