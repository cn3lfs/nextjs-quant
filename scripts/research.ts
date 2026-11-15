import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const args = process.argv.slice(2);
const command = args.shift();
const index = args.indexOf("--config");
if (!command || index < 0 || !args[index + 1])
  throw new Error(
    "research.ts <capture|study|audit|sensitivity|scoreboard|replay|books|cycles|report> --config <file> [arguments]",
  );
process.env.QUANT_RESEARCH_CONFIG = resolve(args[index + 1]!);
args.splice(index, 2);
if (command === "replay") process.env.QUANT_RESEARCH_REPLAY = "1";
const { config, outputTask } = await import("./lib/research/isolation");
if (command === "replay" && config.batch !== "R2a-4")
  throw new Error("Replay requires the frozen R2a4 configuration");
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
