import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const args = process.argv.slice(2);
const command = args.shift();
if (["l3-prepare", "l3-run", "l3-oracle"].includes(command ?? "")) {
  const configIndex = args.indexOf("--config");
  const configPath =
    configIndex >= 0 && args[configIndex + 1]
      ? resolve(args[configIndex + 1]!)
      : resolve("research/configs/l3.json");
  if (command === "l3-oracle") {
    const { reconstructClassicTargets } =
      await import("./lib/research/classic-oracle");
    console.log(
      JSON.stringify(
        await reconstructClassicTargets(".test-data/lifecycle-20261116/oracle"),
        null,
        2,
      ),
    );
  } else {
    const {
      prepareLifecycleResearch,
      runLifecycleResearch,
      lifecyclePrepareSummary,
      assertLifecycleProcessBudget,
    } = await import("./lib/research/lifecycle-runner");
    if (command === "l3-prepare") {
      const prepared = await prepareLifecycleResearch(configPath, undefined, {
        decodeLowZoneFinancials: args.includes("--decode-low-zone-financials"),
      });
      console.log(JSON.stringify(lifecyclePrepareSummary(prepared), null, 2));
    } else {
      const approved = args.indexOf("--approved-plan");
      if (approved < 0 || !args[approved + 1])
        throw new Error(
          "l3-run requires the exact reviewed --approved-plan hash; preparation computes no returns",
        );
      const report = await runLifecycleResearch(
        configPath,
        args[approved + 1]!,
        undefined,
        (completed, total, detail) =>
          console.log(
            JSON.stringify({ progress: "l3", completed, total, ...detail }),
          ),
        {
          decodeLowZoneFinancials: args.includes(
            "--decode-low-zone-financials",
          ),
        },
      );
      console.log(
        JSON.stringify(
          {
            inputHash: report.inputHash,
            executionPlanHash: report.executionPlanHash,
            reportPath: report.reportPath,
            resultHash: report.resultHash,
            statuses: report.rows.reduce<Record<string, number>>(
              (counts, row) => {
                counts[row.status] = (counts[row.status] ?? 0) + 1;
                return counts;
              },
              {},
            ),
            calls: report.calls,
            completedCheckpoints: report.completedCheckpoints,
            resumedCheckpoints: report.resumedCheckpoints,
            insufficientSegments: report.insufficientSegments,
          },
          null,
          2,
        ),
      );
    }
    assertLifecycleProcessBudget("cli-complete");
  }
  process.exit(0);
}
if (command === "inspect" || command === "verify-input") {
  const { executeResearchCommand } =
    await import("../src/server/research/research-command");
  console.log(
    JSON.stringify(
      await executeResearchCommand(
        command === "inspect"
          ? { command, market: args[0] as "cn-equity" | "crypto" }
          : { command, hash: args[0]! },
      ),
      null,
      2,
    ),
  );
  process.exit(0);
}
const index = args.indexOf("--config");
if (!command || index < 0 || !args[index + 1])
  throw new Error(
    "research.ts <capture|study|audit|sensitivity|scoreboard|replay|books|cycles|report> --config <file> [arguments]",
  );
process.env.QUANT_RESEARCH_CONFIG = resolve(args[index + 1]!);
args.splice(index, 2);
if (command === "replay") process.env.QUANT_RESEARCH_REPLAY = "1";
const { config, outputTask } = await import("./lib/research/isolation");
if (config.batch === "R2a-4" && command !== "replay")
  throw new Error(
    "R2a4 is frozen: use replay with its config; computations require the current config",
  );
await mkdir(outputTask, { recursive: true });
if (
  (command === "study" || command === "admit") &&
  args[0] !== "cn" &&
  args[0] !== "crypto"
)
  throw new Error(
    "Study/admit market must be cn or crypto; sensitivity reuses the frozen comparison command",
  );
if (
  (command === "study" || command === "admit") &&
  args[0] === "crypto" &&
  !config.sizing.includes((args[2] ?? "equal") as "equal" | "volatility")
)
  throw new Error(
    "Crypto study sizing must be declared in the selected config",
  );
if (
  command === "books" &&
  args[0] === "crypto" &&
  !config.sizing.includes((args[1] ?? "equal") as "equal" | "volatility")
)
  throw new Error("Crypto book sizing must be declared in the selected config");
process.argv = [process.argv[0]!, process.argv[1]!, ...args];
const commands: Record<string, () => Promise<unknown>> = {
  capture: () => import("./lib/research/capture"),
  study: () => import("./lib/research/study"),
  admit: () => {
    process.env.QUANT_RESEARCH_ADMISSION = "1";
    return import("./lib/research/study");
  },
  audit: () => import("./lib/research/audit"),
  sensitivity: () => import("./lib/research/sensitivity-frozen"),
  scoreboard: () => import("./lib/research/scoreboard"),
  replay: () => import("./lib/research/scoreboard"),
  books: () => import("./lib/research/books"),
  cycles: () => import("./lib/research/low-cycles"),
  report: () => import("./lib/research/report-current"),
  "native-capture": () => import("./lib/research/native"),
  benchmark: () => import("./lib/research/benchmark"),
};
const run = commands[command];
if (!run) throw new Error(`Unknown research command: ${command}`);
await run();
