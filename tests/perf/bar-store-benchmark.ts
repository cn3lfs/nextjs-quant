/** Read-only TDX timing. Explicit isolation is required before importing settings.
 * pnpm exec tsx tests/perf/bar-store-benchmark.ts; TDX_ROOT or isolated settings. */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readSnapshot as oldRead, scan } from "tstdx/local";
import { readBars } from "~/server/market/bar-store/read-bars";
import { evaluateFormula } from "trading-strategies/formula/tdx-formula";
import { settings } from "~/server/infra/settings";
import type { Bar } from "~/lib/domain";
import { evaluateStrategySeries } from "~/server/strategies/drivers/evaluation";
import { formulaStrategy } from "~/server/strategies/drivers/strategy-definitions";

const parent = resolve(process.env.QUANT_BENCH_ROOT ?? ".test-data/r1a");
if (!parent.startsWith(resolve(".test-data") + "\\"))
  throw new Error("Benchmark root must be inside .test-data");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== join(parent, "data"))
  throw new Error(`Set QUANT_DATA_DIR=${join(parent, "data")}`);
await mkdir(parent, { recursive: true });
const root =
  process.env.TDX_ROOT ?? process.env.QUANT_TDX_ROOT ?? settings().tdxRoot;
const output = join(parent, "perf.json");
if (!root) {
  await writeFile(
    output,
    JSON.stringify(
      {
        status: "skipped",
        reason:
          "TDX_ROOT/QUANT_TDX_ROOT are unset and isolated settings.tdxRoot is empty. Production settings DB was not opened; no path guessing or disk search.",
        before: null,
        after: null,
        warmScanTargetMs: 5000,
        targetMet: null,
      },
      null,
      2,
    ),
  );
} else {
  const securities = (await scan(root)).securities
    .filter((s) => s.period === "day")
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const formula = "选股:CROSS(MA(C,5),MA(C,20));";
  const strategy = formulaStrategy({
    name: "benchmark",
    source: formula,
    parameters: {},
  });
  let phase = 0;
  const measure = async (
    reader: (symbol: string) => Promise<{ bars: Bar[] }>,
    evaluate: boolean | "strategy",
  ) => {
    const start = performance.now();
    let cursor = 0,
      bars = 0,
      matches = 0;
    const errors: { symbol: string; error: string }[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (cursor < securities.length) {
          const symbol = securities[cursor++]!.symbol;
          try {
            const result = await reader(symbol);
            bars += result.bars.length;
            if (
              evaluate &&
              (evaluate === "strategy"
                ? evaluateStrategySeries(
                    strategy,
                    {
                      market: "cn-equity",
                      symbol,
                      bars: result.bars,
                    },
                    result.bars.at(-1)!.date,
                  )?.decision.entry
                : evaluateFormula(
                    formula,
                    result.bars,
                    {},
                  ).outputs[0]?.values.at(-1))
            )
              matches++;
          } catch (error) {
            errors.push({ symbol, error: String(error) });
          }
        }
      }),
    );
    const result = {
      elapsedMs: performance.now() - start,
      securities: securities.length,
      bars,
      matches,
      errors,
    };
    console.log(JSON.stringify({ phase: ++phase, ...result }));
    return result;
  };
  const beforeReader = (symbol: string) => oldRead(root, symbol, "day");
  const afterReader = (symbol: string) =>
    readBars({
      instrument: { market: "cn-equity", symbol },
      root,
      period: "day",
      adjustment: "none",
    });
  const before = {
    coldLoad: await measure(beforeReader, false),
    warmLoad: await measure(beforeReader, false),
    warmScan: await measure(beforeReader, true),
  };
  await writeFile(
    output,
    JSON.stringify({ status: "before-complete", root, before }, null, 2),
  );
  const after = {
    coldLoad: await measure(afterReader, false),
    warmLoad: await measure(afterReader, false),
    warmScan: await measure(afterReader, "strategy"),
    forwardScan: await measure(
      (symbol) =>
        readBars({
          instrument: { market: "cn-equity", symbol },
          root,
          period: "day",
          adjustment: "forward",
        }),
      "strategy",
    ),
  };
  await writeFile(
    output,
    JSON.stringify(
      {
        status: "measured",
        root,
        formula,
        methodology:
          "Eight prefetch lanes, complete local histories; cold means first process read, OS cache not purged. Before and after warmScan use raw prices for parity; forwardScan measures new default signal basis including GBBQ.",
        before,
        after,
        warmScanTargetMs: 5000,
        targetMet:
          !after.forwardScan.errors.length &&
          after.forwardScan.elapsedMs < 5000,
      },
      null,
      2,
    ),
  );
}
