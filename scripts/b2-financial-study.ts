import { join } from "node:path";
import { financialReplayBoundary } from "../src/lib/financial/financial-replay";
import {
  ensureResearchRegistration,
  reportResearchJournalFailure,
} from "../src/server/research/research-run";
import { loadFinancialReplayAnnuals } from "../src/server/financial/financial-replay-prepare";
import {
  financialReplayPublicationFence,
  financialReplayRequestDirectory,
  financialReplayRequestIdentity,
  financialReplayRequestLockPath,
  financialReplayRunDirectory,
  financialReplayYearCache,
  resolveFinancialReplayRun,
} from "../src/server/financial/financial-replay-source";
import {
  appendFinancialReplayAttempt,
  withFinancialReplayHostLock,
} from "../src/server/financial/financial-replay-work";
import { ResearchRunAbortedError } from "../src/server/research/research-run";
import {
  CliUsageError,
  cliExit,
  financialCliExitCode,
  installSigint,
  isMainModule,
  parseFinancialCliArgs,
  printJson,
  printUsage,
  readFinancialCliInput,
  requireAbsoluteDataDirectory,
} from "./lib/financial-replay-cli";

const usageLines = [
  "读取冻结财务名单与年度窗口，逐年生成并保存年度信号检查点。",
  "不执行组合回放、不下载、不发通知、不下单。",
  "第二次运行会复用身份与源字节都一致的年度检查点。",
];

/** Shared annual study entrypoint. It uses the same registration, identity,
 * source fence and checkpoint writer as the application; no B2-local loop. */
export async function runFinancialStudy(argv: readonly string[]) {
  let signal: ReturnType<typeof installSigint> | null = null;
  try {
    const args = parseFinancialCliArgs(argv);
    if (args.help) {
      printUsage("b2-financial-study.ts", usageLines);
      return cliExit.ok;
    }
    requireAbsoluteDataDirectory();
    const cli = await readFinancialCliInput(args.inputPath!);
    signal = installSigint();
    const requestIdentity = financialReplayRequestIdentity(cli.input, cli.root),
      lockPath = financialReplayRequestLockPath(requestIdentity),
      journalPath = join(
        financialReplayRequestDirectory(requestIdentity),
        "attempts.jsonl",
      ),
      attempt = (status: string, extra: Record<string, unknown> = {}) =>
        appendFinancialReplayAttempt(requestIdentity, {
          at: new Date().toISOString(),
          requestIdentity,
          kind: "financial-study",
          status,
          ...extra,
        });
    return await withFinancialReplayHostLock(
      requestIdentity,
      lockPath,
      signal.controller.signal,
      async () => {
        try {
          await attempt("started", { input: cli.input });
        } catch (error) {
          reportResearchJournalFailure(journalPath, error);
        }
        try {
          const plan = await resolveFinancialReplayRun(cli.input, cli.root, {
            signal: signal!.controller.signal,
          });
          const directory = financialReplayRunDirectory(plan.identity);
          await ensureResearchRegistration(
            join(directory, "registration.json"),
            {
              version: "financial-replay-registration-v1",
              identity: plan.identity,
              config: plan.config,
              years: plan.years,
              boundary: financialReplayBoundary,
            },
          );
          const annual = await loadFinancialReplayAnnuals(
            plan,
            (value, phase) => process.stderr.write(`[${value}%] ${phase}\n`),
            { signal: signal!.controller.signal },
            financialReplayYearCache(
              plan.config.root,
              plan.identity,
              { signal: signal!.controller.signal },
              {
                poolHash: plan.config.poolHash,
                calendarHash: plan.config.calendarHash,
                researchCodeHash: plan.config.researchCodeHash,
                financialSourceHash: plan.config.financialSourceHash,
              },
            ),
          );
          await financialReplayPublicationFence(plan, {
            signal: signal!.controller.signal,
          })();
          printJson({
            kind: "financial-study",
            status: annual.blockedReason ? "blocked" : "ready",
            identity: plan.identity,
            input: plan.config.input,
            root: plan.config.root,
            runDirectory: directory,
            calendarHash: plan.config.calendarHash,
            financialSourceHash: plan.config.financialSourceHash,
            researchCodeHash: plan.config.researchCodeHash,
            years: annual.statuses.map((year) => ({
              year: year.year,
              asOf: year.asOf,
              executeAt: year.executeAt,
              status: year.status,
              reason: year.reason,
              positions: year.positions,
              counts: year.counts,
              complete: year.complete,
            })),
            blockedReason: annual.blockedReason,
            actualCalls: annual.actualCalls,
            restoredCheckpoints: annual.restoredCheckpoints,
          });
          try {
            await attempt(annual.blockedReason ? "blocked" : "completed", {
              identity: plan.identity,
              actualCalls: annual.actualCalls,
              restoredCheckpoints: annual.restoredCheckpoints,
              blocked: !!annual.blockedReason,
            });
          } catch (error) {
            reportResearchJournalFailure(journalPath, error);
          }
          return annual.blockedReason ? cliExit.blocked : cliExit.ok;
        } catch (error) {
          const cancelled =
            signal!.controller.signal.aborted ||
            (error instanceof ResearchRunAbortedError &&
              error.reason === "cancelled");
          try {
            await attempt(cancelled ? "cancelled" : "failed", {
              errorCode: cancelled ? "cancelled" : "study-failed",
            });
          } catch (journalError) {
            reportResearchJournalFailure(journalPath, journalError);
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      printUsage("b2-financial-study.ts", usageLines);
      return cliExit.usage;
    }
    const cancelled = signal?.controller.signal.aborted === true;
    process.stderr.write(
      `${cancelled ? "已取消：" : "研究失败："}${error instanceof Error ? error.message : String(error)}\n`,
    );
    return cancelled ? cliExit.cancelled : financialCliExitCode(error);
  } finally {
    signal?.dispose();
  }
}

if (isMainModule(import.meta.url))
  process.exitCode = await runFinancialStudy(process.argv.slice(2));
