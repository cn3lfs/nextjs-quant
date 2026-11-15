import { task, json, readArtifact, prior, delivery } from "./lib/research-r2a4";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
type Score = {
  return: number | null;
  excess: number | null;
  drawdown: number | null;
  trades: number;
  events?: { fills: number; orders: number; entries: number; exits: number };
  riskAdjusted?: { sharpeDifference: number | null };
};
type Row = {
  symbols: number | null;
  scope: string;
  id: string;
  family: string;
  level: string;
  full: Score;
  holdout: {
    start: string;
    end: string;
    base: Score;
    doubledCost: Score;
    delayed: Score;
  };
  oosWindows: number;
  positiveWindows: number;
  oldPositiveWindows: number;
  stressPositiveWindows: { cost: number; delay: number };
  closedTrades: number;
  dsr: { value: number | null };
  newReasons: string[];
  oldReasons: string[];
  newPassed: boolean;
  oldPassed: boolean;
  worstDrawdown: number | null;
  stableNeighbors: number;
  scenarios?: {
    valuation: string;
    full: Score;
    holdout: Score;
    terminalSettlements?: number;
  }[];
};
const score = await json<{
  trialCount: number;
  availableTrialSharpes: number;
  trialSharpeVariance: { value: number | null; reason: string | null };
  deflatedSharpeThreshold: { value: number | null; reason: string | null };
  rows: Row[];
  promoted: string[];
  comparisonBooks: {
    scope: string;
    boundary: string;
    variants: {
      name: string;
      shares: Record<string, number>;
      correlation: number | null;
      overlapDays: number;
      score: Score;
      sleeves: {
        sleeve: string;
        observed: number;
        return: number | null;
        drawdown: number | null;
      }[];
      newPassed: boolean;
      oldPassed: boolean;
      reasons: string[];
    }[];
  }[];
  closest: { scope: string; id: string; reasons: string[]; gap: unknown }[];
}>(join(task, "scoreboard-summary.json"));
const alternate = await json<{
  basis: string;
  rows: {
    id: string;
    holdout: {
      base: { excess?: number | null; sharpeDifference?: number | null };
    };
  }[];
}>(join(task, "benchmark-50-50.json"));
const csi = await json<{
  observedAt: string;
  source: string;
  sourceSha256: string;
  rosterSha256: string;
  benchmark: { hash: string; bars: number; start: string; end: string };
}>(join(task, "csi800.json"));
const nativeProgress = await json<{ completed: string[]; elapsedMs: number }>(
  join(task, "native-progress.json"),
);
const terminalCoverage = await json<{
  audit: { symbol: string; studyBars: number }[];
}>(join(task, "terminal-input.json"));
const capture = await readArtifact<{
  cutoff: string;
  csiIntersection: string[];
}>({
  path: join(task, "artifacts/native-manifest.json.gz"),
  sha256: (await import("./lib/research-r2a4")).digest(
    await (
      await import("node:fs/promises")
    ).readFile(join(task, "artifacts/native-manifest.json.gz")),
  ),
});
const crypto = await json<{
  root: string;
  series: {
    symbol: string;
    interval: string;
    start: string;
    end: string;
    rows: number;
    files: unknown[];
    gaps: unknown[];
    bytes: number;
  }[];
}>(join(task, "crypto-coverage.json"));
const audits = await json<{
  engineAudit: unknown;
  breakout15mAttribution: {
    prior20Pairs: {
      grossPnl: number;
      fees: number;
      slippage: number;
      netPnl: number;
      rejections: Record<string, number>;
    };
    btcEth: {
      grossPnl: number;
      fees: number;
      slippage: number;
      netPnl: number;
      rejections: Record<string, number>;
      fills: number;
    };
  };
}>(".codex-runs/delivery.json");
const reconciliation = await json<{
  rows: {
    id: string;
    oldHoldout: { start: string; base: Score };
    numericDifferences: unknown[];
  }[];
}>(join(task, "reconciliation8.json"));
const low = await json<{
  contributions: {
    id: string;
    fullReturn: number;
    indexCyclePnl: number;
    outsideIndexCyclePnl: number;
    totalPnl: number;
    residual: number;
  }[];
}>(join(task, "low-contributions.json"));
const lowOriginal = await prior<{
  checkpoints: {
    row: { id: string; inSample: Score; holdout: { base: Score } };
    fullPeriod: Score;
  }[];
}>("candidate-cnlowzone-historical-low");
const mainCycles = await json<{
  cycles: { start: string; end: string; complete: boolean }[];
  rows: {
    id: string;
    cycles: {
      start: string;
      end: string;
      base: Score;
      doubledCost: Score;
      delayed: Score;
    }[];
  }[];
}>(join(task, "low-market-cycles.json"));
const pct = (v: number | null | undefined) =>
  v == null ? "不可得" : `${(v * 100).toFixed(2)}%`;
const n = (v: number | null | undefined, d = 3) =>
  v == null ? "不可得" : v.toFixed(d);
const verdict = (v: boolean) => (v ? "通过" : "未通过");
function closestDetails(scope: string, id: string) {
  const r = score.rows.find((row) => row.scope === scope && row.id === id)!;
  const fraction = (value: number) => value / r.oosWindows;
  const positiveGap = (value: number | null | undefined, percent = false) =>
    value == null
      ? "不可估计"
      : value > 0
        ? "0"
        : value === 0
          ? "须严格转正"
          : percent
            ? pct(-value)
            : n(-value);
  const rows: string[][] = [
    [
      "OOS窗口",
      String(r.oosWindows),
      "≥3",
      String(Math.max(0, 3 - r.oosWindows)),
    ],
    [
      "新口径正窗口",
      `${r.positiveWindows}/${r.oosWindows} (${pct(fraction(r.positiveWindows))})`,
      "≥60%",
      pct(Math.max(0, 0.6 - fraction(r.positiveWindows))),
    ],
    [
      "成本×2正窗口",
      pct(fraction(r.stressPositiveWindows.cost)),
      "≥60%",
      pct(Math.max(0, 0.6 - fraction(r.stressPositiveWindows.cost))),
    ],
    [
      "延迟正窗口",
      pct(fraction(r.stressPositiveWindows.delay)),
      "≥60%",
      pct(Math.max(0, 0.6 - fraction(r.stressPositiveWindows.delay))),
    ],
    [
      "OOS闭合交易",
      String(r.closedTrades),
      "≥30",
      String(Math.max(0, 30 - r.closedTrades)),
    ],
    [
      "最坏回撤",
      pct(r.worstDrawdown),
      "≤25%",
      r.worstDrawdown === null
        ? "不可估计"
        : pct(Math.max(0, r.worstDrawdown - 0.25)),
    ],
    [
      "训练邻域",
      pct(r.stableNeighbors),
      "≥50%",
      pct(Math.max(0, 0.5 - r.stableNeighbors)),
    ],
    [
      "全族DSR",
      n(r.dsr.value),
      "≥0.95",
      r.dsr.value === null ? "不可估计" : n(Math.max(0, 0.95 - r.dsr.value)),
    ],
  ];
  for (const [label, s] of [
    ["留出", r.holdout.base],
    ["留出成本×2", r.holdout.doubledCost],
    ["留出延迟", r.holdout.delayed],
  ] as const) {
    rows.push(
      [label + "扣费收益", pct(s.return), ">0", positiveGap(s.return, true)],
      [
        label + "夏普差",
        n(s.riskAdjusted?.sharpeDifference),
        ">0",
        positiveGap(s.riskAdjusted?.sharpeDifference),
      ],
    );
  }
  if (r.family === "historical-low") {
    const count = mainCycles.cycles.filter((c) => c.complete).length;
    rows.push(
      ["完整市场周期", String(count), "≥3", String(Math.max(0, 3 - count))],
      ["输入置信度", "价量/近似财务", "corroborated", "历史温度及首版财务不足"],
    );
  }
  return [
    "| 条件 | 实际 | 门槛 | 缺口 |",
    "|---|---|---|---|",
    ...rows.map((cells) => "| " + cells.join(" | ") + " |"),
    "",
  ];
}
const lines: string[] = [
  "# 2026-11 R2a-4 策略研究成绩单",
  "",
  `晋级 ${score.promoted.length} 项。已完成引擎核账、主口径重跑、旧对照重评、终止覆盖敏感性和真实共享账户组合。统计全族共 ${score.trialCount} 个实际试验，统一DSR，不按市场或口径拆分。${score.promoted.length ? "登记仅发生在隔离研究库。" : "未登记任何新的live候选。"}提醒live模式未开启，真实通知/交易均为0。`,
  "",
  "这是带高偏差的规则研究，不是可信可投资业绩。当前成分、历史执行、公司行动/财务版本与历史交易所过滤器均有未认证部分；正收益和程序测试不能消除这些缺口。",
  "",
  "## 口径与来源",
  "",
  `A股800成分来自只读的 「${csi.source}」，观察时间 ${csi.observedAt}；正式快照生效日未知。源SHA256 「${csi.sourceSha256}」，排序名单SHA256 「${csi.rosterSha256}」。800只中258只通过冻结的执行审查，542只（541只非现金公司行动、1只sz000831尾部行情覆盖异常）的逐项理由见 .test-data/r2a4/csi800.json。这是中证800可执行子集，覆盖不足不可忽略。基准000906：${csi.benchmark.start}—${csi.benchmark.end}，${csi.benchmark.bars}根，hash 「${csi.benchmark.hash}」。RPS仍为5564只冻结全市场横截面。`,
  "",
  "主口径使用2025-06起留出段作为主要参考；中证800实际首交易日2025-06-03，数字货币2025-06-01。high `current-constituents-lookahead`始终保留：越早窗口前视偏差越严重，留出也不是无偏。全市场1638只和20币对沿用R2a-3窗口（A股留出2023-06-29起；20币对按原2020年起区间），不得把不同窗口差值当作纯换池效果。",
  "",
  "数字货币主口径BTC/ETH从最早官方归档开始，五周期分别使用原生文件；研究截止UTC2026-11-14 00:00，下载官方日文件截至2026-11-13。分钟/小时bar按结束时刻标记并按此切窗（日线沿用官方开盘日），因此末尾可能显示11-14 00:00；这是11-13最后一根已完成bar，不是读取11-14未来行情。基准从窗内首根观测bar的开盘价建仓；分钟/小时周期的这个开盘可能在名义日期边界之前一个原生周期，不能把它当作日线窗口的完全相同时刻。基准BTC持有；每个窗口重新按初始本金50/50买入BTC/ETH的基准并列列出，基准不收费。",
  "",
  `官方ZIP和CHECKSUM根目录：「${crypto.root}」。合计 ${(crypto.series.reduce((v, s) => v + s.bytes, 0) / 1024 ** 2).toFixed(1)} MiB，高于最初几十MB估计。归档是持久原始输入，不随BarStore缓存清理。manifest记录真缺口和隔离异常时间行；没有插值。`,
  "",
  "| 品种/原生周期 | 起止（结束标记） | bar数 | ZIP数 | 缺口处数 | MiB |",
  "|---|---|---:|---:|---:|---:|",
  ...crypto.series.map(
    (s) =>
      `| ${s.symbol}/${s.interval} | ${s.start}—${s.end} | ${s.rows} | ${s.files.length} | ${s.gaps.length} | ${(s.bytes / 1024 ** 2).toFixed(1)} |`,
  ),
  "",
  "应用设置→数据与连接提供保存目录、可选1m和“回填/补齐 BTC、ETH 历史”按钮，任务中心显示进度和取消。启动只读索引并提示；已有历史时图表读取才按已完成bar补最近REST尾部，禁止隐式历史大批下载。官方替换先验证live一致，冲突保留。全部真实下载仅在本任务隔离目录，生产目录由用户自行触发。",
  "",
  "## 执行核查与差异解释",
  "",
  "A股双突破ATR1006笔、时间止损1128笔，20币对15m共17368笔，分别独立重算原始bar价格、次bar开盘、固定/ATR保护、跳空、取整、费用和现金；每组20个展示样本（各至少10笔买与卖）差异为0。原8只低位共76笔，展示20笔含5笔追加档位，价格、复权、份额/分批差异为0。T+1、一字/涨跌停、缺行情、无效保护、共享资金拒单和零值估值另有固定输入控制。逐笔证据及每个拒单的分类在engine-audit与gzip审计产物；没有把非零拒单说成实现缺陷。",
  "",
  "与`cc934c7`的8只证券、原窗口2017-01-03—2026-11-13，9个双突破含邻域候选在训练、各滚动窗及留出全部数值一致（0差异）。原留出实际2024-11-22起，时间变体绝对+9.285%、原始超额+8.481%；不是同一个2023-06-29起全市场留出。全市场时间变体绝对−42.662%、原始超额−47.342%。证券池由8到1638、共用现金下入场竞争及窗口同时改变，不能把两结果相减归因为一个因素。双突破不读RPS，因此横截面变化不是该项差异来源；参数未改，8只原数据/原执行路径精确复现，审计的全市场原留出也与冻结成绩一致，未发现需要修正的引擎缺陷。",
  "",
  "| 原8只变体 | 原留出起日 | 绝对收益 | 原始超额 | 重放数值差异 |",
  "|---|---|---:|---:|---:|",
  ...reconciliation.rows.map(
    (r) =>
      `| ${r.id} | ${r.oldHoldout.start} | ${pct(r.oldHoldout.base.return)} | ${pct(r.oldHoldout.base.excess)} | ${r.numericDifferences.length} |`,
  ),
  "",
  "下表是固定实际成交路径的现金归因，不是零费用重新下单的反事实回测。毛收益含末期未实现浮盈亏；净额=毛收益−手续费−滑点，独立核账剩余误差见delivery。20币对的毛收益本身为正，但费用和滑点合计超过毛收益；这证明该路径的换手成本足以造成巨亏，不能据此证明无成本策略可投资。BTC/ETH按同一方法复核。",
  "",
  "| 15m ATR留出 | 毛损益 | 手续费 | 滑点 | 净损益 |",
  "|---|---:|---:|---:|---:|",
  ...(["prior20Pairs", "btcEth"] as const).map((k) => {
    const a = audits.breakout15mAttribution[k];
    return `| ${k} | ${n(a.grossPnl, 2)} | ${n(a.fees, 2)} | ${n(a.slippage, 2)} | ${n(a.netPnl, 2)} |`;
  }),
  "",
  ...(["prior20Pairs", "btcEth"] as const).flatMap((k) => [
    `拒单 ${k}（尝试次数，重复重试可大于信号数）：`,
    ...Object.entries(audits.breakout15mAttribution[k].rejections).map(
      ([reason, count]) => `- ${reason}：${count}`,
    ),
    "",
  ]),
  "## 低位检测与收益贡献",
  "",
  "当前检测器与冻结沪深300全部5309行完全一致。指数数据2005起，2008没有最低5年预热。2012–2014价格分位最低25.352%、2016最低55.674%、2018–2019最低42.869%，都没有达到既定20%低位阈值；2019-01-03回撤虽达−44.621%，也不能替代价格分位条件。原R2a提及2008、2018的是个股示例，其沪深300指数同样只有2024-01-17—09-30一轮；没有为了凑周期修改阈值。",
  "",
  `收益很高不等于指数周期证据充分。以下按原连续账户的每日净值损益在唯一指数低位周期内/外归属，含期间持仓和个股触发，二者严格相加；这不是把周期内独立复利收益与周期外收益相加。原冻结ATR全期实际为+1504.46%；派单中的243–329%对应inSample训练段（9变体实际范围${pct(Math.min(...lowOriginal.checkpoints.map((p) => p.row.inSample.return!)))}—${pct(Math.max(...lowOriginal.checkpoints.map((p) => p.row.inSample.return!)))}），不是连续全期。ATR/移动/时间三基础变体的训练收益分别${lowOriginal.checkpoints
    .filter((p) => !p.row.id.includes("neighbor"))
    .map((p) => pct(p.row.inSample.return))
    .join("、")}；连续全期分别${lowOriginal.checkpoints
    .filter((p) => !p.row.id.includes("neighbor"))
    .map((p) => pct(p.fullPeriod.return))
    .join("、")}。`,
  "",
  "| 全市场低位变体 | 全期收益 | 指数周期内损益 | 周期外损益 | 合计损益 |",
  "|---|---:|---:|---:|---:|",
  ...low.contributions.map(
    (c) =>
      `| ${c.id} | ${pct(c.fullReturn)} | ${n(c.indexCyclePnl, 2)} | ${n(c.outsideIndexCyclePnl, 2)} | ${n(c.totalPnl, 2)} |`,
  ),
  "",
  "低位一律保留“不足3完整指数周期”和“历史温度/财务版本置信度不足”阻断，个股很多次触发不能冒充多个独立市场周期。337只恢复证券若缺少冻结PIT估值，保持缺失/价量观察，不补造估值；敏感性结果仍有输入置信度限制。",
  "",
  `换为中证800指数后，同一阈值识别${mainCycles.cycles.filter((c) => c.complete).length}个完整周期：${mainCycles.cycles.map((c) => c.start + "—" + c.end).join("；")}。该指数从2007-01-15起，与沪深300从2005起的历史分位分布不同，2012年是否触发随输入而异，不是调整阈值。下表是每个周期独立本金的真实执行，另列两项压力；日历滚动窗仍并列展示，不能把6个滚动窗当作6个独立市场周期。`,
  "",
  "| 主口径低位变体/指数周期 | 扣费收益/原始超额/夏普差 | 成本×2收益/夏普差 | 延迟收益/夏普差 | 闭合交易/回撤 |",
  "|---|---|---|---|---|",
  ...mainCycles.rows.flatMap((r) =>
    r.cycles.map(
      (c) =>
        `| ${r.id}/${c.start}—${c.end} | ${pct(c.base.return)} / ${pct(c.base.excess)} / ${n(c.base.riskAdjusted?.sharpeDifference)} | ${pct(c.doubledCost.return)} / ${n(c.doubledCost.riskAdjusted?.sharpeDifference)} | ${pct(c.delayed.return)} / ${n(c.delayed.riskAdjusted?.sharpeDifference)} | ${c.base.trades} / ${pct(c.base.drawdown)} |`,
    ),
  ),
  "",
  "## 新旧门槛",
  "",
  "新口径：多数OOS窗口夏普差>0且扣费绝对收益>0，留出同样满足；成本×2和延迟1根分别满足多数OOS及留出，二者不要求是同一组正窗口。旧口径保留原始超额>0（原压力正窗使用二者同时通过的交集）。回撤≤25%、闭合交易≥30、OOS≥3、正窗≥60%、邻域≥50%、DSR≥0.95不变；低位另须≥3完整周期及可靠输入。邻域仍按冻结训练段原始超额>0判定，不借新门槛调整参数。",
  "",
  `全族试验 ${score.trialCount} 项：主/对照所有变体、337只两种终值及实际组合/条件分仓统一分布。不同日历与长度不能拼成一个均匀CSCV收益矩阵，因此不伪造全族PBO；DSR按共同试验夏普分布及各候选OOS观察计算。计数/方差/逐试验夏普在scoreboard产物。重放相同参数和相同输入不重复算成新的策略试验。`,
  `试验夏普可估${score.availableTrialSharpes}/${score.trialCount}，共同日频夏普方差${n(score.trialSharpeVariance.value)}，紧缩日频夏普门槛${n(score.deflatedSharpeThreshold.value)}。条件分仓的无资金日为不适用，不纳入该分仓观察；并未删除试验，也未将其填0或把账户缺失行情当成无资金日。首次汇总误把两个分仓的无资金日当缺失而导致全族DSR不可估，已纠正并重评；逐项数字与验证见scoreboard-dsr-correction.json。`,
  "",
  "修改口径是在看过阶段结果之后，数据挖掘偏差不能靠事后DSR消除。规则统一、参数不动，新旧字段同时披露；两种主池变化属用户另行明确授权，不能写成整批“证券池未变”。",
  "",
];
function section(scope: string, title: string) {
  const rows = score.rows.filter((r) => r.scope === scope);
  lines.push(
    `## ${title}`,
    "",
    `共${rows.length}行。留出范围${[...new Set(rows.map((r) => r.holdout.start + "—" + r.holdout.end))].join("；")}。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。`,
    "",
    "| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of rows)
    lines.push(
      `| ${r.id} | ${pct(r.holdout.base.return)} / ${pct(r.holdout.base.excess)} / ${n(r.holdout.base.riskAdjusted?.sharpeDifference)} | ${pct(r.holdout.doubledCost.return)} / ${n(r.holdout.doubledCost.riskAdjusted?.sharpeDifference)} | ${pct(r.holdout.delayed.return)} / ${n(r.holdout.delayed.riskAdjusted?.sharpeDifference)} | ${r.positiveWindows}/${r.oosWindows} / ${r.oldPositiveWindows}/${r.oosWindows} · ${r.closedTrades} | ${pct(r.worstDrawdown)} / ${pct(r.stableNeighbors)} / ${n(r.dsr.value)} | ${verdict(r.newPassed)} / ${verdict(r.oldPassed)} |`,
    );
  lines.push(
    "",
    "逐项失败代码（完整逐窗和原始字段见scoreboard产物）：",
    "",
    ...rows.map(
      (r) =>
        `- ${r.id}：新 ${r.newReasons.join(", ") || "无"}；旧 ${r.oldReasons.join(", ") || "无"}。`,
    ),
    "",
  );
}
section("csi800", "A股主口径：当前中证800可执行258只");
section("btc-eth", "数字货币主口径：BTC/ETH");
lines.push(
  "### BTC/ETH各50%持有基准并列",
  "",
  alternate.basis,
  "",
  "| 候选 | 对50/50留出原始超额 | 对50/50留出夏普差 |",
  "|---|---:|---:|",
  ...alternate.rows.map(
    (r) =>
      `| ${r.id} | ${pct(r.holdout.base.excess)} | ${n(r.holdout.base.sharpeDifference)} |`,
  ),
  "",
);
section("prior1638", "全市场1638只对照（旧冻结输入、同一新旧门槛重评）");
section("prior20", "20币对对照（旧冻结输入、同一新旧门槛重评）");
lines.push(
  "## 旧对照组合与分仓（全期描述数据）",
  "",
  "以下旧组合没有独立滚动、留出及两项压力的证据。新旧口径均不允许晋级；全期数据不能冒充留出。旧分仓只冻结了条件收益、回撤和有效日数，未记录的夏普差、成交数不填0。它们及所有旧分仓试验向量仍进入同一个DSR试验族。",
  "",
  "| 对照/配置/层级 | 份额 | 全期收益/原始超额/夏普差 | 回撤 | 相关性/共同有效日 | 新/旧资格 |",
  "|---|---|---|---|---|---|",
  ...score.comparisonBooks.flatMap((book) =>
    book.variants.flatMap((v) => [
      `| ${book.scope}/${v.name}/组合 | ${JSON.stringify(v.shares)} | ${pct(v.score.return)} / ${pct(v.score.excess)} / ${n(v.score.riskAdjusted?.sharpeDifference)} | ${pct(v.score.drawdown)} | ${n(v.correlation)} / ${v.overlapDays} | 缺独立OOS/留出/压力，不晋级 / 同左 |`,
      ...v.sleeves.map(
        (s) =>
          `| ${book.scope}/${v.name}/${s.sleeve} | ${pct(v.shares[s.sleeve])} | ${pct(s.return)} / 未记录 / 未记录 | ${pct(s.drawdown)} | 有效日${s.observed} | 缺独立OOS/留出/压力，不晋级 / 同左 |`,
      ),
    ]),
  ),
  "",
);
section("prior-native-prefix", "固定420序列的已完成前N只原生对照");
lines.push(
  `原生有效观测总数${nativeProgress.completed.length}：固定420序列的前${score.rows.find((r) => r.scope === "prior-native-prefix")!.symbols}只用于全市场对照，另外按预定规则补${nativeProgress.completed.length - score.rows.find((r) => r.scope === "prior-native-prefix")!.symbols!}只，使中证800完成交集达到${capture.csiIntersection.length}只。累计已落盘采集耗时${(nativeProgress.elapsedMs / 60000).toFixed(1)}分钟（含补足，异常退出未落盘工作另记）。完成前缀按原序列，补足按事先固定符号顺序，不看收益选择。子集以2010年前已有足够预热的证券为主，存在年龄及流动性选择偏差，不能推广至整个市场或800成分。v22没有append接口，仍为逐前缀O(n²)；三只全历史逐bar完全一致，仅减少请求表和解码。`,
  "",
);
section("books-cn", "A股共享账户组合与条件分仓");
section("books-crypto", "BTC/ETH共享账户组合与条件分仓");
lines.push(
  "组合全部使用看结果前固定ATR预设：A股RPS+低位动态0/30/35/40及静态65/35；加密4h双均线+1h突破，75/25、80/20、70/30，共用原生15m执行时钟，时间止损按周期长度换算、站立止损逐15m监控。分仓为真实共享账户中的条件收益，先扣资金转入转出再算TWR，首次获得资金之前为null；不能把独立回测按权重平均。组合/分仓有独立滚动、留出和压力分数，但分配对照不等于退出参数邻域验证，保守阻断该项晋级。相关性及划拨见books产物。",
  "",
  "每个独立验证段初始100万（A股人民币、数字货币USDT），不跨市场换算或合账。冻结等额槽位为波段10、短线3、低位5并分3批；分仓单笔风险上限波段/短线2%、低位10%，还受等额槽位与可用现金约束。这些是研究预设，应用提醒默认风险/份额未修改。只调拨闲置现金：静态配置每20根执行bar到期或偏离5%触发（A股约20交易日，crypto15m时钟约5小时）；动态目标在每个目标输入日也触发，A股动态逐日给目标，因此每日均可调拨。对应条件是 due || drift || target.date===date，不强卖持仓。延迟压力推迟择时信号1根执行bar，站立保护仍执行；组合crypto延迟1根=15分钟，单策略按其原生周期，不混作相同时长。",
  "",
  "## 全市场337只终止覆盖敏感性",
  "",
  "排除=1638只；最后价和零值=1975只。估值只在终止覆盖日调整会计持仓并释放情景现金，不伪造市场成交或退市回收款。下表完整重跑各候选全期与原留出；不把它描述为已跑两套额外滚动/压力资格。按2b最新指示，这是稳健性参考，不阻断中证800主口径；当前258只执行子集已排除终止覆盖；800原名单仍有sz000831这1个尾部覆盖异常，不能把缺行情当成退市，也不能宣称800数据齐备。当前名单另有历史成分前视。全期/留出差异也受新增证券争用共享现金影响。",
  `恢复的${terminalCoverage.audit.length}只中，${terminalCoverage.audit.filter((r) => r.studyBars === 0).length}只在2010研究起点前已结束行情，没有研究期可交易bar；另${terminalCoverage.audit.filter((r) => r.studyBars > 0).length}只至少有1根研究期bar。输入名单保留全部337只，没有为无行情证券补造价格。`,
  "",
  ...["swing", "low"].flatMap((kind) => [
    kind === "low" ? "### 低位长线敏感性（单列）" : "### 波段敏感性",
    "",
    "| 候选 | 排除 全期/留出收益 | 最后价 全期/留出收益 | 零值 全期/留出收益 | 留出敏感区间 |",
    "|---|---|---|---|---|",
    ...score.rows
      .filter(
        (r) =>
          r.scope === "prior1638" &&
          r.scenarios &&
          (kind === "low"
            ? r.family === "historical-low"
            : r.family !== "historical-low"),
      )
      .map((r) => {
        const [a, b, c] = r.scenarios!;
        const values = [
          a!.holdout.return,
          b!.holdout.return,
          c!.holdout.return,
        ].filter((v): v is number => v !== null);
        return `| ${r.id} | ${pct(a!.full.return)} / ${pct(a!.holdout.return)} | ${pct(b!.full.return)} / ${pct(b!.holdout.return)} | ${pct(c!.full.return)} / ${pct(c!.holdout.return)} | ${pct(Math.min(...values))}—${pct(Math.max(...values))} |`;
      }),
    "",
  ]),
  "完整三情景回撤、交易数、夏普差与各终值结算条目见scoreboard与sensitivity产物；价量低位的财富效应不构成去除幸存者偏差后的盈利证据。若某变体终止日没有持仓，两种终值可能相同；0次终值结算不能证明没有幸存者偏差。新增证券改变共享现金竞争，即使从未持有至终止日，也可能改变收益路径。",
  ...score.rows
    .filter(
      (r) =>
        r.scope === "prior1638" &&
        r.id === "r2a-cn-equity-historical-low-atr" &&
        r.scenarios,
    )
    .map((r) => {
      const [excluded, last, zero] = r.scenarios!;
      return `低位ATR例：排除口径全期${pct(excluded!.full.return)}，恢复后最后价${pct(last!.full.return)}、零值${pct(zero!.full.return)}，高收益对筛选口径敏感。留出最后价${pct(last!.holdout.return)}、${last!.holdout.events?.fills}笔成交/${last!.holdout.trades}笔闭合交易；零值${pct(zero!.holdout.return)}、${zero!.holdout.events?.fills}笔成交/${zero!.holdout.trades}笔闭合交易。两个恢复情景的信号计数均为入场${last!.holdout.events?.entries}/离场${last!.holdout.events?.exits}，但实际成交路径不同。零值收益并非必然最差；这是共享资金重跑，不是固定成交后只减一笔终值的单调对照，不能将两个情景作线性损失分解。`;
    }),
  "",
  "## 最接近的五项与份额建议",
  "",
  "先按未满足的规则代码数排序，再按留出夏普差降序、ID兜底；组合代码可能包含多个条件，逐项差距见下表。",
  "",
  ...score.closest.flatMap((r) => [
    "- **" +
      r.scope +
      "/" +
      r.id +
      "**：" +
      r.reasons.join(", ") +
      "。差距（严格大于0，null为不可得）：",
    "",
    ...closestDetails(r.scope, r.id),
    "",
  ]),
  ...["books-cn", "books-crypto"].flatMap((scope) => [
    scope === "books-cn" ? "### A股份额依据" : "### BTC/ETH份额依据",
    "",
    ...score.rows
      .filter((r) => r.scope === scope && r.level === "market")
      .map(
        (r) =>
          `- ${r.id}：留出净收益${pct(r.holdout.base.return)}、夏普差${n(r.holdout.base.riskAdjusted?.sharpeDifference)}；成本×2净收益${pct(r.holdout.doubledCost.return)}，延迟净收益${pct(r.holdout.delayed.return)}。新口径${verdict(r.newPassed)}，失败：${r.newReasons.join(", ") || "无"}。`,
      ),
    "",
  ]),
  "BTC/ETH组合的三组份额均未解决留出亏损，不能因80/20相对少亏就宣称最佳配置。15m突破毛收益41.90万，被费用76.73万及滑点38.36万吞噬，净亏73.19万（固定实际成交归因）。建议短线突破研究份额暂设0或仅影子观察；限BTC/ETH不足以解决高周转成本。0份额本身未做组合回测，不给它虚构收益，也不把释放资金自动转入4h波段；后者仍须独立通过资格与前向观察。",
  "",
  "A股动态与静态组合的实际留出数列如上；单段静态65/35表现不能证明低位35%有可靠优势。低位只有2轮完整中证800周期，且缺可靠时点输入，不因高历史收益建议真实加仓。BTC/ETH仍沿用冻结的波段10槽位，两品种最多占两个等额槽，份额上限不等于满仓暴露；没有事后改成2槽。所有份额只是研究建议，应用默认设置未修改。",
  "",
  "## 重放、校验与边界",
  "",
  "引擎核验见`.test-data/r2a4/engine-audit-gate.json`；逐候选进度指针和gzip SHA随delivery交接。原R2a3的94个gzip均通过原hash/build/JSON验证，没有坏检查点；原95文件先无损重包，保留原压缩字节SHA与映射，不放宽100文件/4GiB/256MiB/8GiB上限。native、CSI、官方源、337只输入均单独冻结；代码计算身份不混用历史结果build。",
  "",
  "研究脚本必须设置绝对QUANT_DATA_DIR为本任务data；不得使用默认生产库。单文件校验、非法数据与毫秒/微秒、已完成live/归档替换、零值/最后价、T+1/跳空等已做固定输入验证。真实七阶段检查、desktop:prepare、P0浏览器和BarStore计时以delivery.gates最终记录为准，不以本段代替退出码。无数据库迁移；不替换正式包、不发通知、不下单、不提交或推送。任务清理脚本默认预演，持久归档和重放输入保留。",
  "",
);
await writeFile("docs/research/2026-11-scoreboard.md", lines.join("\n"));
await delivery({
  report: "docs/research/2026-11-scoreboard.md",
  sleeveAdvice: {
    defaultSettingsChanged: false,
    cn: "Compare actual dynamic and65/35 holdout/stress rows;one holdout cannot establish35% low-zone advantage. Only2 complete CSI800 cycles and uncorroborated vintages;no live allocation increase.",
    crypto:
      "All75/25,80/20,70/30 books lose in holdout. Recommend breakout0 or shadow pending qualification;0-weight return was not backtested. Do not automatically reallocate to4h swing or claim80/20 optimal. Frozen10 swing slots remain;capital share is not deployed exposure.",
  },
});
console.log(JSON.stringify({ report: true, rows: score.rows.length }));
process.exit(0);
