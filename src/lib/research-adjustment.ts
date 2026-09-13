import { z } from "zod";

export const researchAdjustmentSchema = z.enum(["none", "backward"]);
export type ResearchAdjustment = z.infer<typeof researchAdjustmentSchema>;
export const bonusAdjustmentAssumptions = [
  "仅送转后复权：信号因子累计乘以 1 + bonusRatio（新增股/原股），不含现金分红或配股；成交与估值用原始价，策略和买入持有股数仅跟送转。",
  "现金分红不调股数、不入现金，仅计数；残余除息跳空仍影响信号和净值，不是总回报。主动策略交易会改变，收益偏差方向不保证。",
  "配股不建模：category 1 且 rightsRatio>0，以及 11/12 扩缩股、13/14 权证，包含预热及尾部的整段研究不可用。",
  "依据 W1 §8：类别 2/3/4/5/6/7/8/9/10 视为总股本或上市流通变动，不再次增加个人持股；类别 2/9 不重复计算类别 1 的送转。此简化不证明新股已经可卖。",
  "除权日开盘前调整原持仓；缺行情日顺延至下一观测，首根因子为 1。未还原登记持仓、送股上市可卖日；新增股视为立即可卖，不能作为真实交易业绩。",
  "碎股向下取整到整股，余股按生效观测日原始开盘价折现入现金（无费用），这是研究假设，不是实际零碎股分配或到账规则。",
  "成交量不复权；退市、历史税制、流动性和涨跌停排队未完整建模。GBBQ 是事后且可能不完整的观测，无事件记录不等于已证明无事件。",
  "在历史输入不变的前提下，追加未来事件不改写已有因子；修订历史事件或行情会改变结果，必须保留来源快照。",
];

export type AdjustmentDiagnostics = {
  exDividendDays: number;
  shareAdjustments: number;
  fractionalShares: number;
  rightsIssuesBlocked: number;
  dividendsIgnored: number;
  blockedEvents: {
    count: number;
    events: { date: string; category: number; reason: string }[];
  };
};
