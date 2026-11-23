import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { StrategyObjectInput } from "trading-strategies";
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
  prepareDiagnoseRequest,
  type DiagnoseSourceQuality,
} from "./prepare-request";
import { writeReport } from "./report";
import { buildStrategy, planDiagnoseCells } from "./strategy-specs";
import {
  emptyCounts,
  type StrategyDisclosures,
  type DiagnoseCell,
  type UniversePoolDisclosure,
} from "./types";

export type RunDiagnoseOptions = DiagnosePreparationOptions & {
  symbols: string[];
  pool?: UniversePoolDisclosure;
  strategies: string[];
  controls: string[];
  mode: "per-symbol" | "portfolio" | "both";
  /**
   * `auto` starts per-symbol cells at first bar + strategy warmup and portfolio
   * cells at the latest listing date, or the latest warmup-ready date for native Chan.
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
  mode: DiagnoseCell["mode"];
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
    frozen.request.instruments.map((instrument) => [
      instrument.symbol,
      instrument.bars.length,
    ]),
  );
  await writeJson(join(dir, "run.json"), {
    generatedAt: new Date().toISOString(),
    mode: context.mode,
    strategyKey: effectiveStrategy.id,
    strategyConfig: effectiveStrategy,
    symbols: frozen.request.instruments.map((i) => i.symbol),
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
  for (const instrument of frozen.request.instruments)
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
    strategyConfig: StrategyObjectInput;
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
    strategyKey: context.strategyConfig.id,
    mode: cell.mode,
    strategyConfig: context.strategyConfig,
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
  const executionProfile = options.executionProfile ?? "strict";
  const maxParticipation = options.maxParticipation ?? null;
  const capacityPolicy = options.capacityPolicy ?? null;
  const planned = planDiagnoseCells({
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
  for (const [index, item] of selected.entries()) {
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
    try {
      const prepared = await prepareDiagnoseCell(
        item,
        {
          ...options,
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
      const { strategyConfig, dataQuality } = prepared;
      start = prepared.frozen.request.start;
      cell.start = start;
      cell.end = options.end;
      log(
        `[${index + 1}/${selected.length}] ${item.mode}/${item.strategy}/${item.symbols.join("+")} ${start}~${options.end}`,
      );
      const { frozen, replay, diagnostics, disclosures, reasons } =
        replayDiagnoseCell(prepared, options);
      const { counts } = diagnostics;
      await writeArtifacts(runPath, {
        mode: item.mode,
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
          strategyConfig: buildStrategy(
            item.strategy,
            item.symbols,
            item.mode === "portfolio" ? "portfolio" : "single",
          ),
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
    cells.push(cell);
  }
  const reportPath = await writeReport(options.outDir, cells, options.pool);
  return { cells, reportPath };
}
