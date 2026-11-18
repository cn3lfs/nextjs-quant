import { readJob } from "../src/server/db/jobs";
import { background, cancelJob } from "../src/server/jobs/jobs";
import { runFinancialReplayJob } from "../src/server/financial/financial-replay-host";
import { financialReplayRequestIdentity } from "../src/server/financial/financial-replay-source";
import {
  financialReplayResultPath,
  readFinancialReplay,
} from "../src/server/financial/financial-replay-store";
import type { FinancialReplayJobResult } from "../src/server/financial/financial-replay-store";
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
  "通过应用同款 background 任务、runFinancialReplayJob、worker 与 cancelJob 执行。",
  "SIGINT 会取消实际任务并保留已完成年度检查点；不会发布部分成功结果。",
  "不下载、不发通知、不下单。证据不足返回 blocked（退出码 2），不是失败。",
];

async function waitForReplayJob(jobId: string, signal: AbortSignal) {
  for (;;) {
    const job = readJob(jobId);
    if (!job) throw new Error("回放任务记录不存在");
    if (job.status === "completed")
      return job.result as FinancialReplayJobResult;
    if (job.status === "failed") throw new Error(job.error ?? "回放任务失败");
    if (job.status === "cancelled")
      throw new ResearchRunAbortedError("cancelled", "回放任务已取消");
    if (signal.aborted)
      throw new ResearchRunAbortedError("cancelled", "SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Thin client over the same background/job/worker/cancel path as the app. */
export async function runFinancialReplayCli(argv: readonly string[]) {
  let sigint: ReturnType<typeof installSigint> | null = null,
    removeAbort: (() => void) | null = null;
  try {
    const args = parseFinancialCliArgs(argv);
    if (args.help) {
      printUsage("b2-financial-replay.ts", usageLines);
      return cliExit.ok;
    }
    requireAbsoluteDataDirectory();
    const cli = await readFinancialCliInput(args.inputPath!);
    sigint = installSigint();
    const requestIdentity = financialReplayRequestIdentity(cli.input, cli.root),
      work = {
        type: "financial-replay" as const,
        root: cli.root,
        input: cli.input,
        requestIdentity,
      };
    const job = background(
      "research",
      work,
      (current, signal) => runFinancialReplayJob(work, current.id, signal),
      requestIdentity,
    );
    const cancel = () => cancelJob(job.id);
    sigint.controller.signal.addEventListener("abort", cancel, {
      once: true,
    });
    removeAbort = () =>
      sigint!.controller.signal.removeEventListener("abort", cancel);
    const completed = await waitForReplayJob(job.id, sigint.controller.signal);
    const full = await readFinancialReplay(completed.reportId);
    if (!full)
      throw new Error("回放结果已登记但结果文件无法读取，拒绝伪报成功");
    printJson({
      kind: "financial-replay",
      status: completed.status,
      reportId: completed.reportId,
      identity: full.identity,
      annualIdentity: full.annualIdentity,
      resultPath: financialReplayResultPath(full.identity),
      input: full.input,
      years: full.years.map((year) => ({
        year: year.year,
        asOf: year.asOf,
        executeAt: year.executeAt,
        status: year.status,
        reason: year.reason,
        positions: year.positions,
        cashWeight: year.cashWeight,
        counts: year.counts,
        complete: year.complete,
      })),
      blockedReason: full.blockedReason,
      summary: full.summary ?? null,
      diagnostics: full.diagnostics,
      boundary: full.boundary,
    });
    return completed.status === "blocked" ? cliExit.blocked : cliExit.ok;
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      printUsage("b2-financial-replay.ts", usageLines);
      return cliExit.usage;
    }
    const cancelled = sigint?.controller.signal.aborted === true;
    process.stderr.write(
      `${cancelled ? "已取消：" : "回放失败："}${error instanceof Error ? error.message : String(error)}\n`,
    );
    return cancelled ? cliExit.cancelled : financialCliExitCode(error);
  } finally {
    removeAbort?.();
    sigint?.dispose();
  }
}

if (isMainModule(import.meta.url))
  process.exitCode = await runFinancialReplayCli(process.argv.slice(2));
