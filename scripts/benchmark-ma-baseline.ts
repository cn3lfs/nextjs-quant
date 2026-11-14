import { performance } from "node:perf_hooks";
import { maBaselineInputSchema } from "quant-backtest";
import { executeMaBaseline } from "../src/server/backtest/ma-baseline-work";

// Explicit isolation remains required if future adapters acquire persistence.
if (!process.env.QUANT_DATA_DIR)
  throw new Error("先设置隔离 QUANT_DATA_DIR 再运行基线验证");
const options = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1])
    throw new Error("参数须为 --name value");
  if (!["--symbols", "--tdx-root", "--start", "--end"].includes(args[i]!))
    throw new Error(`未知参数：${args[i]}`);
  options.set(args[i]!, args[i + 1]!);
}
const symbols = (
  options.get("--symbols") ??
  "sh600519,sz000001,sh600000,sz000002,sh600036,sz000333"
).split(",");
if (symbols.length > 100 || new Set(symbols).size !== symbols.length)
  throw new Error("证券须唯一且不超过 100 只");
let failures = 0;
for (const symbol of symbols) {
  const started = performance.now();
  try {
    const input = maBaselineInputSchema.parse({
      symbol,
      start: options.get("--start"),
      end: options.get("--end"),
    });
    const archive = await executeMaBaseline({
      type: "ma-baseline",
      root: options.get("--tdx-root") ?? "E:/new_tdx64",
      input,
    });
    console.log(
      JSON.stringify({
        symbol,
        engineVersion: archive.result.engineVersion,
        dataHash: archive.manifest.dataHash,
        start: archive.manifest.start,
        end: archive.manifest.end,
        bars: archive.result.evaluated,
        fills: archive.result.fills.length,
        pending: archive.result.orders.filter((o) => o.status === "pending")
          .length,
        sourceMs: archive.manifest.sourceMs,
        computeMs: archive.manifest.computeMs,
        elapsedMs: performance.now() - started,
        rssMiB: process.memoryUsage().rss / 1048576,
        quality: archive.result.quality,
      }),
    );
  } catch (error) {
    failures++;
    console.log(
      JSON.stringify({
        symbol,
        error: error instanceof Error ? error.message : "验证失败",
      }),
    );
  }
}
if (failures) process.exitCode = 1;
