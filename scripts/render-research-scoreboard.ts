/** Derive the Chinese handoff from content-addressed research artifacts.
 * pnpm exec tsx scripts/render-research-scoreboard.ts .test-data/r2a
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ValidationScoreboard } from "../src/server/db/validation-scoreboard";
import type { FrozenValidationInput } from "../src/server/research/validation-capture";
import type { replayValidationInput } from "../src/server/research/validation-replay";
import { createHash } from "node:crypto";

const task = resolve(process.argv[2] ?? ".test-data/r2a");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pct = (value: number | null) =>
  value === null ? "缺失" : `${(value * 100).toFixed(2)}%`;
const reason: Record<string, string> = {
  "insufficient-oos-windows": "样本外窗口不足",
  "oos-positive-excess-majority": "正超额窗口未过多数门槛",
  "cost-or-delay-stress": "成本/延迟压力未过门槛",
  "insufficient-closed-trades": "闭合交易数不足",
  "drawdown-bound": "回撤超过上限或缺失",
  "holdout-positive-excess": "末段留出超额非正或缺失",
  "parameter-neighborhood": "训练段数值邻域不稳定",
  "historical-universe-incomplete": "历史证券池不完整",
  "low-zone-input-confidence": "低位估值/温度置信不足",
  "historical-execution-unverified": "历史成交/到账未核验",
  "historical-venue-filters-and-liquidity-unverified":
    "历史平台数量规则/流动性未核验",
  "insufficient-complete-market-cycles": "完整市场周期不足",
};
const explain = (s: string) =>
  reason[s] ??
  (s.startsWith("multiple-testing-dsr-") ? `DSR未达${s.split("-").at(-1)}` : s);
const lines = [
  "# 2026-11 策略研究成绩单",
  "",
  "## 已证实",
  "",
  "本报告的数字由内容寻址输入和结果直接生成。这里的已证实指可核查的研究运行事实；规则自检、固定证券样本和样本外诊断均不等于可信策略业绩或实盘盈利证明。未通过门槛的策略保留research，不开启提醒实时模式、订阅或下单。",
  "",
];
for (const market of ["cn-equity", "crypto"] as const) {
  const summary = JSON.parse(
    await readFile(join(task, `${market}-result.json`), "utf8"),
  ) as ValidationScoreboard & { captureMs: number };
  const root = join(task, "data/research-validation");
  const frozen = JSON.parse(
    await readFile(join(root, `input-${summary.inputHash}.json`), "utf8"),
  ) as FrozenValidationInput;
  const archive = JSON.parse(
    await readFile(join(root, `report-${summary.resultHash}.json`), "utf8"),
  ) as { inputHash: string; result: ReturnType<typeof replayValidationInput> };
  if (
    hash(frozen) !== summary.inputHash ||
    hash(archive) !== summary.resultHash ||
    archive.inputHash !== summary.inputHash
  )
    throw new Error("Research artifact hash mismatch");
  const result = archive.result,
    policy = frozen.input.policy;
  lines.push(
    `### ${market === "cn-equity" ? "A股" : "数字货币"}`,
    "",
    `输入：\`input-${summary.inputHash}.json\`；结果：\`report-${summary.resultHash}.json\`。策略/撮合构建：\`${frozen.strategyBuildHash}\`；研究/评价适配构建：\`${frozen.validationBuildHash}\`。`,
    "",
    `请求区间 ${frozen.input.start} 至 ${frozen.input.end}。本次运行 ${Math.round(summary.runtimeMs)} 毫秒，采集/冻结 ${Math.round(summary.captureMs)} 毫秒。候选成绩行 ${result.rows.filter((r) => r.level === "strategy").length}，可监视候选 ${result.promoted.length}，未运行候选 ${result.missing.length}。这些数量分别取结果rows/promoted/missing，并非全市场策略数量。`,
    "",
    `默认/本次门槛：样本外至少 ${policy.minimumWindows} 窗口，至少 ${(policy.minimumPositiveWindows * 100).toFixed(0)}% 窗口扣费后正超额；最大回撤 ${pct(policy.maximumDrawdown)}；至少 ${policy.minimumTrades} 个闭合交易；训练段数值邻域正超额比例至少 ${(policy.minimumStableNeighbors * 100).toFixed(0)}%；DSR至少 ${policy.minimumDsr}。低位长线另需至少 ${policy.minimumMarketCycles} 个完整市场周期及足够输入置信。成本翻倍、延后一根的多数窗口和末段留出均须通过。历史池/成交证据未核验时不能晋级。门槛在运行前冻结，代码中的配置可由用户显式修改，本轮未下调。`,
    "",
    "训练窗固定长度向前滚动，参数只在训练窗按超额、回撤、稳定ID排序选择；各测试窗独立本金。初始训练段用于数值退出邻域，末20%作为固定留出诊断，与滚动样本外重叠，不能累计为额外独立样本。邻域在样本外揭示前声明为ATR倍数、移动幅度或时间长度±10%。保护单不随延迟压力撤销，延后一根只作用于自主入退场。",
    "",
    "| 周期 | 实际研究区间 | 标的数 | 原始/信号根数 | 基准 |",
    "|---|---|---:|---:|---|",
  );
  for (const d of frozen.datasets)
    lines.push(
      `| ${d.period} | ${d.dates[0]} 至 ${d.dates.at(-1)} | ${d.instruments.length} | ${d.instruments.reduce((n, i) => n + i.bars.length, 0)} | ${d.benchmarkName} |`,
    );
  if (!frozen.datasets.length)
    lines.push("| 无 | 无可用行情 | 0 | 0 | 未补造 | ");
  lines.push(
    "",
    "基准为同窗首个观测开盘买入并持有，A股为沪深300价格指数（无股息）；币种为同来源BTC持有。缺任一基准日时超额留空。分段复用独立quant-performance；币种这里展示收益/回撤，未将252日年化结果当作币种年化业绩。",
    "",
  );
  if (frozen.universe)
    lines.push(
      `免费池可枚举 ${frozen.universe.members.length} 个证券；覆盖等级 \`${frozen.universe.grade}\`；可信缓存已退市下界 ≥ ${frozen.universe.knownDelisted}。没有可枚举痕迹的已移除证券、沪深代码变更及缺少上市日期的成员不能补造。本轮样本由预先排序等距名单选取，包含已知退市缓存的优先项；实际研究不是全市场。原生三买仅使用预先确定的两个可用证券子集。`,
      "",
    );
  lines.push(
    `来源排除 ${frozen.excluded.length} 项；数据缺口 ${frozen.gaps.length} 项。`,
    "",
  );
  for (const e of frozen.excluded)
    lines.push(
      `- ${e.symbol} / ${e.period}：${e.reason.replaceAll("\n", " ")}`,
    );
  for (const gap of frozen.gaps) lines.push(`- ${gap}`);
  lines.push(
    "",
    "#### 策略成绩",
    "",
    "表中收益、超额、回撤和两种压力均为末20%留出段；闭合交易数、正超额窗口数来自滚动样本外之和，不与留出交易数混同。详细逐窗训练选择、压力、市场状态和统计退化原因见结果的suites字段。每个策略对象在包内登记runnable并保存定义；runnable表示规则可执行。",
    "",
    "| 策略 | 分仓 | 训练收益/超额 | 留出收益/超额/回撤 | 成本×2超额 / 延迟超额 | 正超额/窗口 · 闭合交易 | 样本外入场观察/订单/成交/拒单尝试 | 结论 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const row of result.rows.filter((r) => r.level === "strategy")) {
    const detail = result.suites
      .flatMap((s) => s.suite.rows)
      .find((r) => r.id === row.id)!;
    const events = detail.windows.reduce(
      (sum, w) => ({
        entries: sum.entries + w.base.events.entries,
        orders: sum.orders + w.base.events.orders,
        fills: sum.fills + w.base.events.fills,
        rejected: sum.rejected + w.base.events.rejectionAttempts,
      }),
      { entries: 0, orders: 0, fills: 0, rejected: 0 },
    );
    lines.push(
      `| ${row.id} | ${row.sleeve} | ${pct(detail.inSample.return)} / ${pct(detail.inSample.excess)} | ${pct(row.return)} / ${pct(row.excess)} / ${pct(row.drawdown)} | ${pct(detail.holdout.doubledCost.excess)} / ${pct(detail.holdout.delayed.excess)} | ${row.positiveWindows}/${row.oosWindows} · ${row.trades} | ${events.entries}/${events.orders}/${events.fills}/${events.rejected} | ${row.status}：${row.reasons.map(explain).join("；")} |`,
    );
  }
  lines.push(
    "",
    "每行偏差标签随服务端成绩单保存：A股信号为固定截止前复权、RPS为后复权、成交原价；现金按除息日入账是情景假设，ST/IPO/队列与真实到账未核验。低位PE/PB采用本地财务/市值数学并严格过滤公告可见日，当前修订不冒充首次披露；历史市场温度缺失不会用均线状态替代。币种使用单一公开现货来源，数量步长和费用是研究情景，当前高流动性名单不证明历史退市覆盖或容量。",
    "入场观察、订单、成交笔数和闭合轮次是不同集合；保护单/退出可增加订单，受阻卖单可重复尝试，所以拒单尝试数可能大于独立订单数。入场观察或成交为零时不归因任何执行阶段原因，资格栏的未核验项只是数据准入缺口，不是零信号或亏损的已证实原因。",
    "",
    "#### 分仓与组合账本",
    "",
    "组合使用事先声明的固定ATR代表，不按样本外最优结果拼装；表中组合为全期描述回放。分仓收益扣除每根bar现金划转后连乘，零资本bar留空，不将资金流当收益。分仓相关性只用两边均有效的同日收益，少于20日或零方差留空。",
    "",
  );
  for (const book of result.combinedBooks) {
    lines.push(`- ${book.period}：${book.boundary}`);
    for (const v of book.variants) {
      lines.push(
        `  - ${v.name} / ${JSON.stringify(v.shares)}：组合收益 ${pct(v.score.return)}，超额 ${pct(v.score.excess)}，回撤 ${pct(v.score.drawdown)}；分仓相关性 ${v.correlation === null ? "缺失" : v.correlation.toFixed(4)}（重叠 ${v.overlapDays} 日），现金划转 ${v.transfers.length} 笔。`,
      );
      for (const s of v.sleeveScores)
        lines.push(
          `  - ${v.name}/${s.sleeve}：有效 ${s.observed} 日，划转中性收益 ${pct(s.return)}，回撤 ${pct(s.drawdown)}。`,
        );
    }
  }
  if (!result.combinedBooks.length)
    lines.push("无足够共同时间轴，组合未运行，未平均独立策略收益代替。");
  if (result.lowZone.length) {
    lines.push(
      "",
      "#### 独立低位检测与周期",
      "",
      "低位价格分位采用<=当前价的经验比例；至少5个日历年且1000个观察。价格分位≤20%且距前高回撤≥30%为第一档，≤10%且回撤≥45%为第二档，≤5%且回撤≥60%为第三档；份额30%/35%/40%，非低位0%。已知估值/温度分位须≤30%佐证，缺失标签保留。价格分位恢复≥60%、距高点不足15%或已知估值分位≥70%定义恢复。所有条件只读当前及以前的完成数据。",
      "",
    );
    for (const l of result.lowZone) {
      lines.push(
        `- ${l.symbol}：观察 ${l.coverage.start} 至 ${l.coverage.end}，共 ${l.coverage.observations} 根；入低位/加深 ${l.triggers.length} 次；周期 ${l.cycles.length}，其中完整 ${l.cycles.filter((c) => c.complete).length}。`,
      );
      for (const t of l.triggers)
        lines.push(
          `  - ${t.date}：档${t.depth}，目标${pct(t.targetShare)}，置信${t.confidence}；价格分位${pct(t.price.value)}，回撤${pct(t.drawdown.value)}；PE/PB/温度分别 ${t.pe.confidence}/${t.pb.confidence}/${t.temperature.confidence}。`,
        );
    }
    lines.push(
      "",
      "长线策略另按指数低位→恢复的市场周期独立回放，不用短窗口表现代替完整周期。检测覆盖早于成交研究区间的周期，仅是检测器历史事实，缺少可支持公司行动的完整执行输入时不宣称已经回测其长线资金业绩。",
      "",
    );
    for (const c of result.cycleEvaluations)
      for (const cycle of c.cycles)
        lines.push(
          `- ${c.id} / ${cycle.start} 至 ${cycle.end} / ${cycle.complete ? "完整" : "未结束"}：收益${pct(cycle.evaluation.return)}，超额${pct(cycle.evaluation.excess)}，回撤${pct(cycle.evaluation.drawdown)}，闭合交易${cycle.evaluation.trades}。`,
        );
  }
  if (result.missing.length) {
    lines.push("", "未运行候选：", "");
    for (const m of result.missing) lines.push(`- ${m.id}：${m.reason}`);
  }
  lines.push(
    "",
    `核查路径：\`report-${summary.resultHash}.json\` 的 \`result.rows\`、\`result.suites[*].suite\`、\`result.combinedBooks\`、\`result.lowZone\`；时间和采集耗时来自 \`${market}-result.json\`。重放使用隔离QUANT_DATA_DIR和 \`pnpm exec tsx scripts/research-validation.ts --market ${market} --replay ${summary.inputHash}\`，不得在构建身份漂移后静默重算。`,
    "",
  );
}
lines.push(
  "## 推测与下一步",
  "",
  "本轮尚不能区分价格规则本身、样本证券选择、公司行动排除、市场状态和实验成交条件各自造成的影响，不能归因其解释了全部失败。可在新的预先冻结训练方案里研究过滤与退出；本次样本外结果不得回头用于本次参数选择。优先补全历史证券日期、退市行情、财务首次版本和真实平台数量/容量证据；费用敏感的分钟规则需要独立后续窗口验证。",
  "",
  "所有晋级结果只是研究资格；持续真实影子观察、提醒对账和账户核验仍是独立运行验收。本报告不触发通知、实时模式或交易。",
  "",
);
await mkdir("docs/research", { recursive: true });
await writeFile("docs/research/2026-11-scoreboard.md", lines.join("\n"));
console.log(
  "Generated docs/research/2026-11-scoreboard.md from verified artifact hashes",
);
