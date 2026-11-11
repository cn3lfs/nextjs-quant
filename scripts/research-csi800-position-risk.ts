import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import {
  csiPriceSchema,
  classicPanelSchema,
  csiHash,
} from "./lib/csi800-factor-data.js";
import { classicCodeHashes } from "./lib/csi800-research-manifest.js";
import { csi800TradeEvaluation } from "./lib/csi800-trade-evaluation.js";
import { buildClassicSchedule } from "../packages/trading-strategies/src/csi800-composite.js";
import { csi800SignalBars } from "../packages/trading-strategies/src/csi800-signal.js";
import { runCsi800Study } from "../packages/quant-backtest/src/csi800-study.js";
import type { PositionRiskStage } from "../packages/trading-strategies/src/csi800-position-risk.js";
import { evaluatePerformance, performancePeriods } from "quant-performance";

// Only reads frozen research inputs. No application/DB imports or external data fetch.
if (!process.env.QUANT_DATA_DIR || !process.argv[2] || !process.argv[3])
  throw new Error(
    "设置隔离QUANT_DATA_DIR，并传入冻结多因子目录、已有五家族波动率基线JSON",
  );
const source = resolve(process.argv[2]),
  baselinePath = resolve(process.argv[3]),
  out = resolve(process.env.QUANT_DATA_DIR);
if (out === source || out === resolve(source, ".."))
  throw new Error("输出必须使用新的独立目录");
const startedAt = new Date().toISOString();
const codeHashes = async () => ({
  ...(await classicCodeHashes()),
  ["scripts/research-csi800-position-risk.ts"]: csiHash(
    await readFile("scripts/research-csi800-position-risk.ts"),
  ),
});
const before = await codeHashes();
const manifest = z
  .object({
    commonStart: z.string(),
    firstSignal: z.string(),
    inputs: z.object({
      pricePath: z.string(),
      priceHash: z.string(),
      financial: z.object({ path: z.string(), fileHash: z.string() }),
    }),
    panel: z.object({
      path: z.string(),
      fileHash: z.string(),
      contentHash: z.string(),
    }),
  })
  .parse(JSON.parse(await readFile(join(source, "manifest.json"), "utf8")));
const [rawPrices, compressed, financial, baselineBytes] = await Promise.all([
  readFile(manifest.inputs.pricePath),
  readFile(manifest.panel.path),
  readFile(manifest.inputs.financial.path),
  readFile(baselinePath),
]);
if (
  csiHash(rawPrices) !== manifest.inputs.priceHash ||
  csiHash(compressed) !== manifest.panel.fileHash ||
  csiHash(financial) !== manifest.inputs.financial.fileHash
)
  throw new Error("冻结输入hash不匹配");
const rawPanel = gunzipSync(compressed);
if (csiHash(rawPanel) !== manifest.panel.contentHash)
  throw new Error("面板解压hash不匹配");
const price = csiPriceSchema.parse(JSON.parse(rawPrices.toString("utf8"))),
  weeks = classicPanelSchema.parse(JSON.parse(rawPanel.toString("utf8")));
const baseline = z
  .object({
    curve: z.array(
      z.object({
        date: z.string(),
        equity: z.number(),
        cash: z.number(),
        exposure: z.number(),
        holdings: z.number(),
      }),
    ),
  })
  .parse(JSON.parse(baselineBytes.toString("utf8")));
const calendar = price.benchmark.map((b) => b.date),
  indices = new Map(calendar.map((d, i) => [d, i]));
const closes = new Map(
  price.stocks.map((s) => [
    s.symbol,
    new Map(csi800SignalBars(s).map((b) => [b.date, b.close])),
  ]),
);
const riskAt = (symbol: string, date: string) => {
  const i = indices.get(date),
    rows = closes.get(symbol);
  if (i === undefined || i < 60 || !rows) return null;
  const values = calendar.slice(i - 60, i + 1).map((d) => rows.get(d));
  return values.some((v) => v === undefined || !(v > 0))
    ? null
    : values.slice(1).map((v, j) => v! / values[j]! - 1);
};
const schedule = buildClassicSchedule(
  weeks,
  {
    model: "classic-five",
    risk: "volatility",
    startSignal: manifest.firstSignal,
  },
  riskAt,
);
const targetHash = csiHash(JSON.stringify(schedule.allocations));
await mkdir(out); // Must not overwrite any existing run directory.
const metadata = {
  version: "csi800-position-risk-research-4",
  protection: "ema50-current-close",
  entryFilter: "signal-close-and-last-close-and-open-at-or-above-known-ema50",
  startedAt,
  source,
  inputs: manifest.inputs,
  panel: manifest.panel,
  baseline: { path: baselinePath, hash: csiHash(baselineBytes) },
  period: [manifest.commonStart, price.end],
  targetHash,
  codeHashes: before,
  note: "EMA50 replaces ATR protection; current EMA may fall and is not a ratcheted maximum. Retrospective current-CSI800-pool rule check; survivorship ignored by user; same-close risk confirmation/fill assumed; fees and T+1 retained; no stop-threshold optimization; no Elliott filter.",
};
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify({ ...metadata, status: "running" }, null, 2),
);
await writeFile(
  join(out, "targets.json.gz"),
  gzipSync(JSON.stringify(schedule)),
);
const summaries = [];
for (const stage of [
  "baseline",
  "initial",
  "breakeven",
  "partial",
  "full",
] as const) {
  console.log("position-risk stage", stage);
  const result = runCsi800Study(
    price.stocks,
    price.benchmark,
    {
      start: manifest.commonStart,
      end: price.end,
      initial: price.initial,
      mode: "scheduled",
      slippageBps: 10,
      ...(stage !== "baseline"
        ? {
            positionRisk: {
              execution: "assumed-close-auction" as const,
              stage: stage as PositionRiskStage,
            },
          }
        : {}),
    },
    schedule.allocations,
  );
  if (
    stage === "baseline" &&
    JSON.stringify(result.curve) !== JSON.stringify(baseline.curve)
  )
    throw new Error("旧基线未逐日精确复现，停止对照");
  if (csiHash(JSON.stringify(schedule.allocations)) !== targetHash)
    throw new Error("选股目标被回放修改");
  const points = result.curve.map((p) => {
    const i = indices.get(p.date)!;
    return {
      date: p.date,
      value: p.equity,
      benchmarkReturn:
        price.benchmark[i]!.close / price.benchmark[i - 1]!.close - 1,
    };
  });
  const slice = (from: string, to: string) => {
    const selected = points.filter((p) => p.date >= from && p.date <= to),
      i = points.findIndex((p) => p.date === selected[0]?.date);
    return evaluatePerformance(points[i - 1]?.value ?? price.initial, selected);
  };
  const counts: Record<string, number> = {};
  for (const event of result.riskEvents ?? [])
    if (event.executed > 0 && event.action === "exit")
      for (const reason of event.reasons)
        counts[reason] = (counts[reason] ?? 0) + 1;
  const sales = result.fills.filter((f) => f.side === "sell"),
    buys = result.fills.filter((f) => f.side === "buy");
  const stats = {
    stage,
    tradeEvaluation: csi800TradeEvaluation(
      result.fills.map((f) => ({ ...f, side: f.side as "buy" | "sell" })),
      price.stocks,
    ).evaluation,
    evaluation: evaluatePerformance(price.initial, points),
    segments: {
      development: slice("2016-01-01", "2022-12-31"),
      validation: slice("2023-01-01", "2024-12-31"),
      observation: slice("2025-01-01", price.end),
    },
    annual: performancePeriods(price.initial, points, "year"),
    averageExposure: result.curve.reduce(
      (s, p) => s + p.exposure / result.curve.length,
      0,
    ),
    fills: result.fills.length,
    buyFills: buys.length,
    sellFills: sales.length,
    fees: result.fills.reduce((s, p) => s + p.fee, 0),
    riskExits: sales.filter((f) => f.reason === "position-risk-exit").length,
    profitTrims: sales.filter((f) => f.reason === "profit-30pct-trim").length,
    closedCycles: result.riskTrades?.length ?? 0,
    budgetBreaches:
      result.riskTrades?.filter((t) => t.budgetBreached).length ?? 0,
    t1BlockedEvents: result.riskEvents?.filter((e) => e.t1Blocked).length ?? 0,
    exitReasonCounts: counts,
    entryRejected: result.entryChecks?.filter((e) => !e.eligible).length ?? 0,
    firstDayObservations:
      result.riskEvents?.filter((e) => e.date === e.openedAt).length ?? 0,
    firstDayEmaSignals:
      result.riskEvents?.filter(
        (e) => e.date === e.openedAt && e.reasons.includes("ema50-stop"),
      ).length ?? 0,
  };
  summaries.push(stats);
  await writeFile(
    join(out, stage + ".json.gz"),
    gzipSync(JSON.stringify({ stats, result })),
  );
  console.log(
    stage,
    "annual",
    stats.evaluation.annualReturn.value,
    "drawdown",
    stats.evaluation.maxDrawdown.value,
    "exposure",
    stats.averageExposure,
  );
}
if (JSON.stringify(await codeHashes()) !== JSON.stringify(before))
  throw new Error("运行期间代码改变，不能认证本次重放完成");
await writeFile(
  join(out, "summary.json"),
  JSON.stringify({ ...metadata, summaries }, null, 2),
);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      ...metadata,
      status: "complete",
      completedAt: new Date().toISOString(),
      baselineExactlyReproduced: true,
    },
    null,
    2,
  ),
);
console.log("completed", out);
