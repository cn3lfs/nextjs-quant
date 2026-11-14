/** Run through the bundled worker, never the default/user database.
 * QUANT_DATA_DIR must be an absolute path inside this workspace's .test-data.
 * pnpm exec tsx scripts/research-validation.ts --market cn-equity --start 2017-01-01 --end 2026-11-13
 * Replay: same command with --replay <input-hash>; performs no data fetch.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { validationInputSchema } from "../src/server/research/validation-model";

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1] || values.has(args[i]!))
    throw new Error("Expected unique --name value arguments");
  values.set(args[i]!, args[i + 1]!);
}
const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !isAbsolute(directory) ||
  !resolve(directory).startsWith(resolve(".test-data") + sep) ||
  relative(resolve(".test-data"), directory).startsWith("..")
)
  throw new Error("Set an absolute isolated QUANT_DATA_DIR inside .test-data");
const output = resolve(directory, "..");
const market = values.get("--market") ?? "cn-equity";
const input = validationInputSchema.parse({
  market,
  start: values.get("--start") ?? "2017-01-01",
  end: values.get("--end") ?? "2026-11-13",
  sampleSize: Number(values.get("--sample") ?? 12),
  ...(values.get("--symbols")
    ? { symbols: values.get("--symbols")!.split(",") }
    : {}),
  cryptoSource: values.get("--source") ?? "binance",
});
const work = {
  type: "strategy-validation",
  root: process.env.TDX_ROOT ?? "E:\\new_tdx64",
  input,
  ...(values.get("--replay") ? { frozenHash: values.get("--replay") } : {}),
};
const worker = new Worker(resolve("runtime/worker.cjs"));
const started = Date.now();
let lastProgress = 0;
const timeout = setTimeout(() => {
  console.error(
    "Research exceeded 30 minutes; worker terminated. Reduce sample/range before retrying.",
  );
  void worker.terminate();
  process.exitCode = 1;
}, 30 * 60000);
try {
  const result = await new Promise<unknown>((accept, reject) => {
    worker.on(
      "message",
      (message: {
        progress?: number;
        phase?: string;
        error?: string;
        result?: unknown;
      }) => {
        if (message.error) reject(new Error(message.error));
        else if ("result" in message) accept(message.result);
        else if (
          message.progress !== undefined &&
          (Date.now() - lastProgress >= 10000 || message.progress === 40)
        ) {
          lastProgress = Date.now();
          console.log(
            JSON.stringify({
              elapsedMs: Date.now() - started,
              progress: message.progress,
              phase: message.phase,
            }),
          );
        }
      },
    );
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`Research worker exited before result (${code})`)),
    );
    worker.postMessage(work);
  });
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, `${market}${work.frozenHash ? "-replay" : ""}-result.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: "completed",
      elapsedMs: Date.now() - started,
      output,
    }),
  );
} finally {
  clearTimeout(timeout);
  await worker.terminate();
}
