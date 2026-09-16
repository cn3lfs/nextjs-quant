import { sepaEliteDescription } from "./research-sepa-elite";
export const sepaResearchIds = [
  "sepa-vcp-exits-elite",
  "sepa-vcp-exits-daily",
  "sepa-vcp-retest",
  "sepa-vcp-weekly10-half",
  "sepa-vcp-close",
  "sepa-vcp-volume2",
  "sepa-vcp-volume25",
  "sepa-vcp-volume50",
  "sepa-vcp-bear4",
] as const;
export type SepaResearchId = (typeof sepaResearchIds)[number];
export function isSepaResearch(id: string): id is SepaResearchId {
  return (sepaResearchIds as readonly string[]).includes(id);
}
export const sepaResearchStrategies = Object.fromEntries(
  sepaResearchIds.map((id) => [
    id,
    {
      label: `SEPA价量 · ${
        {
          "sepa-vcp-exits-elite": "三周涨20%精英八周组合",
          "sepa-vcp-exits-daily": "周线与放量大阴退出组合",
          "sepa-vcp-retest": "枢纽突破后十日内回踩",
          "sepa-vcp-weekly10-half": "周线跌破10周均线减半",
          "sepa-vcp-close": "趋势VCP收盘突破",
          "sepa-vcp-volume2": "20日均量2倍",
          "sepa-vcp-volume25": "20日均量2.5倍",
          "sepa-vcp-volume50": "50日均量1.5倍",
          "sepa-vcp-bear4": "放量跌超4%退出",
        }[id]
      }`,
      family: "成长股价量",
      signal: "technical" as const,
      version: `${id}-1`,
      sources: [
        "sepa-strategy-analyst/SKILL.md",
        "sepa-strategy-analyst/references/vcp-pattern.md",
        "sepa-strategy-analyst/references/entry-exit-rules.md",
      ],
      description: `${id === "sepa-vcp-exits-elite" ? sepaEliteDescription : ""}${id === "sepa-vcp-exits-daily" || id === "sepa-vcp-exits-elite" ? "页面选择时装配MIN后10%修正版止损、15%保本、20%/30%各卖初始1/3并在实际成交后抬至成本/盈利20%、自然28天不足10%退出，日线版最长60交易日、精英版未达标20交易日；周线10MA下穿减剩余50%、跌超4%且量严格超过前20均量1.5倍全退。全退优先，受阻重试。风控参数独立保存可改为自定义，禁用后仅保留周线和大阴退出；精英规则仅精英具名版本启用；未包含2至3周复核及盘中跳空，非完整SE05。" : ""}纯价量对照，不是完整SEPA：突破前一日六项可计算趋势全部通过，不含RS。复用前一日60根VCP确认极值，至少2次收缩且每次递减30%，总分至少6。上升段工程定义为首个收缩高点之前60根窗口内最近最低收盘至高点前一日，须净上涨；所有评分分项可计算才准入。评分表逐项相加最高11，不按标题10截断。前一日冻结枢纽，首次收盘越枢纽1%且不超5%；当日量至少此前${id === "sepa-vcp-volume50" ? 50 : 20}日均量${id === "sepa-vcp-volume2" ? 2 : id === "sepa-vcp-volume25" ? 2.5 : 1.5}倍。次日可成交开盘含滑点限枢纽至105%，越界取消；固定持有及可选风控。${id === "sepa-vcp-bear4" ? "跌幅严格超过4%且当日量严格超过此前20日均量1.5倍，收盘确认全退，次日开盘执行。" : ""}${id === "sepa-vcp-retest" ? "回踩工程版v1：首次合格突破仅启动等待并冻结枢纽，其后1至10研究交易日最低价触及枢纽至101%、收盘重新严格站上101%且不超105%、量至少此前20日均量1.5倍才发入场。期间最低价破枢纽、收盘超105%、缺失或窗口届满取消；不回填突破日，不要求已成交后再买。" : ""}${id === "sepa-vcp-weekly10-half" ? "复用已完成周线10MA下穿减当时剩余持仓50%；持续线下不重复，恢复后再下穿再减，均线减仓本身不回补。周五完成或下一周首条确认短周，缺周线不补造；整手不足留尾仓，全退优先。" : ""}最近140根预热及当日日历不得缺失；更早52周高点沿用实际行情跨度口径，不声称拥有更早完整市场日历，零量/非法OHLC拒绝；公司行动证明覆盖完整输入前缀。`,
    },
  ]),
) as Record<
  SepaResearchId,
  {
    label: string;
    family: string;
    signal: "technical";
    version: string;
    sources: string[];
    description: string;
  }
>;
