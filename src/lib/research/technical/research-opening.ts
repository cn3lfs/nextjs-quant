import { z } from "zod";
import type { Bar } from "../../domain";

export const openingProfiles = {
  OP01: "强趋势五档开盘确认",
  OP02: "底部转折五档开盘确认",
  OP03: "平台五档突破与回踩",
  OP04: "高位衰竭五档减仓",
  OP05: "下跌趋势五档反弹减仓",
  OP06: "昨收收复与失守",
  OP07: "前30分钟区间确认",
  OP08: "旧仓与今日新仓分批风险管理",
} as const;
export type OpeningId = keyof typeof openingProfiles;
export const openingIds = Object.keys(openingProfiles) as OpeningId[];
export function isOpening(id: string): id is OpeningId {
  return Object.hasOwn(openingProfiles, id);
}
export function openingMinuteStart(calendar: readonly string[], start: string) {
  const index = calendar.findIndex((date) => date >= start);
  const first =
    index >= 0 ? (calendar[Math.max(0, index - 5)] ?? start) : start;
  return first < "2000-01-04" ? "2000-01-04" : first;
}
const price = z.number().finite().positive();
const timestamp = z.string().datetime({ offset: true });
/** A plan is historical evidence, never a classification backfilled from today's close. */
export const openingPlanSchema = z
  .object({
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    effectiveAt: timestamp,
    availableAt: timestamp,
    capturedAt: timestamp,
    position: z.enum(["trend", "bottom", "platform", "exhaustion", "decline"]),
    life: price,
    observation: price,
    resistance: price,
    special: z.boolean(),
  })
  .strict()
  .refine(
    (p) => p.life < p.observation && p.observation < p.resistance,
    "生命线<观察线<压力位",
  );
export const openingPlansSchema = z.array(openingPlanSchema).max(100000);
export type OpeningPlan = z.infer<typeof openingPlanSchema>;
export const openingBoundary =
  "OP工程v1：双突破已确认入场基线叠加开盘管理，不声称完整择股体系。五类位置及生命/观察/压力线须提供前一交易日15:00前已知的逐证券逐日计划（symbol/date/source/version/effectiveAt/availableAt/capturedAt/position/life/observation/resistance/special）；缺失为待数据，特殊日不套普通剧本。大幅高开>5%、明显高开[2%,5%]、平开[-1%,1%]、明显低开[-5%,-2%]、大幅低开<-5%；灰区(1%,2%)及(-2%,-1%)仅观察，不强塞五档。开盘取当日日线open（9:30已知），绝不用首根5分钟close。前30分钟为9:30–10:00六根已完成K线，持续确认两根5分钟收盘，边界相等不算突破；回踩容差0.2%、缩量<0.8/放量>=1.5为工程参数，早盘累计量与此前五个完整交易日同时段比较。昨日蜡烛：实体>=全幅60%为大阳/大阴，上下影>=实体2倍且>=全幅40%，十字实体<=全幅10%；涨停形态无历史状态不猜测。风险生命线优先；观察线失守减原始仓位一半，每证券日一次，已确认请求保留；买入最早10:00下一根open，单次风险和市值各取基线一半，目标空间至少2R。OP04/05只管理相同双突破持仓，不新增逆势买点；OP06/07/08分别比较昨收、冻结30分钟区间及生命/观察线。账本逐批T+1，当日新仓退出意图保留到可卖日；只对完成K线确认后下一根open模拟成交，不推断K内顺序。硬窗口2000-01-04..2022-11-30与逐日48根沿用原引擎。无lc1/竞价历史，竞价量和第一分钟判断单列待数据，五分钟版本不替代。未真实回测。";

export const openingBands = [
  "large-up",
  "up",
  "flat",
  "down",
  "large-down",
] as const;
export type OpeningBand = (typeof openingBands)[number];
export function openingBand(
  open: number,
  previousClose: number,
): OpeningBand | "gray" {
  const gap = Math.round((open / previousClose - 1) * 1e10) / 1e8;
  return gap > 5
    ? "large-up"
    : gap >= 2
      ? "up"
      : gap >= -1 && gap <= 1
        ? "flat"
        : gap >= -5 && gap <= -2
          ? "down"
          : gap < -5
            ? "large-down"
            : "gray";
}
type Branch =
  | "no-chase"
  | "hold-open"
  | "retest"
  | "reclaim"
  | "risk-only"
  | "fade-open"
  | "reject"
  | "rally-sell";
// Rows, not independently implemented strategy modules. Order matches openingBands.
export const openingRows: Record<
  "OP01" | "OP02" | "OP03" | "OP04" | "OP05",
  readonly Branch[]
> = {
  OP01: ["no-chase", "hold-open", "retest", "reclaim", "risk-only"],
  OP02: ["no-chase", "retest", "retest", "reclaim", "risk-only"],
  OP03: ["no-chase", "retest", "retest", "reclaim", "risk-only"],
  OP04: ["fade-open", "reject", "reject", "reject", "risk-only"],
  OP05: ["rally-sell", "rally-sell", "rally-sell", "risk-only", "risk-only"],
};
export function openingCandle(b: Bar) {
  const range = b.high - b.low,
    body = Math.abs(b.close - b.open);
  const upper = b.high - Math.max(b.open, b.close),
    lower = Math.min(b.open, b.close) - b.low;
  const kind =
    range === 0 || body <= range * 0.1
      ? "doji"
      : upper >= body * 2 && upper >= range * 0.4
        ? "upper"
        : lower >= body * 2 && lower >= range * 0.4
          ? "lower"
          : body >= range * 0.6
            ? b.close > b.open
              ? "bull"
              : "bear"
            : "small";
  return {
    kind,
    midpoint: (b.open + b.close) / 2,
    upperMidpoint: (b.high + Math.max(b.open, b.close)) / 2,
  };
}
export type OpeningContext = {
  id: OpeningId;
  symbol: string;
  date: string;
  previousDate: string;
  open: number;
  yesterday: Bar;
  completed: readonly Bar[];
  priorMinutes: readonly (readonly Bar[])[];
  plans: readonly OpeningPlan[];
};
export function openingDecision(c: OpeningContext) {
  const missing = (reason: string) => ({
    status: "missing" as const,
    reason,
    buy: false,
    sell: 0,
    stop: null as number | null,
    evidence: null as null | Record<string, unknown>,
  });
  const y = c.yesterday;
  if (
    ![c.open, y.open, y.high, y.low, y.close, y.volume].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    y.high < Math.max(y.open, y.close, y.low) ||
    y.low > Math.min(y.open, y.close)
  )
    return missing("待数据：开盘价或前日OHLC/成交量无效");
  const matches = c.plans.filter(
    (p) => p.symbol === c.symbol && p.date === c.date,
  );
  const p = matches.length === 1 ? matches[0] : undefined;
  const cutoff = Date.parse(`${c.previousDate}T15:00:00+08:00`);
  if (
    !p ||
    [p.effectiveAt, p.availableAt].some((t) => Date.parse(t) > cutoff) ||
    Date.parse(p.availableAt) < Date.parse(p.effectiveAt) ||
    Date.parse(p.capturedAt) < Date.parse(p.availableAt)
  )
    return missing("待数据：前日冻结的唯一开盘计划及可知时点");
  const positions = {
    OP01: "trend",
    OP02: "bottom",
    OP03: "platform",
    OP04: "exhaustion",
    OP05: "decline",
  } as const;
  const band = openingBand(c.open, c.yesterday.close);
  const candle = openingCandle(c.yesterday);
  const rows = c.completed,
    last = rows.at(-1),
    recent = rows.slice(-2);
  const evidence: Record<string, unknown> = {
    plan: p,
    band,
    candle,
    completed: rows.length,
    openingRangeBars: 6,
    confirmationBars: 2,
  };
  const answer = (buy: boolean, sell: number, reason: string) => ({
    status: "available" as const,
    buy,
    sell,
    reason,
    stop: p.life,
    evidence,
  });
  if (p.special)
    return missing(
      "待数据：特殊日需要事件、竞价及流动性专用证据，不套普通剧本",
    );
  // The opening price is known at 09:30; execution waits until the next boundary.
  if (rows.length && c.open < p.life)
    return answer(false, 1, "开盘直接失守生命线");
  if (recent.length === 2 && recent.every((b) => b.close < p.life))
    return answer(false, 1, "两根五分钟收盘失守生命线");
  if (!last || rows.length < 6) return answer(false, 0, "等待10:00及两根确认");
  if (
    c.id in positions &&
    p.position !== positions[c.id as keyof typeof positions]
  )
    return answer(false, 0, "冻结位置与剧本不匹配");
  if (
    c.priorMinutes.length !== 5 ||
    c.priorMinutes.some((day) => day.length !== 48)
  )
    return missing("待数据：前五个交易日完整分钟量，不能用昨日全天量代替");
  const average = c.priorMinutes.reduce(
    (s, day) =>
      s + day.slice(0, rows.length).reduce((n, b) => n + b.volume, 0) / 5,
    0,
  );
  const ratio = rows.reduce((s, b) => s + b.volume, 0) / average;
  if (!Number.isFinite(ratio) || average <= 0)
    return missing("待数据：同时段量能基准无效");
  evidence.volumeRatio = ratio;
  const above = (line: number) => recent.every((b) => b.close > line);
  const below = (line: number) => recent.every((b) => b.close < line);
  let observation = p.observation;
  if (candle.kind === "bull" || candle.kind === "bear")
    observation = Math.max(observation, candle.midpoint);
  if (candle.kind === "upper")
    observation = Math.max(observation, candle.upperMidpoint);
  if (candle.kind === "doji")
    observation = Math.max(observation, c.yesterday.high);
  const defended =
    rows.every((b) => b.low >= p.life) &&
    (candle.kind !== "lower" || rows.every((b) => b.low >= c.yesterday.low));
  const enoughRoom =
    p.resistance - last.close >= 2 * (last.close - p.life) &&
    last.close > p.life;
  const reclaimed = above(Math.max(observation, c.yesterday.close));
  const retest = rows
    .slice(0, -2)
    .some((b) => b.low <= observation * 1.002 && b.low >= p.life);
  const weak = below(observation);
  if (c.id === "OP06")
    return answer(
      above(c.yesterday.close) && defended && enoughRoom && ratio >= 0.8,
      below(c.yesterday.close) ? 0.5 : 0,
      "昨收两根收复/失守",
    );
  if (c.id === "OP07") {
    const high = Math.max(...rows.slice(0, 6).map((b) => b.high)),
      low = Math.min(...rows.slice(0, 6).map((b) => b.low));
    evidence.range = { high, low, endsAt: rows[5]!.date };
    return answer(
      rows.length >= 8 && above(high) && ratio >= 1.5 && defended && enoughRoom,
      rows.length >= 8 && below(low) ? 0.5 : 0,
      "冻结前30分钟区间，区间后两根确认",
    );
  }
  if (c.id === "OP08")
    return answer(
      reclaimed && defended && enoughRoom && ratio >= 0.8,
      weak ? 0.5 : 0,
      "逐批T+1：旧仓减仓，新仓锁定至可卖日",
    );
  if (band === "gray") return answer(false, 0, "1%至2%灰区仅观察");
  const branch = openingRows[c.id][openingBands.indexOf(band)]!;
  evidence.branch = branch;
  if (branch === "risk-only")
    return answer(false, 0, "大幅低开或下跌低开，不抄底不补仓");
  if (branch === "no-chase" || branch === "fade-open")
    return answer(
      false,
      ratio >= 1.5 && below(c.open) ? 0.5 : 0,
      "大幅高开不追，放量失守开盘减仓",
    );
  if (branch === "rally-sell")
    return answer(
      false,
      last.high >= c.yesterday.close && below(p.resistance) ? 0.5 : 0,
      "下跌趋势反弹不过压力减仓",
    );
  if (branch === "reject")
    return answer(
      false,
      above(c.yesterday.high) && ratio >= 1.5
        ? 0
        : weak || below(c.open)
          ? 0.5
          : 0,
      "高位风险K线反包则观察，否则反弹失败减仓",
    );
  if (branch === "hold-open")
    return answer(
      false,
      ratio >= 1.5 && below(Math.min(c.open, c.yesterday.close)) ? 0.5 : 0,
      "高开守开盘和昨收持有，不追",
    );
  const recovered =
    branch === "reclaim"
      ? reclaimed && (c.id !== "OP01" || ratio < 0.8)
      : retest && above(observation) && ratio < 0.8;
  return answer(
    recovered && defended && enoughRoom,
    weak && ratio >= 1.5 ? 0.5 : 0,
    "缩量回踩/收复确认；放量失守观察线减仓",
  );
}
