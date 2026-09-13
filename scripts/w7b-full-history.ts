import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { readSnapshot } from "../src/server/tdx";
import { fullLocalCalendarReference } from "../src/server/data-health";
import { readGbbq } from "../src/server/tdx-gbbq";
import {
  actionReview,
  type BacktestActions,
} from "../src/server/backtest-actions";
import {
  bonusAdjustedSignals,
  AdjustmentUnavailableError,
} from "../src/server/bonus-adjusted-signals";
import {
  retrospectiveSignals,
  signalBacktestDisclaimer,
} from "../src/server/signal-backtest";
import { benchmarkStratification } from "../src/server/signal-backtest-benchmark";
import { readMarketPool } from "../src/server/market-pool-files";
import { universeAuditPage } from "../src/server/universe-audit";
import { recordResearchUsage } from "../src/server/research-usage";
import { settings } from "../src/server/settings";
import { sqlite } from "../src/server/db";
import { signalInformation } from "../src/lib/signal-information";
import type { ActionEvidence, LedgerRow } from "../src/lib/signal-ledger";

// Bounded artifacts are overwritten only on explicit rerun. User removes this
// directory after manager review; interrupted runs remain here for diagnosis.
const output = resolve(".test-data/w7b");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== resolve(output, "db"))
  throw new Error(
    "必须显式设置 QUANT_DATA_DIR=.test-data/w7b/db；测试不设置此变量",
  );
await mkdir(resolve(output, "db"), { recursive: true });
const sourceDb = new Database(resolve(".test-data/w7/db/quant.sqlite"), {
  readonly: true,
});
await sourceDb.backup(resolve(output, "db/quant.sqlite"));
sourceDb.close();
const connection = sqlite();
const config = settings();
const started = performance.now();
const end = "2026-09-11",
  startA = "2023-09-11";
const ledgerNames = (
  connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'signal_ledger%'",
    )
    .all() as { name: string }[]
)
  .map((r) => r.name)
  .sort();
const counts = () =>
  Object.fromEntries(
    ledgerNames.map((name) => [
      name,
      (
        connection.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
const before = counts();
// Abort even a transient INSERT/UPDATE/DELETE; count equality alone cannot prove no writes.
for (const name of ledgerNames)
  for (const event of ["INSERT", "UPDATE", "DELETE"])
    connection.exec(
      `CREATE TEMP TRIGGER w7b_${name}_${event} BEFORE ${event} ON ${name} BEGIN SELECT RAISE(ABORT,'W7b forbids signal ledger writes'); END`,
    );
const pool = await readMarketPool(
  config.industryBlocksRoot,
  { category: "index", name: "中证A500" },
  config.tdxRoot,
  true,
);
const symbols = [...new Set(pool.members)].sort();
if (symbols.length !== 500) throw new Error(`A500数量 ${symbols.length}，停止`);
const calendar = await fullLocalCalendarReference(config.tdxRoot, []);
const days = calendar.days.filter((d) => d <= end);
if (days.at(-1) !== end || !days.includes(startA))
  throw new Error("日历未覆盖固定 A 区间");
const benchmark = await readSnapshot(config.tdxRoot, "sh000906", "day");
if (benchmark.bars.at(-1)?.date !== end) throw new Error("中证800未覆盖终点");
const gbbq = await readGbbq(config.tdxRoot);
const gbbqHash = createHash("sha256")
  .update(await readFile(gbbq.path))
  .digest("hex");
const fetchedAt = Date.now();
const coverageEnd =
  [...gbbq.events.values()]
    .flat()
    .map((e) => e.date)
    .sort()
    .at(-1) ?? null;
if (!coverageEnd || coverageEnd < end)
  throw new Error("GBBQ全文件事件日期未覆盖研究终点");
const actionsBySymbol: Record<string, BacktestActions> = {};
const outcomesBySymbol: Record<string, ActionEvidence> = {};
type Stock = {
  symbol: string;
  first: string | null;
  last: string | null;
  bars: number;
  hash: string | null;
  error: string | null;
  diagnostics: unknown;
  evaluated: number;
  signals: number;
  elapsedMs: number;
};
const stocks: Stock[] = [];
const inputs = await open(resolve(output, "inputs.jsonl.gz"), "w");
try {
  for (const symbol of symbols) {
    const stock: Stock = {
      symbol,
      first: null,
      last: null,
      bars: 0,
      hash: null,
      error: null,
      diagnostics: null,
      evaluated: 0,
      signals: 0,
      elapsedMs: 0,
    };
    try {
      const snapshot = await readSnapshot(config.tdxRoot, symbol, "day");
      await inputs.writeFile(gzipSync(JSON.stringify(snapshot) + "\n"));
      const bars = snapshot.bars.filter((b) => b.date <= end);
      Object.assign(stock, {
        first: bars[0]?.date ?? null,
        last: bars.at(-1)?.date ?? null,
        bars: bars.length,
        hash: snapshot.hash,
      });
      if (!bars.length || bars[0]!.date < days[0]!)
        throw new Error("日历未覆盖该股可用历史");
      const events = gbbq.events.get(symbol) ?? [];
      const review = actionReview({ ...snapshot, bars }, events, {
        file: gbbq.path,
        modified: gbbq.modified,
        fetchedAt,
      });
      actionsBySymbol[symbol] = review;
      outcomesBySymbol[symbol] = {
        dates: events
          .filter((e) => [1, 11, 12].includes(e.category))
          .map((e) => e.date),
        source: `GBBQ SHA256:${gbbqHash}`,
        coverageEnd,
      };
      stock.diagnostics = bonusAdjustedSignals(bars, review).diagnostics;
    } catch (error) {
      stock.error = String(error);
      if (error instanceof AdjustmentUnavailableError)
        stock.diagnostics = error.diagnostics;
    }
    stocks.push(stock);
  }
} finally {
  await inputs.close();
}
const eligible = stocks.filter((s) => !s.error);
if (!eligible.length) throw new Error("全池被拒绝，停止研究");
const runStock = async (
  symbol: string,
  start: string,
  adjustment: "none" | "backward",
) => {
  const snapshot = await readSnapshot(config.tdxRoot, symbol, "day");
  if (snapshot.hash !== stocks.find((s) => s.symbol === symbol)!.hash)
    throw new Error(`${symbol}行情变化`);
  return retrospectiveSignals({
    symbol,
    bars: snapshot.bars,
    start,
    end,
    days,
    calendarSource: calendar.source,
    actions: outcomesBySymbol[symbol]!,
    completedThrough: end,
    adjustment,
    corporateActions: actionsBySymbol[symbol],
  });
};
const pilotStock =
  eligible.find((s) => s.symbol === "sh600000") ?? eligible[0]!;
const t = performance.now();
const pilot = await runStock(pilotStock.symbol, "2025-09-11", "backward");
const pilotMs = performance.now() - t;
const stockYears = eligible.reduce(
  (n, s) => n + (Date.parse(end) - Date.parse(s.first!)) / 86400000 / 365.25,
  0,
);
// Predeclared wall-time envelope, independent of IC. Full input is still checked
// for W1 exclusions even when only observation years are shortened.
const budgetMs = 90 * 60 * 1000;
let floor = "1990-01-01";
let projectedMs = pilotMs * (stockYears + eligible.length * 3);
for (const candidate of ["2000-01-01", "2010-01-01", "2020-01-01", startA]) {
  if (projectedMs <= budgetMs) break;
  floor = candidate;
  projectedMs =
    pilotMs *
    eligible.reduce(
      (n, s) =>
        n +
        (Date.parse(end) - Date.parse(s.first! > floor ? s.first! : floor)) /
          86400000 /
          365.25 +
        3,
      0,
    );
}
const feasibility = {
  pilotSymbol: pilotStock.symbol,
  pilotMs,
  pilotEvaluated: pilot.evaluated,
  pilotSignals: pilot.rows.length,
  stockYears,
  eligible: eligible.length,
  rejected: stocks.length - eligible.length,
  projectedMs,
  budgetMs,
  floor,
  reason:
    "90分钟单次研究预算；B先缩最早观察年；全池元数据与W1整段拒绝先核实，预热不截断。线性估计不保证实际耗时。",
};
await writeFile(
  resolve(output, "feasibility.json"),
  JSON.stringify({ feasibility, stocks }, null, 2),
);
console.log(JSON.stringify(feasibility));
if (projectedMs > budgetMs)
  throw new Error("缩至A区间仍超预算，停止并报告缩池需求");
const rowsB: LedgerRow[] = [],
  rowsNone: LedgerRow[] = [];
for (const stock of eligible) {
  const tick = performance.now();
  const result = await runStock(
    stock.symbol,
    stock.first! > floor ? stock.first! : floor,
    "backward",
  );
  stock.evaluated = result.evaluated;
  stock.signals = result.rows.length;
  rowsB.push(...result.rows);
  // Same eligible pool and warmup; separates adjustment from whole-stock rejection.
  rowsNone.push(...(await runStock(stock.symbol, startA, "none")).rows);
  stock.elapsedMs = performance.now() - tick;
  console.log(
    JSON.stringify({
      symbol: stock.symbol,
      processed: eligible.indexOf(stock) + 1,
      total: eligible.length,
      signals: rowsB.length,
      elapsedMs: performance.now() - started,
    }),
  );
}
const rowsA = rowsB.filter((r) => r.observedDate >= startA);
const startB = eligible
  .map((s) => (s.first! > floor ? s.first! : floor))
  .sort()[0]!;
const analyses = {
  A: benchmarkStratification(rowsA, benchmark.bars, days, calendar.source, end),
  B: benchmarkStratification(rowsB, benchmark.bars, days, calendar.source, end),
};
const control = signalInformation(rowsNone);
const old = z
  .object({
    range: z.object({ start: z.string(), end: z.string() }),
    scale: z.record(z.number()),
    information: z.object({
      groups: z.array(z.record(z.unknown())),
      decay: z.array(z.record(z.unknown())),
    }),
  })
  .parse(
    JSON.parse(await readFile(resolve(".test-data/w7/report.json"), "utf8")),
  );
const audits = {
  A: await universeAuditPage({
    source: { kind: "market", pool: { category: "index", name: "中证A500" } },
    start: startA,
    end,
  }),
  B: await universeAuditPage({
    source: { kind: "market", pool: { category: "index", name: "中证A500" } },
    start: startB,
    end,
  }),
};
const poolAfter = await readMarketPool(
  config.industryBlocksRoot,
  { category: "index", name: "中证A500" },
  config.tdxRoot,
  true,
);
if (
  poolAfter.hash !== pool.hash ||
  audits.A.summary.total !== 500 ||
  audits.B.summary.total !== 500
)
  throw new Error("证券池研究期间变化");
if (
  (await fullLocalCalendarReference(config.tdxRoot, [])).hash !==
    calendar.hash ||
  (await readSnapshot(config.tdxRoot, "sh000906", "day")).hash !==
    benchmark.hash ||
  createHash("sha256")
    .update(await readFile(gbbq.path))
    .digest("hex") !== gbbqHash
)
  throw new Error("日历/基准/GBBQ研究期间变化");
const evidenceHandle = await open(resolve(output, "rows.jsonl.gz"), "w");
try {
  for (const [group, rows] of Object.entries({
    A: rowsA,
    B: rowsB,
    A_none: rowsNone,
  }))
    for (const row of rows)
      await evidenceHandle.writeFile(
        gzipSync(JSON.stringify({ group, row }) + "\n"),
      );
} finally {
  await evidenceHandle.close();
}
const scale = {
  A: {
    symbols: 500,
    eligible: eligible.length,
    start: startA,
    end,
    tradingDays: days.filter((d) => d >= startA).length,
    candidateCount: 0,
    signals: rowsA.length,
  },
  B: {
    symbols: 500,
    eligible: eligible.length,
    start: startB,
    end,
    tradingDays: days.filter((d) => d >= startB).length,
    candidateCount: eligible.reduce((n, s) => n + s.evaluated, 0),
    signals: rowsB.length,
  },
};
// Count actual date intersections, not calendar length times stocks with short histories.
for (const stock of eligible) {
  const snap = await readSnapshot(config.tdxRoot, stock.symbol, "day");
  if (snap.hash !== stock.hash)
    throw new Error(`${stock.symbol}最终核对行情变化`);
  scale.A.candidateCount += snap.bars.filter(
    (b) => b.date >= startA && b.date <= end && days.includes(b.date),
  ).length;
}
const usage = Object.entries(scale).map(([group, s]) =>
  recordResearchUsage(() => ({
    kind: "sample-research",
    symbols,
    universeSize: 500,
    range: { start: s.start, end },
    candidateCount: s.candidateCount,
    config: {
      kind: "w7b",
      group,
      adjustment: "backward",
      poolHash: pool.hash,
      calendarHash: calendar.hash,
      gbbqHash,
      benchmarkHash: benchmark.hash,
      strategyVersion: "dual-breakout-1",
      eligible: eligible.map((s) => s.symbol),
    },
  })),
);
usage.push(
  recordResearchUsage(() => ({
    kind: "sample-research",
    symbols: eligible.map((s) => s.symbol),
    universeSize: 500,
    range: { start: startA, end },
    candidateCount: scale.A.candidateCount,
    config: { kind: "w7b-control", adjustment: "none", poolHash: pool.hash },
  })),
);
usage.push(
  recordResearchUsage(() => ({
    kind: "sample-research",
    symbols: [pilotStock.symbol],
    universeSize: 1,
    range: { start: "2025-09-11", end },
    candidateCount: pilot.evaluated,
    config: { kind: "w7b-pilot", adjustment: "backward" },
  })),
);
if (usage.some((u) => !u)) throw new Error("V5记账失败");
const after = counts();
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("signal_ledger表发生变化");
const limitations = [
  signalBacktestDisclaimer,
  "A500 成分作为优质公司筛选器使用，非指数复现；当时不可知哪些公司会入选。能回答当前这组大公司上评分是否有区分度；不能回答当时可实施证券池上的策略表现，也不证明这500家公司客观最优。",
  "B为本地可得完整历史，不把首根行情冒称经核验的上市日；日期证据不足见V4审计。",
  "A与B均保留全历史预热，配股及11–14事件、缺失/非法来源整段拒绝；A与W7差异含拒绝池变化，另给同池不复权对照。",
  "W1仅送转，不调成交量，不计现金分红；仍残留除息跳空，类别2–10沿用W1 §8总股本/流通变动假设，可卖性未建模。",
  "收益沿用原始价ledgerOutcome，short不反号；无成本滑点，不是可交易策略业绩。",
  "中证800只用于同日期窗口超额；2007-01-15前留空，不替换指数。IC仅按绝对收益计算。",
  "W7遗漏既有R2d全量日期入口，本批复用fullLocalCalendarReference；已有本地日期不是官方完整交易日历证明。",
  "V4退市为截至终点下界，含起点前；名单日期缓存不是当时已知证据。",
  "同日相关、重叠持有期、低离散评分及多重比较限制t值解释，扩大样本不以翻转结论为目标。",
  "V5仅记入W7隔离副本的复制库，不进入生产；固定产物管理者审核后由用户删除.test-data/w7b，异常退出保留有限文件。",
  "ledgerSignals的snapshotHash仍标识原始行情；复权来源及因子由冻结输入和GBBQ规范化事件独立复现。",
];
const signalKey = (row: LedgerRow) =>
  JSON.stringify([row.symbol, row.observedDate, row.direction]);
const adjustedRows = new Map(rowsA.map((row) => [signalKey(row), row]));
const rawRows = new Map(rowsNone.map((row) => [signalKey(row), row]));
const adjustmentComparison = {
  unadjustedSignals: rawRows.size,
  adjustedSignals: adjustedRows.size,
  added: [...adjustedRows.keys()].filter((key) => !rawRows.has(key)).length,
  removed: [...rawRows.keys()].filter((key) => !adjustedRows.has(key)).length,
  scoreChanged: [...adjustedRows.keys()].filter(
    (key) =>
      rawRows.has(key) &&
      rawRows.get(key)!.score !== adjustedRows.get(key)!.score,
  ).length,
};
const maxSections = Math.max(
  0,
  ...analyses.B.information.groups.map((g) => g.sections.valid),
);
const tValues = analyses.B.information.groups.flatMap((g) =>
  g.icTStat === null ? [] : [Math.abs(g.icTStat)],
);
const conclusion = `B组最多${maxSections}个有效截面，${maxSections < 1000 ? "未达到上千，不能断言已排除样本不足" : "已达到上千，但相关性与重叠持有期仍限制有效独立样本数"}；最大|t|=${tValues.length ? Math.max(...tValues).toFixed(6) : "null"}。t值与分层须按方向和期限共同读取，不作为独立样本显著性证明，不预设扩大样本会翻转结论。`;
const benchmarkDays = new Set(benchmark.bars.map((bar) => bar.date));
const benchmarkMissingDates = days.filter(
  (day) => day >= benchmark.bars[0]!.date && !benchmarkDays.has(day),
);
limitations.push(
  `中证800覆盖起点之后仍缺本地行情日期：${JSON.stringify(benchmarkMissingDates)}；涉及窗口的超额继续留空。ledgerOutcome的可能停牌文案不证明指数停牌。`,
);
const report = {
  benchmarkMissingDates,
  adjustmentComparison,
  conclusion,
  createdAt: new Date().toISOString(),
  scale,
  feasibility,
  elapsedMs: performance.now() - started,
  pool,
  calendar,
  benchmark,
  gbbqHash,
  coverageEnd,
  actionsBySymbol,
  stocks,
  analyses,
  control,
  oldW7: { range: old.range, scale: old.scale, information: old.information },
  audits,
  usage,
  ledger: { before, after },
  limitations,
};
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2),
);
const fmt = (n: number | null) => (n === null ? "null" : n.toFixed(6));
const lines = [
  "# W7b A/B 全历史研究",
  conclusion,
  `同池复权差异：${JSON.stringify(adjustmentComparison)}`,
  ...limitations.map((x) => `- ${x}`),
  `规模：${JSON.stringify(scale)}；耗时 ${(report.elapsedMs / 60000).toFixed(2)}分钟。`,
  `可行性：${JSON.stringify(feasibility)}`,
  "## IC并排对照（绝对收益）",
  "方向|期限|A有效收益|A截面|A IC|A t|B有效收益|B截面|B IC|B t|同池不复权A IC|同池不复权A t",
  "---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:",
];
for (const a of analyses.A.information.groups) {
  const b = analyses.B.information.groups.find(
    (g) => g.direction === a.direction && g.horizon === a.horizon,
  )!;
  const c = control.groups.find(
    (g) => g.direction === a.direction && g.horizon === a.horizon,
  );
  lines.push(
    `${a.direction}|${a.horizon}|${a.valid}|${a.sections.valid}|${fmt(a.icMean)}|${fmt(a.icTStat)}|${b.valid}|${b.sections.valid}|${fmt(b.icMean)}|${fmt(b.icTStat)}|${fmt(c?.icMean ?? null)}|${fmt(c?.icTStat ?? null)}`,
  );
}
lines.push(
  "## 分层（分组成员固定于绝对收益，超额缺失不重新划层）",
  "组|方向|期限|层|评分范围|绝对条数|均值%|中位%|胜率%|超额条数|超额均值%|超额中位%|超额胜率%|缺失原因",
  "---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---",
);
for (const [name, analysis] of Object.entries(analyses))
  for (const group of analysis.groups)
    for (const bin of group.bins)
      lines.push(
        `${name}|${group.direction}|${group.horizon}|${bin.quantile}|${JSON.stringify(bin.scoreRange)}|${bin.count}|${fmt(bin.meanReturn)}|${fmt(bin.medianReturn)}|${fmt(bin.winRate)}|${bin.excessCount}|${fmt(bin.meanExcess)}|${fmt(bin.medianExcess)}|${fmt(bin.excessWinRate)}|${JSON.stringify(bin.excessReasons)}`,
      );
lines.push("## ICIR、衰减与排除");
for (const [name, analysis] of Object.entries(analyses)) {
  lines.push(`### ${name}`, JSON.stringify(analysis.information.decay));
  for (const g of analysis.information.groups)
    lines.push(
      `${g.direction} T+${g.horizon} ICIR=${fmt(g.icir)}；单调性=${fmt(g.stratification.monotonicity)}；${JSON.stringify(g.exclusions)}；${[...g.reasons, g.stratification.reason].filter(Boolean).join("；")}`,
    );
}
lines.push(
  "## 池审计与整段排除",
  `A: ${JSON.stringify(audits.A.summary)}`,
  `B: ${JSON.stringify(audits.B.summary)}`,
  `整段排除 ${stocks.filter((s) => s.error).length} / 500，逐股原因见 report.json stocks。`,
  ...stocks.filter((s) => s.error).map((s) => `${s.symbol}: ${s.error}`),
  "## 结论边界",
  "按实际IC、t及分层读取。null不等于0；没有预设正向结果。若扩大后仍无稳定区分度，仅能加强该设计内缺乏证据的判断，不能证明所有市场状态下绝对无信息。",
  `台账 ${JSON.stringify({ before, after })}；V5 ${usage.map((u) => u?.id).join(", ")}`,
);
await writeFile(
  resolve(output, "report.md"),
  lines
    .map(
      (line, i) =>
        `${i > 0 && line.includes("|") && lines[i - 1]!.includes("|") ? "\n" : "\n\n"}${line}`,
    )
    .join("")
    .trimStart(),
);
console.log(
  JSON.stringify({
    scale,
    elapsedMs: report.elapsedMs,
    groups: Object.fromEntries(
      Object.entries(analyses).map(([k, a]) => [
        k,
        a.information.groups.map((g) => ({
          direction: g.direction,
          horizon: g.horizon,
          valid: g.valid,
          sections: g.sections.valid,
          ic: g.icMean,
          t: g.icTStat,
        })),
      ]),
    ),
  }),
);
connection.close();
