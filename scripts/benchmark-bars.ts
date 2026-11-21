import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { isAStock, resolveTdxRoot, validateLocalDate } from "tstdx/local";
import { readBars } from "../src/server/market/bar-store/read-bars";

// Run each mode in a separate process and use a fresh QUANT_DATA_DIR for each.
// Timestamp bounds select the legacy path with the same exchange-date range.
async function main() {
  assert(
    process.env.QUANT_DATA_DIR && isAbsolute(process.env.QUANT_DATA_DIR),
    "Set QUANT_DATA_DIR to an isolated absolute directory",
  );
  assert(
    (await readdir(process.env.QUANT_DATA_DIR)).length === 0,
    "QUANT_DATA_DIR must be an empty benchmark directory",
  );
  assert(
    !process.env.QUANT_RESEARCH_BAR_STORE_DIR,
    "Unset QUANT_RESEARCH_BAR_STORE_DIR",
  );
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      period: { type: "string", default: "day" },
      mode: { type: "string" },
      count: { type: "string", default: "32" },
      symbols: { type: "string" },
    },
  });
  const { mode, period } = values;
  assert(mode === "window" || mode === "full", "--mode window|full");
  assert(period === "day" || period === "5m", "--period day|5m");
  assert(
    values.root && values.from && values.to,
    "--root, --from and --to are required",
  );
  const root = resolveTdxRoot(values.root);
  const from = validateLocalDate(values.from);
  const to = validateLocalDate(values.to);
  assert(from <= to, "Invalid date range");
  const count = Number(values.count);
  assert(Number.isSafeInteger(count) && count > 0, "Invalid --count");
  const all =
    values.symbols?.split(",") ??
    (
      await Promise.all(
        ["sh", "sz"].map(async (market) => {
          const filenames = await readdir(
            join(root, "vipdoc", market, period === "day" ? "lday" : "fzline"),
          );
          const suffix = period === "day" ? ".day" : ".lc5";
          return filenames
            .filter((name) => name.endsWith(suffix))
            .map((name) => name.slice(0, -suffix.length))
            .filter(isAStock)
            .sort();
        }),
      )
    )
      .flatMap((symbols) => symbols.slice(0, Math.ceil(count / 2)))
      .slice(0, count);
  assert(
    all.length && all.every(isAStock) && new Set(all).size === all.length,
    "Invalid symbol list",
  );
  const dateOffset = period === "day" ? "Z" : "+08:00";
  for (const pass of ["cold", "warm"]) {
    const digest = createHash("sha256");
    const started = performance.now();
    const cpu = process.cpuUsage();
    let bars = 0;
    let empty = 0;
    let peakHeap = process.memoryUsage().heapUsed;
    for (const symbol of all) {
      const result = await readBars({
        instrument: { market: "cn-equity", symbol },
        root,
        source: "local",
        period,
        adjustment: "none",
        from: mode === "window" ? from : `${from}T00:00:00${dateOffset}`,
        to: mode === "window" ? to : `${to}T23:59:59${dateOffset}`,
        now: Date.parse(`${to}T23:59:59+08:00`),
      });
      assert(
        result.source === "tdx-local",
        `Unexpected source: ${result.source}`,
      );
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      digest.update(result.hash).update(JSON.stringify(result.bars));
      bars += result.bars.length;
      if (!result.bars.length) empty++;
    }
    const spent = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        mode,
        pass,
        period,
        from,
        to,
        symbols: all.length,
        empty,
        bars,
        sha256: digest.digest("hex"),
        wallMs: Math.round(performance.now() - started),
        cpuMs: Math.round((spent.user + spent.system) / 1000),
        sampledHeapMiB: +(peakHeap / 1024 ** 2).toFixed(1),
        processMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
