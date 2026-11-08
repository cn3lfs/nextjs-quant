import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  readSnapshot,
  readGbbq,
  readStableLocalFile,
  parseBars,
} from "tstdx/local";
import {
  runClassicStudy,
  studyStrategies,
  studySignalBars,
  classicStudyDatasetSchema,
} from "quant-backtest";
import { z } from "zod";
import { ma } from "trading-strategy-core/indicators";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离 QUANT_DATA_DIR");
const args = process.argv.slice(2),
  options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--out", "--tdx-root", "--replay"].includes(args[i] ?? "") ||
    !args[i + 1]
  )
    throw new Error("参数仅支持 --out/--tdx-root/--replay value");
  options.set(args[i]!, args[i + 1]!);
}
const out = resolve(
  options.get("--out") ?? join(process.env.QUANT_DATA_DIR, "maotai-classics"),
);
const hash = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
async function capture() {
  const root = options.get("--tdx-root") ?? "E:/new_tdx64";
  const [stock, calendar, actions] = await Promise.all([
    readSnapshot(root, "sh600519", "day"),
    readSnapshot(root, "sh000001", "day"),
    readGbbq(root),
  ]);
  if (stock.sourceNote) throw new Error("股票源行情含自动修复，需先核验");
  // Calendar uses dates only. Audit every source record through the existing
  // parser: OHLC widening cannot change dates; any dropped record is rejected.
  const calendarBody = (
    await readStableLocalFile(join(root, "vipdoc/sh/lday/sh000001.day"))
  ).body;
  if (hash(calendarBody) !== calendar.hash)
    throw new Error("日历源读取期间变化");
  const calendarRepairs: string[] = [];
  for (let offset = 0; offset < calendarBody.length; offset += 32) {
    const repairs = { fixed: 0, dropped: 0 };
    const rows = parseBars(
      calendarBody.subarray(offset, offset + 32),
      "day",
      undefined,
      2,
      repairs,
    );
    if (repairs.dropped || rows.length !== 1)
      throw new Error("日历存在剔除记录");
    if (repairs.fixed) calendarRepairs.push(rows[0]!.date);
  }
  const requestedStart = "2016-11-08",
    requestedEnd = "2026-11-08";
  const end = [
    stock.bars.at(-1)!.date,
    calendar.bars.at(-1)!.date,
    requestedEnd,
  ].sort()[0]!;
  const first = stock.bars.findIndex((b) => b.date >= requestedStart);
  if (first < 140) throw new Error("预热不足");
  const bars = stock.bars.slice(first - 140).filter((b) => b.date <= end);
  const calendarDates = calendar.bars
    .filter((b) => b.date >= bars[0]!.date && b.date <= end)
    .map((b) => b.date);
  if (JSON.stringify(bars.map((b) => b.date)) !== JSON.stringify(calendarDates))
    throw new Error("股票与本地指数日历不一致，禁止补日");
  const events = (actions.events.get("sh600519") ?? []).filter(
    (e) => e.date >= bars[0]!.date && e.date <= end,
  );
  for (const e of events) {
    if (
      [11, 12, 13, 14].includes(e.category) ||
      (e.category === 1 &&
        ((e.bonusRatio ?? 0) !== 0 || (e.rightsRatio ?? 0) !== 0))
    )
      throw new Error("存在未支持的非现金公司行动");
  }
  const dividends = events
    .filter((e) => e.category === 1)
    .map((e) => ({ date: e.date, perShare: e.dividend! }));
  if (dividends.length < 10) throw new Error("十年分红事件覆盖异常");
  return {
    version: "maotai-classic-input-1",
    symbol: "sh600519",
    requestedStart,
    requestedEnd,
    end,
    initial: 1000000,
    bars,
    dividends,
    events,
    calendarDates,
    source: {
      root,
      stockHash: stock.hash,
      calendarHash: calendar.hash,
      calendarRepairs,
      gbbqHash: hash(await readFile(actions.path)),
      capturedAt: new Date().toISOString(),
    },
  };
}
const frozenSchema = classicStudyDatasetSchema.extend({
  version: z.literal("maotai-classic-input-1"),
  symbol: z.literal("sh600519"),
  requestedStart: z.literal("2016-11-08"),
  requestedEnd: z.literal("2026-11-08"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  initial: z.literal(1000000),
  events: z.array(z.unknown()),
  calendarDates: z.array(z.string()),
  source: z.record(z.unknown()),
});
const input = frozenSchema.parse(
  options.has("--replay")
    ? JSON.parse(await readFile(resolve(options.get("--replay")!), "utf8"))
    : await capture(),
);
if (
  JSON.stringify(input.bars.map((b) => b.date)) !==
  JSON.stringify(input.calendarDates)
)
  throw new Error("冻结输入与日历不符");
const sourceFiles = [
  "packages/quant-backtest/src/classic-study.ts",
  "scripts/backtest-maotai-classics.ts",
  "scripts/export-classic-study.ts",
  "packages/quant-backtest/package.json",
  "packages/quant-backtest/src/execution.ts",
  "packages/quant-backtest/src/costs.ts",
  "packages/trading-strategy-core/src/indicators.ts",
  "packages/trading-strategy-core/src/money.ts",
  "packages/tstdx/src/local/quotes.ts",
  "packages/tstdx/src/local/gbbq.ts",
  "pnpm-lock.yaml",
];
const codeHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [file, hash(await readFile(file))]),
  ),
);
const results = studyStrategies.map((strategy) =>
  runClassicStudy(input.bars, input.dividends, {
    strategy,
    start: input.requestedStart,
    end: input.end,
    initial: input.initial,
  }),
);
const sensitivity = [
  { slippageBps: 5, dividendTaxBps: 0 },
  { slippageBps: 10, dividendTaxBps: 0 },
  { slippageBps: 0, dividendTaxBps: 2000 },
].map((scenario) => ({
  scenario,
  results: studyStrategies.map((strategy) => {
    const r = runClassicStudy(input.bars, input.dividends, {
      ...scenario,
      strategy,
      start: input.requestedStart,
      end: input.end,
      initial: input.initial,
    });
    return {
      strategy,
      totalReturn: r.totalReturn,
      cagr: r.cagr,
      maxDrawdown: r.maxDrawdown,
      fees: r.fees,
      fills: r.fills.length,
      rejected: r.rejected.length,
    };
  }),
}));
// Attribution uses yesterday's regime and today's P&L. Contributions are
// additive percentages of initial capital, not a tradable spliced equity curve.
const signalBars = studySignalBars(input.bars, input.dividends),
  longMa = ma(signalBars, 120);
const firstIndex = input.bars.findIndex((b) => b.date >= input.requestedStart);
const regimes = ["上涨", "下跌", "盘整/过渡"] as const;
const attribution = results.map((r) => ({
  strategy: r.strategy,
  regimes: regimes.map((regime) => {
    let days = 0,
      pnl = 0,
      exposure = 0;
    r.curve.forEach((row, j) => {
      const i = firstIndex + j - 1,
        slope = longMa[i]! / longMa[i - 20]! - 1;
      const label =
        signalBars[i]!.close > longMa[i]! && slope > 0.02
          ? "上涨"
          : signalBars[i]!.close < longMa[i]! && slope < -0.02
            ? "下跌"
            : "盘整/过渡";
      if (label === regime) {
        days++;
        pnl += row.equity - (r.curve[j - 1]?.equity ?? input.initial);
        exposure += row.exposure;
      }
    });
    return {
      regime,
      days,
      returnContribution: pnl / input.initial,
      averageExposure: exposure / days,
    };
  }),
}));
const fixedPathStress = results.map((r) => ({
  strategy: r.strategy,
  scenarios: [5, 10].map((bps) => {
    const extraCost = r.fills.reduce(
      (sum, f) => sum + (f.price * f.shares * bps) / 10000,
      0,
    );
    return {
      slippageBps: bps,
      extraCost,
      totalReturn: (r.finalEquity - extraCost) / input.initial - 1,
    };
  }),
}));
await mkdir(out, { recursive: true });
const inputText = JSON.stringify(input, null, 2),
  resultText = JSON.stringify(
    { results, sensitivity, attribution, fixedPathStress },
    null,
    2,
  );
await writeFile(join(out, "input.json"), inputText);
await writeFile(join(out, "results.json"), resultText);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      version: "maotai-classic-study-1",
      quality: "rule-check-only",
      inputHash: hash(inputText),
      resultHash: hash(resultText),
      codeHashes,
      assumptions: [
        "commission 1bp both sides minimum CNY5; sell charges 5bp",
        "raw execution; causal cash-adjusted signals",
        "dividends segregated and never reinvested; tax scenarios 0/20%",
        "explicit non-ST mainboard 10% limit scenario; not certified history",
        "daily close decision/next open; no intraday fills; end marked to close",
      ],
    },
    null,
    2,
  ),
);
const pct = (v: number) => (v * 100).toFixed(2) + "%";
const header =
  "|策略|累计收益|年化|最大回撤|成交笔数|费用(元)|隔离分红(元)|平均仓位|\n|---|---:|---:|---:|---:|---:|---:|---:|";
const table = results
  .map(
    (r) =>
      `|${r.name}|${pct(r.totalReturn)}|${pct(r.cagr)}|${pct(r.maxDrawdown)}|${r.fills.length}|${r.fees.toFixed(2)}|${r.dividends.toFixed(2)}|${pct(r.averageExposure)}|`,
  )
  .join("\n");
const annual =
  "|年份|" +
  results.map((r) => r.name).join("|") +
  "|\n|---|" +
  results.map(() => "---:").join("|") +
  "|\n" +
  results[0]!.annual
    .map(
      (a, i) =>
        `|${a.year}|${results.map((r) => pct(r.annual[i]!.return)).join("|")}|`,
    )
    .join("\n");
const scenarios = sensitivity
  .map(
    (s) =>
      `### 滑点${s.scenario.slippageBps}bp / 分红税情景${s.scenario.dividendTaxBps / 100}%\n\n|策略|累计收益|年化|最大回撤|成交/拒绝笔数|\n|---|---:|---:|---:|---:|\n` +
      s.results
        .map(
          (r, i) =>
            `|${results[i]!.name}|${pct(r.totalReturn)}|${pct(r.cagr)}|${pct(r.maxDrawdown)}|${r.fills}/${r.rejected}|`,
        )
        .join("\n"),
  )
  .join("\n\n");
const regimeTable =
  "|策略|上涨贡献|下跌贡献|盘整/过渡贡献|\n|---|---:|---:|---:|\n" +
  attribution
    .map(
      (a, i) =>
        `|${results[i]!.name}|${a.regimes.map((r) => pct(r.returnContribution)).join("|")}|`,
    )
    .join("\n");
const fixedPathTable =
  "|策略|固定路径额外5bp后累计收益|额外10bp后累计收益|\n|---|---:|---:|\n" +
  fixedPathStress
    .map(
      (s, i) =>
        `|${results[i]!.name}|${s.scenarios.map((r) => pct(r.totalReturn)).join("|")}|`,
    )
    .join("\n");
await writeFile(
  join(out, "report.md"),
  `# 贵州茅台五类策略十年规则实验\n\n${results[0]!.start} 至 ${results[0]!.end}；${results[0]!.tradingDays}交易日；初始100万元。费用按用户固定口径；分红隔离不复投；规则自检等级。2016及2026为不完整年度。\n\n${header}\n${table}\n\n## 逐年收益\n\n${annual}\n\n## 行情归因\n\n以上一日后复权价格/MA120及MA120的20日斜率±2%分类；其余为盘整/过渡，包含趋势切换。各类当日盈亏/期初本金的加总可还原全期收益，不是分行情独立回测或预测。\n\n${regimeTable}\n\n## 固定成交路径费用压力\n\n保持主结果成交股数与时间，额外从期末财富扣成交额×单边滑点；仅估计费用拖累，不重撮合、不重投资，也不代表资金约束下可执行的另一条路径。\n\n${fixedPathTable}\n\n## 重撮合敏感性\n\n注意：滑点可能导致报价超出日线高低价而拒绝成交，随后持仓与整手数量改变。因此重跑收益可能提高，不能解释为成本提高有利；成交/拒绝笔数一并列出。\n\n${scenarios}\n\n输入SHA256: ${hash(inputText)}\n结果SHA256: ${hash(resultText)}\n`,
);
const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]!);
  return [
    keys.join(","),
    ...rows.map((row) =>
      keys.map((k) => JSON.stringify(row[k] ?? "")).join(","),
    ),
  ].join("\n");
};
for (const r of results) {
  await writeFile(
    join(out, `${r.strategy}-fills.csv`),
    "\uFEFF" + csv(r.fills),
  );
  await writeFile(
    join(out, `${r.strategy}-equity.csv`),
    "\uFEFF" + csv(r.curve),
  );
}
console.log(
  JSON.stringify(
    {
      out,
      inputHash: hash(inputText),
      resultHash: hash(resultText),
      start: results[0]!.start,
      end: input.end,
      days: results[0]!.tradingDays,
      summary: results.map(
        ({
          name,
          totalReturn,
          cagr,
          maxDrawdown,
          fees,
          dividends,
          fills,
          rejected,
        }) => ({
          name,
          totalReturn,
          cagr,
          maxDrawdown,
          fees,
          dividends,
          fills: fills.length,
          rejected: rejected.length,
        }),
      ),
    },
    null,
    2,
  ),
);
