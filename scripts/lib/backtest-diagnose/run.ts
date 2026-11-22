import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bar } from "trading-strategy-core/bars";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { StrategyObjectInput } from "trading-strategies";
import { settingsSchema } from "../../../src/lib/domain";
import { readBars } from "../../../src/server/market/bar-store/read-bars";
import {
  replayLabBacktest,
  type FrozenLabBacktest,
} from "../../../src/server/research/lab-backtest";
import { runDiagnostics } from "./diagnostics";
import {
  prepareDiagnoseRequest,
  BENCHMARK_CALENDAR_SYMBOL,
  type DiagnoseSourceQuality,
} from "./prepare-request";
import { writeReport } from "./report";
import {
  buildStrategy,
  planDiagnoseCells,
  warmupBarsFor,
  type StrategyKey,
} from "./strategy-specs";
import {
  emptyCounts,
  type DiagnoseCell,
  type DiagnoseLayer,
  type DiagnoseStatus,
} from "./types";

export type RunDiagnoseOptions = {
  symbols: string[];
  strategies: string[];
  controls: string[];
  mode: "per-symbol" | "portfolio" | "both";
  /**
   * `auto` starts per-symbol cells at first bar + strategy warmup and portfolio
   * cells at the latest first bar (the documented shared window).
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

function classifyError(error: unknown): {
  status: DiagnoseStatus;
  layer: DiagnoseLayer;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/GBBQ|公司行动|配股|除权|warrant|权证|entitlement/i.test(message))
    return { status: "blocked", layer: "gbbq" };
  if (/因果|复权|价格基|price basis/i.test(message))
    return { status: "blocked", layer: "causal-price" };
  if (
    /行情|数据|日历|缺少|缺失|无交易日|超出|未对齐|停牌|原价|Invalid portfolio|Invalid strategy bars|Raw \/ signal|基准日历/i.test(
      message,
    )
  )
    return { status: "blocked", layer: "data" };
  return { status: "failed", layer: "internal" };
}

type BarCache = Map<string, Bar[]>;

async function loadDaily(
  tdxRoot: string,
  end: string,
  symbol: string,
  cache: BarCache,
): Promise<Bar[]> {
  const cached = cache.get(symbol);
  if (cached) return cached;
  const snapshot = await readBars({
    instrument: { market: "cn-equity", symbol },
    root: tdxRoot,
    period: "day",
    adjustment: "none",
    to: end,
    live: false,
  });
  cache.set(symbol, snapshot.bars);
  return snapshot.bars;
}

/** Advance a start date to the benchmark's next trading day when absent. */
async function alignToBenchmark(
  date: string,
  tdxRoot: string,
  end: string,
  cache: BarCache,
) {
  const calendar = await loadDaily(
    tdxRoot,
    end,
    BENCHMARK_CALENDAR_SYMBOL,
    cache,
  );
  if (calendar.some((bar) => bar.date === date)) return date;
  const next = calendar.find((bar) => bar.date > date)?.date;
  if (!next)
    throw new Error(
      `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 在 ${date} 之后无交易日`,
    );
  return next;
}

async function resolveAutoStart(
  key: StrategyKey,
  symbols: readonly string[],
  mode: "per-symbol" | "portfolio",
  tdxRoot: string,
  end: string,
  cache: BarCache,
) {
  const warmup = warmupBarsFor(key);
  const series = await Promise.all(
    symbols.map((symbol) => loadDaily(tdxRoot, end, symbol, cache)),
  );
  // The portfolio window starts when the latest-listed member has bars, with
  // no extra warmup shift: every instrument keeps its pre-start bars, so the
  // strategy warms up on history the window does not score. Per-symbol windows
  // keep their own first observation plus the strategy warmup.
  if (mode === "portfolio") {
    const listed = series
      .map((bars) => bars[0]?.date)
      .filter((date): date is string => date !== undefined);
    if (!listed.length) throw new Error("自动起始日缺少本地日线");
    const latest = listed.reduce((a, b) => (b > a ? b : a));
    const start = await alignToBenchmark(latest, tdxRoot, end, cache);
    if (start >= end)
      throw new Error(`自动起始日 ${start} 不早于结束日 ${end}`);
    return start;
  }
  const reference = series[0]!;
  if (!reference?.length) throw new Error("自动起始日缺少本地日线");
  const index = Math.min(warmup, reference.length - 1);
  const start = reference[index]!.date;
  if (!start) throw new Error("自动起始日解析失败");
  if (start >= end) throw new Error(`自动起始日 ${start} 不早于结束日 ${end}`);
  return start;
}

type ArtifactContext = {
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
};

async function writeArtifacts(dir: string, context: ArtifactContext) {
  const { frozen, replay, strategyConfig } = context;
  const result = replay.result;
  const barCounts = Object.fromEntries(
    frozen.request.instruments.map((instrument) => [
      instrument.symbol,
      instrument.bars.length,
    ]),
  );
  await writeJson(join(dir, "run.json"), {
    generatedAt: new Date().toISOString(),
    mode: frozen.request.instruments.length > 1 ? "portfolio" : "per-symbol",
    strategyKey: strategyConfig.id,
    strategyConfig,
    symbols: frozen.request.instruments.map((i) => i.symbol),
    start: context.start,
    end: context.end,
    initial: context.initial,
    riskPerTrade: context.riskPerTrade,
    maxPositions: context.maxPositions,
    costScenario: context.costScenario,
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
    tdxRoot: string;
  },
) {
  await writeJson(join(dir, "run.json"), {
    generatedAt: new Date().toISOString(),
    strategyKey: context.strategyConfig.id,
    strategyConfig: context.strategyConfig,
    symbols: cell.symbols,
    start: context.start,
    end: context.end,
    initial: context.initial,
    costScenario: context.costScenario,
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

function rejectionReasons(replay: ReplayReturn) {
  const counts = new Map<string, number>();
  for (const rejection of replay.result.rejections)
    counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export async function runDiagnose(options: RunDiagnoseOptions) {
  const log = options.log ?? (() => {});
  if (!options.symbols.length) throw new Error("至少需要一个标的");
  if (new Set(options.symbols).size !== options.symbols.length)
    throw new Error("标的需要唯一");
  const config = settingsSchema.parse({ tdxRoot: options.tdxRoot });
  const planned = planDiagnoseCells({
    symbols: options.symbols,
    strategies: options.strategies,
    controls: options.controls,
    mode: options.mode,
  });
  const selected =
    options.limit !== undefined ? planned.slice(0, options.limit) : planned;
  if (!selected.length) throw new Error("没有可执行的诊断单元");
  const cache: BarCache = new Map();
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
      if (options.start === "auto")
        start = await resolveAutoStart(
          item.strategy,
          item.symbols,
          item.mode,
          options.tdxRoot,
          options.end,
          cache,
        );
      cell.start = start;
      cell.end = options.end;
      const strategyConfig = buildStrategy(
        item.strategy,
        item.symbols,
        item.mode === "portfolio" ? "portfolio" : "single",
      );
      log(
        `[${index + 1}/${selected.length}] ${item.mode}/${item.strategy}/${item.symbols.join("+")} ${start}~${options.end}`,
      );
      const { frozen, dataQuality } = await prepareDiagnoseRequest({
        strategy: strategyConfig,
        start,
        end: options.end,
        initial: options.initial,
        riskPerTrade,
        maxPositions,
        costScenario: options.cost,
        config,
        forceCausalPrice: item.strategy !== "hold",
      });
      const replay = replayLabBacktest(frozen);
      const diagnostics = runDiagnostics({
        request: frozen.request,
        frozen,
        replay,
      });
      await writeArtifacts(runPath, {
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
      });
      await writeJson(join(runPath, "diagnostics.json"), diagnostics);
      await writeJson(join(runPath, "summary.json"), {
        status: diagnostics.status,
        layer: diagnostics.layer,
        counts: diagnostics.counts,
        overview: replay.overview,
        findings: diagnostics.findings,
      });
      cell.status = diagnostics.status;
      cell.layer = diagnostics.layer;
      cell.counts = diagnostics.counts;
      cell.overview = replay.overview;
      cell.findings = diagnostics.findings;
      cell.checks = diagnostics.checks;
      cell.rejectionReasons = rejectionReasons(replay);
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
          tdxRoot: options.tdxRoot,
        });
      } catch {
        // Artifact failures must not abort the remaining cells.
      }
    }
    cells.push(cell);
  }
  const reportPath = await writeReport(options.outDir, cells);
  return { cells, reportPath };
}
