import {
  task,
  config,
  prior,
  json,
  artifact,
  readArtifact,
  delivery,
  equity,
  frozen,
  barsOf,
  executionOf,
  digest,
  calculationIdentity,
  type CompactInstrument,
} from "./context";
import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  researchCandidates,
  historicalLowSeries,
  lowZoneCycles,
  type LowZoneFact,
  type LowZoneObservation,
} from "trading-strategies";
import { runPortfolio, type PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import type {
  FrozenValidationInput,
  ValidationDataset,
} from "../../../src/server/research/validation-capture";
import {
  projectCandidate,
  numericNeighbors,
  scoreValidationResult,
} from "../../../src/server/research/validation-replay";
import {
  runCandidateCheckpoint,
  type CandidateCheckpoint,
} from "../../../src/server/research/validation-scale";
import { readPublicData } from "../../../src/server/data-sources/binance/public-data-store";
import { auditPortfolio } from "../../../tests/helpers/portfolio-execution-audit";

import {
  sizeCryptoResearch,
  type ResearchSizing,
} from "../../../src/server/research/crypto-sizing";
const sizing = (process.argv[4] ?? "equal") as ResearchSizing;
const mode = process.argv[2],
  family = process.argv[3];
if (!family)
  throw new Error("Pass cn|crypto|sensitivity plus one declared family");
const current = await json<{ engineAudit: { status: string } }>(
  ".codex-runs/delivery.json",
);
if (current.engineAudit.status !== "passed")
  throw new Error("Engine audit must pass before new candidate evaluation");
type Csi = {
  symbols: string[];
  benchmark: { bars: Bar[] };
  biasTags: unknown[];
};
const csi = await readArtifact<Csi>(
  await json(join(task, "csi800-pointer.json")),
);
let dataset: ValidationDataset, base: FrozenValidationInput;
async function attachLow(
  dataset: ValidationDataset,
  base: FrozenValidationInput,
  indexBars: Bar[],
) {
  const selected = new Set(dataset.instruments.map((i) => i.symbol));
  const facts = new Map<string, LowZoneFact[]>();
  const input = await prior<{ shards: string[] }>("low-input");
  for (const shard of input.shards)
    for (const row of await prior<
      {
        symbol: string;
        facts: [string, number | null, number | null][];
        observations: LowZoneObservation[];
      }[]
    >(shard)) {
      if (!selected.has(row.symbol)) continue;
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
            "R2a3 frozen PIT-filtered GP16/financial facts; revisions approximate, missing temperature",
        })),
      );
      base.lowZones.push({
        symbol: row.symbol,
        observations: row.observations,
      });
    }
  for (const i of dataset.instruments)
    i.external = { ...i.external, lowZone: facts.get(i.symbol) ?? [] };
  base.lowZones.push({
    symbol: "sh000906",
    observations: historicalLowSeries(indexBars),
  });
}
if (mode === "cn") {
  ({ dataset, base } = await equity(
    csi.symbols,
    family === "rps-multi",
    family === "historical-low",
  ));
  dataset.benchmark = csi.benchmark.bars;
  dataset.benchmarkName = "CSI800000906 raw index, no dividends";
  if (family === "historical-low" && config.batch === "R2a-4")
    await attachLow(dataset, base, csi.benchmark.bars);
  if (family === "chan-third-buy") {
    const progress = await json<{ chunks: { path: string; sha256: string }[] }>(
      join(task, "native-progress.json"),
    );
    const native = (
      await Promise.all(
        progress.chunks.map((p) =>
          readArtifact<FrozenValidationInput["native"]>(p),
        ),
      )
    ).flat();
    const keep = new Set(native.map((n) => n.symbol));
    dataset.instruments = dataset.instruments.filter((i) => keep.has(i.symbol));
    dataset.sources = dataset.sources.filter((i) => keep.has(i.symbol));
    base.native = native.filter((n) => csi.symbols.includes(n.symbol));
    const finished = await json<{ chanSubset: { status: string } }>(
      ".codex-runs/delivery.json",
    );
    if (finished.chanSubset.status !== "capture-complete")
      throw new Error("Native capture has not reached its predeclared cutoff");
  }
} else if (mode === "crypto") {
  const period = family.endsWith("-day")
    ? "day"
    : family.endsWith("-4h")
      ? "4h"
      : family.endsWith("-1h")
        ? "1h"
        : "15m";
  const interval = period === "day" ? "1d" : period;
  const instruments: PortfolioInstrument[] = [],
    sources: ValidationDataset["sources"] = [];
  const coverage = await json<{
    root: string;
    series: { symbol: string; interval: string; status: string }[];
  }>(join(task, "crypto-coverage.json"));
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const ready = coverage.series.find(
      (s) => s.symbol === symbol && s.interval === interval,
    );
    if (ready?.status !== "ready")
      throw new Error(
        `Official native source incomplete ${symbol}/${interval}`,
      );
    const view = await readPublicData(symbol, interval, {
      root: coverage.root,
      now: Date.parse(config.end) + 86400000,
    });
    const bars = view.rows.map((r) => r.bar);
    instruments.push({
      symbol: `cx${symbol}`,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        minimum: 0.000001,
        step: 0.000001,
        maximum: 1e9,
        tradable: true,
        limitUp: null,
        limitDown: null,
        evidence:
          "Frozen research quantity grid; historical venue filters unverified",
      },
    });
    sources.push({
      symbol: `cx${symbol}`,
      hash: digest(JSON.stringify(view.files.map((f) => [f.path, f.sha256]))),
      adjustmentReference: null,
    });
  }
  const benchmark = instruments[0]!.bars;
  dataset = {
    period,
    instruments,
    sources,
    benchmark: [...benchmark],
    dates: [...new Set(benchmark.map((b) => b.date.slice(0, 10)))],
    benchmarkName: "BTC hold; each window first open; uncharged benchmark",
  };
  base = frozen(dataset);
} else if (mode === "sensitivity") {
  ({ dataset, base } = await equity(undefined, family === "rps-multi"));
  const terminal = await json<{
    complete: boolean;
    shards: { path: string; sha256: string }[];
  }>(join(task, "terminal-input.json"));
  if (!terminal.complete) throw new Error("All337 terminal inputs required");
  for (const p of terminal.shards)
    for (const row of await readArtifact<CompactInstrument[]>(p)) {
      const bars = barsOf(row),
        signalBars = barsOf(row, true);
      const extra: NonNullable<PortfolioInstrument["external"]> = {};
      if (family === "rps-multi")
        extra.rps = dataset.dates.map((date, i) => ({
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
      dataset.instruments.push({
        symbol: row.symbol,
        market: "cn-equity",
        bars,
        signalBars,
        actions: row.actions,
        execution: executionOf(row.symbol, bars),
        external: extra,
        terminal: {
          date: bars.at(-1)!.date,
          valuation: "last-close",
          evidence:
            "Survivorship sensitivity; last observed price is not certified delisting proceeds or a historical fill",
        },
      });
      dataset.sources.push({
        symbol: row.symbol,
        hash: row.sourceHash,
        adjustmentReference: row.adjustmentReference,
      });
    }
  if (dataset.instruments.length !== 1975)
    throw new Error("Survivorship pool must restore all337");
  if (family === "historical-low")
    await attachLow(dataset, base, dataset.benchmark);
} else throw new Error("Expected cn|crypto|sensitivity");
base.candidateMenu = researchCandidates(
  dataset.instruments.map((i) => i.symbol),
  base.input.market,
);
const candidates = base.candidateMenu
  .filter((c) => c.family === family)
  .flatMap((c) => [c, ...numericNeighbors(c)]);
if (candidates.length !== 9)
  throw new Error("Expected unchanged three variants plus two neighbors each");
const scope =
  mode === "cn"
    ? "csi800"
    : mode === "crypto"
      ? "btc-eth"
      : "all-market-sensitivity";
const name = `${scope}-${family}${mode === "crypto" && config.batch === "R2a-5" ? `-${sizing}` : ""}`;
const progressPath = join(task, `${name}-progress.json`);
const identity = digest(
  JSON.stringify({
    calculationBuild: await calculationIdentity(base.input.market),
    mode,
    family,
    sizing,
    sources: dataset.sources,
    dates: dataset.dates,
    benchmark: dataset.benchmark.map((b) => [b.date, b.open, b.close]),
    menu: candidates,
  }),
);
const admission = process.env.QUANT_RESEARCH_ADMISSION === "1";
let sourceIdentity = "";
let originalGroup: Record<string, unknown> | undefined;
let checkpoints: CandidateCheckpoint[] = [],
  sensitivity: unknown[] = [];
try {
  const saved = await json<{
    identity: string;
    pointer: { path: string; sha256: string };
  }>(progressPath);
  sourceIdentity = saved.identity;
  if (saved.identity !== identity && !admission)
    throw new Error(
      "Research input changed on resume; explicit admit requires exact frozen financial parity",
    );
  const content = await readArtifact<{
    checkpoints: CandidateCheckpoint[];
    sensitivity: unknown[];
  }>(saved.pointer);
  originalGroup = content as unknown as Record<string, unknown>;
  checkpoints = content.checkpoints;
  sensitivity = content.sensitivity;
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const cache = new Map();
const policy = {
  ...base.input.policy,
  holdoutStart: mode === "sensitivity" ? undefined : config.holdoutStart,
  trainBars: Math.max(20, Math.floor(dataset.dates.length * 0.4)),
  testBars: Math.max(5, Math.floor(dataset.dates.length * 0.1)),
};
if (admission) {
  if (
    config.batch !== "R2a-5" ||
    mode === "sensitivity" ||
    !originalGroup ||
    !checkpoints.length
  )
    throw new Error("Admission requires a frozen R2a5 candidate checkpoint");
  const baseline = await readArtifact<{
    inputs: Record<string, string>;
    rows: Record<
      string,
      {
        progress: { identity: string; pointer: { sha256: string } };
        bytes: string;
      }
    >;
  }>(await json(join(task, "score-mode-baseline-pointer.json")));
  for (const [name, hash] of Object.entries(baseline.inputs))
    if (digest(await readFile(join(task, name))) !== hash)
      throw new Error("Captured input pointer changed; admission forbidden");
  const original = baseline.rows[`${name}-progress.json`];
  if (!original || original.progress.identity !== sourceIdentity)
    throw new Error("Admission baseline identity mismatch");
  if (
    digest(Buffer.from(original.bytes, "base64")) !==
    original.progress.pointer.sha256
  )
    throw new Error("Admission baseline bytes changed");
  const compared = [];
  for (const old of checkpoints) {
    const originalId = old.row.id.replace(/-sizing-(equal|volatility)/, "");
    const candidate = candidates.find((c) => c.strategy.id === originalId);
    if (!candidate) throw new Error("Frozen candidate is missing");
    console.log(
      JSON.stringify({
        phase: "admit-start",
        id: old.row.id,
        at: new Date().toISOString(),
      }),
    );
    const projected = projectCandidate(
      candidate,
      dataset,
      base,
      cache,
      (done, total) =>
        console.log(
          JSON.stringify({ phase: "prepare-admission", done, total }),
        ),
    );
    if (!projected) throw new Error("Missing projection during admission");
    if (mode === "crypto") {
      projected.request = sizeCryptoResearch(projected.request, sizing);
      projected.id = old.row.id;
    }
    const next = runCandidateCheckpoint(projected, dataset, policy);
    const financial = (p: CandidateCheckpoint) =>
      JSON.parse(
        JSON.stringify({
          row: p.row,
          training: p.training,
          fullPeriod: p.fullPeriod,
        }),
      );
    if (!isDeepStrictEqual(financial(old), financial(next))) {
      await writeFile(
        join(task, `${name}-admission-failed.json`),
        JSON.stringify({ old: financial(old), next: financial(next) }, null, 2),
      );
      throw new Error(
        "Exact frozen financial parity failed; old checkpoint retained",
      );
    }
    compared.push({
      id: old.row.id,
      previousMs: old.elapsedMs,
      currentMs: next.elapsedMs,
      exact: true,
    });
    console.log(
      JSON.stringify({
        phase: "admit-exact",
        ...compared.at(-1),
        at: new Date().toISOString(),
      }),
    );
  }
  const pointer = await artifact(name, { ...originalGroup, identity });
  await writeFile(
    progressPath,
    JSON.stringify(
      {
        identity,
        pointer,
        complete: checkpoints.length === 9,
        admission: { sourceIdentity, compared },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(task, `${name}-admission.json`),
    JSON.stringify(
      {
        sourceIdentity,
        identity,
        compared,
        financialTolerance: 0,
        inputPointersVerified: Object.keys(baseline.inputs).length,
      },
      null,
      2,
    ),
  );
  await delivery({
    scoreModeParity: {
      scope,
      family,
      compared: compared.length,
      exact: true,
      evidence: `${name}-admission.json`,
    },
    nextStart: `Resume ${name}; all existing checkpoint numbers exactly reproduced with current scoring detail`,
  });
  process.exit(0);
}
for (const c of candidates) {
  if (
    mode !== "sensitivity" &&
    checkpoints.some(
      (p) =>
        p.row.id ===
        (mode === "crypto" && config.batch === "R2a-5"
          ? c.strategy.id.replace(/(-neighbor-\d+)?$/, `-sizing-${sizing}$1`)
          : c.strategy.id),
    )
  )
    continue;
  if (
    mode === "sensitivity" &&
    sensitivity.some((s) => (s as { id: string }).id === c.strategy.id)
  )
    continue;
  console.log(
    JSON.stringify({
      phase: "candidate-start",
      scope,
      id: c.strategy.id,
      symbols: dataset.instruments.length,
      at: new Date().toISOString(),
    }),
  );
  const projected = projectCandidate(c, dataset, base, cache, (done, total) =>
    console.log(
      JSON.stringify({
        phase: "prepare-rules",
        id: c.strategy.id,
        done,
        total,
        at: new Date().toISOString(),
      }),
    ),
  );
  if (!projected) throw new Error("Projected inputs unavailable");
  if (mode === "crypto" && config.batch === "R2a-5") {
    projected.request = sizeCryptoResearch(projected.request, sizing);
    projected.id = c.strategy.id.replace(
      /(-neighbor-\d+)?$/,
      `-sizing-${sizing}$1`,
    );
  }
  if (mode === "sensitivity") {
    const old = await prior<{ checkpoints: CandidateCheckpoint[] }>(
      `candidate-${family === "historical-low" ? "cnlowzone" : "cnswing"}-${family}`,
    );
    const oldRow = old.checkpoints.find((p) => p.row.id === c.strategy.id)!;
    const outcomes = [];
    for (const valuation of ["last-close", "total-loss"] as const) {
      const request = {
        ...projected.request,
        instruments: projected.request.instruments.map((i) => ({
          ...i,
          ...(i.terminal ? { terminal: { ...i.terminal, valuation } } : {}),
        })),
      };
      const full = runPortfolio(request);
      const holdRequest = {
        ...request,
        start: oldRow.row.holdout.start,
        end: oldRow.row.holdout.end,
      };
      const hold = runPortfolio(holdRequest);
      outcomes.push({
        valuation,
        full: scoreValidationResult(full, request, dataset),
        holdout: scoreValidationResult(hold, holdRequest, dataset),
        terminalValuations: full.terminalValuations,
      });
      if (
        family === "historical-low" &&
        c.variant === "atr" &&
        !c.strategy.id.includes("neighbor")
      )
        await artifact(
          "low-terminal-tranche-audit",
          auditPortfolio(request, full),
        );
    }
    sensitivity.push({
      id: c.strategy.id,
      exclude: { full: oldRow.fullPeriod, holdout: oldRow.row.holdout.base },
      outcomes,
    });
  } else checkpoints.push(runCandidateCheckpoint(projected, dataset, policy));
  const pointer = await artifact(name, {
    scope,
    family,
    identity,
    policy,
    symbols: dataset.instruments.map((i) => i.symbol),
    checkpoints,
    sensitivity,
    benchmark: dataset.benchmarkName,
    marketCycles:
      family === "historical-low"
        ? lowZoneCycles(historicalLowSeries(dataset.benchmark)).filter(
            (c) => c.start >= "2010-01-01",
          )
        : [],
  });
  await writeFile(
    progressPath,
    JSON.stringify(
      {
        identity,
        pointer,
        complete:
          (mode === "sensitivity" ? sensitivity.length : checkpoints.length) ===
          9,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase: "candidate-complete",
      scope,
      id: c.strategy.id,
      complete:
        mode === "sensitivity" ? sensitivity.length : checkpoints.length,
      at: new Date().toISOString(),
    }),
  );
  await delivery({
    activeResearch: {
      scope,
      family,
      complete:
        mode === "sensitivity" ? sensitivity.length : checkpoints.length,
      pointer,
    },
    nextStart: `Resume ${name} from validated progress pointer; no live reminders activated`,
  });
}
process.exit(0);
