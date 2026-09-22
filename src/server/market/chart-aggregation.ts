import type { Bar } from "~/lib/domain";
import { isMinutePeriod, type ChartPeriod } from "~/lib/chart-view";

const dayMs = 86400000;
function exchangeNow(now: number) {
  return new Date(now + 8 * 3600000).toISOString();
}
export function chartPeriodEnd(date: string, period: ChartPeriod): number {
  if (isMinutePeriod(period)) return Date.parse(date);
  let day = date.slice(0, 10);
  if (period === "week") {
    const d = new Date(day);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
    day = d.toISOString().slice(0, 10);
  } else if (period === "month") {
    const d = new Date(day);
    day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
  }
  return Date.parse(`${day}T15:00:00+08:00`);
}
function combine(rows: Bar[], date: string): Bar {
  return {
    date,
    open: rows[0]!.open,
    close: rows.at(-1)!.close,
    high: Math.max(...rows.map((b) => b.high)),
    low: Math.min(...rows.map((b) => b.low)),
    volume: rows.reduce((sum, b) => sum + b.volume, 0),
    amount: rows.reduce((sum, b) => sum + b.amount, 0),
  };
}
/** End-labelled 5m bars; never combine across lunch, fabricate missing bars or fill volume. */
export function aggregateChartBars(
  bars: Bar[],
  base: "day" | "5m",
  target: ChartPeriod,
  now: number,
  calendar?: { days: string[]; closedDays?: string[] },
) {
  const groups = new Map<string, Bar[]>();
  const expected = new Map<string, number>();
  const today = exchangeNow(now).slice(0, 10);
  let previous = "";
  for (const bar of bars) {
    if (
      bar.date <= previous ||
      !Number.isFinite(Date.parse(bar.date)) ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount].every(
        Number.isFinite,
      ) ||
      bar.low <= 0 ||
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.volume < 0 ||
      bar.amount < 0
    )
      throw new Error("合成源行情日期、价格或成交量无效");
    previous = bar.date;
    const day = bar.date.slice(0, 10);
    let key = bar.date;
    if (base === "5m") {
      const wall = new Date(Date.parse(bar.date) + 8 * 3600000);
      const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
      const start =
        minute > 570 && minute <= 690
          ? 570
          : minute > 780 && minute <= 900
            ? 780
            : -1;
      if (start < 0 || minute % 5)
        throw new Error("5分钟行情不在交易时段或时间未对齐");
      if (target === "day") {
        key = day;
        expected.set(key, 48);
      } else {
        if (!isMinutePeriod(target)) throw new Error("周月线须从日线合成");
        const size = Number.parseInt(target);
        const end = start + Math.ceil((minute - start) / size) * size;
        key = `${day}T${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}:00+08:00`;
        expected.set(key, size / 5);
      }
    } else if (target === "week") {
      const d = new Date(day);
      key = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * dayMs)
        .toISOString()
        .slice(0, 10);
    } else if (target === "month") key = day.slice(0, 7);
    else if (target !== "day") throw new Error("分钟线不能从日线合成");
    const group = groups.get(key) ?? [];
    if (group.some((b) => b.date === bar.date)) throw new Error("行情时间重复");
    group.push(bar);
    groups.set(key, group);
  }
  const result: Bar[] = [],
    formingDates: string[] = [],
    excluded: { date: string; reason: string }[] = [];
  for (const [key, rows] of groups) {
    const date = base === "day" ? rows.at(-1)!.date : key;
    const forming = chartPeriodEnd(date, target) > now;
    const count = expected.get(key);
    // Even forming bars require an uninterrupted prefix beginning at the bucket boundary.
    let complete = !count || rows.length === count;
    if (base === "day" && (target === "week" || target === "month")) {
      const opening = new Set(calendar?.days ?? []),
        closed = new Set(calendar?.closedDays ?? []);
      const present = new Set(rows.map((b) => b.date));
      const first = target === "month" ? `${key}-01` : key;
      const last = new Date(chartPeriodEnd(date, target) + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      for (
        let day = first;
        day <= last && day <= today;
        day = new Date(Date.parse(day) + dayMs).toISOString().slice(0, 10)
      ) {
        const weekday = new Date(day).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        // 只有能证明当天开市、而本品种缺这一根时才算缺口。日历只保留最近约 400 个
        // 交易日且不含休市名单：不在日历里的工作日一律视为休市/无交易日，否则每个
        // 节假日都会把整块周/月行情判成不完整，本地周/月线永远无法使用。
        if (opening.has(day) && (!present.has(day) || closed.has(day)))
          complete = false;
      }
    }
    if (count && forming && key.slice(0, 10) === today) {
      const end =
        target === "day"
          ? Date.parse(`${today}T15:00:00+08:00`)
          : Date.parse(key);
      const first =
        target === "day"
          ? Date.parse(`${today}T09:35:00+08:00`)
          : end - (count - 1) * 300000;
      complete =
        Date.parse(rows[0]!.date) === first &&
        rows.every(
          (b, i) =>
            i === 0 ||
            Date.parse(b.date) - Date.parse(rows[i - 1]!.date) ===
              (b.date.includes("T13:05:") ? 5700000 : 300000),
        );
    }
    if (!complete) {
      excluded.push({ date, reason: "缺少组成周期行情" });
      continue;
    }
    result.push(combine(rows, date));
    if (forming) formingDates.push(date);
  }
  return { bars: result, formingDates, excluded };
}
