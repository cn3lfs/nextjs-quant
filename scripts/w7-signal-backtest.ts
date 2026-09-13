import { mkdir, open, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { z } from "zod";
import { signalInformation } from "../src/lib/signal-information";
import type { LedgerRow } from "../src/lib/signal-ledger";
import {
  retrospectiveSignals,
  signalBacktestDisclaimer,
} from "../src/server/signal-backtest";
import { readSnapshot } from "../src/server/tdx";
import { localLedgerActions } from "../src/server/signal-ledger-job";
import { readMarketPool } from "../src/server/market-pool-files";
import { universeAuditPage } from "../src/server/universe-audit";
import { recordResearchUsage } from "../src/server/research-usage";
import { settings } from "../src/server/settings";
import { sqlite } from "../src/server/db";

// Fixed bounded artifacts, overwritten on explicit rerun. Retain for manager
// review; the user can remove .test-data/w7 after review, including partial runs.
const output = resolve(".test-data/w7");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== resolve(output, "db"))
  throw new Error(
    "W7 运行必须显式设置 QUANT_DATA_DIR=.test-data/w7/db（隔离副本）",
  );
const started = performance.now();
const config = settings();
const connection = sqlite();
const ledgerCounts = () =>
  Object.fromEntries(
    [
      "signal_ledger",
      "signal_ledger_outcomes",
      "signal_ledger_baselines",
      "signal_ledger_runs",
    ].map((name) => [
      name,
      (
        connection.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
const before = ledgerCounts();
const pool = await readMarketPool(
  config.industryBlocksRoot,
  { category: "index", name: "中证A500" },
  config.tdxRoot,
  true,
);
const symbols = [...new Set(pool.members)].sort();
if (symbols.length !== 500)
  throw new Error(`A500 实际为 ${symbols.length} 只，停止核对名单`);
const calendar = await readSnapshot(config.tdxRoot, "sz399006", "day");
const today = new Date().toISOString().slice(0, 10);
const days = calendar.bars.filter((b) => b.date < today).map((b) => b.date);
const end = z.string().min(10).parse(days.at(-1));
if (end < today.slice(0, 4) + "-01-01")
  throw new Error("日历严重过期，停止研究");
const start = `${Number(end.slice(0, 4)) - 3}${end.slice(4)}`;
const calendarSource = `本地创业板指 sz399006 已有交易日期（非完整官方日历），SHA256:${calendar.hash}`;
const actions = await localLedgerActions(config.tdxRoot);
const runStock = async (symbol: string, from: string) => {
  const t = performance.now();
  const snapshot = await readSnapshot(config.tdxRoot, symbol, "day");
  const result = retrospectiveSignals({
    symbol,
    bars: snapshot.bars,
    start: from,
    end,
    days,
    calendarSource,
    actions: actions(symbol),
    completedThrough: end,
  });
  return {
    result,
    elapsedMs: performance.now() - t,
    hash: snapshot.hash,
    first: snapshot.bars[0]!.date,
    last: snapshot.bars.at(-1)!.date,
  };
};
const pilotSymbol = "sh600000";
const pilotStart = `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`;
const pilot = await runStock(pilotSymbol, pilotStart);
const feasibility = {
  symbol: pilotSymbol,
  start: pilotStart,
  end,
  evaluated: pilot.result.evaluated,
  signals: pilot.result.rows.length,
  elapsedMs: pilot.elapsedMs,
  projectedThreeYearMs: pilot.elapsedMs * 3 * symbols.length,
  projectedStockYearCapacity: Math.floor((30 * 60 * 1000) / pilot.elapsedMs),
  budgetMs: 30 * 60 * 1000,
  reason:
    "单只单年包含完整历史读取与递推预热；线性估计并非耗时保证；按30分钟预算先缩至1年，不因信号结果选区间",
};
const actualStart =
  feasibility.projectedThreeYearMs <= feasibility.budgetMs ? start : pilotStart;
if (pilot.elapsedMs * symbols.length > feasibility.budgetMs)
  throw new Error("一年全池仍超预算，需明确缩池方案后再运行");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "feasibility.json"),
  JSON.stringify(feasibility, null, 2),
);
console.log(
  JSON.stringify({ feasibility, actualStart, end, symbols: symbols.length }),
);
const rows: LedgerRow[] = [];
const stocks: {
  symbol: string;
  evaluated: number;
  signals: number;
  elapsedMs: number;
  hash: string | null;
  first: string | null;
  last: string | null;
  error: string | null;
}[] = [];
for (const symbol of symbols) {
  const t = performance.now();
  try {
    const stock = await runStock(symbol, actualStart);
    rows.push(...stock.result.rows);
    stocks.push({
      symbol,
      evaluated: stock.result.evaluated,
      signals: stock.result.rows.length,
      elapsedMs: stock.elapsedMs,
      hash: stock.hash,
      first: stock.first,
      last: stock.last,
      error: null,
    });
  } catch (error) {
    stocks.push({
      symbol,
      evaluated: 0,
      signals: 0,
      elapsedMs: performance.now() - t,
      hash: null,
      first: null,
      last: null,
      error: String(error),
    });
  }
  if (stocks.length % 25 === 0)
    console.log(
      JSON.stringify({
        scanned: stocks.length,
        signals: rows.length,
        elapsedMs: performance.now() - started,
      }),
    );
}
const audit = await universeAuditPage({
  source: { kind: "market", pool: { category: "index", name: "中证A500" } },
  start: actualStart,
  end,
});
// Preserve exact parsed inputs in one bounded compressed artifact. Re-reading
// must match the calculation's source hash; never freeze a newer generation.
const evidencePath = resolve(output, "inputs.jsonl.gz");
const evidenceFile = await open(evidencePath, "w");
try {
  for (const stock of stocks.filter((s) => s.hash !== null)) {
    const snapshot = await readSnapshot(config.tdxRoot, stock.symbol, "day");
    if (snapshot.hash !== stock.hash)
      throw new Error(`${stock.symbol} 研究期间行情变化，拒绝混合快照`);
    await evidenceFile.writeFile(gzipSync(JSON.stringify(snapshot) + "\n"));
  }
} finally {
  await evidenceFile.close();
}
const poolAfter = await readMarketPool(
  config.industryBlocksRoot,
  { category: "index", name: "中证A500" },
  config.tdxRoot,
  true,
);
if (poolAfter.hash !== pool.hash || audit.summary.total !== symbols.length)
  throw new Error("研究期间名单变化，拒绝混合审计");
const information = signalInformation(rows);
const candidateCount = stocks.reduce((n, s) => n + s.evaluated, 0);
const usage = recordResearchUsage(() => ({
  kind: "sample-research",
  symbols,
  universeSize: symbols.length,
  range: { start: actualStart, end },
  candidateCount,
  config: {
    kind: "w7",
    poolHash: pool.hash,
    calendarHash: calendar.hash,
    start: actualStart,
    end,
    adjustment: "none",
    strategyVersion: "dual-breakout-1",
  },
}));
const after = ledgerCounts();
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("signal_ledger 表发生变化");
const report = {
  disclaimer: signalBacktestDisclaimer,
  createdAt: new Date().toISOString(),
  range: { start: actualStart, end },
  scale: {
    symbols: symbols.length,
    successful: stocks.filter((s) => !s.error).length,
    tradingDays: days.filter((d) => d >= actualStart && d <= end).length,
    candidateCount,
    signals: rows.length,
  },
  elapsedMs: performance.now() - started,
  feasibility,
  pool,
  evidencePath,
  actionsBySymbol: Object.fromEntries(
    symbols.map((symbol) => [symbol, actions(symbol)]),
  ),
  calendar: { source: calendarSource, days, hash: calendar.hash },
  audit,
  information,
  stocks,
  rows,
  usage,
  ledger: { before, after },
  limitations: [
    "当前A500成分回溯，生存者偏差幅度未知；日期缓存来自隔离副本，不是历史时点证据。",
    "V4退市字段实际为截至终点已退市下界（含起点前），不是严格区间内退市总数。",
    "上证与深证成指完整文件分别在1991-05-09/1995-03-01被现有解析器拒绝；使用创业板指已有日期，不宣称官方日历完整性。",
    "既有localCalendarReference仅400根，不够三年；本次完整指数日期仍复用readSnapshot解析。",
    "信号沿用不复权全历史与当前参数，除权可能污染信号结构；收益仅按ledgerOutcome排除持有区间除权，不引入W1调整。",
    "缺行情可能停牌但不能确证；逐标的错误完整记录，未跳过后伪称完整有效覆盖。",
    "V5记账仅在隔离数据库副本，未进入生产累计试验次数；candidateCount为实际有行情且位于日历的标的×观察日数，另有单股单年可行性试算。",
    "0条台账只证明未落库；不能仅凭0行证明应用从未在收盘后运行，异常等亦可能导致无记录。",
    "同日相关、重叠持有期与低离散评分限制统计解释；V3的t值不是独立样本显著性证明。",
    "报告固定覆盖写入，管理者验收后由用户删除.test-data/w7；异常中断保留有限部分产物供诊断，无自动清理后台任务。",
  ],
};
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2),
);
const fmt = (x: number | null) => (x === null ? "null" : x.toFixed(6));
const lines = [
  "# W7 双突破历史信号信息含量",
  signalBacktestDisclaimer,
  `区间 ${actualStart} 至 ${end}；${report.scale.symbols}只，成功读取${report.scale.successful}只；${report.scale.tradingDays}个代理交易日；评估${candidateCount}个标的×时点；信号${rows.length}条；耗时${(report.elapsedMs / 1000).toFixed(2)}秒。`,
  `可行性：${pilotSymbol} 单年 ${pilot.result.evaluated} 个时点实测 ${(pilot.elapsedMs / 1000).toFixed(3)}秒，A500×3年估计 ${(feasibility.projectedThreeYearMs / 60000).toFixed(2)}分钟，预算30分钟。`,
  `线性预算上限约 ${feasibility.projectedStockYearCapacity} 标的年，单股差异与并发负载会影响耗时，不是保证。`,
  "## IC / 衰减三点",
  "方向 | T+N | 有效收益 | 有效截面 | RankIC均值 | ICIR | t值 | 顶底差(百分点)",
  "---|---:|---:|---:|---:|---:|---:|---:",
  ...information.groups.map(
    (g) =>
      `${g.direction}|${g.horizon}|${g.valid}|${g.sections.valid}|${fmt(g.icMean)}|${fmt(g.icir)}|${fmt(g.icTStat)}|${fmt(g.stratification.topMinusBottom)}`,
  ),
  "## 分层",
  "方向 | T+N | 层 | 评分范围 | 条数 | 平均收益% | 中位收益% | 胜率%",
  "---|---:|---:|---|---:|---:|---:|---:",
  ...information.groups.flatMap((g) =>
    g.stratification.groups.map(
      (b) =>
        `${g.direction}|${g.horizon}|${b.quantile}|${JSON.stringify(b.scoreRange)}|${b.count}|${fmt(b.meanReturn)}|${fmt(b.medianReturn)}|${fmt(b.winRate)}`,
    ),
  ),
  ...information.groups.map(
    (g) =>
      `${g.direction} T+${g.horizon}：单调性=${fmt(g.stratification.monotonicity)}；${[...g.reasons, g.stratification.reason].filter(Boolean).join("；")}`,
  ),
  "## 池审计",
  `起点未上市 ${audit.summary.notListedAtStart}；区间内上市 ${audit.summary.listedDuring}；截至终点已退市 ≥ ${audit.summary.delistedDuring}；无日期证据 ${audit.summary.noEvidence}；行情覆盖未知 ${audit.summary.localCoverageUnknown}。当前成分必含生存者偏差，幅度未知。`,
  "## 排除计数（各标记可能重叠）",
  ...information.groups.map(
    (g) => `${g.direction} T+${g.horizon}: ${JSON.stringify(g.exclusions)}`,
  ),
  `读取错误：${JSON.stringify(stocks.filter((s) => s.error))}`,
  "## 结论边界",
  "按上表如实读取；null不是IC=0。评分并列造成空层时无法判定单调性，不能据此证明有效或无效。没有正向有效性的预设结论。",
  "## 冲突与未处理风险",
  ...report.limitations.map((l) => `- ${l}`),
  `\n台账表前后计数：${JSON.stringify(report.ledger)}；V5隔离记账：${usage?.id ?? "失败"}。`,
];
await writeFile(
  resolve(output, "report.md"),
  lines
    .map((line, i) =>
      i > 0 && line.includes("|") && lines[i - 1]!.includes("|")
        ? `\n${line}`
        : `\n\n${line}`,
    )
    .join("")
    .trimStart(),
);
console.log(
  JSON.stringify({
    scale: report.scale,
    elapsedMs: report.elapsedMs,
    groups: information.groups.map((g) => ({
      direction: g.direction,
      horizon: g.horizon,
      ic: g.icMean,
      sections: g.sections,
      stratification: g.stratification,
    })),
    audit: audit.summary,
  }),
);
connection.close();
