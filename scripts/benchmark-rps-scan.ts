import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// Deterministic 1,000-security × 300-session RPS scan. The old implementation
// resolves every date with calendar.indexOf(); the new one uses the known day
// index. Run the same script against both checkouts to compare identical input.
const { values } = parseArgs({
  options: {
    impl: { type: "string", default: "new" },
    days: { type: "string", default: "300" },
    symbols: { type: "string", default: "1000" },
  },
});
const days = Number(values.days),
  symbols = Number(values.symbols);
if (!Number.isSafeInteger(days) || days < 150)
  throw new Error("--days must be >= 150");
if (!Number.isSafeInteger(symbols) || symbols < 2)
  throw new Error("--symbols must be >= 2");

const calendar: string[] = [];
for (let day = Date.UTC(2024, 0, 1); calendar.length < days; day += 86400000) {
  if (![0, 6].includes(new Date(day).getUTCDay()))
    calendar.push(new Date(day).toISOString().slice(0, 10));
}
const securities = Array.from({ length: symbols }, (_, index) => {
  const closes = new Map<string, { close: number; volume: number }>();
  let value = 10 + (index % 50);
  for (let i = 0; i < calendar.length; i++) {
    value *= 1 + (((index + i) % 11) - 5) / 1000;
    closes.set(calendar[i]!, { close: value, volume: 1000 + (index % 7) });
  }
  return {
    symbol: `sh${String(600000 + index).padStart(6, "0")}`,
    name: `BENCH${index}`,
    firstDate: calendar[0]!,
    closes,
    unsupportedDates: [],
  };
});

async function load() {
  if (values.impl === "old")
    return import("../.test-data/bench-old/packages/quant-rps/src/index.js");
  return import("../packages/quant-rps/src/index.js");
}

async function main() {
  const module = (await load()) as {
    calculateRps: (...args: never[]) => unknown;
    calculateRpsAtIndex?: (...args: never[]) => unknown;
    rpsPeriods: readonly number[];
  };
  if (!module.calculateRps || !module.rpsPeriods)
    throw new Error("RPS module does not expose the benchmark surface");
  const periods = module.rpsPeriods;
  let checksum = 0;
  const times: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const started = performance.now();
    checksum = 0;
    for (let index = 120; index < calendar.length; index++) {
      const ranked = module.calculateRpsAtIndex
        ? module.calculateRpsAtIndex(
            securities as never,
            calendar as never,
            index as never,
            periods as never,
          )
        : module.calculateRps(
            securities as never,
            calendar as never,
            calendar[index]! as never,
            periods as never,
          );
      const rows = (ranked as { rows: { values: (number | null)[] }[] }).rows;
      for (const row of rows)
        for (const value of row.values) checksum += value ?? 0;
    }
    if (pass > 0) times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = (times[1]! + times[2]!) / 2;
  console.log(
    JSON.stringify({
      impl: values.impl,
      symbols,
      days,
      sessions: calendar.length - 120,
      medianMs: Number(median.toFixed(1)),
      minMs: Number(times[0]!.toFixed(1)),
      checksum: Number(Number(checksum).toFixed(6)),
    }),
  );
}

await main();
