import { isDeepStrictEqual } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { StrategyObjectInput } from "trading-strategies";
import { readBars } from "../../market/bar-store/read-bars";
import { settingsSchema } from "~/lib/domain";
import type {
  replayLabBacktest,
  FrozenLabBacktest,
  LabExecutionProfile,
} from "../lab-backtest";
import {
  classifyError,
  prepareDiagnoseCell,
  replayDiagnoseCell,
  type DiagnosePreparationOptions,
  type DiagnoseMarketCache,
} from "./cell";
export { resolveAutoStart } from "./cell";
import {
  BENCHMARK_CALENDAR_SYMBOL,
  prepareDiagnoseRequest,
  type DiagnoseSourceQuality,
} from "./prepare-request";
import { decomposeChanZdImpact, NATIVE_CHAN_ZD_STOP_KEY } from "./chan-native";
import {
  DEFAULT_HOLDOUT_START,
  runDiagnoseFamilyTimeHoldout,
  type DiagnoseFamilyCandidate,
} from "./time-holdout";
import { writeReport } from "./report";
import {
  buildDiagnoseCellStrategies,
  DIAGNOSE_BOOK_PRESETS,
  planDiagnoseCells,
  resolveDiagnoseFamily,
  type DiagnoseBookKey,
} from "./strategy-specs";
import {
  emptyCounts,
  type StrategyDisclosures,
  type BookControl,
  type DiagnoseComparison,
  type DiagnoseCell,
  type UniversePoolDisclosure,
} from "./types";

export type RunDiagnoseOptions = DiagnosePreparationOptions & {
  book?: DiagnoseBookKey;
  family?: string;
  bookControl?: BookControl;
  holdoutStart?: string;
  symbols: string[];
  pool?: UniversePoolDisclosure;
  strategies: string[];
  controls: string[];
  mode: "per-symbol" | "portfolio" | "both";
  /**
   * `auto` starts per-symbol cells at first bar + strategy warmup and portfolio
   * cells at the first warmup-ready member on the benchmark clock.
   */
  start: string;
  end: string;
  tdxRoot: string;
  initial: number;
  cost: ResearchCostScenario;
  outDir: string;
  limit?: number;
  riskPerTrade?: number;
  maxPositions?: number;
  executionProfile?: LabExecutionProfile;
  maxParticipation?: number;
  capacityPolicy?: "clip" | "reject";
  log?: (line: string) => void;
};

type ReplayReturn = ReturnType<typeof replayLabBacktest>;

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: readonly string[], rows: readonly unknown[][]) {
  return [
    header.map(csvValue).join(","),
    ...rows.map((row) => row.map(csvValue).join(",")),
  ]
    .join("\n")
    .concat("\n");
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

type ArtifactContext = {
  book?: DiagnoseBookKey;
  mode: DiagnoseCell["mode"];
  symbols: string[];
  marketInstruments: FrozenLabBacktest["request"]["instruments"];
  strategyConfig: StrategyObjectInput;
  frozen: FrozenLabBacktest;
  replay: ReplayReturn;
  dataQuality: DiagnoseSourceQuality[];
  tdxRoot: string;
  start: string;
  end: string;
  initial: number;
  riskPerTrade: number;
  maxPositions: number;
  costScenario: ResearchCostScenario;
  disclosures: StrategyDisclosures;
  pool?: UniversePoolDisclosure;
};

async function writeArtifacts(dir: string, context: ArtifactContext) {
  const { frozen, replay, strategyConfig } = context;
  // The frozen request may have rewritten the strategy (for example an
  // explicit --start updates firstIndex); record what was actually replayed.
  const effectiveStrategy = frozen.request.strategies[0] ?? strategyConfig;
  const result = replay.result;
  const barCounts = Object.fromEntries(
    context.marketInstruments.map((instrument) => [
      instrument.symbol,
      instrument.bars.length,
    ]),
  );
  await writeJson(join(dir, "run.json"), {
    generatedAt: new Date().toISOString(),
    mode: context.mode,
    ...(context.book
      ? {
          strategyKey: context.book,
          strategies: frozen.request.strategies,
          sleeves: frozen.request.sleeves,
          rebalance: frozen.request.rebalance,
          sleeveTargets: frozen.request.sleeveTargets,
          accountMaxUniqueSymbols: frozen.request.accountMaxUniqueSymbols,
          accountMaxSymbolWeight: frozen.request.accountMaxSymbolWeight,
          collectDailyDecisionCounts: frozen.request.collectDailyDecisionCounts,
        }
      : {
          strategyKey: effectiveStrategy.id,
          strategyConfig: effectiveStrategy,
        }),
    symbols: context.symbols,
    ...(context.symbols.length !== frozen.request.instruments.length && {
      executableSymbols: frozen.request.instruments.map((i) => i.symbol),
    }),
    pool: context.pool,
    start: context.start,
    end: context.end,
    initial: context.initial,
    riskPerTrade: context.riskPerTrade,
    maxPositions: context.maxPositions,
    costScenario: context.costScenario,
    executionProfile: frozen.executionProfile ?? "strict",
    maxParticipation: frozen.maxParticipation ?? null,
    capacityPolicy: frozen.capacityPolicy ?? null,
    tdxRoot: context.tdxRoot,
    dataAsOf: [
      ...new Set(
        context.dataQuality
          .map((row) => row.dataAsOf)
          .filter((value): value is string => value !== null),
      ),
    ],
    barCounts,
    signalBasis: frozen.marketPolicy.signalBars,
    corporateActionCoverage: frozen.corporateActionCoverage,
    sources: context.dataQuality,
    ...context.disclosures,
    timingStatus: replay.timingStatus,
    // Recorded metadata only; never compared or enforced in this path.
    inputHash: replay.inputHash,
  });
  await writeJson(join(dir, "positions.json"), result.positions);
  await writeFile(
    join(dir, "orders.csv"),
    toCsv(
      [
        "id",
        "strategyId",
        "sleeve",
        "symbol",
        "side",
        "signalAt",
        "due",
        "status",
        "reason",
        "attempts",
        "trigger",
      ],
      result.orders.map((order) => [
        order.id,
        order.strategyId,
        order.sleeve,
        order.symbol,
        order.side,
        order.signalAt,
        order.due,
        order.status,
        order.reason,
        order.attempts,
        order.trigger,
      ]),
    ),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(dir, "fills.csv"),
    toCsv(
      [
        "orderId",
        "strategyId",
        "sleeve",
        "symbol",
        "side",
        "signalAt",
        "date",
        "price",
        "quantity",
        "fee",
        "cashAfter",
        "holdingAfter",
        "capacityClipped",
      ],
      result.fills.map((fill) => [
        fill.orderId,
        fill.strategyId,
        fill.sleeve,
        fill.symbol,
        fill.side,
        fill.signalAt,
        fill.date,
        fill.price,
        fill.quantity,
        fill.fee,
        fill.cashAfter,
        fill.holdingAfter,
        fill.capacityClipped === true,
      ]),
    ),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(dir, "rejections.csv"),
    toCsv(
      ["orderId", "date", "reason"],
      result.rejections.map((row) => [row.orderId, row.date, row.reason]),
    ),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(dir, "equity.csv"),
    toCsv(
      ["date", "cash", "equity"],
      result.curve.map((row) => [row.date, row.cash, row.equity]),
    ),
    { encoding: "utf8", flag: "wx" },
  );
  const barRows: unknown[][] = [];
  for (const instrument of context.marketInstruments)
    instrument.bars.forEach((bar, index) =>
      barRows.push([
        bar.date,
        instrument.symbol,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.amount,
        instrument.signalBars[index]?.close ?? "",
      ]),
    );
  await writeFile(
    join(dir, "bars.csv"),
    toCsv(
      [
        "date",
        "symbol",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "amount",
        "signalClose",
      ],
      barRows,
    ),
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeErrorArtifacts(
  dir: string,
  cell: DiagnoseCell,
  message: string,
  context: {
    strategies: StrategyObjectInput[];
    start: string;
    end: string;
    initial: number;
    costScenario: ResearchCostScenario;
    executionProfile: LabExecutionProfile;
    maxParticipation: number | null;
    capacityPolicy: "clip" | "reject" | null;
    tdxRoot: string;
    pool?: UniversePoolDisclosure;
  },
) {
  await writeJson(join(dir, "run.json"), {
    generatedAt: new Date().toISOString(),
    strategyKey:
      context.strategies.length > 1 ? cell.strategy : context.strategies[0]!.id,
    mode: cell.mode,
    ...(context.strategies.length > 1
      ? { strategies: context.strategies }
      : { strategyConfig: context.strategies[0] }),
    symbols: cell.symbols,
    pool: context.pool,
    start: context.start,
    end: context.end,
    initial: context.initial,
    costScenario: context.costScenario,
    executionProfile: context.executionProfile,
    maxParticipation: context.maxParticipation,
    capacityPolicy: context.capacityPolicy,
    tdxRoot: context.tdxRoot,
    status: cell.status,
    layer: cell.layer,
    error: message,
  });
  await writeJson(join(dir, "summary.json"), {
    status: cell.status,
    layer: cell.layer,
    error: message,
    counts: cell.counts,
    pool: context.pool,
  });
  await writeJson(join(dir, "diagnostics.json"), {
    status: cell.status,
    layer: cell.layer,
    counts: cell.counts,
    checks: [
      {
        id: "cellError",
        status: cell.status === "failed" ? "fail" : "warn",
        message,
      },
    ],
    findings: [message],
  });
  await writeJson(join(dir, "positions.json"), []);
  for (const name of ["orders", "fills", "rejections", "equity", "bars"])
    await writeFile(join(dir, `${name}.csv`), "", {
      encoding: "utf8",
      flag: "wx",
    });
}

type ComparisonInput = {
  calendar?: readonly string[];
  candidate: DiagnoseFamilyCandidate;
  benchmark: Awaited<
    ReturnType<typeof prepareDiagnoseRequest>
  >["benchmarkBars"];
  ledger?: Parameters<typeof decomposeChanZdImpact>[0];
};
const ch14 = "research-chan-hold-cash";

/** Each strategy freezes its own signal inputs. Prices, actions and certified
 * trading sessions must come from the same market snapshot for a comparison. */
function sameMarketEvidence(
  left: ComparisonInput,
  right: ComparisonInput,
  before?: string,
) {
  const prefix = <T>(rows: readonly T[] | undefined, date: (r: T) => string) =>
    before ? (rows?.filter((row) => date(row) < before) ?? []) : rows;
  const visible = ({ candidate }: ComparisonInput) =>
    before
      ? candidate.request.instruments.filter((i) =>
          i.bars.some((bar) => bar.date < before),
        )
      : candidate.request.instruments;
  const a = visible(left),
    b = visible(right);
  return (
    isDeepStrictEqual(
      prefix(left.benchmark, (b) => b.date),
      prefix(right.benchmark, (b) => b.date),
    ) &&
    a.length === b.length &&
    a.every((instrument, index) => {
      const peer = b[index]!;
      return (
        instrument.symbol === peer.symbol &&
        isDeepStrictEqual(
          prefix(instrument.bars, (b) => b.date),
          prefix(peer.bars, (b) => b.date),
        ) &&
        isDeepStrictEqual(
          prefix(instrument.signalBars, (b) => b.date),
          prefix(peer.signalBars, (b) => b.date),
        ) &&
        isDeepStrictEqual(
          prefix(instrument.actions, (b) => b.date),
          prefix(peer.actions, (b) => b.date),
        ) &&
        isDeepStrictEqual(
          prefix(instrument.certifiedSuspensions, (b) => b.resumptionDate),
          prefix(peer.certifiedSuspensions, (b) => b.resumptionDate),
        )
      );
    })
  );
}

function compareRuns(
  cells: DiagnoseCell[],
  inputs: Map<string, ComparisonInput>,
  family: string | undefined,
  members: string[],
  holdoutStart: string | undefined,
): DiagnoseComparison {
  const { mode, symbols } = cells[0]!;
  const comparison: DiagnoseComparison = { mode, symbols, family };
  const first = inputs.get(ch14),
    zd = inputs.get(NATIVE_CHAN_ZD_STOP_KEY);
  if (
    first?.ledger &&
    zd?.ledger &&
    first.candidate.request.start === zd.candidate.request.start &&
    sameMarketEvidence(first, zd)
  )
    comparison.chanZdImpact = decomposeChanZdImpact(first.ledger, zd.ledger);
  if (!family) return comparison;
  const unavailable = members
    .filter((id) => !inputs.has(id))
    .map(
      (id) =>
        `${id}: ${cells.find((c) => c.strategy === id)?.findings.join("；") || "未运行"}`,
    );
  if (unavailable.length) return { ...comparison, unavailable };
  const anchor = inputs.get(members[0]!)!;
  const { request } = anchor.candidate;
  const dates =
    anchor.calendar ??
    request.calendar.filter(
      (day) => day >= request.start && day <= request.end,
    );
  const cut = holdoutStart ?? DEFAULT_HOLDOUT_START;
  if (members.some((id) => !sameMarketEvidence(inputs.get(id)!, anchor, cut)))
    return {
      ...comparison,
      unavailable: ["候选开发段行情、公司行动或停牌证据快照不一致"],
    };
  const complete = members
    .map((id) => inputs.get(id)!)
    .filter((i) => i.candidate.holdoutFailure === undefined);
  const mixedHoldout = complete.some(
    (i) => !sameMarketEvidence(i, complete[0]!),
  );
  comparison.familyHoldout = runDiagnoseFamilyTimeHoldout(
    [...inputs.values()].map(({ candidate }) =>
      mixedHoldout && candidate.holdoutFailure === undefined
        ? {
            ...candidate,
            holdoutFailure: "候选留出段行情、公司行动或停牌证据快照不一致",
          }
        : candidate,
    ),
    {
      family,
      candidateId: members[0]!,
      dates,
      benchmark: anchor.benchmark,
      holdoutStart,
    },
  );
  return comparison;
}

export async function runDiagnose(
  options: RunDiagnoseOptions,
  prepare = prepareDiagnoseRequest,
) {
  const log = options.log ?? (() => {});
  // Long native captures walk every causal prefix; heartbeat every 1,000
  // prefixes and on completion so a silent run is distinguishable from a hang.
  const nativeProgress = (symbol: string, done: number, total: number) => {
    if (done >= total || done % 1000 === 0)
      log(`    原生缠论 ${symbol} 前缀 ${done}/${total}`);
  };
  if (!options.symbols.length) throw new Error("至少需要一个标的");
  if (new Set(options.symbols).size !== options.symbols.length)
    throw new Error("标的需要唯一");
  const config = settingsSchema.parse({ tdxRoot: options.tdxRoot });
  const bookPreset = options.book
    ? DIAGNOSE_BOOK_PRESETS[options.book]
    : undefined;
  const executionProfile = options.executionProfile ?? "strict";
  const maxParticipation =
    options.maxParticipation ?? bookPreset?.maxParticipation ?? null;
  const capacityPolicy =
    maxParticipation === null
      ? null
      : (options.capacityPolicy ?? bookPreset?.capacityPolicy ?? null);
  if (options.bookControl && options.bookControl !== "none" && !options.book)
    throw new Error("--book-control 需要 --book");
  const planned = planDiagnoseCells({
    family: options.family,
    book: options.book,
    symbols: options.symbols,
    strategies: options.strategies,
    controls: options.controls,
    mode: options.mode,
  });
  const selected =
    options.limit !== undefined ? planned.slice(0, options.limit) : planned;
  if (!selected.length) throw new Error("没有可执行的诊断单元");
  const marketCache: DiagnoseMarketCache = {};
  const cells: DiagnoseCell[] = [];
  const createdDirs = new Set<string>();
  const comparisons: DiagnoseComparison[] = [];
  const members: string[] = options.family
    ? resolveDiagnoseFamily(options.family)
    : [];
  const compareZd =
    planned.some((i) => i.strategy === ch14) &&
    planned.some((i) => i.strategy === NATIVE_CHAN_ZD_STOP_KEY);
  // Keep at most one symbol group of frozen portfolios in memory.
  const groups = new Map<string, typeof selected>();
  for (const item of selected) {
    const key =
      members.length || compareZd
        ? JSON.stringify([item.mode, item.symbols])
        : "";
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const inputs = new Map<string, ComparisonInput>();
    const groupStart = cells.length;
    for (const item of group) {
      const index = cells.length;
      const leaf = item.mode === "portfolio" ? "all" : item.symbols[0]!;
      if (
        !/^[a-z0-9_-]+$/i.test(leaf) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(leaf)
      )
        throw new Error(`非法标的目录名：${leaf}`);
      let runPath = options.outDir;
      for (const component of [item.mode, item.strategy]) {
        runPath = join(runPath, component);
        if (!createdDirs.has(runPath)) {
          await mkdir(runPath);
          createdDirs.add(runPath);
        }
      }
      runPath = join(runPath, leaf);
      await mkdir(runPath);
      const cell: DiagnoseCell = {
        strategy: item.strategy,
        symbols: item.symbols,
        mode: item.mode,
        status: "failed",
        runPath,
        counts: emptyCounts(),
        findings: [],
      };
      const riskPerTrade = options.riskPerTrade ?? 0.02;
      const maxPositions = options.maxPositions ?? item.symbols.length;
      let start = options.start;
      const prepareThrough = (end: string, developmentRetry = false) =>
        prepareDiagnoseCell(
          item,
          {
            ...options,
            end,
            retryFullEnd:
              developmentRetry && item.symbols.length > 1
                ? options.end
                : undefined,
            config,
            riskPerTrade,
            maxPositions,
            nativeCacheDir:
              options.nativeCacheDir ?? join(options.outDir, "native-cache"),
            nativeProgress,
          },
          marketCache,
          prepare,
        );
      let familyBenchmark: ComparisonInput["benchmark"];
      try {
        const prepared = await prepareThrough(options.end);
        familyBenchmark = prepared.benchmarkBars;
        const { strategyConfig, dataQuality } = prepared;
        start = prepared.frozen.request.start;
        cell.start = start;
        cell.end = options.end;
        log(
          `[${index + 1}/${selected.length}] ${item.mode}/${item.strategy}/${item.symbols.join("+")} ${start}~${options.end}`,
        );
        const { frozen, replay, diagnostics, disclosures, reasons } =
          replayDiagnoseCell(
            prepared,
            options.family ? { ...options, holdoutStart: undefined } : options,
          );
        const { counts } = diagnostics;
        await writeArtifacts(runPath, {
          book: item.strategy === options.book ? options.book : undefined,
          mode: item.mode,
          symbols: item.symbols,
          marketInstruments: prepared.frozen.request.instruments,
          strategyConfig,
          frozen,
          replay,
          dataQuality,
          tdxRoot: options.tdxRoot,
          start,
          end: options.end,
          initial: options.initial,
          riskPerTrade,
          maxPositions,
          costScenario: options.cost,
          disclosures,
          pool: options.pool,
        });
        await writeJson(join(runPath, "diagnostics.json"), {
          ...diagnostics,
          counts,
        });
        await writeJson(join(runPath, "summary.json"), {
          status: diagnostics.status,
          layer: diagnostics.layer,
          counts,
          overview: replay.overview,
          findings: diagnostics.findings,
          pool: options.pool,
          ...disclosures,
        });
        Object.assign(cell, disclosures);
        cell.status = diagnostics.status;
        cell.layer = diagnostics.layer;
        cell.counts = counts;
        cell.overview = replay.overview;
        cell.findings = diagnostics.findings;
        cell.checks = diagnostics.checks;
        cell.rejectionReasons = reasons;
        const paired =
          compareZd &&
          (item.strategy === ch14 || item.strategy === NATIVE_CHAN_ZD_STOP_KEY);
        if (
          diagnostics.status === "ok" &&
          (members.includes(item.strategy) ||
            (item.strategy === "hold" && options.family) ||
            paired)
        ) {
          const { orders, fills, rejections, corporateActions } = replay.result;
          inputs.set(item.strategy, {
            candidate: {
              id: item.strategy,
              request: frozen.request,
              role: item.strategy === "hold" ? "hold" : "base",
            },
            benchmark: prepared.benchmarkBars,
            ledger: paired
              ? { orders, fills, rejections, corporateActions }
              : undefined,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const classified = classifyError(error);
        cell.status = classified.status;
        cell.layer = classified.layer;
        cell.error = message;
        cell.findings = [message];
        log(`    阻断：${message}`);
        try {
          await writeErrorArtifacts(runPath, cell, message, {
            strategies: buildDiagnoseCellStrategies(item),
            start: cell.start ?? options.start,
            end: options.end,
            initial: options.initial,
            costScenario: options.cost,
            executionProfile,
            maxParticipation,
            capacityPolicy,
            tdxRoot: options.tdxRoot,
            pool: options.pool,
          });
        } catch {
          // Artifact failures must not abort the remaining cells.
        }
      }
      // Verify the prefix independently if the full cell could not certify it.
      // A genuine development failure still excludes the candidate.
      const cut = options.holdoutStart ?? DEFAULT_HOLDOUT_START;
      if (
        cell.status !== "ok" &&
        members.includes(item.strategy) &&
        cut <= options.end
      ) {
        try {
          const end = new Date(Date.parse(cut) - 86_400_000)
            .toISOString()
            .slice(0, 10);
          const prefix = await prepareThrough(end, true);
          const dev = replayDiagnoseCell(prefix, {
            ...options,
            holdoutStart: undefined,
          });
          if (dev.diagnostics.status !== "ok")
            throw new Error(dev.diagnostics.findings.join("；"));
          const benchmark =
            familyBenchmark ??
            (
              await (options.read ?? readBars)({
                instrument: {
                  market: "cn-equity",
                  symbol: BENCHMARK_CALENDAR_SYMBOL,
                },
                period: "day",
                adjustment: "none",
                root: options.tdxRoot,
                to: options.end,
                live: false,
              })
            ).bars;
          // Keep the real observation axis. No post-cut instrument evidence
          // is supplied by the verified prefix.
          const calendar = benchmark
            .map((b) => b.date)
            .filter((d) => d >= dev.frozen.request.start && d <= options.end);
          inputs.set(item.strategy, {
            candidate: {
              id: item.strategy,
              role: "base",
              holdoutFailure: [
                cell.error ?? cell.findings.join("；"),
                ...(prefix.excludedSymbols.length
                  ? [
                      `开发段无切点前行情，排除标的：${prefix.excludedSymbols.join(", ")}`,
                    ]
                  : []),
              ].join("；"),
              request: dev.frozen.request,
            },
            calendar,
            benchmark,
          });
        } catch (error) {
          cell.findings.push(
            `开发段复核失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      cells.push(cell);
    }
    if (
      options.family ||
      (inputs.has(ch14) && inputs.has(NATIVE_CHAN_ZD_STOP_KEY))
    )
      comparisons.push(
        compareRuns(
          cells.slice(groupStart),
          inputs,
          options.family,
          members,
          options.holdoutStart,
        ),
      );
  }
  const reportPath = await writeReport(
    options.outDir,
    cells,
    options.pool,
    comparisons,
  );
  return { cells, comparisons, reportPath };
}
