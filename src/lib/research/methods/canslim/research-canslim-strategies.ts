import type { Bar } from "../../../domain";
import {
  canslimMarketIds,
  canslimMarketStrategies,
  isCanslimMarket,
  canslimMarketCombinationIds,
  isCanslimMarketCombination,
  canslimMarketCombinationDefinition,
} from "./research-canslim-market-strategies";

export const canslimHighIds = [
  "canslim-high-90",
  "canslim-high-95",
  "canslim-high-98",
  "canslim-high-100",
] as const;
export type CanslimHighId = (typeof canslimHighIds)[number];
export function isCanslimHigh(id: string): id is CanslimHighId {
  return (canslimHighIds as readonly string[]).includes(id);
}
export const canslimHighPoints: Record<CanslimHighId, number> = {
  "canslim-high-90": 3,
  "canslim-high-95": 6,
  "canslim-high-98": 9,
  "canslim-high-100": 9,
};
/** Include the previous observation's complete window for threshold crossing. */
export function canslimHighWarmupStart(bars: readonly Bar[], start: string) {
  const first = bars.findIndex((bar) => bar.date >= start);
  const previous = bars[Math.max(0, first - 1)]?.date ?? start;
  return new Date(Date.parse(previous) - 364 * 86400000)
    .toISOString()
    .slice(0, 10);
}
function highDefinition(id: CanslimHighId) {
  const ratio = id.slice("canslim-high-".length);
  return {
    label: `CANSLIM新高 · 达到52周高点${ratio}%`,
    family: "成长股价量",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      id === "canslim-high-98"
        ? "canslim-analyst/SKILL.md"
        : "canslim-analyst/references/canslim-scoring.md",
    ],
    description: `${id === "canslim-high-98" ? "入口简表98%二值版：达到98%计9分，否则0分；独立于细则90/95/100%分层。" : ""}N2独立因子实验：收盘相对截至当日52周最高价评分首次从低于${canslimHighPoints[id]}分达到该分档，下一交易时点买入。52周为364自然日左开右闭且含当日最高价，须有起点或更早记录；前一有效观察也必须能计算，不从缺失状态产生上穿。滚动高点下降也可能触发。无额外放量或平台枢纽追价条件，沿用持有期和可选组合风控；不是完整CANSLIM。无公司行动证明覆盖首个研究观察的前一观察日减364自然日至期末，交易日全集与历史证券池仍需独立验证。`,
  };
}
const highStrategies = Object.fromEntries(
  canslimHighIds.map((id) => [id, highDefinition(id)]),
) as Record<CanslimHighId, ReturnType<typeof highDefinition>>;
export const canslimSaucerIds = [
  "canslim-saucer-u",
  "canslim-saucer-w",
  "canslim-saucer-u-hold3",
  "canslim-saucer-w-hold3",
] as const;
export type CanslimSaucerId = (typeof canslimSaucerIds)[number];
export function isCanslimSaucer(id: string): id is CanslimSaucerId {
  return (canslimSaucerIds as readonly string[]).includes(id);
}
export function canslimSaucerShape(id: CanslimSaucerId) {
  return /-w(?:-|$)/.test(id) ? "W" : "U";
}
export function canslimShapeWarmup(id: string) {
  if (id.startsWith("canslim-volume-") || isCanslimMarket(id)) return 25;
  return (isCanslimSaucer(id) ? 140 : 50) + (id.endsWith("-hold3") ? 3 : 0);
}
function saucerDefinition(id: CanslimSaucerId) {
  const hold = id.endsWith("-hold3");
  return {
    label: `CANSLIM价量 · ${canslimSaucerShape(id)}形碟形${hold ? "三日维持" : "突破"}`,
    family: "成长股价量",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/references/entry-exit-rules.md",
    ],
    description: `复用25至120日碟形识别，按${canslimSaucerShape(id)}形独立筛选，深度不超15%、底部量低于整理前20日均量60%、评分至少6；收盘首次高于枢纽1%且不超5%，量至少前20日均量1.5倍。候选按分数、周期、枢纽降序选择。${hold ? "冻结突破枢纽，随后三个研究日历日最低价均不低于枢纽，第三日收盘不超105%确认；缺日拒绝，不回填突破日。" : "突破收盘确认，未等待三日维持。"}下一可成交开盘含滑点价须在枢纽至105%内，越界取消。固定持有及可选组合风控，无公司行动证明覆盖研究期及前${canslimShapeWarmup(id)}根。识别窗口与底部几何为工程定义，不含完整CANSLIM因子或原文分批退出。`,
  };
}
const saucerStrategies = Object.fromEntries(
  canslimSaucerIds.map((id) => [id, saucerDefinition(id)]),
) as Record<CanslimSaucerId, ReturnType<typeof saucerDefinition>>;
export const canslimCupIds = [
  "canslim-cup-u-window120",
  "canslim-cup-w-window120",
  "canslim-cup-total-score",
  "canslim-cup-total-score-hold3",
  "canslim-cup-u-right-not-higher",
  "canslim-cup-w-right-not-higher",
  "canslim-cup-u-right-not-higher-hold3",
  "canslim-cup-w-right-not-higher-hold3",
  "canslim-cup-u",
  "canslim-cup-w",
  "canslim-cup-u-hold3",
  "canslim-cup-w-hold3",
  "canslim-cup-v-score",
  "canslim-cup-v-score-hold3",
  "canslim-cup-u-half-handle",
  "canslim-cup-w-half-handle",
  "canslim-cup-v-half-handle",
  "canslim-cup-u-half-handle-hold3",
  "canslim-cup-w-half-handle-hold3",
  "canslim-cup-v-half-handle-hold3",
] as const;
export type CanslimCupId = (typeof canslimCupIds)[number];
export function isCanslimCup(id: string): id is CanslimCupId {
  return (canslimCupIds as readonly string[]).includes(id);
}
export function canslimCupShape(id: CanslimCupId) {
  return id.includes("-v-") ? "V" : /-w(?:-|$)/.test(id) ? "W" : "U";
}
function cupDefinition(id: CanslimCupId) {
  if (id.endsWith("-window120"))
    return {
      label: `CANSLIM价量 · ${canslimCupShape(id)}杯柄120根窗口`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/SKILL.md",
        "canslim-analyst/references/technical-patterns.md",
      ],
      description:
        "仅取截至观察日最近120根日线，窗口未满保持缺失。复用严格杯柄、柄深三分之一、缩量及至少6分规则，U/W分名；首次收盘超过枢纽1%、不超过5%、量至少此前20日均量1.5倍，次日含滑点成交限枢纽至105%。固定持有及可选风控。与完整前缀版对照，不覆盖超过120根的杯形，不是完整CANSLIM。",
    };
  if (id.includes("-total-score"))
    return {
      label: `CANSLIM价量 · 杯柄总分确认${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `按五项十分制至少6分选杯柄：形状U/W/V/未分类计3/2/1/0，杯深15%至30%计2否则1，柄深不超杯深三分之一/二分之一计2/1否则0，柄量低于杯量60%/80%计2/1否则0，周期1分。柄评分依综合表仅看深度，不附加缩量或平稳门槛；分项0分不单独否决，保留各硬条件证据。基础几何仍需杯35至325日、深12至33%、杯沿上下5%、柄至少5日且上半部，柄无额外上限。候选按分数、杯周期、柄长度、枢纽降序。首次收盘越枢纽1%且不超5%、突破量至少前20均量1.5倍。${id.endsWith("-hold3") ? "随后三研究日历日最低价不破原枢纽且第三日收盘不超105%确认，缺日拒绝。" : "突破收盘确认。"}次日起含滑点成交限枢纽至105%，逐事件公司行动证明覆盖左沿前3条及研究期。固定持有及可选风控，与严格形态版独立，不是完整CANSLIM。`,
    };
  if (id.includes("-right-not-higher"))
    return {
      label: `CANSLIM价量 · ${canslimCupShape(id)}形杯柄（右沿不高）${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `右杯沿最高价在左杯沿95%至100%之间（含边界），不接受右沿更高；与原上下5%对称容差版独立比较。沿用${canslimCupShape(id)}形、杯35至325日/深12至33%、柄至少5日且上半部、回调不超杯深三分之一并缩量、柄量低于杯量80%和总分至少6，柄无额外长度上限。先过滤杯沿再按分数、杯周期、柄长度、枢纽降序择优。首次收盘越枢纽1%且不超5%、量至少前20均量1.5倍。${id.endsWith("-hold3") ? "随后三个研究日历日最低价不破原枢纽，第三日收盘不超105%确认，缺日拒绝。" : "突破收盘确认。"}次日起含滑点成交限枢纽至105%，公司行动证明逐事件覆盖左沿前3条至期末及研究期；固定持有及可选风控，不是完整CANSLIM。`,
    };
  if (id.includes("-half-handle"))
    return {
      label: `CANSLIM价量 · ${canslimCupShape(id)}形杯柄（柄1分）${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `仅选${canslimCupShape(id)}形杯柄的柄质量1分分支：回调不超杯深二分之一，柄后半均量为前半90%至110%（含边界，量能平稳的工程定义）；浅柄且缩量优先计2分，不混入本预设。保留杯35至325日、深12至33%、柄至少5日且上半部、柄量低于杯量80%和总分至少6，柄无额外长度上限。候选按分数、杯周期、柄长度及枢纽降序。首次收盘越枢纽1%且不超5%，突破量至少前20均量1.5倍。${id.endsWith("-hold3") ? "随后三个研究日历日最低价不破原枢纽，第三日收盘不超105%才确认，缺日拒绝。" : "突破日收盘确认。"}次日起含滑点成交限枢纽至105%，逐事件核验左杯沿前3条起点及研究期无公司行动证明。固定持有和可选风控，不是完整CANSLIM；平稳范围及分档优先级随版本保存。`,
    };
  return {
    label: `CANSLIM价量 · ${canslimCupShape(id)}形杯柄${canslimCupShape(id) === "V" ? "评分对照" : ""}${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
    family: "成长股价量",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/references/entry-exit-rules.md",
    ],
    description: `逐历史前缀复用${canslimCupShape(id)}杯柄${canslimCupShape(id) === "V" ? "评分对照（V形1分，其余门槛保留）" : "严格识别"}：杯35至325日、深12至33%，柄至少5日且上半部回撤不超杯深三分之一、缩量，评分至少6。不额外设置柄长度上限；候选按分数、杯周期、柄长度及枢纽降序选择。收盘首次越枢纽1%且不超5%，量至少前20均量1.5倍。${id.endsWith("-hold3") ? "随后三个研究日历日最低价均不破原枢纽，第三日收盘不超105%确认，缺日拒绝。" : "突破日收盘确认，不等三日维持。"}次日起含滑点成交价须在枢纽至105%内，越界取消。保存左杯沿前3条起点及原枢纽；选中形态窗口含已知除权则剔除该事件，无公司行动证明覆盖研究期及选中窗口。固定持有与可选风控，几何口径为工程定义；完整CANSLIM及原文分批退出继续。`,
  };
}
const cupStrategies = Object.fromEntries(
  canslimCupIds.map((id) => [id, cupDefinition(id)]),
) as Record<CanslimCupId, ReturnType<typeof cupDefinition>>;
export const canslimPriorityIds = [
  "canslim-priority-exits-daily",
  ...canslimMarketCombinationIds,
  "canslim-priority-gate2-fallback",
  "canslim-priority-weekly10-half",
  "canslim-priority-bear4-previous",
  "canslim-priority-bear4-ma20",
  "canslim-priority-volume-wait3",
  "canslim-priority-volume-wait5",
  "canslim-priority-fail3-low",
  "canslim-priority-fail3-close",
  "canslim-priority",
  "canslim-priority-hold3",
  "canslim-priority-scored-handles",
  "canslim-priority-scored-handles-hold3",
] as const;
export type CanslimPriorityId = (typeof canslimPriorityIds)[number];
export function isCanslimPriority(id: string): id is CanslimPriorityId {
  return (canslimPriorityIds as readonly string[]).includes(id);
}
function priorityDefinition(id: CanslimPriorityId) {
  if (id === "canslim-priority-exits-daily")
    return {
      label: "CANSLIM价量 · 周线与放量大阴退出组合",
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description:
        "严格杯柄→平台→碟形突破组合。收盘跌超4%且量至少此前20日均量1.5倍清仓，已完成周线10MA下穿减剩余50%，全退优先、受阻重试、T+1。页面选择时装配固定8%止损、盈利15%保本、20%卖初始一半且成交后抬成本、25%清余仓、自然28天涨幅不足5%退出，最长60交易日。4.1成本版与4.2盈利10%版有冲突，本组合明确采用4.1成本版。组合风控参数独立保存，可改为自定义实验；禁用风控后仅剩周线与大阴退出。次日开盘含滑点须在枢纽至105%，公司行动证明覆盖完整形态前缀。日线工程组合，未含市场连续分布日、明显放量下跌减仓、盘中跳空或14:30动作，不是完整CA08或CANSLIM。",
    };
  if (isCanslimMarketCombination(id))
    return canslimMarketCombinationDefinition(id);
  if (id === "canslim-priority-gate2-fallback")
    return {
      label: "CANSLIM价量 · 杯柄低于4分才替代",
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/SKILL.md",
        "canslim-analyst/references/technical-patterns.md",
      ],
      description:
        "以五项总分版杯柄按分数、周期、柄长、枢纽降序选择；最高分4至5分保持观察，不检查替代形态，至少6分且几何合格才准入。无杯柄或最高分低于4才依次检查平台、碟形；高分但几何不合格亦不降级。复用首次收盘越枢纽1%、量至少此前20日均量1.5倍、追价不超5%，下一可成交开盘限枢纽至105%；固定持有和可选风控。此保守交易解释与原文继续分析相区别，不是完整CANSLIM。",
    };
  if (id === "canslim-priority-weekly10-half")
    return {
      label: "CANSLIM价量 · 周线下破10周均线减半",
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description:
        "严格形态优先级突破入场。已完成周线收盘从不低于10周均线到严格低于均线时，减当时剩余持仓50%；均线包含该已完成周，须有前一周可比均线，持续在线下不重复卖，恢复后再下穿再减半。周五收盘确认；周五休市的短周在下一周首条行情收盘确认，不回填到节前。缺研究日历行情或零量的周不可用，最初不完整周不参与均线。数量按实际卖出规则向下取整，不强行清掉不足半手的尾仓；卖出受阻保留原目标，已有全仓退出优先，已有部分卖出不叠加新目标。信号与证据独立于当前是否仍有买点，不取消未成交买入。入场含滑点限枢纽至105%，完整前缀公司行动证明沿用；页面切换此预设设置60交易日最长持有，仍可手动调整。周线时点与重复减仓为工程定义，不是完整CANSLIM。",
    };
  if (id.includes("-bear4-"))
    return {
      label: `CANSLIM价量 · 跌超4%放量退出（${id.endsWith("previous") ? "较昨日" : "20日1.5倍"}）`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `严格杯柄→平台→碟形优先级直接突破入场；收盘较前一研究交易日严格下跌超过4%，且${id.endsWith("previous") ? "成交量严格大于前一日" : "成交量至少为此前20个研究交易日均量1.5倍"}，收盘确认清仓，下一可成交开盘执行。原文未给放量阈值，本版本显式采用此工程定义；4%等号不退出，缺日、零量或无效窗口不造信号，不要求阴线实体或跌破枢纽。退出适用于本股持仓并取消此前未成交买入，价格恢复不撤销已确认退出，受阻按既有规则重试。入场含滑点限枢纽至105%，完整输入前缀及研究期公司行动证明沿用优先级版；最长持有及可选风控有效，不含完整CANSLIM。`,
    };
  if (id.includes("-volume-wait"))
    return {
      label: `CANSLIM价量 · 低量突破等待${id.endsWith("3") ? 3 : 5}日补量`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `仅研究严格杯柄→平台→碟形优先级的低量首次突破：收盘越枢纽1%且不超5%，当日量严格低于此前20条均量时启动。冻结原候选和枢纽，等待其后最多${id.endsWith("3") ? 3 : 5}个研究日历日；当日量达到此前20条均量1.5倍且收盘仍越原枢纽1%、不超5%才确认，下一可成交开盘含滑点限原枢纽至105%。初日量在1至1.5倍之间不属低量等待样本。期间收盘低于枢纽、超过105%、缺日或行情无效即取消，末日可确认否则过期，不按新形态替换原候选。等待期限及取消规则为工程定义，原文未给天数；记录初始与确认日，不回填信号。完整输入前缀及研究期公司行动证明复用，固定持有及可选风控，不是完整CANSLIM。`,
    };
  if (id.includes("-fail3-"))
    return {
      label: `CANSLIM价量 · 三日失败${id.endsWith("-low") ? "最低价" : "收盘"}退出`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `沿用严格杯柄→平台→碟形优先级直接突破入场，不等待三日维持。冻结原突破日及枢纽，随后三个研究日历日（不含突破当日）${id.endsWith("-low") ? "最低价" : "收盘价"}严格低于原枢纽即失败，等于不触发；日线完成后确认，下一可成交开盘退出。未成交的原买入意图取消，已成交不后验撤销；失败绑定原突破，不能退出另一事件的持仓。缺日不顺延三日窗口，缺当日有效行情不造触发；卖出受阻保留意图，恢复价格也不撤销，遵守T+1及实际成交规则。最长持有和可选组合风控仍有效。入场含滑点限枢纽至105%，完整输入前缀及研究期公司行动证明沿用优先级版；不是完整CANSLIM。`,
    };
  if (id.includes("-scored-handles"))
    return {
      label: `CANSLIM价量 · 形态优先级（评分柄）${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "canslim-analyst/references/technical-patterns.md",
        "canslim-analyst/references/entry-exit-rules.md",
      ],
      description: `杯柄允许U/W/V，合并两分浅柄缩量和一分半深柄平稳分支，总分至少6，仍保留上半部、柄量低于杯量80%及周期/深度门槛。平稳为后半均量占前半90%至110%，浅柄缩量优先两分；并非仅总分通过即可入场。合格杯柄优先，其次平台、碟形，族内按分数、周期、柄长度、枢纽降序；先选形态再确认，不因未突破或量不足降级。首次收盘越枢纽1%且不超5%、量至少前20均量1.5倍。${id.endsWith("-hold3") ? "随后三个研究日历日最低价不破原枢纽，第三日收盘不超105%确认，缺日拒绝。" : "突破收盘确认。"}次日起含滑点成交限枢纽至105%；无公司行动证明覆盖完整输入前缀及研究期。固定持有及可选风控，不是完整CANSLIM，严格形态版独立保留。`,
    };
  return {
    label: `CANSLIM价量 · 形态优先级${id.endsWith("-hold3") ? "三日维持" : "突破"}`,
    family: "成长股价量",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/references/entry-exit-rules.md",
    ],
    description: `先在严格合格形态中按杯柄、平台、碟形选择，再确认突破；高优先级未突破、量不足或追价超限时不改选低优先级。杯柄仅U/W严格柄，沿用各家族几何及分数、周期、柄长度、枢纽降序择优；不混入V形或柄1分评分对照。收盘首次越枢纽1%且不超5%，量至少前20日均量1.5倍。${id.endsWith("-hold3") ? "随后三个研究日历日最低价不破原枢纽，第三日收盘不超105%才确认，缺日拒绝。" : "突破收盘确认。"}次日起含滑点成交限枢纽至105%。优先级判断使用完整历史前缀，无公司行动证明须覆盖整个输入前缀及研究期；固定持有及可选风控，不是完整CANSLIM。`,
  };
}
const priorityStrategies = Object.fromEntries(
  canslimPriorityIds.map((id) => [id, priorityDefinition(id)]),
) as Record<CanslimPriorityId, ReturnType<typeof priorityDefinition>>;
export const canslimResearchIds = [
  "canslim-volume-tier",
  "canslim-volume-tier-crash",
  ...canslimMarketIds,
  "canslim-volume-entry-binary",
  "canslim-flat-price-volume",
  "canslim-flat-hold3",
  ...canslimHighIds,
  ...canslimSaucerIds,
  ...canslimCupIds,
  ...canslimPriorityIds,
] as const;
export type CanslimResearchId = (typeof canslimResearchIds)[number];
export function isCanslimResearch(id: string): id is CanslimResearchId {
  return (canslimResearchIds as readonly string[]).includes(id);
}
export const canslimResearchStrategies = {
  "canslim-volume-tier": {
    label: "CANSLIM量能 · 近5日峰量分层",
    family: "成长股价量",
    signal: "technical" as const,
    version: "canslim-volume-tier-1",
    sources: ["canslim-analyst/references/canslim-scoring.md"],
    description:
      "S1分层独立实验：近5日峰量/此前20日均量，至少2/1.5/1.2倍分别8/6/3分，否则0；两窗不重叠，前后连续有效评分从低于8到8才确认。次日合法开盘入场，固定持有及可选风控，无枢纽限价。25日OHLCV及日历必须完整，无公司行动证明覆盖研究期及前25根。未加入涨停缩量或市场暴跌例外，不等于完整S1或CANSLIM。",
  },
  "canslim-volume-tier-crash": {
    label: "CANSLIM量能 · 分层排除暴跌放量日",
    family: "成长股价量",
    signal: "technical" as const,
    version: "canslim-volume-tier-crash-1",
    sources: ["canslim-analyst/references/canslim-scoring.md"],
    description:
      "S1分层具名工程版：近5日峰量/此前20日均量至少2/1.5/1.2倍给8/6/3分，否则0。近5日内沪深300较前日收跌至少3%、个股收跌且量大于前日的日期从峰量候选排除，20日基准不变，不向更早日补位；5日全排除则不可用。3%为暴跌工程阈值，不是原文明确值；未实现涨停缩量例外。沪深300独立来源冻结，近6日市场与25日个股日历/OHLCV完整，缺失不造上穿。由低于8到8收盘确认，次日合法开盘、固定持有和可选风控，无枢纽限价；公司行动证明覆盖研究期及前25根。不是完整CANSLIM或盈利证据。",
  },
  ...canslimMarketStrategies,
  "canslim-volume-entry-binary": {
    label: "CANSLIM量能 · 近5日峰量1.5倍二值评分",
    family: "成长股价量",
    signal: "technical" as const,
    version: "canslim-volume-entry-binary-1",
    sources: ["canslim-analyst/SKILL.md"],
    description:
      "入口S1独立二值组件：近5日最高成交量至少为此前20日均量1.5倍计8分，否则0分。两窗不重叠，不等同突破当日放量或细则3/6/8分。完整连续25个研究交易日且OHLCV有效；前后评分由0到8时收盘确认，下一可成交开盘买入，固定持有及可选组合风控；首次已知评分不造上穿。无额外枢纽或追价门槛，无公司行动证明覆盖研究期及前25根。不含涨停缩量/大盘暴跌例外，不是完整CANSLIM或盈利证据。",
  },
  ...priorityStrategies,
  ...highStrategies,
  ...saucerStrategies,
  ...cupStrategies,
  "canslim-flat-hold3": {
    label: "CANSLIM价量 · 平台三日维持",
    family: "成长股价量",
    signal: "technical" as const,
    version: "research-canslim-flat-hold3-1",
    sources: [
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/references/entry-exit-rules.md",
    ],
    description:
      "沿用平台严格突破候选，冻结其枢纽；随后三个研究日历日均有有效日线且最低价不低于枢纽，第三日收盘仍不超枢纽105%才确认。次日开盘含滑点价在枢纽至105%内才买入。固定持有期价量对照，最低价判定为工程口径；不含完整CANSLIM因子与退出。无公司行动证明覆盖研究期及前53根，保留突破日与确认日，不回填信号。",
  },
  "canslim-flat-price-volume": {
    label: "CANSLIM价量 · 平台突破",
    family: "成长股价量",
    signal: "technical" as const,
    version: "research-canslim-flat-1",
    sources: [
      "canslim-analyst/references/technical-patterns.md",
      "canslim-analyst/references/entry-exit-rules.md",
    ],
    description:
      "复用15至30日平台严格诊断，评分至少6，收盘首次越过枢纽1%、不超过5%，量至少前20日均量1.5倍；候选按分数、周期、枢纽价降序选择。下一可成交开盘含滑点价格须在枢纽至枢纽105%内，越界取消；固定持有期退出，可叠加组合风控。这是纯价量对照，不含财务、RS、M、催化、板块过滤或三日维持，不等于完整CANSLIM。无公司行动证据须覆盖研究期及前50根。",
  },
};
