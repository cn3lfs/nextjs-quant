import "./lib/research-scale-isolation";
/** R2a-3 equity phases; existing TDX inputs are read-only. */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  historicalLowSeries,
  lowZoneCycles,
  researchCandidates,
  type LowZoneFact,
  type LowZoneObservation,
} from "trading-strategies";
import type { PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { equityResearchRules } from "trading-strategy-core/market-rules";
import { readBars } from "../src/server/market/bar-store/read-bars";
import { corporateActions } from "../src/server/market/bar-store/corporate-actions";
import { captureLowZoneFinancials } from "../src/server/research/validation-financials";
import { readFinancialPoolHistory } from "../src/server/data-sources/tdx/local-financial-files";
import { captureNativeChanObservations } from "../src/server/strategies/strategy-center-native";
import {
  combinedBook,
  projectCandidate,
  scoreValidationResult,
  numericNeighbors,
  combinedLowZoneTargets,
} from "../src/server/research/validation-replay";
import { runPortfolio } from "quant-backtest";
import type {
  FrozenValidationInput,
  ValidationDataset,
} from "../src/server/research/validation-capture";
import type { ValidationUniverse } from "../src/server/research/validation-universe";
import {
  task,
  artifacts,
  build,
  digest,
  json,
  writeArtifact,
  readArtifact,
  updateDelivery,
  frozen,
  runFamily,
  readGroups,
  reportStage,
} from "./research-scale";

const codeHash = digest(await readFile(new URL(import.meta.url)));
const root = "E:\\new_tdx64";
const rpsHash =
  "e66c660f3ccca359c803a06743f6322ddc62d0e9bd825d32d33cf5996ad97bd4";
const rpsRoot = resolve(".test-data/r2a2/data/research-validation");
type RpsPackIndex = {
  root: string;
  blocks: Record<string, string>;
  inventory: {
    universe: ValidationUniverse;
    grouped: { eligible: string[]; nonCash: string[] };
  };
};
let packedCache:
  { name: string; blocks: { hash: string; text: string }[] } | undefined;
type RpsManifest = {
  version: string;
  inputChunks: string[];
  rankChunks: string[];
  dates: string[];
  calendar: string[];
  strategyBuildHash: string;
  universe: ValidationUniverse;
  executionEligible: number;
  sources: { symbol: string; hash: string }[];
};
async function rpsArtifact<T>(hash: string): Promise<T> {
  const packed = await readArtifact<RpsPackIndex>("rps-pack-index");
  if (packed) {
    if (hash === packed.root) {
      const text = (await readArtifact<string>("rps-root"))!;
      if (digest(text) !== hash) throw new Error("Frozen RPS root drift");
      return JSON.parse(text) as T;
    }
    const name = packed.blocks[hash];
    if (!name) throw new Error("RPS block missing from packed lineage");
    if (packedCache?.name !== name)
      packedCache = {
        name,
        blocks: (await readArtifact<{ hash: string; text: string }[]>(name))!,
      };
    const text = packedCache.blocks.find((b) => b.hash === hash)?.text;
    if (!text || digest(text) !== hash)
      throw new Error("Frozen RPS packed block drift");
    return JSON.parse(text) as T;
  }
  const bytes = await readFile(join(rpsRoot, `report-${hash}.json`));
  if (bytes.length > 256 * 1024 ** 2 || digest(bytes) !== hash)
    throw new Error("Frozen RPS artifact drift");
  return JSON.parse(bytes.toString()) as T;
}
const rps = await rpsArtifact<RpsManifest>(rpsHash);
const inventory =
  (await readArtifact<RpsPackIndex>("rps-pack-index"))?.inventory ??
  (await json<{
    universe: ValidationUniverse;
    grouped: { eligible: string[]; nonCash: string[] };
  }>(".test-data/r2a2/universe-inventory.json"));
// The broad strategy identity changed for low-zone/portfolio performance. The
// frozen ranks are inputs, not reinterpreted results; their actual calculator,
// adjustment source and lock must still match the accepted predecessor.
if (
  execFileSync(
    "git",
    [
      "diff",
      "2b72c99",
      "--",
      "packages/quant-rps",
      "packages/tstdx/src/local/gbbq.ts",
      "pnpm-lock.yaml",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim()
)
  throw new Error("Frozen RPS calculator/source lineage changed");
if (
  rps.executionEligible !== 1975 ||
  inventory.grouped.eligible.length !== 1975
)
  throw new Error("Preliminary universe mismatch");
type CompactInstrument = {
  symbol: string;
  columns: (string | number)[][];
  rps: (number | null)[];
  sourceHash: string;
  adjustmentReference: string | null;
  actions: PortfolioInstrument["actions"];
};
type EquityManifest = {
  build: string;
  codeHash: string;
  rpsHash: string;
  shards: string[];
  audit: {
    symbol: string;
    accepted: boolean;
    reason: string;
    first?: string;
    last?: string;
    bars?: number;
  }[];
  benchmark: Bar[];
  startedAt: string;
  elapsedMs: number;
  eligible: string[];
};
async function equityManifest() {
  const manifest = await readArtifact<EquityManifest>("equity-input");
  if (
    !manifest ||
    manifest.codeHash !== codeHash ||
    manifest.rpsHash !== rpsHash
  )
    throw new Error(
      "Equity input/code identity mismatch; capture before study",
    );
  return manifest;
}
function barsOf(instrument: CompactInstrument, signal: boolean): Bar[] {
  const offset = signal ? 7 : 1;
  return instrument.columns.map((r) => ({
    date: r[0] as string,
    open: r[offset] as number,
    high: r[offset + 1] as number,
    low: r[offset + 2] as number,
    close: r[offset + 3] as number,
    volume: r[offset + 4] as number,
    amount: r[offset + 5] as number,
  }));
}
function executionOf(
  symbol: string,
  bars: Bar[],
): PortfolioInstrument["execution"] {
  return Object.fromEntries(
    bars.map((bar, i) => {
      const rules = equityResearchRules(symbol, bar.date),
        previous = bars[i - 1]?.close;
      return [
        bar.date,
        {
          evidence: "Board-rule scenario; historical ST/IPO/queue unverified",
          minimum: rules.minimum,
          step: rules.step,
          tradable: bar.volume > 0,
          limitUp: previous
            ? Math.round(previous * (1 + rules.limit) * 100) / 100
            : null,
          limitDown: previous
            ? Math.round(previous * (1 - rules.limit) * 100) / 100
            : null,
        },
      ];
    }),
  );
}
type LowRecord = {
  symbol: string;
  facts: [string, number | null, number | null][];
  observations: LowZoneObservation[];
  provenance: unknown;
  coverage?: { start: string; end: string; observations: number };
  cycles?: ReturnType<typeof lowZoneCycles>;
};
type LowManifest = {
  codeHash: string;
  shards: string[];
  stocks: number;
  benchmark: LowRecord;
  elapsedMs: number;
  inputHash: string;
};
async function lowManifest() {
  const manifest = await readArtifact<LowManifest>("low-input");
  if (!manifest || manifest.codeHash !== codeHash)
    throw new Error("Low-zone frozen input identity mismatch");
  return manifest;
}
export async function loadEquity(family: string, subset?: string[]) {
  const manifest = await equityManifest();
  const instruments: PortfolioInstrument[] = [],
    sources: ValidationDataset["sources"] = [];
  const selected = subset && new Set(subset);
  const low =
    family === "historical-low" || family === "combined"
      ? await lowManifest()
      : null;
  const facts = new Map<string, LowZoneFact[]>();
  const zones: FrozenValidationInput["lowZones"] = [];
  if (low) {
    zones.push({
      symbol: "sh000300",
      observations: low.benchmark.observations,
    });
    for (const shard of low.shards) {
      for (const row of (await readArtifact<LowRecord[]>(shard))!) {
        if (
          !manifest.eligible.includes(row.symbol) ||
          (selected && !selected.has(row.symbol))
        )
          continue;
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
              "Frozen PIT-filtered local financial facts; source hashes and reports retained in low-zone shard; no first-vintage/temperature certification",
          })),
        );
        zones.push({ symbol: row.symbol, observations: row.observations });
      }
    }
  }
  for (const shard of manifest.shards) {
    for (const row of (await readArtifact<CompactInstrument[]>(shard))!) {
      if (selected && !selected.has(row.symbol)) continue;
      const bars = barsOf(row, false),
        signalBars = barsOf(row, true);
      const external: NonNullable<PortfolioInstrument["external"]> = {};
      if (family === "rps-multi" || family === "combined")
        external.rps = rps.dates.map((date, i) => ({
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
      if (low) external.lowZone = facts.get(row.symbol) ?? [];
      instruments.push({
        symbol: row.symbol,
        market: "cn-equity",
        bars,
        signalBars,
        execution: executionOf(row.symbol, bars),
        external,
        actions: row.actions,
      });
      sources.push({
        symbol: row.symbol,
        hash: digest(JSON.stringify([row.sourceHash, rpsHash, external])),
        adjustmentReference: row.adjustmentReference,
      });
    }
  }
  if (instruments.length !== (subset?.length ?? manifest.eligible.length))
    throw new Error("Equity shard count mismatch");
  const dataset: ValidationDataset = {
    period: "day",
    instruments,
    benchmark: manifest.benchmark,
    dates: rps.dates,
    sources,
    benchmarkName:
      "CSI300 raw price index; first evaluation open; no dividends",
  };
  const menu = researchCandidates(
    instruments.map((i) => i.symbol),
    "cn-equity",
  );
  const base = frozen("cn-equity", [dataset], menu);
  base.universe = rps.universe;
  base.lowZones = zones;
  base.selection =
    "R2a-2 1975 preliminary symbols; all terminal/repaired/lifecycle exclusions frozen before outcomes; cross-sectional ranks remain the 5564-stock frozen market";
  return { dataset, base };
}
const command =
  resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    ? process.argv[2]
    : "library";
if (command === "library") {
  // Read-only helpers for the final scoreboard join.
} else if (command === "rps-pack") {
  const packed: RpsPackIndex = { root: rpsHash, blocks: {}, inventory };
  await writeArtifact(
    "rps-root",
    await readFile(join(rpsRoot, `report-${rpsHash}.json`), "utf8"),
  );
  for (const [kind, hashes, size] of [
    ["source", rps.inputChunks, 10],
    ["rank", rps.rankChunks, 5],
  ] as const) {
    for (let index = 0; index < hashes.length; index += size) {
      const name = `rps-${kind}-${String(index / size).padStart(2, "0")}`;
      const blocks: { hash: string; text: string }[] = [];
      for (const hash of hashes.slice(index, index + size)) {
        const text = await readFile(
          join(rpsRoot, `report-${hash}.json`),
          "utf8",
        );
        if (digest(text) !== hash)
          throw new Error("RPS source changed while packing");
        blocks.push({ hash, text });
        packed.blocks[hash] = name;
      }
      await writeArtifact(name, blocks);
      console.log(
        JSON.stringify({ phase: "rps-pack", name, blocks: blocks.length }),
      );
    }
  }
  await writeArtifact("rps-pack-index", packed);
} else if (command === "capture") {
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r1a/data/bar-store",
  );
  const started = performance.now();
  const actions = await corporateActions(root);
  // The shared cache has no CSI300 input; read from the separately retained
  // r2a2 benchmark generation through BarStore, never the user's database.
  const benchmark = (
    await readBars({
      instrument: { market: "cn-equity", symbol: "sh000300" },
      root,
      period: "day",
      adjustment: "none",
      to: "2026-11-13",
    })
  ).bars;
  const saved = await readArtifact<EquityManifest>("equity-input");
  if (saved && saved.codeHash !== codeHash)
    throw new Error("Equity capture code changed");
  const manifest: EquityManifest = saved ?? {
    build,
    codeHash,
    rpsHash,
    shards: [],
    audit: [],
    benchmark: [...benchmark],
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    eligible: [],
  };
  await updateDelivery("cnSwing", {
    status: "auditing-terminal-coverage",
    preliminary: 1975,
  });
  for (const [chunkIndex, hash] of rps.rankChunks.entries()) {
    const name = `equity-${String(chunkIndex).padStart(2, "0")}`;
    if (manifest.shards.includes(name)) continue;
    const rankChunk = await rpsArtifact<{
      dates: string[];
      rows: { symbol: string; values: (number | null)[] }[];
    }>(hash);
    if (JSON.stringify(rankChunk.dates) !== JSON.stringify(rps.dates))
      throw new Error("RPS rank axes mismatch");
    const rows: CompactInstrument[] = [];
    for (const rank of rankChunk.rows) {
      const symbol = rank.symbol;
      try {
        if (!inventory.grouped.eligible.includes(symbol))
          throw new Error("Unexpected RPS execution symbol");
        const backward = await readBars({
          instrument: { market: "cn-equity", symbol },
          root,
          period: "day",
          adjustment: "backward",
          to: "2026-11-13",
        });
        if (
          backward.hash !== rps.sources.find((s) => s.symbol === symbol)?.hash
        )
          throw new Error(
            "Current prices no longer match the frozen full-market RPS source generation",
          );
        const snapshot = await readBars({
          instrument: { market: "cn-equity", symbol },
          root,
          period: "day",
          adjustment: "forward",
          freezeRaw: true,
          to: "2026-11-13",
        });
        if (snapshot.sourceNote)
          throw new Error(`Repaired/dropped source: ${snapshot.sourceNote}`);
        const signalBars = snapshot.bars;
        const raw = snapshot.rawBars!;
        const last = raw.at(-1)?.date,
          first = raw[0]?.date;
        if (last !== "2026-11-13")
          throw new Error(
            `Unverified terminal coverage: last observed ${last ?? "none"}; no proven settlement/terminal valuation`,
          );
        const member = rps.universe.members.find((m) => m.symbol === symbol);
        if (member?.delistingDate && member.delistingDate <= "2026-11-13")
          throw new Error("Known delisted member lacks settlement evidence");
        const events = (actions.events.get(symbol) ?? []).filter(
          (a) => a.date >= "2010-01-01" && a.date <= "2026-11-13",
        );
        if (
          events.some(
            (e) =>
              [11, 12, 13, 14].includes(e.category) ||
              (e.category === 1 &&
                ((e.bonusRatio ?? 0) > 0 || (e.rightsRatio ?? 0) > 0)),
          )
        )
          throw new Error("Unsupported/unproven non-cash action");
        if (
          raw.length !== signalBars.length ||
          raw.some((b, i) => b.date !== signalBars[i]!.date)
        )
          throw new Error("Unaligned raw/forward bars");
        rows.push({
          symbol,
          rps: rank.values,
          sourceHash: snapshot.hash,
          adjustmentReference: snapshot.barStore.adjustmentReference,
          columns: raw.map((b, i) => {
            const s = signalBars[i]!;
            return [
              b.date,
              b.open,
              b.high,
              b.low,
              b.close,
              b.volume,
              b.amount,
              s.open,
              s.high,
              s.low,
              s.close,
              s.volume,
              s.amount,
            ];
          }),
          actions: events
            .filter((a) => a.category === 1 && (a.dividend ?? 0) > 0)
            .map((a) => ({
              date: a.date,
              availableAt: a.date,
              dividend: a.dividend!,
              bonus: 0,
              evidence: `${actions.fingerprint}; ex-date cash scenario, not verified payment date`,
            })),
        });
        manifest.audit.push({
          symbol,
          accepted: true,
          reason:
            "Observed through common end; execution remains uncertified scenario",
          first,
          last,
          bars: raw.length,
        });
      } catch (error) {
        manifest.audit.push({
          symbol,
          accepted: false,
          reason: error instanceof Error ? error.message : "Unavailable source",
        });
      }
    }
    await writeArtifact(name, rows);
    manifest.shards.push(name);
    manifest.eligible = manifest.audit
      .filter((a) => a.accepted)
      .map((a) => a.symbol)
      .sort();
    manifest.elapsedMs = performance.now() - started;
    await writeArtifact("equity-input", manifest);
    await updateDelivery("cnSwing", {
      status: "auditing-terminal-coverage",
      audited: manifest.audit.length,
      accepted: manifest.eligible.length,
      excluded: manifest.audit.filter((a) => !a.accepted),
      elapsedMs: manifest.elapsedMs,
    });
    console.log(
      JSON.stringify({
        phase: "equity-capture",
        audited: manifest.audit.length,
        accepted: manifest.eligible.length,
        elapsedMs: manifest.elapsedMs,
      }),
    );
  }
  if (manifest.audit.length !== 1975)
    throw new Error("Terminal audit incomplete");
} else if (command === "swing") {
  const family = process.argv[3];
  if (
    ![
      "rps-multi",
      "double-breakout",
      "formula-ma",
      "formula-range",
      "formula-pullback",
    ].includes(family ?? "")
  )
    throw new Error("Pass one declared swing family");
  const { dataset, base } = await loadEquity(family!);
  await runFamily("cnSwing", dataset, base, family!);
  const groups = await readGroups("cnSwing");
  await reportStage("cnSwing", groups);
  await updateDelivery("cnSwing", {
    status:
      groups.reduce((n, g) => n + g.checkpoints.length, 0) === 45
        ? "complete-statistics-provisional"
        : "running",
    symbols: dataset.instruments.length,
  });
} else if (command === "low-capture") {
  const started = performance.now();
  const old = await readArtifact<LowManifest>("low-input");
  if (old && old.codeHash !== codeHash)
    throw new Error("Low-zone capture code changed");
  const symbols = rps.universe.members
    .filter((m) => /^sh|^sz/.test(m.symbol) && m.local)
    .map((m) => m.symbol);
  const pool = await readFinancialPoolHistory(root, symbols, {
    asOf: "2026-11-13",
    strict: true,
    limit: 160,
    fieldIds: [96, 271],
    progress: (done, total) => {
      if (done % 100 === 0)
        console.log(JSON.stringify({ phase: "financial-pool", done, total }));
    },
  });
  const manifest: LowManifest = old ?? {
    codeHash,
    shards: [],
    stocks: 0,
    benchmark: {
      symbol: "sh000300",
      facts: [],
      observations: historicalLowSeries((await equityManifest()).benchmark),
      provenance:
        "Frozen CSI300 price index; missing historical index PE/PB/temperature",
    },
    elapsedMs: 0,
    inputHash: rpsHash,
  };
  await updateDelivery("cnLowZone", {
    status: "freezing-all-market-detector",
    requested: 5564,
  });
  for (let index = 0; index < rps.inputChunks.length; index += 2) {
    const name = `low-${String(index / 2).padStart(2, "0")}`;
    if (manifest.shards.includes(name)) continue;
    const records: LowRecord[] = [];
    for (const hash of rps.inputChunks.slice(index, index + 2)) {
      const chunk = await rpsArtifact<{
        stocks: { symbol: string; closes: [string, number, number][] }[];
      }>(hash);
      for (const stock of chunk.stocks) {
        const bars = stock.closes.map(([date, close]) => ({ date, close }));
        let facts: LowZoneFact[] = [],
          provenance: unknown;
        try {
          const capture = await captureLowZoneFinancials(
            root,
            stock.symbol,
            bars.map((b) => b.date),
            pool,
          );
          facts = capture.facts;
          provenance = {
            seriesHash: capture.seriesHash,
            reports: capture.reports,
            issues: capture.issues,
            gaps: capture.gaps,
            boundary:
              "Frozen computed PIT facts; source GP16 content bound by SHA256, no temperature proxy",
          };
        } catch (error) {
          provenance = {
            missing:
              error instanceof Error
                ? error.message
                : "Unavailable local financials",
          };
        }
        const observations = historicalLowSeries(bars, {}, facts);
        records.push({
          symbol: stock.symbol,
          facts: facts.map((f) => [f.date, f.pe, f.pb]),
          observations: observations.filter(
            (o, i) =>
              i === 0 ||
              o.depth !== observations[i - 1]!.depth ||
              o.recovery !== observations[i - 1]!.recovery ||
              o.confidence !== observations[i - 1]!.confidence,
          ),
          coverage: {
            start: bars[0]!.date,
            end: bars.at(-1)!.date,
            observations: bars.length,
          },
          cycles: lowZoneCycles(observations),
          provenance,
        });
      }
    }
    await writeArtifact(name, records);
    manifest.shards.push(name);
    manifest.stocks += records.length;
    manifest.elapsedMs = performance.now() - started;
    await writeArtifact("low-input", manifest);
    await updateDelivery("cnLowZone", {
      status: "freezing-all-market-detector",
      stocks: manifest.stocks,
      elapsedMs: manifest.elapsedMs,
    });
    console.log(
      JSON.stringify({
        phase: "low-capture",
        stocks: manifest.stocks,
        elapsedMs: manifest.elapsedMs,
      }),
    );
  }
  if (manifest.stocks !== 5564)
    throw new Error("Full-market detector coverage incomplete");
} else if (command === "low") {
  const { dataset, base } = await loadEquity("historical-low");
  await runFamily("cnLowZone", dataset, base, "historical-low");
  const cycles = lowZoneCycles(
    (await lowManifest()).benchmark.observations,
  ).filter((c) => c.start >= "2010-01-01");
  const decisionCache = new Map();
  const evaluated = base.candidateMenu
    .filter((c) => c.family === "historical-low")
    .flatMap((c) => [c, ...numericNeighbors(c)])
    .map((candidate) => {
      const projected = projectCandidate(
        candidate,
        dataset,
        base,
        decisionCache,
      )!;
      return {
        id: candidate.strategy.id,
        cycles: cycles.map((cycle) => {
          const request = {
            ...projected.request,
            start: cycle.start,
            end: cycle.end,
          };
          return {
            ...cycle,
            score: scoreValidationResult(
              runPortfolio(request),
              request,
              dataset,
            ),
          };
        }),
      };
    });
  await writeArtifact("low-cycles", {
    marketCycles: evaluated,
    boundary:
      "Individual cycles are detector facts; qualifying market cycles use index timing. Price-only confidence never becomes corroborated.",
  });
  await reportStage("cnLowZone", await readGroups("cnLowZone"));
  const delivery = await json<Record<string, unknown>>(
    ".codex-runs/delivery.json",
  );
  delivery.lowZone = {
    detectorStocks: 5564,
    executableStocks: dataset.instruments.length,
    benchmarkCycles: cycles,
    strategyCycles: evaluated,
    confidence:
      "Historical market temperature missing; local financial revisions approximate",
    artifacts: (await lowManifest()).shards,
  };
  await writeFile(
    ".codex-runs/delivery.json",
    JSON.stringify(delivery, null, 2) + "\n",
  );
  await updateDelivery("cnLowZone", {
    status: "complete-statistics-provisional",
  });
} else if (command === "books") {
  const { dataset, base } = await loadEquity("combined");
  const a = projectCandidate(
    base.candidateMenu.find(
      (c) => c.family === "rps-multi" && c.variant === "atr",
    )!,
    dataset,
    base,
    new Map(),
  )!;
  const b = projectCandidate(
    base.candidateMenu.find(
      (c) => c.family === "historical-low" && c.variant === "atr",
    )!,
    dataset,
    base,
    new Map(),
  )!;
  const targets = combinedLowZoneTargets(base, a.request).filter(
    (t) => t.date >= a.request.start && t.date <= a.request.end,
  );
  const targetDays: Record<string, number> = {};
  for (const target of targets) {
    const share = String(target.shares["low-zone"]);
    targetDays[share] = (targetDays[share] ?? 0) + 1;
  }
  const book = {
    ...combinedBook(base, dataset, a.request, b.request),
    dynamicAllocation: {
      observedDays: targets.length,
      targetDays,
      rule: "Deepest available index or terminal-audited individual low-zone; idle cash only; targets are descriptive and not retuned after OOS",
    },
  };
  await writeArtifact("equity-books", book);
  const groups = await readGroups("cnLowZone");
  await reportStage("cnLowZone", groups, [book]);
  await updateDelivery("cnLowZone", {
    status: "complete-statistics-provisional",
  });
} else if (command === "native-capture") {
  const manifest = await equityManifest();
  const { dataset } = await loadEquity("chan-third-buy");
  const eligible = dataset.instruments
    .filter((i) => i.bars.findIndex((b) => b.date >= "2010-01-01") >= 140)
    .map((i) => i.symbol)
    .sort();
  // Dyadic breadth order is fixed from the terminal-audited roster before any
  // native strategy outcomes. Freeze completed usable members within 60min.
  const order: string[] = [];
  const queue: [number, number][] = [[0, eligible.length]];
  while (queue.length) {
    const [lo, hi] = queue.shift()!;
    if (lo >= hi) continue;
    const mid = Math.floor((lo + hi) / 2);
    order.push(eligible[mid]!);
    queue.push([lo, mid], [mid + 1, hi]);
  }
  const started = performance.now(),
    budget = 60 * 60000;
  const plan = {
    codeHash,
    order,
    source: manifest.eligible,
    selection:
      "Dyadic breadth-first indices of sorted audited symbols with 140-bar warmup; fixed before native outcomes",
    budgetMs: budget,
  };
  await writeArtifact("native-plan", plan);
  type Capture = FrozenValidationInput["native"][number] & {
    elapsedMs: number;
  };
  const captures: Capture[] =
    (await readArtifact<Capture[]>("native-input")) ?? [];
  const failed: { symbol: string; reason: string }[] = [];
  let spent = captures.reduce((n, c) => n + c.elapsedMs, 0);
  for (const symbol of order) {
    if (captures.some((c) => c.symbol === symbol)) continue;
    const remaining = budget - spent;
    if (remaining <= 0) break;
    const instrument = dataset.instruments.find((i) => i.symbol === symbol)!;
    const first = instrument.signalBars.findIndex(
      (b) => b.date >= "2010-01-01",
    );
    const begun = performance.now();
    try {
      const capture = await captureNativeChanObservations(
        instrument.signalBars.slice(first - 140),
        140,
        AbortSignal.timeout(Math.max(1, remaining)),
        undefined,
        (done, total) => {
          if (done % 1000 === 0)
            console.log(
              JSON.stringify({
                phase: "native",
                symbol,
                done,
                total,
                elapsedMs: performance.now() - begun,
              }),
            );
        },
      );
      const completed = {
        symbol,
        capture,
        elapsedMs: performance.now() - begun,
      };
      await writeArtifact("native-input", [...captures, completed]);
      captures.push(completed);
    } catch (error) {
      failed.push({
        symbol,
        reason: error instanceof Error ? error.message : "Native unavailable",
      });
    }
    spent += performance.now() - begun;
    await updateDelivery("chan", {
      status: "capturing",
      completed: captures.length,
      elapsedMs: spent,
      failed,
      plannedOrderHash: digest(JSON.stringify(order)),
      eligible: order.length,
    });
    if (spent >= budget) break;
  }
  const delivery = await json<Record<string, unknown>>(
    ".codex-runs/delivery.json",
  );
  delivery.chanSubset = {
    ...plan,
    completed: captures.map((c) => ({
      symbol: c.symbol,
      observations: c.capture.observations.length,
      elapsedMs: c.elapsedMs,
    })),
    failed,
    elapsedMs: spent,
    maximumBoundary:
      "Completed usable members of the predeclared order within one hour of serial capture, 256MiB single-file and task resource budgets; failures disclosed, not an absolute hardware capacity claim",
  };
  await writeFile(
    ".codex-runs/delivery.json",
    JSON.stringify(delivery, null, 2) + "\n",
  );
} else if (command === "chan") {
  const native =
    await readArtifact<FrozenValidationInput["native"]>("native-input");
  if (!native?.length) throw new Error("No completed native subset");
  const { dataset, base } = await loadEquity(
    "chan-third-buy",
    native.map((n) => n.symbol),
  );
  base.native = native;
  dataset.sources = dataset.sources.map((source) => ({
    ...source,
    hash: digest(
      JSON.stringify([
        source.hash,
        native.find((n) => n.symbol === source.symbol)!.capture,
      ]),
    ),
  }));
  await runFamily("chan", dataset, base, "chan-third-buy");
  await reportStage("chan", await readGroups("chan"));
  await updateDelivery("chan", {
    status: "complete-statistics-provisional",
    symbols: native.length,
  });
} else
  throw new Error(
    "Expected capture, swing <family>, low-capture, low, books, native-capture or chan",
  );
if (command !== "library") process.exit(0);
