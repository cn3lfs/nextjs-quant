import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { task, json, delivery } from "./context";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { validationScoreboardPage } from "../../../src/server/db/validation-scoreboard";
type Score = {
  return: number | null;
  excess: number | null;
  riskAdjusted?: { sharpeDifference: number | null };
};
type Row = {
  scope: string;
  id: string;
  family: string;
  market: string;
  level: string;
  symbols: number | null;
  holdout: {
    start: string;
    end: string;
    base: Score;
    doubledCost: Score;
    delayed: Score;
  };
  oosWindows: number;
  positiveWindows: number;
  closedTrades: number;
  worstDrawdown: number | null;
  stableNeighbors: number;
  dsr: { value: number | null };
  globalDsr?: { value: number | null };
  newReasons: string[];
  newPassed: boolean;
  oldPassed: boolean;
  scenarios?: { valuation: string; full: Score; holdout: Score }[];
};
const score = await json<{
  supersededSizing: { changed: string[]; identicalRecomputations: string[] };
  trialCount: number;
  rows: Row[];
  promoted: string[];
  marketDistributions: Record<
    string,
    {
      trials: number;
      variance: { value: number | null };
      threshold: { value: number | null };
    }
  >;
  closest: { scope: string; id: string; reasons: string[]; gap: unknown }[];
}>(join(task, "scoreboard-summary.json"));
const csi = await json<{
  executableCount: number;
  excluded: { symbol: string; reason: string }[];
  source: string;
  sourceSha256: string;
  rosterSha256: string;
}>(join(task, "csi800.json"));
const alternate = await json<{
  basis: string;
  rows: {
    id: string;
    holdout: {
      base: {
        return: number | null;
        benchmarkReturn: number | null;
        excess: number | null;
        sharpeDifference: number | null;
      };
    };
  }[];
}>(join(task, "benchmark-50-50.json"));
const pct = (v: number | null) =>
  v === null ? "—" : `${displayNumber(v * 100, 2)}%`;
const n = (v: number | null | undefined) =>
  v == null ? "—" : displayNumber(v, 4);
const shadow = [];
for (const market of ["cn-equity", "crypto"] as const) {
  const first = validationScoreboardPage({ market, page: 0 });
  for (let page = 0; page < Math.ceil(first.total / 20); page++)
    shadow.push(
      ...validationScoreboardPage({ market, page }).rows.filter(
        (r) => r.status === "shadow-candidate",
      ),
    );
}
const lines = [
  "# 2026-11 R2a-5 策略研究成绩单",
  "",
  `晋级 ${score.promoted.length} 项；影子候选 ${shadow.length} 项。影子只求值、落库和记录T+5/10/20，不投递、不自动开启live。应用提醒、计划和份额默认值未改。`,
  "",
  "## 已证实的口径与限制",
  "",
  `当前中证800执行覆盖由258/800扩到${csi.executableCount}/800。源 ${csi.source}；源SHA256 ${csi.sourceSha256}；名单SHA256 ${csi.rosterSha256}。当前名单正式生效日未知，high current-constituents-lookahead保留；原5564只全市场RPS输入与排名政策不变，新增列与原重叠证券逐值对照见rps-expanded.json。基准000906原价指数，不含红利。`,
  "",
  "GBBQ送转、拆并股按权益调整数量与单位成本；现金分红按除权日现金到账情景；配股不参与，持股按理论除权价重估，审计保留。原股T+1锁保留。送转总权益向下取整到整股，不足一股残差披露且不虚构现金，不足一手的整股余额一次卖出。实际到账与中国结算余股分派未认证，不能把这些情景当成真实券商账本。",
  "",
  "BTC/ETH继续复用币安官方原样ZIP/CHECKSUM及原生周期；不重复下载。等权方式每品种上限为分仓资金1/N；第二种方式用此前60个完成UTC日收益样本标准差、365年化及预先固定30%目标波动缩减1/N上限，不加杠杆，缺预热不入场。止损风险预算、费用和退出参数保持，不保证把资金满投。两种仓位全部独立计入试验。",
  "",
  "DSR按市场计算并判定，全局混合DSR并列诊断。计入当前和此前主口径、对照、敏感性、实际组合及条件分仓全部实际试验；重复重放不算新试验。此变更在看过R2a-4结果之后提出，数据挖掘偏差仍存在。2025-06留出已经看过，重跑不能再叫纯样本外。真正的新证据从影子登记时刻开始。",
  `波动率缺日后旧权重沿用的问题已修复，权重次日失效，连续预热不足时禁止新增持仓。修复前原gzip字节和SHA另行封存；${score.supersededSizing.changed.length}项财务结果发生变化的实际试验作为pre-expiry对照计入数字货币DSR，${score.supersededSizing.identicalRecomputations.length}项逐字段完全相同的重复计算不增加N。修正只恢复此前声明，不改变30%/60日等参数。`,
  "",
  "回撤25%、闭合交易30、至少3个OOS窗口、正窗60%、邻域50%、DSR0.95和低位至少3完整周期等门槛不变；正窗、留出和两项压力均要求净收益及夏普差为正。低位仍缺第三完整指数周期及可靠财务/温度版本。",
  "",
  "| 试验范围 | N | 日频夏普方差 | DSR日频门槛 |",
  "|---|---:|---:|---:|",
  ...Object.entries(score.marketDistributions).map(
    ([market, d]) =>
      `| ${market} | ${d.trials} | ${n(d.variance.value)} | ${n(d.threshold.value)} |`,
  ),
  `| 全局（仅诊断） | ${score.trialCount} | 见冻结产物 | 见冻结产物 |`,
  "",
  "剩余排除逐只列出：",
  ...csi.excluded.map((e) => `- ${e.symbol}：${e.reason}`),
  "",
  "## 主口径候选与组合",
  "",
  "新/旧判定指风险调整/原始超额两套收益规则；两者在本批都使用市场DSR。历史数值对照也按本批试验族重评；原R2a-4混合DSR判定完整冻结并可精确重放，不能把本表新重评当原判定。回撤是OOS/留出及成本×2、延迟压力中的最坏值。原生三买沿用事先固定的已完成观察子集，不冒称800只全部有原生观察。",
  "",
  "| 市场/口径/候选 | 留出净收益 / 原始超额 / 夏普差 | 成本×2净收益 / 夏普差 | 延迟净收益 / 夏普差 | 正窗 / 闭合交易 | 最坏DD / 邻域 | 市场DSR / 全局DSR | 新/旧判定 |",
  "|---|---|---|---|---|---|---|---|",
];
for (const r of score.rows)
  lines.push(
    `| ${r.market}/${r.scope}/${r.id} (${r.symbols ?? "组合"}) | ${pct(r.holdout.base.return)} / ${pct(r.holdout.base.excess)} / ${n(r.holdout.base.riskAdjusted?.sharpeDifference)} | ${pct(r.holdout.doubledCost.return)} / ${n(r.holdout.doubledCost.riskAdjusted?.sharpeDifference)} | ${pct(r.holdout.delayed.return)} / ${n(r.holdout.delayed.riskAdjusted?.sharpeDifference)} | ${r.positiveWindows}/${r.oosWindows} / ${r.closedTrades} | ${pct(r.worstDrawdown)} / ${pct(r.stableNeighbors)} | ${n(r.dsr.value)} / ${n(r.globalDsr?.value)} | ${r.newPassed ? "通过" : "未通过"}/${r.oldPassed ? "通过" : "未通过"} |`,
  );
lines.push(
  "",
  "## BTC/ETH各50%持有对照",
  "",
  "每个窗口在两品种首个原生开盘价各投入50%，无再平衡，基准不计交易成本。策略收益及夏普均先与主产物复算核对；该表仅改变比较基准，不改变主要门槛或策略收益。",
  "",
  "| 候选 | 留出策略净收益 | 50/50持有 | 原始超额 | 夏普差 |",
  "|---|---:|---:|---:|---:|",
  ...alternate.rows.map(
    (r) =>
      `| ${r.id} | ${pct(r.holdout.base.return)} | ${pct(r.holdout.base.benchmarkReturn)} | ${pct(r.holdout.base.excess)} | ${n(r.holdout.base.sharpeDifference)} |`,
  ),
  "",
  "逐项阻断（完整窗口及差距在冻结scoreboard产物）：",
  "",
  ...score.rows.map(
    (r) => `- ${r.scope}/${r.id}：${r.newReasons.join("；") || "无"}`,
  ),
  "",
  "## 影子候选与选取依据",
  "",
  "每市场、每分仓取策略行的前2项：先按未通过条件数升序，再按留出夏普差降序，ID兜底；剔除留出净收益非正/不可得及最坏DD大于50%/不可得。登记后开始计数，已有留出不计入。达到30个信号或60个实际观察市场日后按同一门槛给建议；证据不足继续显示原因，用户仍须手动开启live及订阅。",
  "",
  "| 市场/分仓/候选 | 起始时间 | 信号/市场日 | 选择原因 |",
  "|---|---|---:|---|",
);
for (const r of shadow)
  lines.push(
    `| ${r.market}/${r.sleeve}/${r.id} | ${r.shadow ? new Date(r.shadow.startedAt).toISOString() : "待登记"} | ${r.shadow?.signals ?? 0}/${r.shadow?.days ?? 0} | 失败${r.reasons.length}项，留出夏普差${n(r.riskAdjusted?.sharpeDifference)} |`,
  );
lines.push(
  "",
  "## 最接近的五项与份额建议",
  "",
  ...score.closest.flatMap((c) => [
    `- ${c.scope}/${c.id}：${c.reasons.join("；")}`,
    "",
    `差距：${JSON.stringify(c.gap)}`,
    "",
  ]),
  "所有份额只作建议，默认值未改。组合配置不能替代退出参数邻域检验；低位周期/财务缺口不因高收益消失。按市场与仓位分别列出实际留出结果，不能按少亏或一个窗口宣称最佳份额：",
  "",
  ...score.rows
    .filter(
      (r) =>
        ["books-cn", "books-crypto"].includes(r.scope) && r.level === "market",
    )
    .map(
      (r) =>
        `- ${r.id}：净收益${pct(r.holdout.base.return)}，夏普差${n(r.holdout.base.riskAdjusted?.sharpeDifference)}，最坏DD ${pct(r.worstDrawdown)}；${r.newPassed ? "通过统计门槛，仍只供手动选择" : "未通过，先影子观察"}。`,
    ),
  "",
  "## 推测与前向验证边界",
  "",
  "这些带当前成分前视、历史成交/到账与财务版本缺口的规则研究不能冒充可信可投资业绩。程序测试与冻结重放不证明盈利。影子尚无自然时间积累时样本数如实为0；固定时钟fixture不计入真实前推。T+5/10/20是无成本价格观察，界面继续标记非策略业绩；前推资格另用实际观察bar和事先记录的决策回放费用、压力及门槛。",
  "本批影子名单登记在绝对隔离研究库 `.test-data/r2a5/data`，主库未写入，没有启动常驻研究服务。要积累自然样本，在已完成构建后将QUANT_DATA_DIR设为该库绝对路径并运行 `pnpm start`，在数据与连接中核对通达信目录及已有币安官方归档目录。只有登记后实际观察到的完成bar计数；应用关闭期间不补造记录。正式库发布与打包仍由管理者另行安排，本批不冒称已在用户生产应用运行。",
  "",
  "## 重放、验证与收尾",
  "",
  "入口：`pnpm exec tsx scripts/research.ts <子命令> --config research/configs/r2a5.json`，先设置本任务绝对QUANT_DATA_DIR。旧成绩单：replay子命令配r2a4.json与隔离replay-r2a4/data，逐项比较完整JSON，包含全部数字。原gzip无损重包后仍按原SHA核验。真实退出码、首次失败、资源与清理记录见 `.codex-runs/delivery.json`；不以此文本替代门禁。无提交、推送、正式打包、生产库操作或真实通知/交易。",
  "",
);
await writeFile("docs/research/2026-11-scoreboard.md", lines.join("\n"));
await delivery({
  shadowCandidates: shadow.map((r) => ({
    id: r.id,
    market: r.market,
    sleeve: r.sleeve,
    startedAt: r.shadow?.startedAt,
    signals: r.shadow?.signals ?? 0,
    days: r.shadow?.days ?? 0,
    reasons: r.reasons,
  })),
  report: "docs/research/2026-11-scoreboard.md",
});
console.log(
  JSON.stringify({
    report: true,
    rows: score.rows.length,
    shadow: shadow.length,
  }),
);
process.exit(0);
