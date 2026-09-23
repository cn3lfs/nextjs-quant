import type { Bar } from "../../domain";
import type { ResearchManagement } from "../workflow/research-management";
export const growthDailyIds = [
  "SE-D-review23",
  "SE-D-targets",
  "SE-D-partial2030",
  "SE-P-tplus",
  "SE-P-standard",
  "CA-D-volume-sell",
  "CA-D-distribution5",
  "CA-P-full",
  "CA-P-add23",
  "CA-E-cooldown",
  "CA-E-reward25",
] as const;
export type GrowthDailyId = (typeof growthDailyIds)[number];
export const growthDailyLabels: Record<GrowthDailyId, string> = {
  "SE-D-review23": "SEPA两至三周形态复核",
  "SE-D-targets": "SEPA第二目标至少3R准入",
  "SE-D-partial2030": "SEPA 20%/30%各减三分之一与周线尾仓",
  "SE-P-tplus": "SEPA T+1 1.5%风险/25%单股/5只",
  "SE-P-standard": "SEPA标准2%风险/30%单股/8只",
  "CA-D-volume-sell": "CANSLIM明显放量下跌减半",
  "CA-D-distribution5": "CANSLIM连续五分布日减半",
  "CA-P-full": "CANSLIM一次买入全部目标仓位",
  "CA-P-add23": "CANSLIM涨2%至3%与量市确认补半仓",
  "CA-E-cooldown": "CANSLIM止损后同股冷静三交易日",
  "CA-E-reward25": "CANSLIM第一目标至少2.5R准入",
};
export const growthDailyDescription =
  "B1a日线工程版v1，SEPA以纯价量VCP为基线、CANSLIM以严格形态优先级为基线，非完整体系。复核为首仓后自然14/21天各一次：到期首个研究日收盘（缺失不可用，不顺延）涨不足5%时检验冻结枢纽，收盘低于枢纽才次开盘退出，否则记录继续观察。SEPA目标20%/30%，以第二目标30%除实际初始止损距离至少3倍准入；独立分批版20%/30%各卖初始1/3，实际成交后抬成本/盈利20%，剩余以10周均线下穿减半管理。仓位标准版2%风险、30%单股、最多8只；T+1版1.5%、25%、最多5只，采用原范围上界，标准版也遵守A股T+1。CANSLIM放量下跌工程定义为收跌且量严格超此前20日均量1.5倍，每次从不满足转满足减剩余50%；分布日为沪深300收跌至少0.2%且量大于前日，连续第5个减剩余50%，第6个不再减，断开后重计；缺日不凑数。一次建仓按1.5%风险/25%单股算目标100%买入；加仓版先50%，其后收盘较首仓涨2%至3%（含两端）、量大于此前20日均量、沪深300当日涨跌幅绝对值小于2%才补至原计划，下一开盘仍须在2%至3%及冻结枢纽105%内，超界取消；复用已有加仓费用风险保护并只抬止损，最多补一次。冷静工程版为止损成交当日及随后3研究交易日同股禁买，第4日恢复，其他证券不受影响；不沿用期间过期信号。回报门槛以第一目标20%除实际初始止损距离至少2.5倍，非凯利历史盈亏比。全部收盘动作下一合法开盘成交，费用/整手/停牌/涨跌停/最长持有有效。";
export function growthDailyBase(id: GrowthDailyId) {
  return id === "SE-D-partial2030"
    ? ("sepa-vcp-weekly10-half" as const)
    : id.startsWith("SE-")
      ? ("sepa-vcp-close" as const)
      : ("canslim-priority" as const);
}
export function growthDailyTemplate(id: GrowthDailyId): ResearchManagement {
  return {
    growthDaily: id,
    stop: { kind: "percent", fraction: id.startsWith("SE-") ? 0.1 : 0.08 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
    ...(id === "SE-D-targets" ? { maxInitialStopDistance: 0.1 } : {}),
    ...(id === "CA-E-reward25" ? { maxInitialStopDistance: 0.08 } : {}),
    ...(id === "SE-D-partial2030"
      ? {
          scaleOut: [
            { atR: 2, fraction: 1 / 3, raiseStopR: 0 },
            { atR: 3, fraction: 1 / 3, raiseStopR: 2 },
          ],
        }
      : {}),
    ...(id === "CA-P-add23"
      ? { pyramid: { kind: "r-50-30-20" as const, maxTotalWeight: 1 } }
      : {}),
  };
}
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.high >= Math.max(b.open, b.close) &&
  b.low <= Math.min(b.open, b.close);
function window(
  bars: readonly Bar[],
  calendar: readonly string[],
  date: string,
  count: number,
) {
  const index = calendar.indexOf(date),
    dates = calendar.slice(index - count + 1, index + 1),
    map = new Map(bars.filter((b) => b.date <= date).map((b) => [b.date, b]));
  const rows = dates.map((d) => map.get(d));
  return dates.length === count && rows.every((b): b is Bar => !!b && valid(b))
    ? rows
    : null;
}
export function growthVolumeReduction(
  bars: readonly Bar[],
  calendar: readonly string[],
  date: string,
) {
  const rows = window(bars, calendar, date, 22);
  if (!rows) return null;
  const check = (offset: number) =>
    rows[offset + 20]!.close < rows[offset + 19]!.close &&
    rows[offset + 20]!.volume >
      rows.slice(offset, offset + 20).reduce((s, b) => s + b.volume / 20, 0) *
        1.5;
  return check(1) && !check(0);
}
export function growthDistributionReduction(
  market: readonly Bar[],
  calendar: readonly string[],
  date: string,
) {
  const rows = window(market, calendar, date, 7);
  if (!rows) return null;
  const flags = rows
    .slice(1)
    .map(
      (b, i) =>
        b.close <= rows[i]!.close * 0.998 + 1e-10 && b.volume > rows[i]!.volume,
    );
  return flags.slice(1).every(Boolean) && !flags[0];
}
export function growthAddConfirmation(
  bars: readonly Bar[],
  market: readonly Bar[],
  calendar: readonly string[],
  date: string,
  entry: number,
) {
  const stock = window(bars, calendar, date, 21),
    index = window(market, calendar, date, 2);
  if (!stock || !index) return null;
  const bar = stock[20]!;
  return (
    bar.close >= entry * 1.02 - 1e-10 &&
    bar.close <= entry * 1.03 + 1e-10 &&
    bar.volume > stock.slice(0, 20).reduce((s, b) => s + b.volume / 20, 0) &&
    Math.abs(index[1]!.close / index[0]!.close - 1) < 0.02 - 1e-12
  );
}
