import {
  task,
  prior,
  json,
  artifact,
  readArtifact,
  delivery,
  frozen,
  barsOf,
  executionOf,
  digest,
  calculationIdentity,
  type CompactInstrument,
  type EquityManifest,
} from "./lib/research-r2a4";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareStrategy,
  researchCandidates,
  type LowZoneFact,
} from "trading-strategies";
import {
  runPortfolio,
  type PortfolioRequest,
  type PortfolioInstrument,
} from "quant-backtest";
import type { ValidationDataset } from "../src/server/research/validation-capture";
import type { CandidateCheckpoint } from "../src/server/research/validation-scale";
import {
  projectCandidate,
  numericNeighbors,
  scoreValidationResult,
} from "../src/server/research/validation-replay";

const family = process.argv[2];
if (
  ![
    "rps-multi",
    "double-breakout",
    "formula-ma",
    "formula-range",
    "formula-pullback",
    "historical-low",
  ].includes(family ?? "")
)
  throw new Error("Pass a declared sensitivity family");
if (
  (await json<{ engineAudit: { status: string } }>(".codex-runs/delivery.json"))
    .engineAudit.status !== "passed"
)
  throw new Error("Engine audit required");
const manifest = await prior<EquityManifest>("equity-input");
const rps = JSON.parse(await prior<string>("rps-root")) as {
  dates: string[];
  universe: ReturnType<typeof frozen>["universe"];
};
const terminal = await json<{
  complete: boolean;
  shards: { path: string; sha256: string }[];
}>(join(task, "terminal-input.json"));
if (!terminal.complete) throw new Error("All337 frozen inputs required");
const instruments: PortfolioInstrument[] = [],
  sources: ValidationDataset["sources"] = [],
  parity: unknown[] = [];
const menu = researchCandidates(["QA"], "cn-equity");
const rpsTemplate = menu.find((c) => c.family === "rps-multi")!.strategy;
async function add(rows: CompactInstrument[], isTerminal: boolean) {
  for (const row of rows) {
    const bars = barsOf(row),
      signalBars = barsOf(row, true);
    const external: NonNullable<PortfolioInstrument["external"]> = {};
    if (family === "rps-multi") {
      const ranks = rps.dates.map((date, i) => ({
        date,
        periods: [20, 50, 120],
        values: [0, 1, 2].map((p) =>
          row.rps[i * 9 + p * 3] === null
            ? null
            : {
                return: row.rps[i * 9 + p * 3]!,
                rank: row.rps[i * 9 + p * 3 + 1]!,
                rps: row.rps[i * 9 + p * 3 + 2]!,
              },
        ),
      }));
      // Compile the actual package-owned formula once per source, then retain only
      // true entry dates. No alternative RPS formula or cross-section is introduced.
      const rule = {
        ...rpsTemplate,
        universe: { kind: "symbols" as const, symbols: [row.symbol] },
        exit: {},
      };
      const compiled = prepareStrategy(rule, signalBars, { rps: ranks });
      external.signals = signalBars.flatMap((b, i) =>
        compiled.evaluate(i).entry === true
          ? [
              {
                id: "frozen-rps-entry",
                date: b.date,
                availableAt: b.date,
                entry: true,
                exit: false,
              },
            ]
          : [],
      );
      if (parity.length < 3) {
        const dates = new Set(external.signals.map((s) => s.date));
        const mismatch = signalBars.filter(
          (b, i) => dates.has(b.date) !== (compiled.evaluate(i).entry === true),
        ).length;
        if (mismatch) throw new Error("RPS entry compression lost dates");
        parity.push({
          symbol: row.symbol,
          observations: signalBars.length,
          trueEntries: dates.size,
          mismatch,
          source: row.sourceHash,
        });
      }
    }
    instruments.push({
      symbol: row.symbol,
      market: "cn-equity",
      bars,
      signalBars,
      execution: executionOf(row.symbol, bars),
      external,
      actions: row.actions,
      ...(isTerminal
        ? {
            terminal: {
              date: bars.at(-1)!.date,
              valuation: "last-close" as const,
              evidence:
                "Sensitivity only; no verified delisting settlement. Not a market fill.",
            },
          }
        : {}),
    });
    sources.push({
      symbol: row.symbol,
      hash: row.sourceHash,
      adjustmentReference: row.adjustmentReference,
    });
  }
}
for (const shard of manifest.shards)
  await add(await prior<CompactInstrument[]>(shard), false);
for (const pointer of terminal.shards)
  await add(await readArtifact<CompactInstrument[]>(pointer), true);
if (instruments.length !== 1975)
  throw new Error("Sensitivity must restore1975 including337 exclusions");
const dataset: ValidationDataset = {
  period: "day",
  instruments,
  sources,
  benchmark: manifest.benchmark,
  dates: rps.dates,
  benchmarkName: "Frozen CSI300 broad comparison, raw price index",
};
const base = frozen(dataset);
base.universe = rps.universe;
if (family === "historical-low") {
  const selected = new Set(instruments.map((i) => i.symbol));
  const facts = new Map<string, LowZoneFact[]>();
  const low = await prior<{ shards: string[] }>("low-input");
  for (const shard of low.shards)
    for (const row of await prior<
      { symbol: string; facts: [string, number | null, number | null][] }[]
    >(shard))
      if (selected.has(row.symbol))
        facts.set(
          row.symbol,
          row.facts.map(([date, pe, pb]) => ({
            date,
            availableAt: date,
            pe,
            pb,
            temperature: null,
            confidence: "approximate",
            source:
              "Unchanged frozen R2a3 PIT facts; first vintage and temperature missing",
          })),
        );
  for (const i of instruments)
    i.external = { ...i.external, lowZone: facts.get(i.symbol) ?? [] };
}
const originalCandidates = researchCandidates(
  instruments.map((i) => i.symbol),
  "cn-equity",
)
  .filter((c) => c.family === family)
  .flatMap((c) => [c, ...numericNeighbors(c)]);
const candidates = originalCandidates.map((c) =>
  family === "rps-multi"
    ? {
        ...c,
        strategy: {
          ...c.strategy,
          entry: {
            kind: "external" as const,
            id: "frozen-rps-entry",
            side: "entry" as const,
          },
        },
      }
    : c,
);
const identity = digest(
  JSON.stringify({
    sources,
    dates: rps.dates,
    menu: originalCandidates,
    calculationBuild: await calculationIdentity("cn-equity"),
    adapter: digest(await readFile(new URL(import.meta.url))),
  }),
);
const progressPath = join(
  task,
  `all-market-sensitivity-${family}-progress.json`,
);
let sensitivity: { id: string; exclude: unknown; outcomes: unknown[] }[] = [];
try {
  const old = await json<{
    identity: string;
    pointer: { path: string; sha256: string };
  }>(progressPath);
  if (old.identity !== identity) throw new Error("Sensitivity design changed");
  sensitivity = (
    await readArtifact<{ sensitivity: typeof sensitivity }>(old.pointer)
  ).sensitivity;
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const reference = await prior<{ checkpoints: CandidateCheckpoint[] }>(
  `candidate-${family === "historical-low" ? "cnlowzone" : "cnswing"}-${family}`,
);
/** After features have been frozen by projectCandidate, no rule reads a price
 * prefix. Crop only the execution input, never an indicator/detector prefix. */
function executionWindow(
  request: PortfolioRequest,
  start: string,
  end: string,
): PortfolioRequest {
  if (
    request.strategies.some(
      (s) =>
        s.entry.kind !== "external" ||
        s.exit.rule?.kind !== "external" ||
        s.exit.stop?.kind === "atr",
    )
  )
    throw new Error("Cannot crop unfrozen features");
  return {
    ...request,
    start,
    end,
    calendar: request.calendar.filter(
      (d) => d.slice(0, 10) >= start && d.slice(0, 10) <= end,
    ),
    instruments: request.instruments
      .map((i) => ({
        ...i,
        bars: i.bars.filter((b) => b.date >= start && b.date <= end),
        signalBars: i.signalBars.filter(
          (b) => b.date >= start && b.date <= end,
        ),
        external: {
          ...i.external,
          signals: i.external?.signals?.filter(
            (s) => s.date >= start && s.date <= end,
          ),
          levels: i.external?.levels?.filter(
            (s) => s.date >= start && s.date <= end,
          ),
        },
      }))
      .filter((i) => i.bars.length > 0),
  };
}
function evaluate(request: PortfolioRequest) {
  const r = runPortfolio(request);
  return {
    score: scoreValidationResult(r, request, dataset),
    terminalValuations: r.terminalValuations,
  };
}
const cache = new Map();
for (const c of candidates) {
  if (sensitivity.some((s) => s.id === c.strategy.id)) continue;
  console.log(
    JSON.stringify({
      phase: "candidate-start",
      family,
      id: c.strategy.id,
      at: new Date().toISOString(),
    }),
  );
  const projected = projectCandidate(c, dataset, base, cache)!;
  const old = reference.checkpoints.find((p) => p.row.id === c.strategy.id)!;
  if (!sensitivity.length) {
    const symbols = new Set(instruments.slice(0, 3).map((i) => i.symbol));
    const request = {
      ...projected.request,
      instruments: projected.request.instruments.filter((i) =>
        symbols.has(i.symbol),
      ),
      start: old.row.holdout.start,
      end: old.row.holdout.end,
    };
    const normal = runPortfolio(request),
      cropped = runPortfolio(
        executionWindow(request, request.start, request.end),
      );
    for (const key of [
      "fills",
      "orders",
      "rejections",
      "equity",
      "terminalValuations",
    ] as const)
      if (JSON.stringify(normal[key]) !== JSON.stringify(cropped[key]))
        throw new Error(`Execution-only crop changed ${key}`);
    await writeFile(
      join(task, `sensitivity-parity-${family}.json`),
      JSON.stringify(
        {
          rpsEntryCompression: parity,
          threeSymbolExecutionIdentical: true,
          fields: [
            "fills",
            "orders",
            "rejections",
            "equity",
            "terminalValuations",
          ],
          start: request.start,
          end: request.end,
        },
        null,
        2,
      ),
    );
  }
  const outcomes = [];
  for (const valuation of ["last-close", "total-loss"] as const) {
    const request = {
      ...projected.request,
      instruments: projected.request.instruments.map((i) => ({
        ...i,
        ...(i.terminal ? { terminal: { ...i.terminal, valuation } } : {}),
      })),
    };
    const full = evaluate(executionWindow(request, request.start, request.end));
    const holdout = evaluate(
      executionWindow(request, old.row.holdout.start, old.row.holdout.end),
    );
    outcomes.push({
      valuation,
      full: full.score,
      holdout: holdout.score,
      terminalValuations: full.terminalValuations,
    });
  }
  sensitivity.push({
    id: c.strategy.id,
    exclude: { full: old.fullPeriod, holdout: old.row.holdout.base },
    outcomes,
  });
  const pointer = await artifact(`all-market-sensitivity-${family}`, {
    scope: "all-market-sensitivity",
    family,
    identity,
    symbols: instruments.map((i) => i.symbol),
    checkpoints: [],
    sensitivity,
    projection:
      "Actual package-owned rule compiled before execution-only crop; no indicator warmup truncated",
  });
  await writeFile(
    progressPath,
    JSON.stringify(
      { identity, pointer, complete: sensitivity.length === 9 },
      null,
      2,
    ),
  );
  await delivery({
    survivorship: {
      status: "running",
      family,
      completed: sensitivity.length,
      pointer,
    },
    nextStart: `Continue sensitivity ${family} from verified candidate checkpoint`,
  });
  console.log(
    JSON.stringify({
      phase: "candidate-complete",
      family,
      id: c.strategy.id,
      complete: sensitivity.length,
      at: new Date().toISOString(),
    }),
  );
}
process.exit(0);
