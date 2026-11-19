import { beijingClock } from "~/lib/market/market-session";
import { sqlite } from "./index";
import {
  tradingSession,
  type LimitObservation,
} from "../market/limit-sentiment-observations";

/**
 * 打板情绪盘中观测的只追加存储。与历史定稿快照 `limit-sentiment` 分开存放，
 * 同一分钟只保留第一条，不覆盖已有证据。
 */
export const LIMIT_OBSERVATION_KIND = "limit-sentiment-observation";
const ID_PREFIX = "limit-sentiment-observation:";
/** 09:30–11:30 与 13:00–15:00 各 121 个含端点分钟。 */
const MAX_OBSERVATIONS_PER_DAY = 242;

const idFor = (date: string, minute: string) => `${ID_PREFIX}${date}:${minute}`;

/** 同一分钟只保留第一条；仅吞主键冲突，其他约束错误照常抛出。 */
export function insertLimitObservation(point: LimitObservation): boolean {
  const result = sqlite()
    .prepare(
      "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
    .run(
      idFor(point.date, point.minute),
      LIMIT_OBSERVATION_KIND,
      JSON.stringify(point),
      Date.now(),
    );
  return result.changes === 1;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** 只接受与 `at` 的北京日期/分钟一致、处于两交易时段且家数为整数的行。 */
const isObservation = (
  value: unknown,
  date: string,
): value is LimitObservation => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.date !== date) return false;
  if (typeof row.minute !== "string" || !/^\d{2}:\d{2}$/.test(row.minute))
    return false;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false;
  const clock = beijingClock(row.at);
  if (clock.date !== date || clock.hhmm !== row.minute) return false;
  if (clock.weekday < 1 || clock.weekday > 5) return false;
  if (!tradingSession(clock.minutes)) return false;
  return isCount(row.limitUp) && isCount(row.broken) && isCount(row.limitDown);
};

/**
 * 读取该请求日已有的真实本机观测。日 ID 区间是唯一 WHERE 筛选，确保
 * `records.id` 主键区间被选中；`kind` 在解析循环中排除，避免 `records_kind`
 * 索引与临时排序。单日上限 242；坏行跳过，不补造。同时要求持久化 id 与
 * payload 的日期/分钟一致。
 */
export function readLimitObservations(date: string): LimitObservation[] {
  const prefix = `${ID_PREFIX}${date}:`;
  // `;` 是 `:` 的下一字符，作为不含上界的区间端点。
  const upper = `${prefix.slice(0, -1)};`;
  const rows = sqlite()
    .prepare(
      "SELECT id,kind,payload FROM records WHERE id>=? AND id<? ORDER BY id LIMIT ?",
    )
    .all(prefix, upper, MAX_OBSERVATIONS_PER_DAY) as {
    id: string;
    kind: string;
    payload: string;
  }[];
  const points: LimitObservation[] = [];
  for (const row of rows) {
    if (row.kind !== LIMIT_OBSERVATION_KIND) continue;
    try {
      const value: unknown = JSON.parse(row.payload);
      if (
        isObservation(value, date) &&
        row.id === idFor(value.date, value.minute)
      )
        points.push(value);
    } catch {
      // 单条坏记录不应让同日的其余真实观测不可读。
    }
  }
  return points;
}
