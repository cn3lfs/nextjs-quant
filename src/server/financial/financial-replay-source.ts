import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { financialVersions } from "trading-strategy-core/financial";
import {
  financialTheoryVersion,
  specialProductionAssetsQualification,
} from "trading-strategies/research/financial-theory";
import { strategyBuildHash } from "trading-strategies";
import {
  financialDirectory,
  listFinancialReports,
  readStableFinancialFile,
} from "tstdx/local";
import {
  financialReplayInput,
  financialReplayStrategyIds,
  normalizeFinancialReplayInput,
  type FinancialReplayInput,
  type FinancialReplayYearSignal,
} from "~/lib/financial/financial-replay";
import { dataDirectory } from "../db";
import { fullLocalCalendarReference } from "../market/data-health";
import {
  forwardExecutionBuildHash,
  runtimeExecutionIdentity,
} from "../research/forward-identity";
import {
  assertResearchRunActive,
  readResearchCheckpoint,
  researchDigest,
  researchJsonHash,
  writeResearchCheckpoint,
  type ResearchRunBudget,
} from "../research/research-run";
import { financialRebalanceDates } from "./financial-theory-history";

export const financialReplayCodeVersion = "financial-replay-research-v2";

const financialReplaySourceDirectories = [
  "src/server/financial",
  "src/server/market/bar-store",
] as const;
/** Actual executed workspace package dist output: performance and execution
 * code are not guaranteed to be in strategyBuildHash. */
const financialReplayWorkspaceDist = [
  "packages/quant-backtest/dist",
  "packages/quant-performance/dist",
  "packages/tstdx/dist",
  "packages/trading-strategies/dist",
  "packages/trading-strategy-core/dist",
] as const;
const financialReplaySourceFiles = [
  "src/lib/financial/financial-replay.ts",
  "src/lib/research/research-readiness.ts",
  "src/lib/backtest/daily-equity.ts",
  "src/server/market/data-health.ts",
  "src/server/db/jobs.ts",
  "src/server/data-sources/tdx/local-financial-files.ts",
  "src/server/research/corporate-actions.ts",
  "src/server/research/freeze-portfolio-execution.ts",
  "src/server/research/forward-identity.ts",
  "src/server/research/research-run.ts",
] as const;
const financialReplaySourceRequired = [
  "src/lib/financial/financial-replay.ts",
  "src/server/financial/financial-replay-work.ts",
] as const;

/** Hash explicit source files. Exported for the CLI/source-mode regression
 * test, which edits a dependency copy and must observe a new identity. */
export function financialReplaySourceIdentity(
  paths: readonly string[],
): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    // Source-mode identity only: the packaged app runs the bundled worker and
    // authenticates it via runtimeExecutionIdentity/workerSha256 instead of
    // copying these TS/task source trees into standalone.
    hash.update(readFileSync(/* turbopackIgnore: true */ path));
  }
  return hash.digest("hex");
}

/** Source-only identity used by direct TS/tsx study/source runs. The bundled
 * worker never calls this path, so Turbopack must not trace the repository
 * source/dist trees into the standalone output. */
function financialReplaySourceDependencyHash(): string | null {
  if (
    financialReplaySourceRequired.some(
      (path) => !existsSync(/* turbopackIgnore: true */ path),
    )
  )
    return null;
  const paths = new Set<string>(financialReplaySourceFiles);
  for (const directory of financialReplaySourceDirectories) {
    if (!existsSync(/* turbopackIgnore: true */ directory)) continue;
    for (const name of readdirSync(/* turbopackIgnore: true */ directory, {
      recursive: true,
      encoding: "utf8",
    }))
      if (/\.(ts|json)$/.test(name))
        paths.add(join(/* turbopackIgnore: true */ directory, name));
  }
  for (const directory of financialReplayWorkspaceDist) {
    if (!existsSync(/* turbopackIgnore: true */ directory)) return null;
    for (const name of readdirSync(/* turbopackIgnore: true */ directory, {
      recursive: true,
      encoding: "utf8",
    }))
      if (/\.(js|json)$/.test(name))
        paths.add(join(/* turbopackIgnore: true */ directory, name));
  }
  const ordered = [...paths].sort();
  if (ordered.some((path) => !existsSync(/* turbopackIgnore: true */ path)))
    return null;
  return financialReplaySourceIdentity(ordered);
}

export type FinancialReplayCodeIdentity = {
  mode: "source" | "runtime";
  hash: string;
  sourceHash?: string;
  workerSha256?: string;
};

declare const __RESEARCH_VALIDATION_BUILD_HASH__: string;

/** The runtime build injects this identifier. Its presence is the only valid
 * marker that the current code is the bundled worker; a source tree may also
 * exist beside an old bundle and must never authenticate edited TS. */
function bundledRuntimeBuild(): boolean {
  return typeof __RESEARCH_VALIDATION_BUILD_HASH__ !== "undefined";
}

/** Bundled code uses the actual worker bytes; direct TS/tsx code requires real
 * source dependency hashes. A missing source tree or a bad bundle identity
 * fails; there is no cross-mode fallback. */
export function financialReplayCodeIdentity(): FinancialReplayCodeIdentity {
  if (bundledRuntimeBuild()) {
    const runtime = runtimeExecutionIdentity();
    const execution = forwardExecutionBuildHash();
    return {
      mode: "runtime",
      workerSha256: runtime.workerSha256,
      hash: researchJsonHash({
        mode: "runtime",
        execution,
        worker: runtime.workerSha256,
        strategy: strategyBuildHash,
        financialTheoryVersion,
        financialVersions,
      }),
    };
  }
  const source = financialReplaySourceDependencyHash();
  if (!source)
    throw new Error(
      "财务回放源码身份不可用：缺少源依赖文件，不得退回旧worker身份",
    );
  return {
    mode: "source",
    sourceHash: source,
    hash: researchJsonHash({
      mode: "source",
      source,
      strategy: strategyBuildHash,
      financialTheoryVersion,
      financialVersions,
    }),
  };
}

export function financialReplayCodeHash() {
  return financialReplayCodeIdentity().hash;
}

export function financialReplayPoolHash(symbols: readonly string[]) {
  return researchJsonHash([...symbols].sort());
}

/** Content identity of every local financial report package. Used both in the
 * run identity and before reusing a cached year, so a corrected `.dat` file
 * cannot silently keep old annual signals. */
export async function financialReplaySourceHash(
  root: string,
  budget: ResearchRunBudget = {},
  options: { refresh?: boolean } = {},
) {
  const names = await listFinancialReports(root);
  const hash = createHash("sha256");
  for (const name of names) {
    assertResearchRunActive(budget);
    const file = await readStableFinancialFile(
      join(financialDirectory(root), name),
      { refresh: options.refresh ?? true },
    );
    hash.update(name);
    hash.update(file.body);
  }
  assertResearchRunActive(budget);
  return hash.digest("hex");
}

/** Light request identity for the host lock and background dedupe. It contains
 * only normalized user input and the configured root; heavy financial source
 * hashing and final run identity stay in the worker. */
export function financialReplayRequestIdentity(
  raw: FinancialReplayInput,
  root: string,
) {
  const input = normalizeFinancialReplayInput(financialReplayInput.parse(raw));
  return researchJsonHash({
    version: "financial-replay-request-v1",
    input,
    root,
  });
}

export type FinancialReplayConfig = {
  version: "financial-replay-v1";
  input: FinancialReplayInput;
  root: string;
  calendarHash: string;
  poolHash: string;
  researchCodeHash: string;
  financialSourceHash: string;
  strategyId: string;
};

export function financialReplayConfig(
  input: FinancialReplayInput,
  root: string,
  calendarHash: string,
  financialSourceHash: string,
): FinancialReplayConfig {
  const normalized = normalizeFinancialReplayInput(input);
  return {
    version: "financial-replay-v1",
    input: normalized,
    root,
    calendarHash,
    poolHash: financialReplayPoolHash(normalized.symbols),
    researchCodeHash: financialReplayCodeHash(),
    financialSourceHash,
    strategyId: financialReplayStrategyIds[normalized.preset],
  };
}

export function financialReplayIdentity(config: FinancialReplayConfig) {
  return researchJsonHash(config);
}

/** Pre-publication fence: cancellation plus frozen source/code identity. Used
 * both before starting a write and immediately before the atomic publication. */
export function financialReplayPublicationFence(
  plan: FinancialReplayRunPlan,
  budget: ResearchRunBudget,
) {
  return async () => {
    assertResearchRunActive(budget);
    if (financialReplayCodeHash() !== plan.config.researchCodeHash)
      throw new Error("财务回放代码身份在结果发布前变化，拒绝发布");
    const current = await financialReplaySourceHash(plan.config.root, budget, {
      refresh: false,
    });
    if (current !== plan.config.financialSourceHash)
      throw new Error("财务源文件在结果发布前变化，拒绝发布旧身份结果");
  };
}

export type FinancialReplayRunPlan = {
  config: FinancialReplayConfig;
  identity: string;
  calendar: { days: string[]; hash: string };
  years: { year: number; asOf: string; executeAt: string }[];
};

/** The router calls this before creating a job; the worker repeats it so a
 * stale or forged job input cannot skip the causal date checks. */
export async function resolveFinancialReplayRun(
  raw: FinancialReplayInput,
  root: string,
  budget: ResearchRunBudget = {},
): Promise<FinancialReplayRunPlan> {
  const input = normalizeFinancialReplayInput(financialReplayInput.parse(raw));
  if (!root.trim()) throw new Error("请先配置通达信本地目录");
  assertResearchRunActive(budget);
  const calendar = await fullLocalCalendarReference(root, []);
  assertResearchRunActive(budget);
  if (!calendar.hash) throw new Error("交易日历缺少内容身份");
  const years = financialRebalanceDates(
    calendar.days,
    input.firstYear,
    input.lastYear,
  );
  if (years[0]!.asOf < calendar.days[0]!)
    throw new Error("年度区间早于本地交易日历覆盖");
  for (const year of years)
    if (year.executeAt > input.endDate)
      throw new Error(
        `${year.year}年首个交易日 ${year.executeAt} 晚于结束日期 ${input.endDate}`,
      );
  const financialSourceHash = await financialReplaySourceHash(root, budget);
  const config = financialReplayConfig(
    input,
    root,
    calendar.hash,
    financialSourceHash,
  );
  return {
    config,
    identity: financialReplayIdentity(config),
    calendar: { days: calendar.days, hash: calendar.hash },
    years,
  };
}

export type FinancialReplayFinancialRow = {
  symbol: string;
  result: {
    reportDate: string | null;
    fScore: { score: number | null };
    magic: {
      matched: boolean | null;
      eligible: boolean;
      enterpriseValue: {
        value: number | null;
        inputs: readonly { value: number | null }[];
      };
      investedCapital: {
        value: number | null;
        inputs: readonly { value: number | null }[];
      };
      ebit: { value: number | null };
      specialProductionAssets: readonly {
        code: string;
        value: number | null;
      }[];
    };
  };
  sourceReports: readonly { sourceFilename: string; sourceSha256: string }[];
};

export type FinancialReplayAnnualSignal = FinancialReplayYearSignal & {
  version: string;
  poolHash: string;
  calendarHash: string;
  researchCodeHash: string;
  warning: string;
  rows: readonly FinancialReplayFinancialRow[];
  issues: readonly { filename: string; reason: string }[];
};

const knownInputs = (inputs: readonly { value: number | null }[]) =>
  inputs.length > 0 && inputs.every((input) => input.value !== null);

/** Whether this row's magic-rule facts are known. Negative economics remain a
 * complete rejection; only unknown industry/inputs are missing facts. */
export function financialReplayRowMagicComplete(
  row: FinancialReplayFinancialRow,
) {
  const value = row.result.magic;
  // `matched` is null only when a required fact is unknown; a false value is
  // produced by a decisive rejection (financial industry, nonpositive EV, or a
  // certified-zero capital gap), which is a complete fact.
  if (value.matched === null) return false;
  if (value.matched === true)
    return (
      specialProductionAssetsQualification(value.specialProductionAssets)
        .certifiedZero &&
      value.enterpriseValue.value !== null &&
      value.investedCapital.value !== null &&
      value.ebit.value !== null &&
      knownInputs(value.enterpriseValue.inputs) &&
      knownInputs(value.investedCapital.inputs)
    );
  return true;
}

/** Count rows where the magic rule's facts are actually known. `magicEligible`
 * alone cannot distinguish a valid economic rejection from missing inputs. */
export function financialReplayCompleteness(
  signal: FinancialReplayAnnualSignal,
) {
  let magic = 0;
  for (const row of signal.rows)
    if (financialReplayRowMagicComplete(row)) magic++;
  return {
    annualReport: signal.counts.annualReport,
    fScore: signal.counts.fScoreComplete,
    magic,
  };
}

/** Per-symbol, per-year facts required by the selected preset. A single ready
 * candidate elsewhere does not upgrade another symbol's missing annual facts. */
export function financialReplayInstrumentFinancialFacts(
  signals: readonly FinancialReplayAnnualSignal[],
  symbol: string,
  preset: "f-score" | "magic-formula",
) {
  const requiredFacts: string[] = [],
    missingFacts: { fact: string; reason: string }[] = [];
  for (const signal of signals) {
    const year = Number(signal.executeAt.slice(0, 4)),
      annualFact = `annual-report:${year}`,
      presetFact =
        preset === "f-score" ? `f-score:${year}` : `magic-formula:${year}`,
      row = signal.rows.find((item) => item.symbol === symbol);
    requiredFacts.push(annualFact, presetFact);
    if (!row?.result.reportDate)
      missingFacts.push({
        fact: annualFact,
        reason: "该年度没有可见的年度财报",
      });
    if (preset === "f-score") {
      if (!row || row.result.fScore.score === null)
        missingFacts.push({
          fact: presetFact,
          reason: "该年度九项F-score事实不完整",
        });
    } else if (!row || !financialReplayRowMagicComplete(row))
      missingFacts.push({
        fact: presetFact,
        reason: "该年度魔法公式企业价值/资本/EBIT/特殊生产资产事实不完整",
      });
  }
  return { requiredFacts, missingFacts };
}

export function validateAnnualSignal(
  signal: FinancialReplayAnnualSignal,
  expected: {
    year: number;
    asOf: string;
    executeAt: string;
    poolHash: string;
    calendarHash: string;
    researchCodeHash: string;
  },
) {
  if (
    signal.asOf !== expected.asOf ||
    signal.executeAt !== expected.executeAt ||
    signal.poolHash !== expected.poolHash ||
    signal.calendarHash !== expected.calendarHash ||
    signal.researchCodeHash !== expected.researchCodeHash
  )
    throw new Error(`年度检查点身份或内容不符：${expected.year}`);
  const { hash, ...content } = signal;
  if (researchJsonHash(content) !== hash)
    throw new Error(`年度检查点内容哈希不符：${expected.year}`);
  if (!signal.selections?.magicFormula || !signal.selections.fScore)
    throw new Error(`年度检查点缺少筛选结果：${expected.year}`);
  if (!Array.isArray(signal.rows))
    throw new Error(`年度检查点缺少逐股证据：${expected.year}`);
}

export async function assertAnnualSourcesUnchanged(
  root: string,
  signal: FinancialReplayAnnualSignal,
) {
  const used = new Map<string, string>();
  for (const row of signal.rows)
    for (const report of row.sourceReports ?? [])
      used.set(report.sourceFilename, report.sourceSha256);
  for (const [filename, expected] of used) {
    const file = await readStableFinancialFile(
      join(financialDirectory(root), filename),
      { refresh: true },
    );
    if (researchDigest(file.body) !== expected)
      throw new Error(`财务源文件已更新，缓存年度信号失效：${filename}`);
  }
}

export type FinancialReplayYearCache = {
  read(
    year: number,
    expected: { asOf: string; executeAt: string },
  ): Promise<FinancialReplayAnnualSignal | null>;
  write(
    year: number,
    expected: { asOf: string; executeAt: string },
    signal: FinancialReplayAnnualSignal,
  ): Promise<void>;
};

export function financialReplayRunDirectory(identity: string) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("财务回放身份格式非法");
  return join(dataDirectory(), "research", "financial-replay", identity);
}

export function financialReplayRequestDirectory(requestIdentity: string) {
  if (!/^[a-f0-9]{64}$/.test(requestIdentity))
    throw new Error("财务回放请求身份格式非法");
  return join(
    dataDirectory(),
    "research",
    "financial-replay",
    "requests",
    requestIdentity,
  );
}

/** Host lock path is keyed by the light request identity, so a cancelled
 * worker's still-terminating process does not block a retry with a new source
 * identity. */
export function financialReplayRequestLockPath(requestIdentity: string) {
  return join(financialReplayRequestDirectory(requestIdentity), "run.lock");
}

/** Results are keyed by every source input, so they live outside the annual
 * checkpoint directory that only carries financial/calendar/code identity. */
export function financialReplayResultDirectory(identity: string) {
  if (!/^[a-f0-9]{64}$/.test(identity))
    throw new Error("财务回放结果身份格式非法");
  return join(
    dataDirectory(),
    "research",
    "financial-replay",
    "results",
    identity,
  );
}

/** Worker-side cache: no PID lock (workers share the host PID). The host job
 * dedupe and the main-thread run lock own cross-process exclusion. */
export function financialReplayYearCache(
  root: string,
  identity: string,
  budget: ResearchRunBudget,
  context?: FinancialReplayIdentityContext,
): FinancialReplayYearCache {
  const directory = join(financialReplayRunDirectory(identity), "years");
  const active = () => assertResearchRunActive(budget);
  return {
    async read(year, expected) {
      active();
      const checkpoint =
        await readResearchCheckpoint<FinancialReplayAnnualSignal>(
          join(directory, `year-${year}.json`),
          {
            identity,
            key: { year, asOf: expected.asOf, executeAt: expected.executeAt },
            beforeResume: active,
          },
        );
      if (!checkpoint) return null;
      const identityContext =
        context ?? (await financialReplayIdentityContext(identity));
      validateAnnualSignal(checkpoint.row, {
        year,
        asOf: expected.asOf,
        executeAt: expected.executeAt,
        ...identityContext,
      });
      await assertAnnualSourcesUnchanged(root, checkpoint.row);
      active();
      return checkpoint.row;
    },
    async write(year, expected, signal) {
      const identityContext =
        context ?? (await financialReplayIdentityContext(identity));
      const fence = async () => {
        active();
        validateAnnualSignal(signal, {
          year,
          asOf: expected.asOf,
          executeAt: expected.executeAt,
          poolHash: identityContext.poolHash,
          calendarHash: identityContext.calendarHash,
          researchCodeHash: identityContext.researchCodeHash,
        });
        if (financialReplayCodeHash() !== identityContext.researchCodeHash)
          throw new Error(
            "财务回放代码身份在年度报告提交前变化，拒绝发布旧身份信号",
          );
        await assertAnnualSourcesUnchanged(root, signal);
        if (identityContext.financialSourceHash) {
          const current = await financialReplaySourceHash(root, budget, {
            refresh: false,
          });
          if (current !== identityContext.financialSourceHash)
            throw new Error(
              "财务源文件在年度计算提交前变化，拒绝发布旧身份信号",
            );
        }
      };
      await fence();
      await writeResearchCheckpoint(
        join(directory, `year-${year}.json`),
        {
          identity,
          key: { year, asOf: expected.asOf, executeAt: expected.executeAt },
          row: signal,
        },
        { beforeCommit: fence },
      );
    },
  };
}

type FinancialReplayIdentityContext = {
  poolHash: string;
  calendarHash: string;
  researchCodeHash: string;
  financialSourceHash?: string;
};

const identityContexts = new Map<string, FinancialReplayIdentityContext>();

export function rememberFinancialReplayIdentity(
  identity: string,
  context: FinancialReplayIdentityContext,
) {
  identityContexts.set(identity, context);
  if (identityContexts.size > 8)
    identityContexts.delete(identityContexts.keys().next().value!);
}

export async function financialReplayIdentityContext(
  identity: string,
): Promise<FinancialReplayIdentityContext> {
  const cached = identityContexts.get(identity);
  if (cached) return cached;
  const registration = JSON.parse(
    await readFile(
      join(financialReplayRunDirectory(identity), "registration.json"),
      "utf8",
    ),
  ) as { config?: FinancialReplayIdentityContext };
  if (!registration.config) throw new Error("财务回放登记缺少来源身份");
  rememberFinancialReplayIdentity(identity, registration.config);
  return registration.config;
}
