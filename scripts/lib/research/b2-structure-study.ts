import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";
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
  createStudyDecision,
  createTheoryFailedUpthrust,
  strategyBuildHash,
  studyWarmup,
  type StrategyObjectInput,
  type StudyDecisionState,
} from "trading-strategies";
import { executionCostsSchema } from "trading-strategy-core/costs";
import type { Bar } from "trading-strategy-core/bars";
import {
  readInputs,
  summarizeTheoryResult,
  theoryStudyWindows,
} from "../../theory-study";
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
  validateResearchRunBudget,
  withResearchRunLock,
  writeResearchCheckpoint,
  writeResearchJsonAtomic,
  type ResearchRunBudget,
} from "../../../src/server/research/research-run";
export const b2StructureRegistration = {
  version: "b2-structure-2",
  source:
    ".test-data/lifecycle-20261116/l3/sources/source-978a42271380e3609b78f644b74772a323203c917c78e805d3a3ed18ce247a1e.json",
  cnLimit: 799,
  candidates: [
    "theory-range-reversion",
    "theory-sos-pullback",
    "breakout",
    "breakout-failed-upthrust",
  ],
  windows: theoryStudyWindows,
  scenarios: ["base", "double-cost"],
  initial: 1000000,
  budgetMiB: 4096,
  boundary:
    "Development and reused-history only; no independent holdout, parameter selection or promotion. Fixed current 799 pool plus BTC/ETH.",
  comparison:
    "Existing createStudyDecision breakout pure 55-high/20-low branch projected without simulated fills; component arm changes only exit OR failed-upthrust, never Turtle actual-entry ATR protection.",
} as const;
type Candidate = (typeof b2StructureRegistration.candidates)[number];
const flat: StudyDecisionState = {
  cash: 1,
  shares: 0,
  entry: 0,
  entryIndex: 0,
  anchor: 0,
  core: 0,
  sleeveCap: 0,
  initialized: false,
  lastAllocationMonth: "",
  installments: 0,
};

/** Only the audited state-independent breakout branch is projected. These
 * selector states choose its entry/exit outputs; no account or fill is created. */
export function b2BreakoutSignals(bars: readonly Bar[], component: boolean) {
  const base = createStudyDecision(
    "breakout",
    bars,
    bars,
    1,
    studyWarmup("breakout"),
  );
  const failed = component ? createTheoryFailedUpthrust(bars) : null;
  return bars.map((bar, index) => ({
    id: "b2-breakout",
    date: bar.date,
    availableAt: bar.date,
    entry:
      index >= studyWarmup("breakout") && base(index, flat)?.side === "buy",
    exit:
      index >= studyWarmup("breakout") &&
      (base(index, { ...flat, shares: 1 })?.side === "sell" ||
        failed?.(index).status === "signal"),
  }));
}

export function b2StructureStrategy(
  candidate: Candidate,
  market: "cn-equity" | "crypto",
  symbols: string[],
): StrategyObjectInput {
  const breakout =
    candidate === "breakout" || candidate === "breakout-failed-upthrust";
  return {
    id: `b2-${market}-${candidate}`,
    version: 2,
    market,
    period: "day",
    universe: { kind: "symbols", symbols },
    entry: breakout
      ? { kind: "external", id: "b2-breakout", side: "entry" }
      : { kind: "study-rule", strategy: candidate, side: "entry" },
    exit: {
      rule: breakout
        ? { kind: "external", id: "b2-breakout", side: "exit" }
        : { kind: "study-rule", strategy: candidate, side: "exit" },
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  };
}
export function b2StructureInstruments(
  candidate: Candidate,
  instruments: readonly PortfolioInstrument[],
) {
  if (candidate !== "breakout" && candidate !== "breakout-failed-upthrust")
    return instruments;
  return instruments.map((instrument) => ({
    ...instrument,
    external: {
      ...instrument.external,
      signals: b2BreakoutSignals(
        instrument.signalBars,
        candidate === "breakout-failed-upthrust",
      ),
    },
  }));
}
async function artifacts() {
  const hash = createHash("sha256");
  for (const directory of [
    "packages/quant-backtest/dist",
    "packages/trading-strategies/dist",
    "packages/trading-strategy-core/dist",
    "packages/tstdx/dist",
    "packages/quant-rps/dist",
  ]) {
    for (const file of (await readdir(directory, { recursive: true }))
      .filter((f) => /\.(js|ts|tsx|json)$/.test(f))
      .sort()) {
      hash.update(join(directory, file));
      hash.update(await readFile(join(directory, file)));
    }
  }
  const pending = [
    "scripts/lib/research/b2-structure-study.ts",
    "scripts/theory-study.ts",
  ].map((file) => resolve(file));
  const dependencies = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (dependencies.has(file)) continue;
    dependencies.add(file);
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
          (ts.isExportDeclaration(node) && !node.isTypeOnly)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of imports) {
      if (!specifier.startsWith(".") && !specifier.startsWith("~/")) continue;
      const path = specifier.startsWith("~/")
        ? resolve("src", specifier.slice(2))
        : resolve(dirname(file), specifier);
      const base = path.replace(/\.js$/, "");
      const found = [
        path,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.json`,
        join(base, "index.ts"),
      ].find(
        (candidate) =>
          /\.(ts|tsx|js|json)$/.test(candidate) && existsSync(candidate),
      );
      if (!found)
        throw new Error(
          `Unresolved research runtime dependency: ${file} -> ${specifier}`,
        );
      pending.push(found);
    }
  }
  for (const file of [...dependencies, resolve("pnpm-lock.yaml")].sort()) {
    hash.update(file);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}
export type B2StructureRunOptions = {
  /** New research must pass the current task root; the historical default is
   * kept only for reproducing the recorded B2 run. */
  output?: string;
  budget?: ResearchRunBudget;
};

export async function runB2StructureStudy(options: B2StructureRunOptions = {}) {
  const output = resolve(options.output ?? ".test-data/method-pool-ten/structure");
  const outputRelative = relative(resolve(".test-data"), output);
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
      "Set absolute isolated QUANT_DATA_DIR under .test-data before research",
    );
  const budget: ResearchRunBudget = options.budget
    ? validateResearchRunBudget(options.budget)
    : createResearchRunBudget({
        maxRssMiB: b2StructureRegistration.budgetMiB,
      });
  await mkdir(output, { recursive: true });
  return await withResearchRunLock(join(output, ".run.lock"), async () => {
    const codeHash = await artifacts();
    const inputs = await readInputs(
      b2StructureRegistration.source,
      b2StructureRegistration.cnLimit,
      budget,
    );
    assertResearchRunActive(budget);
    const manifest = JSON.parse(
      await readFile(b2StructureRegistration.source, "utf8"),
    ) as {
      identities: {
        classic: {
          normalized: {
            equity: { path: string; hash: string; decodedContentHash: string };
          };
        };
      };
    };
    const ref = manifest.identities.classic.normalized.equity;
    const compressed = await readFile(ref.path),
      plain = gunzipSync(compressed);
    if (
      researchDigest(compressed) !== ref.hash ||
      researchDigest(plain) !== ref.decodedContentHash
    )
      throw new Error("Frozen benchmark calendar identity mismatch");
    const benchmark = (JSON.parse(plain.toString()) as { benchmark: Bar[] })
      .benchmark;
    const cnCalendar = benchmark.map((bar) => bar.date);
    if (
      !cnCalendar.length ||
      cnCalendar.some((day, i) => i > 0 && day <= cnCalendar[i - 1]!)
    )
      throw new Error("Invalid frozen benchmark calendar");
    const registration = {
      ...b2StructureRegistration,
      codeHash,
      strategyBuildHash,
      engineBuildHash: maBaselineBuildHash,
      inputs: inputs.evidence,
      biasTags: inputs.biasTags,
      cnCalendar: {
        path: ref.path,
        hash: ref.hash,
        datesHash: researchJsonHash(cnCalendar),
      },
    };
    const identity = researchJsonHash(registration);
    await ensureResearchRegistration(
      join(output, `registration-${identity}.json`),
      registration,
      identity,
    );
    await writeResearchJsonAtomic(
      join(
        output,
        `runner-${researchDigest(await readFile(new URL(import.meta.url)))}.json`,
      ),
      {
        runner: await readFile(new URL(import.meta.url), "utf8"),
        inputLoader: await readFile("scripts/theory-study.ts", "utf8"),
      },
      { immutable: true },
    );
    const journal = join(output, `attempts-${identity}.jsonl`);
    const assertCommitIdentity = async () => {
      assertResearchRunActive(budget);
      assertResearchIdentity(
        codeHash,
        await artifacts(),
        "Research code identity changed during run",
      );
      // Cancellation can arrive while the artifact hash is being read.
      assertResearchRunActive(budget);
    };
    const rows: unknown[] = [];
    let calls = 0,
      restored = 0;
    for (const [market, originals] of [
      ["cn-equity", inputs.cn],
      ["crypto", inputs.crypto],
    ] as const) {
      const calendar =
        market === "cn-equity"
          ? cnCalendar
          : [
              ...new Set(
                originals.flatMap((instrument) =>
                  instrument.bars.map((bar) => bar.date),
                ),
              ),
            ].sort();
      for (const candidate of b2StructureRegistration.candidates) {
        const instruments = b2StructureInstruments(candidate, originals);
        const preparation = createPortfolioPreparation();
        for (const window of theoryStudyWindows)
          for (const scenario of b2StructureRegistration.scenarios) {
            assertResearchRunActive(budget);
            const key = { market, candidate, window: window.label, scenario };
            const path = join(
              output,
              `${identity}-${market}-${candidate}-${window.label}-${scenario}.json`,
            );
            const saved = await readResearchCheckpoint(path, {
              identity,
              key,
              beforeResume: assertCommitIdentity,
            });
            if (saved) {
              rows.push(saved.row);
              restored++;
              await appendResearchAttempt(journal, {
                identity,
                key,
                event: "restored",
                contentHash: saved.contentHash,
              });
              continue;
            }
            const multiplier = scenario === "base" ? 1 : 2;
            const request: PortfolioRequest = {
              market,
              initial: b2StructureRegistration.initial,
              start: window.start,
              end: window.end,
              calendar,
              instruments,
              strategies: [
                b2StructureStrategy(
                  candidate,
                  market,
                  instruments.map((i) => i.symbol),
                ),
              ],
              sleeves: [
                {
                  id: "swing",
                  share: 1,
                  maxPositions: 10,
                  riskPerTrade: 0.01,
                },
              ],
              observationDetail: "counts",
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
            };
            const started = performance.now();
            const attemptId = `${Date.now()}-${process.pid}`;
            await appendResearchAttempt(journal, {
              identity,
              key,
              attemptId,
              event: "started",
            });
            // calls counts attempted engines; rows only holds completed work.
            calls++;
            let completed: { row: unknown; contentHash: string };
            try {
              const result = runPortfolio(
                request,
                createResearchRunGuard(budget),
                preparation,
              );
              assertResearchRunActive(budget);
              const row = {
                ...key,
                status: "completed",
                ...summarizeTheoryResult(result, request.initial),
                symbols: instruments.length,
                elapsedMs: Math.round(performance.now() - started),
              };
              const contentHash = await writeResearchCheckpoint(
                path,
                { identity, key, row },
                { beforeCommit: assertCommitIdentity },
              );
              completed = { row, contentHash };
            } catch (error) {
              // Journaling is secondary here; preserve the original stop.
              await appendResearchAttempt(journal, {
                identity,
                key,
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
            await appendResearchAttempt(journal, {
              identity,
              key,
              attemptId,
              event: "completed",
              contentHash: completed.contentHash,
            });
            rows.push(completed.row);
            console.log(
              JSON.stringify({ completed: rows.length, total: 32, ...key }),
            );
          }
      }
    }
    await assertCommitIdentity();
    const result = {
      identity,
      rows,
      calls,
      restored,
      expected: 32,
      boundary: b2StructureRegistration.boundary,
    };
    await writeResearchJsonAtomic(
      join(output, `results-${identity}.json`),
      result,
    );
    return result;
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
  if (!process.argv.includes("--run"))
    console.log(JSON.stringify(b2StructureRegistration, null, 2));
  else {
    const timeBudgetMs = Number(argument("--time-budget-ms") ?? "0");
    const controller = new AbortController();
    const cancel = () => controller.abort("cancelled by signal");
    // SIGINT is observed only at cooperative checkpoints; a synchronous engine
    // call is not preempted. Deadline and RSS checks use the same checkpoints.
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      await runB2StructureStudy({
        output: argument("--output"),
        budget: createResearchRunBudget({
          signal: controller.signal,
          timeBudgetMs,
          maxRssMiB: Number(
            argument("--max-rss-mib") ??
              String(b2StructureRegistration.budgetMiB),
          ),
        }),
      });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}
