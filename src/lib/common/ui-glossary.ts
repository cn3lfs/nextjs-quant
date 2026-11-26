/**
 * 全站直白中文交易词汇。
 *
 * 同一个概念在接口、日志和旧页面里常有英文枚举名；界面只显示这里的中文，
 * 避免「影子」「sleeve」「冻结快照」这类需要内部背景才能读懂的词。
 * 未收录的值原样返回，便于发现遗漏，而不是悄悄显示成空白。
 */
export const glossary = {
  off: "已关闭",
  shadow: "空跑观察",
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
  shadowForward: "空跑验证",
  paperForward: "模拟前推",
  notSetStop: "未设止损",
  touchedStop: "已触及止损",
  dualPriceSync: "双价同步",
} as const;
export type GlossaryTerm = keyof typeof glossary;

/** Localize legacy messages at render time so stored evidence stays intact. */
export function alertDisplayCopy(message: string): string {
  return message
    .replaceAll("仅影子记录", "仅空跑记录")
    .replaceAll("影子信号", "空跑信号")
    .replaceAll("影子前推", glossary.shadowForward)
    .replaceAll("影子扫描", "空跑扫描")
    .replace(/影子(?:(?:观察|执行)?模式|观察)/g, glossary.shadow)
    .replaceAll("手动确认模式", "人工确认模式")
    .replace(/[ \t]*\blive[ \t]*提醒/g, glossary.live);
}

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
