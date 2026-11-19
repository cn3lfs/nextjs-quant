/**
 * 全站直白中文交易词汇。
 *
 * 同一个概念在接口、日志和旧页面里常有英文枚举名；界面只显示这里的中文，
 * 避免「影子」「sleeve」「冻结快照」这类需要内部背景才能读懂的词。
 * 未收录的值原样返回，便于发现遗漏，而不是悄悄显示成空白。
 */
export const glossary = {
  off: "已关闭",
  shadow: "观察模式（不推送）",
  live: "正式提醒",
  sleeve: "策略分仓",
  frozenSnapshot: "选股当时快照",
  paperAccount: "本地模拟盘",
  ruleCheckOnly: "仅规则自检（非实盘业绩）",
  stale: "已过期（历史批次）",
  unverified: "待核验",
  freshClose: "本次收盘",
  intraday: "盘中观察",
  outbox: "推送队列",
  decay: "表现下滑预警",
  protection: "止损保护价",
} as const;
export type GlossaryTerm = keyof typeof glossary;

export function termLabel(term: string | null | undefined): string {
  if (term == null || term === "") return "—";
  return (glossary as Readonly<Record<string, string>>)[term] ?? term;
}

export const alertModeLabels = {
  off: glossary.off,
  shadow: glossary.shadow,
  live: glossary.live,
} as const;
export type AlertMode = keyof typeof alertModeLabels;

export function alertModeLabel(mode: string | null | undefined): string {
  if (mode == null || mode === "") return "—";
  return (alertModeLabels as Readonly<Record<string, string>>)[mode] ?? mode;
}

export const marketLabels = {
  "cn-equity": "A 股",
  crypto: "数字货币",
  futures: "期货",
} as const;
export type MarketKey = keyof typeof marketLabels;

export function marketLabel(market: string | null | undefined): string {
  if (market == null || market === "") return "—";
  return (marketLabels as Readonly<Record<string, string>>)[market] ?? market;
}
