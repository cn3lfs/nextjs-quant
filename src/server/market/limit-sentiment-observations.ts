import { beijingClock } from "~/lib/market/market-session";

/**
 * 打板情绪盘中观测的领域类型与采样时间判断。存储见
 * `src/server/db/limit-sentiment-observations.ts`。
 */
export type LimitObservation = {
  /** 请求交易日（北京时间）。 */
  date: string;
  /** 本机四池请求完成时的北京时间 HH:MM。 */
  minute: string;
  /** 本机四池请求完成时刻，epoch 毫秒；不是交易所同秒快照。 */
  at: number;
  /** 涨停家数，允许真实 0。 */
  limitUp: number;
  /** 炸板家数，允许真实 0。 */
  broken: number;
  /** 跌停家数，允许真实 0。 */
  limitDown: number;
};

export type TradingSession = "morning" | "afternoon";

/** 09:30–11:30、13:00–15:00，含两个交易端点。 */
export function tradingSession(minutes: number): TradingSession | null {
  if (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) return "morning";
  if (minutes >= 13 * 60 && minutes <= 15 * 60) return "afternoon";
  return null;
}

/**
 * 仅当请求日期就是四池请求完成时的本地日期、且为工作日交易时段才生成采样点。
 * 返回 null 表示不写；真实 0 仍会生成点。
 */
export function samplingPoint(
  requestDate: string,
  at: number,
  counts: { limitUp: number; broken: number; limitDown: number },
): LimitObservation | null {
  const clock = beijingClock(at);
  if (clock.date !== requestDate) return null;
  if (clock.weekday < 1 || clock.weekday > 5) return null;
  if (!tradingSession(clock.minutes)) return null;
  return {
    date: requestDate,
    minute: clock.hhmm,
    at,
    limitUp: counts.limitUp,
    broken: counts.broken,
    limitDown: counts.limitDown,
  };
}
