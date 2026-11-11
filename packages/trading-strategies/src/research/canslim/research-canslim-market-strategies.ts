export const canslimMarketBinaryIds = [
  "canslim-market-entry-ma250",
  "canslim-market-entry-follow10",
  "canslim-market-entry-distribution20",
] as const;
export const canslimMarketTierIds = [
  "canslim-market-tier-ma250",
  "canslim-market-tier-ma200",
  "canslim-market-tier-follow10",
  "canslim-market-tier-distribution20",
] as const;
export const canslimMarketIds = [
  ...canslimMarketBinaryIds,
  ...canslimMarketTierIds,
] as const;
export type CanslimMarketId = (typeof canslimMarketIds)[number];
export const canslimMarketCombinationIds = [
  "canslim-priority-market-warning",
  "canslim-priority-market-m6",
  "canslim-priority-market-trend",
] as const;
export type CanslimMarketCombinationId =
  (typeof canslimMarketCombinationIds)[number];
export function isCanslimMarketCombination(
  id: string,
): id is CanslimMarketCombinationId {
  return (canslimMarketCombinationIds as readonly string[]).includes(id);
}
export function needsCanslimMarket(id: string) {
  return (
    isCanslimMarket(id) ||
    isCanslimMarketCombination(id) ||
    id === "canslim-volume-tier-crash"
  );
}
export function canslimMarketCombinationDefinition(
  id: CanslimMarketCombinationId,
) {
  return {
    label: `CANSLIM形态市场组合 · ${id.endsWith("warning") ? "低分警告继续分析" : id.endsWith("m6") ? "M至少6分" : "确认上升趋势"}`,
    family: "成长股价量",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      "canslim-analyst/references/canslim-scoring.md",
      "canslim-analyst/references/entry-exit-rules.md",
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/SKILL.md",
    ],
    description: `先完成严格杯柄→平台→碟形分析，再叠加沪深300市场过滤。M为正文MA250、跟进日、分布日三个细则分项之和，缺任一项不填零；低于6保留候选和醒目警告，继续分析不等于准许买入。${id.endsWith("trend") ? "确认上升趋势采用工程定义：M1=10且M2=8且总分至少6；不是原文唯一解释。" : "交易须M总分至少6，等于通过。"}形态原突破当日不通过就过滤，不在后日补买；形态及市场缺研究日历数据均不可用。市场评分沿用既有具名工程版本，完整输入前缀公司行动证明、次日合法开盘及枢纽至105%限价、固定持有及可选风控不变。不是完整CANSLIM或盈利证据。`,
  };
}
export function isCanslimMarket(id: string): id is CanslimMarketId {
  return (canslimMarketIds as readonly string[]).includes(id);
}
const rules: Record<CanslimMarketId, [string, string]> = {
  "canslim-market-tier-ma250": [
    "M1细则MA250",
    "正文MA250版：±1%含边界优先5分；在线上且均线上行、连续4日站上10分，其余线上7分；线下但高于MA120给3分，否则0分。满分10分上穿入场。",
  ],
  "canslim-market-tier-ma200": [
    "M1标题MA200",
    "标题MA200版，明确把正文主均线250替换为200，辅助MA120保持：±1%含边界优先5分；线上且均线上行、连续4日站上10分，其余线上7分；线下但高于MA120给3分，否则0分。满分10分上穿入场。",
  ],
  "canslim-market-tier-follow10": [
    "M2细则跟进日",
    "复用20日新低后首次收涨为反弹第1日，4至7日量价都满足给8分、只满足一项4分，否则0分；近10日最后候选被后续破低作废，不回退旧候选。以已冻结研究日历起点开始累积反弹状态，至少38日。满分8分上穿入场，不回填过去。",
  ],
  "canslim-market-tier-distribution20": [
    "M3细则分布日",
    "近20日分布日≤2给5分、3至4给3分、≥5给0分；最近5日至少3个分布日工程定义为集中，优先0分。满分5分上穿入场。",
  ],
  "canslim-market-entry-ma250": [
    "M1高于MA250",
    "沪深300收盘严格高于含当日MA250计10分，否则0分；不附上行或站稳要求。",
  ],
  "canslim-market-entry-follow10": [
    "M2十日放量上涨",
    "近10日任一天沪深300涨幅至少1.5%且量严格大于前日1.5倍计8分，否则0分；不附反弹第4至7日限制。",
  ],
  "canslim-market-entry-distribution20": [
    "M3分布日少于5",
    "近20日沪深300收跌且量严格大于前日的分布日少于5计5分，否则0分；不附集中分布修正。",
  ],
};
export const canslimMarketStrategies = Object.fromEntries(
  canslimMarketIds.map((id) => [
    id,
    {
      label: `CANSLIM市场${id.includes("-tier-") ? "分层" : "二值"} · ${rules[id][0]}`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        id.includes("-tier-")
          ? "canslim-analyst/references/canslim-scoring.md"
          : "canslim-analyst/SKILL.md",
      ],
      description: `${rules[id][1]}独立市场因子实验，前后有效评分由低于满分到满分时，在个股有效收盘观察确认，次日合法开盘买入，固定持有及可选风控。沪深300来源独立采集并冻结，不以收益基准上证指数或个股代替；缺完整交易日历、市场窗口或行情返回缺失，不从首次已知值产生上穿。个股公司行动证明覆盖研究期及前25根，无枢纽价格限制。不等于完整CANSLIM或真实盈利验证。`,
    },
  ]),
) as Record<
  CanslimMarketId,
  {
    label: string;
    family: string;
    signal: "technical";
    version: string;
    sources: string[];
    description: string;
  }
>;
