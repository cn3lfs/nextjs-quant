import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// Same-input microbenchmarks for the three P6 lookup changes:
// 1. RPS eligibility: per bar/symbol Array.find vs prebuilt date Map.
// 2. PIT membership: per bar/strategy Array.find vs prebuilt date Map.
// 3. Chan movement chain: repeated Array.find/filter vs id Map.
const { values } = parseArgs({
  options: {
    impl: { type: "string", default: "new" },
    symbols: { type: "string", default: "1000" },
    bars: { type: "string", default: "1000" },
    movements: { type: "string", default: "4000" },
  },
});
const symbolCount = Number(values.symbols),
  barCount = Number(values.bars),
  movementCount = Number(values.movements);
if (!Number.isSafeInteger(symbolCount) || symbolCount < 2)
  throw new Error("invalid --symbols");
if (!Number.isSafeInteger(barCount) || barCount < 2)
  throw new Error("invalid --bars");
if (!Number.isSafeInteger(movementCount) || movementCount < 3)
  throw new Error("invalid --movements");
const old = values.impl === "old";

const calendar = Array.from(
  { length: barCount },
  (_, i) =>
    `2024-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
);
const symbols = Array.from({ length: symbolCount }, (_, index) => ({
  symbol: `sh${String(600000 + index).padStart(6, "0")}`,
  points: calendar.map((date, i) => ({
    date,
    values: [
      { rps: ((index + i) % 100) + 1 },
      { rps: ((index * 3 + i) % 100) + 1 },
    ],
  })),
}));
const membershipRows = Array.from({ length: barCount }, (_, i) => ({
  strategyId: "s1",
  date: calendar[i]!,
  symbols: Array.from(
    { length: symbolCount },
    (_, index) => `sh${String(600000 + index).padStart(6, "0")}`,
  ),
}));
const movements = Array.from({ length: movementCount }, (_, i) => ({
  id: i + 1,
  successorId: i + 2 <= movementCount ? i + 2 : null,
  level: 1,
  completed: {},
}));

function median(runs: number[]) {
  runs.sort((a, b) => a - b);
  return Number(((runs[1]! + runs[2]!) / 2).toFixed(1));
}

function rpsLookup() {
  let checksum = 0;
  const maps = old
    ? null
    : new Map(
        symbols.map((row) => [
          row.symbol,
          new Map(row.points.map((point) => [point.date, point])),
        ]),
      );
  for (let i = 120; i < calendar.length; i++) {
    const date = calendar[i]!;
    for (const row of symbols) {
      const point = maps
        ? maps.get(row.symbol)!.get(date)
        : row.points.find((p) => p.date === date);
      checksum += point?.values[0]?.rps ?? 0;
    }
  }
  return checksum;
}

function membershipLookup() {
  let checksum = 0;
  const map = old
    ? null
    : new Map(membershipRows.map((row) => [row.date, new Set(row.symbols)]));
  for (let i = 120; i < calendar.length; i++) {
    const date = calendar[i]!;
    for (const row of symbols) {
      const included = map
        ? map.get(date)!.has(row.symbol)
        : membershipRows
            .find((m) => m.date === date)!
            .symbols.includes(row.symbol);
      if (included) checksum++;
    }
  }
  return checksum;
}

function chanSequence() {
  const byId = old
    ? null
    : new Map(movements.map((movement) => [movement.id, movement]));
  const roots = old
    ? movements.filter(
        (m) => !movements.some((candidate) => candidate.successorId === m.id),
      )
    : movements.filter(
        (m) => !movements.some((candidate) => candidate.successorId === m.id),
      );
  let current = roots[0],
    count = 0;
  while (current) {
    count++;
    current = byId
      ? byId.get(current.successorId!)
      : movements.find((m) => m.id === current!.successorId);
  }
  return count;
}

function run(label: string, work: () => number) {
  const times: number[] = [];
  let checksum = 0;
  for (let pass = 0; pass < 4; pass++) {
    const started = performance.now();
    checksum = work();
    if (pass > 0) times.push(performance.now() - started);
  }
  return { label, medianMs: median(times), checksum };
}

console.log(
  JSON.stringify(
    {
      impl: values.impl,
      symbols: symbolCount,
      bars: barCount,
      movements: movementCount,
      results: [
        run("rps", rpsLookup),
        run("membership", membershipLookup),
        run("chan", chanSequence),
      ],
    },
    null,
    2,
  ),
);
