import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseBars } from "../data-sources/tdx/tdx";
import type { Period } from "~/lib/domain";
export type CalendarReference = {
  days: string[];
  closedDays?: string[];
  source: string;
  hash: string | null;
};
export type ScreenDataHealth = {
  status: "aligned" | "lagging" | "unknown";
  dataAsOf: string | null;
  referenceAsOf: string | null;
  referenceSource: string;
  referenceHash: string | null;
  assessedAt: number;
  tradingStatus: "unknown";
  warnings: string[];
};
export function requireCurrentScreen(health: ScreenDataHealth) {
  if (health.status !== "aligned")
    throw new Error(
      `严格当前模式未通过：行情 ${health.dataAsOf ?? "未知"}，参考 ${health.referenceAsOf ?? "未知"}；${health.status === "lagging" ? "本地行情落后，请更新通达信数据" : "无法核验当前应有时点，请核对交易日历和行情"}。可切换本地最近时点作研究。`,
    );
}
export async function localCalendarReference(
  root: string,
  overrides: string[],
): Promise<CalendarReference> {
  if (overrides.length)
    return {
      days: overrides,
      source: "用户确认的交易日期",
      hash: createHash("sha256")
        .update(JSON.stringify(overrides))
        .digest("hex"),
    };
  try {
    const path = join(root, "vipdoc", "sh", "lday", "sh000001.day");
    const handle = await open(path, "r");
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size % 32)
        throw new Error("指数日期记录不完整");
      const size = Math.min(before.size, 400 * 32);
      bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          size - offset,
          before.size - size + offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat(),
        current = await stat(path);
      const unchanged = (value: typeof before) =>
        value.dev === before.dev &&
        value.ino === before.ino &&
        value.size === before.size &&
        value.mtimeMs === before.mtimeMs &&
        value.ctimeMs === before.ctimeMs &&
        value.birthtimeMs === before.birthtimeMs;
      if (offset !== size || !unchanged(after) || !unchanged(current))
        throw new Error("指数日期文件读取期间发生变化");
    } finally {
      await handle.close();
    }
    return {
      days: parseBars(bytes, "day").map((bar) => bar.date),
      source: "本地上证指数最近 400 根已有交易日期（非完整官方日历）",
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { days: [], source: "交易日期参考不可用", hash: null };
  }
}
function calendarCoverage(days: string[]) {
  return {
    start: days.length ? days.reduce((a, b) => (a < b ? a : b)) : null,
    end: days.length ? days.reduce((a, b) => (a > b ? a : b)) : null,
    count: days.length,
  };
}
export async function fullLocalCalendarReference(
  root: string,
  overrides: string[],
): Promise<
  CalendarReference & {
    coverage: { start: string | null; end: string | null; count: number };
  }
> {
  if (overrides.length)
    return {
      days: overrides,
      coverage: calendarCoverage(overrides),
      source: "用户确认的交易日期",
      hash: createHash("sha256")
        .update(JSON.stringify(overrides))
        .digest("hex"),
    };
  try {
    const path = join(root, "vipdoc", "sh", "lday", "sh000001.day");
    const handle = await open(path, "r");
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size % 32)
        throw new Error("指数日期记录不完整");
      const size = before.size;
      bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          size - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat(),
        current = await stat(path);
      const unchanged = (value: typeof before) =>
        value.dev === before.dev &&
        value.ino === before.ino &&
        value.size === before.size &&
        value.mtimeMs === before.mtimeMs &&
        value.ctimeMs === before.ctimeMs &&
        value.birthtimeMs === before.birthtimeMs;
      if (offset !== size || !unchanged(after) || !unchanged(current))
        throw new Error("指数日期文件读取期间发生变化");
    } finally {
      await handle.close();
    }
    const days: string[] = [];
    // Calendar membership depends only on dates, including early records with invalid OHLC.
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const raw = String(bytes.readUInt32LE(offset)).padStart(8, "0");
      const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
      const parsed = new Date(day);
      if (
        raw.length !== 8 ||
        raw.slice(0, 4) === "0000" ||
        !Number.isFinite(+parsed) ||
        parsed.toISOString().slice(0, 10) !== day
      )
        throw new Error(`指数日期非法：${raw}`);
      if (days.length && day <= days[days.length - 1]!)
        throw new Error(`指数日期倒序或重复：${day}`);
      days.push(day);
    }
    return {
      days,
      coverage: calendarCoverage(days),
      source: "本地上证指数全部已有交易日期（非完整官方日历）",
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    throw new Error(
      `完整交易日期参考读取失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
export function screenDataHealth(
  asOf: string | null,
  period: Period,
  now: number,
  calendar: CalendarReference,
): ScreenDataHealth {
  const local = new Date(now + 8 * 3600000).toISOString(),
    today = local.slice(0, 10);
  const minutes =
    Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const days = [
    ...new Set(
      calendar.days.filter(
        (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today,
      ),
    ),
  ].sort();
  const todayKnown = days.includes(today);
  const todayConfirmed =
    todayKnown || Boolean(calendar.closedDays?.includes(today));
  const previous = days.filter((day) => day < today).at(-1);
  let referenceAsOf: string | null = null;
  if (period === "day")
    referenceAsOf = (todayKnown && minutes >= 905 ? today : previous) ?? null;
  else {
    let end =
      todayKnown && minutes >= 575
        ? Math.min(900, Math.floor(minutes / 5) * 5)
        : null;
    if (end !== null && end > 690 && end < 785) end = 690;
    referenceAsOf =
      end === null
        ? previous
          ? `${previous}T15:00:00+08:00`
          : null
        : `${today}T${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}:00+08:00`;
  }
  const value = asOf
    ? Date.parse(period === "day" ? `${asOf}T00:00:00+08:00` : asOf)
    : NaN;
  const target = referenceAsOf
    ? Date.parse(
        period === "day" ? `${referenceAsOf}T00:00:00+08:00` : referenceAsOf,
      )
    : NaN;
  const status =
    Number.isFinite(value) && Number.isFinite(target) && value < target
      ? "lagging"
      : todayConfirmed && Number.isFinite(value) && value === target
        ? "aligned"
        : "unknown";
  return {
    status,
    dataAsOf: asOf,
    referenceAsOf,
    referenceSource: calendar.source,
    referenceHash: calendar.hash,
    assessedAt: now,
    tradingStatus: "unknown",
    warnings: [
      ...(status === "lagging"
        ? [
            "整批行情落后于已知交易时点；结果可供历史观察，不能视为当前选股信号。",
          ]
        : []),
      ...(!todayConfirmed
        ? ["参考日历未确认今天是否交易，无法证明资料已更新到当前应有时点。"]
        : []),
      ...(status === "unknown"
        ? ["当前时效未核验；缺少基准或来源时点与参考不一致。"]
        : []),
      "证券停牌、退市及个股缺失区间尚未逐项核验；同批时点一致不代表数据完整。",
    ],
  };
}
